import { spawn } from "bun";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getHostname, discoverSprites } from "./network";
import * as distributedTasks from "./distributed-tasks";

export interface WorkerSprite {
  name: string;
  status: "creating" | "ready" | "busy" | "error";
  publicUrl?: string;
  createdAt: number;
  currentTaskId?: string;
  error?: string;
}

const DATA_DIR = join(process.env.HOME || "/home/sprite", ".sprite-mobile", "data");
const WORKERS_FILE = join(DATA_DIR, "workers.json");
const CREATE_SCRIPT = join(process.env.HOME || "/home/sprite", ".sprite-mobile", "scripts", "create-sprite.sh");

let workers: WorkerSprite[] = [];

export function loadWorkers(): WorkerSprite[] {
  try {
    if (existsSync(WORKERS_FILE)) {
      workers = JSON.parse(readFileSync(WORKERS_FILE, "utf-8"));
    }
  } catch {}
  return workers;
}

function saveWorkers(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(WORKERS_FILE, JSON.stringify(workers, null, 2));
}

/**
 * Create a new worker sprite using create-sprite.sh.
 */
export async function createWorkerSprite(name: string): Promise<WorkerSprite> {
  if (!existsSync(CREATE_SCRIPT)) {
    throw new Error(`create-sprite.sh not found at ${CREATE_SCRIPT}`);
  }

  const worker: WorkerSprite = {
    name,
    status: "creating",
    createdAt: Date.now(),
  };

  loadWorkers();
  // Replace existing entry if present
  workers = workers.filter(w => w.name !== name);
  workers.push(worker);
  saveWorkers();

  const proc = spawn({
    cmd: ["bash", CREATE_SCRIPT, name],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    const urlMatch = output.match(/Public URL: (https?:\/\/[^\s]+)/);
    worker.publicUrl = urlMatch ? urlMatch[1] : undefined;
    worker.status = "ready";
    console.log(`[Workers] Created worker sprite: ${name}`);
  } else {
    const stderr = await new Response(proc.stderr).text();
    worker.status = "error";
    worker.error = (output + stderr).slice(-500);
    console.error(`[Workers] Failed to create worker sprite ${name}:`, worker.error);
  }

  saveWorkers();
  return worker;
}

/**
 * Find an available worker sprite, or return null.
 */
export async function getAvailableWorker(): Promise<WorkerSprite | null> {
  loadWorkers();

  // Check local worker pool first
  const idle = workers.find(w => w.status === "ready");
  if (idle) return idle;

  // Check network sprites (excluding self) that aren't busy
  if (distributedTasks.isTasksNetworkEnabled()) {
    const sprites = await discoverSprites();
    const selfHostname = getHostname();
    const networkSprites = sprites.filter(s => s.hostname !== selfHostname);

    for (const sprite of networkSprites) {
      try {
        const queue = await distributedTasks.getTaskQueue(sprite.hostname);
        if (!queue.currentTask && queue.queuedTasks.length === 0) {
          return {
            name: sprite.hostname,
            status: "ready",
            createdAt: 0,
          };
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Delegate work to a worker sprite.
 */
export async function delegateWork(
  title: string,
  description: string,
  workerName?: string,
): Promise<{ worker: WorkerSprite; taskId: string }> {
  if (!distributedTasks.isTasksNetworkEnabled()) {
    throw new Error("Distributed tasks not configured - cannot delegate work");
  }

  let worker: WorkerSprite | null = null;

  if (workerName) {
    loadWorkers();
    worker = workers.find(w => w.name === workerName) || null;
    if (!worker) {
      // Treat as a network sprite
      worker = { name: workerName, status: "ready", createdAt: 0 };
    }
  } else {
    worker = await getAvailableWorker();
  }

  if (!worker) {
    throw new Error("No available worker sprites. Create one first with POST /api/workers.");
  }

  const assignedBy = getHostname();

  const task = await distributedTasks.createTask({
    assignedTo: worker.name,
    assignedBy,
    title,
    description,
  } as any);

  // Update worker status in local pool
  loadWorkers();
  const tracked = workers.find(w => w.name === worker!.name);
  if (tracked) {
    tracked.status = "busy";
    tracked.currentTaskId = task.id;
    saveWorkers();
  }

  console.log(`[Workers] Delegated "${title}" to ${worker.name} (task ${task.id})`);
  return { worker, taskId: task.id };
}

/**
 * List all worker sprites.
 */
export function listWorkers(): WorkerSprite[] {
  return loadWorkers();
}

/**
 * Remove a worker sprite from the pool.
 */
export function removeWorker(name: string): boolean {
  loadWorkers();
  const before = workers.length;
  workers = workers.filter(w => w.name !== name);
  if (workers.length < before) {
    saveWorkers();
    return true;
  }
  return false;
}
