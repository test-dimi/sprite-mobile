import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { BackgroundProcess } from "./types";
import { saveMessage, updateSession, saveInProgressMessage, clearInProgressMessage } from "./storage";

// Global singleton - only ONE Claude process at a time
let activeProcess: BackgroundProcess | null = null;

// Legacy compatibility: backgroundProcesses facade over singleton
// This allows code that checks .has(sessionId) or .get(sessionId) to still work
export const backgroundProcesses = {
  get(sessionId: string): BackgroundProcess | undefined {
    return activeProcess?.sessionId === sessionId ? activeProcess : undefined;
  },
  has(sessionId: string): boolean {
    return activeProcess?.sessionId === sessionId;
  },
  set(sessionId: string, bg: BackgroundProcess): void {
    setActiveProcess(bg);
  },
  delete(sessionId: string): boolean {
    if (activeProcess?.sessionId === sessionId) {
      activeProcess = null;
      return true;
    }
    return false;
  },
  get size(): number {
    return activeProcess ? 1 : 0;
  },
  [Symbol.iterator](): Iterator<[string, BackgroundProcess]> {
    let done = false;
    const proc = activeProcess;
    return {
      next() {
        if (!done && proc) {
          done = true;
          return { value: [proc.sessionId, proc] as [string, BackgroundProcess], done: false };
        }
        return { value: undefined, done: true };
      },
    };
  },
};

export function getActiveProcess(): BackgroundProcess | null {
  return activeProcess;
}

export function setActiveProcess(bg: BackgroundProcess | null): void {
  // Kill any existing process if replacing with a different one
  if (activeProcess && bg && activeProcess !== bg) {
    console.log(`[Singleton] Replacing process for session ${activeProcess.sessionId} with ${bg.sessionId}`);
    try { activeProcess.process.kill(); } catch {}
    updateSession(activeProcess.sessionId, { isProcessing: false });
  }
  activeProcess = bg;
}

export function killActiveProcess(): void {
  if (activeProcess) {
    console.log(`[Singleton] Killing active process for session ${activeProcess.sessionId}`);
    try { activeProcess.process.kill(); } catch {}
    updateSession(activeProcess.sessionId, { isProcessing: false });
    clearActiveSessionFile();
    activeProcess = null;
  }
}

const ACTIVE_SESSION_DIR = join(process.env.HOME || "/home/sprite", ".claude-hub");
const ACTIVE_SESSION_FILE = join(ACTIVE_SESSION_DIR, "active-session");

function writeActiveSessionFile(claudeSessionId: string): void {
  try {
    if (!existsSync(ACTIVE_SESSION_DIR)) mkdirSync(ACTIVE_SESSION_DIR, { recursive: true });
    writeFileSync(ACTIVE_SESSION_FILE, claudeSessionId);
  } catch {}
}

function clearActiveSessionFile(): void {
  try {
    if (existsSync(ACTIVE_SESSION_FILE)) unlinkSync(ACTIVE_SESSION_FILE);
  } catch {}
}

// Broadcast to all connected clients
export function trySend(bg: BackgroundProcess, data: string) {
  for (const ws of bg.clients) {
    if (ws.readyState === 1) { // OPEN
      try {
        ws.send(data);
      } catch {
        bg.clients.delete(ws);
      }
    } else {
      bg.clients.delete(ws);
    }
  }
}

// Spawn Claude process
export function spawnClaude(cwd: string, claudeSessionId?: string): Subprocess {
  const cmd = [
    "claude",
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
  ];

  if (claudeSessionId) {
    cmd.push("--resume", claudeSessionId);
  }

  return spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwd || process.env.HOME,
  });
}

