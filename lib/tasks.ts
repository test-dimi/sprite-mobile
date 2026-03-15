import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { spawn } from "bun";
import { readFileSync, existsSync } from "fs";
import type { NetworkTask } from "./types";
import { getHostname } from "./network";
import { buildNetworkContext } from "./knowledge";

const CREDS_PATH = process.env.SPRITE_NETWORK_CREDS || `${process.env.HOME}/.sprite-network/credentials.json`;

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let taskWorkerRunning = false;

export function initTasks(): boolean {
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
    console.log("Task system initialized");
    return true;
  } catch (err) {
    console.error("Failed to initialize task system:", err);
    return false;
  }
}

// --- Task CRUD ---

async function putTask(task: NetworkTask): Promise<void> {
  if (!s3Client || !bucketName) throw new Error("Task system not initialized");
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `tasks/${task.id}.json`,
    Body: JSON.stringify(task, null, 2),
    ContentType: "application/json",
  }));
}

async function getTask(taskId: string): Promise<NetworkTask | null> {
  if (!s3Client || !bucketName) return null;
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: `tasks/${taskId}.json`,
    }));
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (err: any) {
    if (err.name === "NoSuchKey") return null;
    throw err;
  }
}

// Submit a task for another sprite
export async function submitTask(to: string, prompt: string, context?: string): Promise<NetworkTask> {
  const task: NetworkTask = {
    id: crypto.randomUUID(),
    from: getHostname(),
    to,
    prompt,
    context,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await putTask(task);
  console.log(`Submitted task ${task.id} to ${to}`);
  return task;
}

// List tasks (optionally filtered)
export async function listTasks(filter?: {
  status?: string;
  to?: string;
  from?: string;
}): Promise<NetworkTask[]> {
  if (!s3Client || !bucketName) return [];

  try {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "tasks/",
    }));

    const tasks: NetworkTask[] = [];

    for (const obj of response.Contents || []) {
      if (!obj.Key?.endsWith(".json")) continue;
      try {
        const data = await s3Client.send(new GetObjectCommand({
          Bucket: bucketName,
          Key: obj.Key,
        }));
        const body = await data.Body?.transformToString();
        if (body) {
          const task: NetworkTask = JSON.parse(body);
          if (filter?.status && task.status !== filter.status) continue;
          if (filter?.to && task.to !== filter.to && task.to !== "*") continue;
          if (filter?.from && task.from !== filter.from) continue;
          tasks.push(task);
        }
      } catch {}
    }

    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error("Failed to list tasks:", err);
    return [];
  }
}

// Claim a pending task
async function claimTask(taskId: string): Promise<NetworkTask | null> {
  const task = await getTask(taskId);
  if (!task || task.status !== "pending") return null;

  const hostname = getHostname();

  // Check if task is for us
  if (task.to !== "*" && task.to !== hostname) return null;

  task.status = "claimed";
  task.claimedBy = hostname;
  task.updatedAt = Date.now();
  await putTask(task);

  console.log(`Claimed task ${taskId} from ${task.from}`);
  return task;
}

// Execute a task using claude --print
async function executeTask(task: NetworkTask): Promise<void> {
  const hostname = getHostname();

  // Update status to running
  task.status = "running";
  task.updatedAt = Date.now();
  await putTask(task);

  console.log(`Executing task ${task.id}: ${task.prompt.slice(0, 80)}...`);

  try {
    // Build prompt with network context if available
    let fullPrompt = task.prompt;

    if (task.context) {
      fullPrompt = `Context from requesting sprite (${task.from}):\n${task.context}\n\nTask:\n${fullPrompt}`;
    }

    // Add network knowledge context
    try {
      const networkContext = await buildNetworkContext();
      if (networkContext) {
        fullPrompt = `${networkContext}\n\n---\n\n${fullPrompt}`;
      }
    } catch {}

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn({
      cmd: ["claude", "--print", "-p", fullPrompt],
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0 && output.trim()) {
      task.status = "done";
      task.result = output.trim();
    } else {
      task.status = "failed";
      task.error = stderr.trim() || `Exit code: ${exitCode}`;
    }
  } catch (err: any) {
    task.status = "failed";
    task.error = err.message;
  }

  task.updatedAt = Date.now();
  await putTask(task);

  console.log(`Task ${task.id} ${task.status}${task.error ? `: ${task.error}` : ""}`);
}

// Delete a completed/failed task
export async function deleteTask(taskId: string): Promise<void> {
  if (!s3Client || !bucketName) throw new Error("Task system not initialized");
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: `tasks/${taskId}.json`,
  }));
}

// --- Task Worker ---

// Poll for pending tasks and execute them
async function pollAndExecute(): Promise<void> {
  const hostname = getHostname();

  try {
    const pendingTasks = await listTasks({ status: "pending" });

    for (const task of pendingTasks) {
      // Skip tasks not meant for us
      if (task.to !== "*" && task.to !== hostname) continue;

      // Skip tasks from ourselves
      if (task.from === hostname) continue;

      const claimed = await claimTask(task.id);
      if (claimed) {
        await executeTask(claimed);
      }
    }
  } catch (err) {
    console.error("Task poll error:", err);
  }
}

// Start the task worker (polls every 30 seconds)
export function startTaskWorker(): void {
  if (taskWorkerRunning) return;
  taskWorkerRunning = true;

  console.log("Task worker started (polling every 30s)");

  // Initial poll after 5 seconds
  setTimeout(() => pollAndExecute(), 5000);

  // Then poll every 30 seconds
  setInterval(() => pollAndExecute(), 30 * 1000);
}

// Get tasks submitted by this sprite (to check results)
export async function getMySubmittedTasks(): Promise<NetworkTask[]> {
  return listTasks({ from: getHostname() });
}

// Get task result
export async function getTaskResult(taskId: string): Promise<NetworkTask | null> {
  return getTask(taskId);
}
