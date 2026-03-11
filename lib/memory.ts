import { spawn } from "bun";
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { MEMORIES_DIR } from "./storage";

export interface MemoryMeta {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  size: number;
}

// Parse frontmatter from a memory markdown file
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

function memoryPath(sessionId: string): string {
  return join(MEMORIES_DIR, `${sessionId}.md`);
}

// List all memories with metadata
export function listMemories(): MemoryMeta[] {

  const files = readdirSync(MEMORIES_DIR).filter(f => f.endsWith(".md"));
  return files.map(f => {
    const sessionId = f.replace(".md", "");
    const filePath = join(MEMORIES_DIR, f);
    const content = readFileSync(filePath, "utf-8");
    const stat = statSync(filePath);
    const { meta } = parseFrontmatter(content);
    return {
      sessionId,
      title: meta.title || sessionId,
      createdAt: meta.created || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
    };
  }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Get a specific memory
export function getMemory(sessionId: string): string | null {
  const path = memoryPath(sessionId);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// Save a memory
export function saveMemory(sessionId: string, content: string): void {

  writeFileSync(memoryPath(sessionId), content);
}

// Delete a memory
export function deleteMemory(sessionId: string): boolean {
  const path = memoryPath(sessionId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// Get combined context from multiple sessions
export function getCombinedContext(sessionIds: string[]): string {
  const parts: string[] = [];
  for (const id of sessionIds) {
    const content = getMemory(id);
    if (content) {
      parts.push(content);
    }
  }
  return parts.join("\n\n---\n\n");
}

// Read a session's .jsonl conversation and extract messages
function readSessionConversation(sessionId: string): Array<{ role: string; content: string }> {
  const homeDir = process.env.HOME || "/home/sprite";
  const claudeProjectsDir = join(homeDir, ".claude", "projects");

  if (!existsSync(claudeProjectsDir)) return [];

  // Scan all cwd directories for the session file
  let jsonlPath: string | null = null;
  try {
    const cwdDirs = readdirSync(claudeProjectsDir);
    for (const cwdDir of cwdDirs) {
      const candidate = join(claudeProjectsDir, cwdDir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        jsonlPath = candidate;
        break;
      }
    }
  } catch {}

  if (!jsonlPath) return [];

  const messages: Array<{ role: string; content: string }> = [];
  try {
    const content = readFileSync(jsonlPath, "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "user" && msg.message?.content) {
          const c = msg.message.content;
          const text = typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
              : "";
          if (text) messages.push({ role: "user", content: text });
        }
        if (msg.type === "assistant" && msg.message?.content) {
          const text = Array.isArray(msg.message.content)
            ? msg.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
            : "";
          if (text) messages.push({ role: "assistant", content: text });
        }
      } catch {}
    }
  } catch {}

  return messages;
}

// Generate a memory summary for a session using Claude
export async function generateMemory(sessionId: string, sessionTitle: string): Promise<string> {
  const messages = readSessionConversation(sessionId);
  if (messages.length === 0) {
    throw new Error("No conversation found for this session");
  }

  // Build conversation excerpt (truncate long messages, limit total size)
  const excerpt = messages.map(m => {
    const truncated = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
    return `${m.role}: ${truncated}`;
  }).join("\n\n");

  // Cap at ~8000 chars to keep the prompt reasonable
  const truncatedExcerpt = excerpt.slice(0, 8000);

  const prompt = `Summarize this conversation into a concise memory document. Include:
- What was discussed (key topics)
- What was decided or built
- Important outcomes, file paths, or technical details worth remembering
- Any open items or follow-ups

Write in markdown. Be concise but preserve important details. Use bullet points.
Do NOT include a frontmatter block — just the markdown body.

Conversation:
${truncatedExcerpt}`;

  const env = { ...process.env };
  delete env.CLAUDECODE;
  const proc = spawn({
    cmd: ["claude", "--print", "-p", prompt],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const output = await new Response(proc.stdout).text();
  const body = output.trim();

  if (!body) {
    throw new Error("Claude returned empty summary");
  }

  // Build the memory file with frontmatter
  const now = new Date().toISOString();
  const memory = `---
title: ${sessionTitle}
session: ${sessionId}
created: ${now}
---
${body}
`;

  saveMemory(sessionId, memory);
  return memory;
}