// Generate a chat name from the first message using Claude
export async function generateChatName(message: string, sessionId: string, bg: BackgroundProcess): Promise<void> {
  try {
    const prompt = `Generate a very short title (3-5 words max) for a chat that starts with this message. Reply with ONLY the title, no quotes or punctuation:\n\n${message.slice(0, 500)}`;

    const proc = spawn({
      cmd: ["claude", "--print", "-p", prompt],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const title = output.trim().slice(0, 50) || "New Chat";

    updateSession(sessionId, { name: title });
    trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
  } catch (err) {
    console.error("Failed to generate chat name:", err);
    // Fallback to truncated message
    const fallback = message.slice(0, 40).trim() + (message.length > 40 ? "..." : "");
    updateSession(sessionId, { name: fallback || "New Chat" });
    trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
  }
}

// Handle Claude output - continues even if client disconnects
export async function handleClaudeOutput(bg: BackgroundProcess) {
  const reader = bg.process.stdout.getReader();
  const decoder = new TextDecoder();

  // Track last save time to debounce saves during streaming
  let lastSaveTime = 0;
  const SAVE_INTERVAL = 200; // Save at most every 200ms during streaming (more frequent to survive refreshes)

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bg.buffer += decoder.decode(value, { stream: true });
      const lines = bg.buffer.split("\n");
      bg.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          // Always send to client if connected
          trySend(bg, JSON.stringify(msg));

          // Capture Claude's session ID from init
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            updateSession(bg.sessionId, { claudeSessionId: msg.session_id });
            writeActiveSessionFile(msg.session_id);
          }

          // Accumulate assistant text from streaming deltas
          if (msg.type === "content_block_delta" && msg.delta?.type === "text_delta" && msg.delta?.text) {
            bg.assistantBuffer += msg.delta.text;

            // Progressively save during streaming to survive refreshes
            const now = Date.now();
            if (now - lastSaveTime >= SAVE_INTERVAL && bg.assistantBuffer.length > 0) {
              lastSaveTime = now;
              saveInProgressMessage(bg.sessionId, bg.assistantBuffer);
              console.log(`[${bg.sessionId}] Saved in-progress message (${bg.assistantBuffer.length} chars)`);
            }
          }

          // Accumulate assistant text from full message (for reconnection)
          if (msg.type === "assistant" && msg.message?.content) {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              const textBlock = content.find((b: any) => b.type === "text");
              if (textBlock?.text) {
                bg.assistantBuffer = textBlock.text;
              }
            }
          }

          // Save complete assistant message
          if (msg.type === "result" && bg.assistantBuffer) {
            // Final save - mark as complete
            saveMessage(bg.sessionId, {
              role: "assistant",
              content: bg.assistantBuffer,
              timestamp: Date.now(),
            });
            console.log(`[${bg.sessionId}] Saved complete assistant message (${bg.assistantBuffer.length} chars)`);
            // Clear any in-progress message marker
            clearInProgressMessage(bg.sessionId);
            updateSession(bg.sessionId, {
              lastMessageAt: Date.now(),
              lastMessage: bg.assistantBuffer.slice(0, 100),
              isProcessing: false,
            });
            trySend(bg, JSON.stringify({ type: "refresh_sessions" }));
            bg.assistantBuffer = "";
            bg.isGenerating = false;
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error("Error reading Claude output:", err);
  }

  // Process finished - clean up
  // Save any remaining buffered content as a message if the process ended abruptly
  if (bg.assistantBuffer) {
    saveMessage(bg.sessionId, {
      role: "assistant",
      content: bg.assistantBuffer,
      timestamp: Date.now(),
    });
    console.log(`[${bg.sessionId}] Saved abruptly ended assistant message (${bg.assistantBuffer.length} chars)`);
    clearInProgressMessage(bg.sessionId);
  }
  console.log(`Claude process finished for session ${bg.sessionId}`);
  updateSession(bg.sessionId, { isProcessing: false });
  if (activeProcess === bg) {
    activeProcess = null;
    clearActiveSessionFile();
  }
}

// Handle stderr - just forward to client if connected
export async function handleClaudeStderr(bg: BackgroundProcess) {
  const reader = bg.process.stderr.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.trim()) {
        trySend(bg, JSON.stringify({ type: "stderr", message: text }));
      }
    }
  } catch {}
}

// Cleanup stale processes
export function cleanupStaleProcesses() {
  if (!activeProcess) return;

  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  if (now - activeProcess.startedAt > maxAge && activeProcess.clients.size === 0) {
    console.log(`Cleaning up stale process for session ${activeProcess.sessionId}`);
    killActiveProcess();
  }
}
