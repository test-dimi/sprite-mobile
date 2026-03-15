import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { SharedKnowledge, SpriteCapabilities } from "./types";
import { getHostname } from "./network";

const CREDS_PATH = process.env.SPRITE_NETWORK_CREDS || `${process.env.HOME}/.sprite-network/credentials.json`;

let s3Client: S3Client | null = null;
let bucketName: string | null = null;

export function initKnowledge(): boolean {
  if (!existsSync(CREDS_PATH)) return false;

  try {
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
    if (!creds.AWS_ACCESS_KEY_ID || !creds.AWS_SECRET_ACCESS_KEY || !creds.BUCKET_NAME) return false;

    s3Client = new S3Client({
      region: "auto",
      endpoint: creds.AWS_ENDPOINT_URL_S3 || "https://fly.storage.tigris.dev",
      credentials: {
        accessKeyId: creds.AWS_ACCESS_KEY_ID,
        secretAccessKey: creds.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: false,
    });

    bucketName = creds.BUCKET_NAME;
    console.log("Knowledge store initialized");
    return true;
  } catch (err) {
    console.error("Failed to initialize knowledge store:", err);
    return false;
  }
}

// --- Publishing ---

async function putObject(key: string, body: string, contentType = "application/json"): Promise<void> {
  if (!s3Client || !bucketName) throw new Error("Knowledge store not initialized");
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

async function getObject(key: string): Promise<string | null> {
  if (!s3Client || !bucketName) return null;
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    }));
    return await response.Body?.transformToString() || null;
  } catch (err: any) {
    if (err.name === "NoSuchKey") return null;
    throw err;
  }
}

async function listKeys(prefix: string): Promise<string[]> {
  if (!s3Client || !bucketName) return [];
  const response = await s3Client.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
  }));
  return (response.Contents || []).map(obj => obj.Key!).filter(Boolean);
}

// Publish a single knowledge item
export async function publishKnowledge(item: SharedKnowledge): Promise<void> {
  const key = `knowledge/${item.type}/${item.hostname}/${item.id}.json`;
  await putObject(key, JSON.stringify(item, null, 2));
}

// Publish Claude Code memories from ~/.claude/projects/-home-sprite/memory/
export async function publishMemories(): Promise<number> {
  const hostname = getHostname();
  const memoryDir = join(process.env.HOME || "/home/sprite", ".claude", "projects", "-home-sprite", "memory");

  if (!existsSync(memoryDir)) return 0;

  const files = readdirSync(memoryDir).filter(f => f.endsWith(".md"));
  let count = 0;

  for (const file of files) {
    const filePath = join(memoryDir, file);
    const content = readFileSync(filePath, "utf-8");
    const stat = statSync(filePath);
    const id = file.replace(".md", "");

    // Parse title from frontmatter
    let title = id;
    const frontmatterMatch = content.match(/^---\n[\s\S]*?name:\s*(.+)\n[\s\S]*?---/);
    if (frontmatterMatch) title = frontmatterMatch[1].trim();

    await publishKnowledge({
      id,
      hostname,
      type: "memory",
      title,
      content,
      updatedAt: stat.mtimeMs,
    });
    count++;
  }

  console.log(`Published ${count} memories to network`);
  return count;
}

// Publish session summaries from sprite-mobile data/memories/
export async function publishSummaries(): Promise<number> {
  const hostname = getHostname();
  const memoriesDir = join(import.meta.dir, "..", "data", "memories");

  if (!existsSync(memoriesDir)) return 0;

  const files = readdirSync(memoriesDir).filter(f => f.endsWith(".md"));
  let count = 0;

  for (const file of files) {
    const filePath = join(memoriesDir, file);
    const content = readFileSync(filePath, "utf-8");
    const stat = statSync(filePath);
    const id = file.replace(".md", "");

    let title = id;
    const frontmatterMatch = content.match(/^---\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/);
    if (frontmatterMatch) title = frontmatterMatch[1].trim();

    await publishKnowledge({
      id,
      hostname,
      type: "summary",
      title,
      content,
      updatedAt: stat.mtimeMs,
    });
    count++;
  }

  console.log(`Published ${count} summaries to network`);
  return count;
}

// Publish CLAUDE.md
export async function publishClaudeMd(): Promise<void> {
  const hostname = getHostname();
  const claudeMdPath = join(process.env.HOME || "/home/sprite", "CLAUDE.md");

  if (!existsSync(claudeMdPath)) return;

  const content = readFileSync(claudeMdPath, "utf-8");
  const stat = statSync(claudeMdPath);

  await publishKnowledge({
    id: "CLAUDE",
    hostname,
    type: "claude-md",
    title: `CLAUDE.md from ${hostname}`,
    content,
    updatedAt: stat.mtimeMs,
  });

  console.log("Published CLAUDE.md to network");
}

// --- Fetching ---

// Fetch all knowledge from all sprites, optionally filtered
export async function fetchAllKnowledge(type?: string, fromHostname?: string): Promise<SharedKnowledge[]> {
  const prefix = type
    ? (fromHostname ? `knowledge/${type}/${fromHostname}/` : `knowledge/${type}/`)
    : "knowledge/";

  const keys = await listKeys(prefix);
  const items: SharedKnowledge[] = [];

  for (const key of keys) {
    if (!key.endsWith(".json")) continue;
    const body = await getObject(key);
    if (body) {
      try {
        items.push(JSON.parse(body));
      } catch {}
    }
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Fetch knowledge from other sprites (exclude self)
export async function fetchNetworkKnowledge(type?: string): Promise<SharedKnowledge[]> {
  const all = await fetchAllKnowledge(type);
  const self = getHostname();
  return all.filter(k => k.hostname !== self);
}

// Build a context string from network knowledge for injecting into Claude prompts
export async function buildNetworkContext(): Promise<string> {
  const knowledge = await fetchNetworkKnowledge();
  if (knowledge.length === 0) return "";

  const sections: string[] = ["# Network Knowledge from Other Sprites\n"];

  // Group by hostname
  const byHost = new Map<string, SharedKnowledge[]>();
  for (const k of knowledge) {
    const list = byHost.get(k.hostname) || [];
    list.push(k);
    byHost.set(k.hostname, list);
  }

  for (const [host, items] of byHost) {
    sections.push(`## From ${host}\n`);
    for (const item of items) {
      sections.push(`### ${item.title} (${item.type})\n${item.content}\n`);
    }
  }

  return sections.join("\n");
}

// --- Capabilities ---

// Collect this sprite's installed plugins and skills
export function collectCapabilities(): SpriteCapabilities {
  const plugins: string[] = [];
  const skills: string[] = [];
  const knowledgeTopics: string[] = [];

  // Collect installed plugins
  const pluginsDir = join(process.env.HOME || "/home/sprite", ".claude", "plugins", "marketplaces", "claude-plugins-official", "plugins");
  if (existsSync(pluginsDir)) {
    try {
      const entries = readdirSync(pluginsDir);
      for (const entry of entries) {
        const pluginJsonPath = join(pluginsDir, entry, ".claude-plugin", "plugin.json");
        if (existsSync(pluginJsonPath)) {
          plugins.push(entry);
        }
      }
    } catch {}
  }

  // Collect skills from ~/.claude/skills/
  const skillsDir = join(process.env.HOME || "/home/sprite", ".claude", "skills");
  if (existsSync(skillsDir)) {
    try {
      const entries = readdirSync(skillsDir);
      for (const entry of entries) {
        const skillPath = join(skillsDir, entry, "SKILL.md");
        if (existsSync(skillPath)) {
          skills.push(entry);
        }
      }
    } catch {}
  }

  // Collect project-level skills
  const projectSkillsDir = join(process.env.HOME || "/home/sprite", ".claude", "projects", "-home-sprite", "skills");
  if (existsSync(projectSkillsDir)) {
    try {
      const entries = readdirSync(projectSkillsDir);
      for (const entry of entries) {
        if (!skills.includes(entry)) skills.push(entry);
      }
    } catch {}
  }

  // Knowledge topics from local memories
  const memoryDir = join(process.env.HOME || "/home/sprite", ".claude", "projects", "-home-sprite", "memory");
  if (existsSync(memoryDir)) {
    try {
      const files = readdirSync(memoryDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        const content = readFileSync(join(memoryDir, file), "utf-8");
        const nameMatch = content.match(/^---\n[\s\S]*?name:\s*(.+)\n/);
        if (nameMatch) knowledgeTopics.push(nameMatch[1].trim());
      }
    } catch {}
  }

  return { plugins, skills, knowledgeTopics };
}

// Publish capabilities to the registry
export async function publishCapabilities(): Promise<void> {
  const hostname = getHostname();
  const capabilities = collectCapabilities();

  await putObject(
    `capabilities/${hostname}.json`,
    JSON.stringify({ hostname, capabilities, updatedAt: Date.now() }, null, 2),
  );

  console.log(`Published capabilities: ${capabilities.plugins.length} plugins, ${capabilities.skills.length} skills, ${capabilities.knowledgeTopics.length} knowledge topics`);
}

// Fetch capabilities from all sprites
export async function fetchAllCapabilities(): Promise<Array<{ hostname: string; capabilities: SpriteCapabilities }>> {
  const keys = await listKeys("capabilities/");
  const results: Array<{ hostname: string; capabilities: SpriteCapabilities }> = [];

  for (const key of keys) {
    if (!key.endsWith(".json")) continue;
    const body = await getObject(key);
    if (body) {
      try {
        results.push(JSON.parse(body));
      } catch {}
    }
  }

  return results;
}

// Publish everything
export async function publishAll(): Promise<void> {
  try {
    await Promise.all([
      publishMemories(),
      publishSummaries(),
      publishClaudeMd(),
      publishCapabilities(),
    ]);
    console.log("Published all knowledge to network");
  } catch (err) {
    console.error("Failed to publish knowledge:", err);
  }
}
