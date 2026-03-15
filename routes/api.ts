import { spawn } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { ChatSession, SpriteProfile } from "../lib/types";
import {
  loadSessions, saveSessions, getSession, updateSession,
  loadSprites, saveSprites,
  loadMessages, deleteMessagesFile, saveMessages,
  generateId, UPLOADS_DIR
} from "../lib/storage";
import type { StoredMessage } from "../lib/types";
import { discoverSprites, getSpriteStatus, getNetworkInfo, getHostname, updateHeartbeat, deleteSprite } from "../lib/network";
import { fetchAllKnowledge, fetchNetworkKnowledge, publishAll, collectCapabilities, fetchAllCapabilities } from "../lib/knowledge";
import { submitTask, listTasks, getTaskResult, deleteTask, getMySubmittedTasks } from "../lib/tasks";
import { listMemories, getMemory, saveMemory, deleteMemory, getCombinedContext, generateMemory } from "../lib/memory";
import { allClients } from "./websocket";

// Broadcast a message to all connected keepalive clients
function broadcastToAll(message: any) {
  const data = JSON.stringify(message);
  for (const client of allClients) {
    if (client.readyState === 1) {
      try {
        client.send(data);
      } catch (err) {
        // Client may have disconnected, ignore
      }
    }
  }
}

// Detect actual image format from file content (magic bytes)
function detectImageFormat(buffer: ArrayBuffer): { ext: string; mediaType: string } | null {
  const bytes = new Uint8Array(buffer);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { ext: "png", mediaType: "image/png" };
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 &&
      bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { ext: "jpg", mediaType: "image/jpeg" };
  }

  // GIF: 47 49 46 38 (GIF8)
  if (bytes.length >= 4 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: "gif", mediaType: "image/gif" };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { ext: "webp", mediaType: "image/webp" };
  }

  return null;
}

export function handleApi(req: Request, url: URL): Response | Promise<Response> | null {
  const path = url.pathname;

  // GET /api/config - returns public configuration for the client
  // Read env var lazily so .env file has time to load
  if (req.method === "GET" && path === "/api/config") {
    return Response.json({
      publicUrl: process.env.SPRITE_PUBLIC_URL || "",
      spriteName: getHostname(),
    });
  }

  // GET /api/sessions
  if (req.method === "GET" && path === "/api/sessions") {
    const sessions = loadSessions();
    sessions.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return Response.json(sessions);
  }

  // GET /api/sessions/:id/messages
  if (req.method === "GET" && path.match(/^\/api\/sessions\/[^/]+\/messages$/)) {
    const id = path.split("/")[3];
    const messages = loadMessages(id);
    return Response.json(messages);
  }

  // POST /api/sessions
  if (req.method === "POST" && path === "/api/sessions") {
    return (async () => {
      const body = await req.json().catch(() => ({}));
      const sessions = loadSessions();
      const cwd = body.cwd || process.env.HOME || "/home/sprite";
      const newSession: ChatSession = {
        id: generateId(),
        name: body.name || `Chat ${sessions.length + 1}`,
        cwd,
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      };

      sessions.push(newSession);
      saveSessions(sessions);

      // Broadcast to all clients to refresh their session lists
      broadcastToAll({ type: "refresh_sessions" });

      return Response.json(newSession);
    })();
  }

  // PATCH /api/sessions/:id
  if (req.method === "PATCH" && path.startsWith("/api/sessions/") && !path.includes("regenerate")) {
    return (async () => {
      const id = path.split("/")[3];
      const body = await req.json().catch(() => ({}));
      const sessions = loadSessions();
      const session = sessions.find(s => s.id === id);
      if (!session) return new Response("Not found", { status: 404 });
      if (body.name) session.name = body.name;
      if (body.cwd) session.cwd = body.cwd;
      saveSessions(sessions);
      return Response.json(session);
    })();
  }

  // POST /api/sessions/:id/regenerate-title
  if (req.method === "POST" && path.match(/^\/api\/sessions\/[^/]+\/regenerate-title$/)) {
    return (async () => {
      const id = path.split("/")[3];

      // Find Claude session file by scanning all cwd directories
      // Claude's files are the source of truth - no need for sprite-mobile metadata
      let claudeSessionFile: string | null = null;
      const claudeProjectsDir = join(process.env.HOME || "/home/sprite", ".claude", "projects");

      if (existsSync(claudeProjectsDir)) {
        const cwdDirs = readdirSync(claudeProjectsDir);
        for (const cwdDir of cwdDirs) {
          const candidateFile = join(claudeProjectsDir, cwdDir, `${id}.jsonl`);
          if (existsSync(candidateFile)) {
            claudeSessionFile = candidateFile;
            break;
          }
        }
      }

      if (!claudeSessionFile) {
        return new Response("No Claude session file found", { status: 404 });
      }

      let messages: Array<{ role: string; content: string }> = [];

      try {
        const content = readFileSync(claudeSessionFile, "utf-8");
        const lines = content.trim().split("\n").filter(line => line.trim());

        // Parse Claude's .jsonl format (written by claude-hub)
        messages = lines
          .map(line => {
            try {
              const msg = JSON.parse(line);

              // User message: {"type": "user", "message": {"role": "user", "content": "..."}}
              if (msg.type === "user" && msg.message?.content) {
                const content = msg.message.content;
                // Handle both string and array content
                const textContent = typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
                    : "";
                if (textContent) {
                  return { role: "user", content: textContent };
                }
              }

              // Assistant message: {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
              if (msg.type === "assistant" && msg.message?.content) {
                const content = Array.isArray(msg.message.content)
                  ? msg.message.content
                      .filter((c: any) => c.type === "text")
                      .map((c: any) => c.text)
                      .join("\n")
                  : "";
                if (content) {
                  return { role: "assistant", content };
                }
              }
            } catch {}
            return null;
          })
          .filter((msg): msg is { role: string; content: string } => msg !== null);
      } catch (err) {
        console.error("Failed to read Claude session file:", err);
        return new Response("Failed to read session file", { status: 500 });
      }

      if (messages.length === 0) {
        return new Response("No messages to generate title from", { status: 400 });
      }

      const conversationSummary = messages
        .slice(0, 10)
        .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");

      try {
        const prompt = `Based on this conversation, generate a very short title (3-5 words max) that captures the main topic. Reply with ONLY the title, no quotes or punctuation:\n\n${conversationSummary.slice(0, 1500)}`;

        const env = { ...process.env };
        delete env.CLAUDECODE;
        const proc = spawn({
          cmd: ["claude", "--print", "-p", prompt],
          stdout: "pipe",
          stderr: "pipe",
          env,
        });

        const output = await new Response(proc.stdout).text();
        const title = output.trim().slice(0, 50) || session.name;

        updateSession(id, { name: title });

        return Response.json({ id, name: title });
      } catch (err) {
        console.error("Failed to regenerate title:", err);
        return new Response("Failed to generate title", { status: 500 });
      }
    })();
  }

  // POST /api/sessions/:id/update-id
  if (req.method === "POST" && path.match(/^\/api\/sessions\/[^/]+\/update-id$/)) {
    return (async () => {
      const oldId = path.split("/")[3];
      const body = await req.json() as { newId: string };
      const { newId } = body;

      if (!newId) {
        return new Response("Missing newId", { status: 400 });
      }

      const session = getSession(oldId);
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      console.log(`[API] Updating session ID from ${oldId} to ${newId}`);

      // Update sessions file
      const sessions = loadSessions();
      const sessionIndex = sessions.findIndex(s => s.id === oldId);
      if (sessionIndex !== -1) {
        sessions[sessionIndex].id = newId;
        saveSessions(sessions);
      }

      // Rename messages file if it exists
      const oldMessagesFile = join(process.env.HOME || "/home/sprite", ".sprite-mobile/data", `${oldId}.json`);
      const newMessagesFile = join(process.env.HOME || "/home/sprite", ".sprite-mobile/data", `${newId}.json`);
      try {
        if (existsSync(oldMessagesFile)) {
          const fs = await import("fs");
          fs.renameSync(oldMessagesFile, newMessagesFile);
          console.log(`[API] Renamed messages file from ${oldId}.json to ${newId}.json`);
        }
      } catch (err) {
        console.error(`[API] Failed to rename messages file:`, err);
      }

      return Response.json({ success: true, oldId, newId });
    })();
  }

  // POST /api/sessions/:id/update-message
  if (req.method === "POST" && path.match(/^\/api\/sessions\/[^/]+\/update-message$/)) {
    return (async () => {
      const id = path.split("/")[3];
      const body = await req.json() as { role: 'user' | 'assistant'; content: string };
      const { role, content } = body;

      if (!role || !content) {
        return new Response("Missing role or content", { status: 400 });
      }

      const session = getSession(id);

      // If session doesn't exist in sprite-mobile metadata, that's OK
      // Claude files are source of truth - we just maintain lightweight metadata for UI
      if (!session) {
        const sessions = loadSessions();
        const preview = content.slice(0, 100);
        const newSession = {
          id,
          name: role === 'user' ? preview : "New Chat",
          cwd: process.env.HOME || "/home/sprite",
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
          lastMessage: preview,
        };
        sessions.unshift(newSession);
        saveSessions(sessions);
      } else {
        // Update existing metadata
        const preview = content.slice(0, 100);
        updateSession(id, {
          lastMessage: preview,
          lastMessageAt: Date.now()
        });
      }

      return Response.json({ success: true });
    })();
  }

  // DELETE /api/sessions/:id
  if (req.method === "DELETE" && path.startsWith("/api/sessions/")) {
    const id = path.split("/")[3];
    let sessions = loadSessions();
    sessions = sessions.filter(s => s.id !== id);
    saveSessions(sessions);
    deleteMessagesFile(id);

    // Broadcast to all clients to refresh their session lists
    broadcastToAll({ type: "refresh_sessions" });

    return new Response(null, { status: 204 });
  }

  // GET /api/sprites
  if (req.method === "GET" && path === "/api/sprites") {
    const sprites = loadSprites();
    sprites.sort((a, b) => b.createdAt - a.createdAt);
    return Response.json(sprites);
  }

  // POST /api/sprites
  if (req.method === "POST" && path === "/api/sprites") {
    return (async () => {
      const body = await req.json().catch(() => ({}));
      if (!body.name || !body.address) {
        return new Response("Name and address required", { status: 400 });
      }
      const sprites = loadSprites();
      const newSprite: SpriteProfile = {
        id: generateId(),
        name: body.name,
        address: body.address,
        port: body.port || 8080,
        publicUrl: body.publicUrl,
        createdAt: Date.now(),
      };
      sprites.push(newSprite);
      saveSprites(sprites);
      return Response.json(newSprite);
    })();
  }

  // PATCH /api/sprites/:id
  if (req.method === "PATCH" && path.match(/^\/api\/sprites\/[^/]+$/)) {
    return (async () => {
      const id = path.split("/")[3];
      const body = await req.json().catch(() => ({}));
      const sprites = loadSprites();
      const sprite = sprites.find(s => s.id === id);
      if (!sprite) return new Response("Not found", { status: 404 });
      if (body.name) sprite.name = body.name;
      if (body.address) sprite.address = body.address;
      if (body.port) sprite.port = body.port;
      if (body.publicUrl !== undefined) sprite.publicUrl = body.publicUrl;
      saveSprites(sprites);
      return Response.json(sprite);
    })();
  }

  // DELETE /api/sprites/:id
  if (req.method === "DELETE" && path.match(/^\/api\/sprites\/[^/]+$/)) {
    const id = path.split("/")[3];
    let sprites = loadSprites();
    sprites = sprites.filter(s => s.id !== id);
    saveSprites(sprites);
    return new Response(null, { status: 204 });
  }

  // GET /api/network/status - Check if network is configured
  if (req.method === "GET" && path === "/api/network/status") {
    return Response.json(getNetworkInfo());
  }

  // GET /api/network/sprites - Discover sprites in the network
  if (req.method === "GET" && path === "/api/network/sprites") {
    return (async () => {
      const sprites = await discoverSprites();
      const currentHostname = getHostname();

      const spritesWithStatus = sprites.map(s => ({
        ...s,
        status: getSpriteStatus(s),
        isSelf: s.hostname === currentHostname,
      }));

      return Response.json(spritesWithStatus);
    })();
  }

  // POST /api/network/heartbeat - Manual heartbeat trigger
  if (req.method === "POST" && path === "/api/network/heartbeat") {
    return (async () => {
      await updateHeartbeat();
      return Response.json({ ok: true });
    })();
  }

  // DELETE /api/network/sprites/:hostname - Remove a sprite from the network
  if (req.method === "DELETE" && path.startsWith("/api/network/sprites/")) {
    const spriteHostname = path.replace("/api/network/sprites/", "");
    if (!spriteHostname) {
      return new Response("Hostname required", { status: 400 });
    }
    return (async () => {
      try {
        await deleteSprite(spriteHostname);
        return Response.json({ ok: true, deleted: spriteHostname });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    })();
  }

  // POST /api/upload?session={sessionId}
  if (req.method === "POST" && path === "/api/upload") {
    return (async () => {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) {
        return new Response("Session ID required", { status: 400 });
      }

      // Sanitize sessionId to prevent path traversal
      const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (sanitizedSessionId !== sessionId || sanitizedSessionId.length === 0) {
        return new Response("Invalid session ID", { status: 400 });
      }

      try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
          return new Response("No file provided", { status: 400 });
        }

        if (!file.type.startsWith("image/")) {
          return new Response("Only images are allowed", { status: 400 });
        }

        // Only read first 12 bytes for format detection (magic bytes check)
        const blobSlice = file.slice(0, 12);
        const headerBuffer = await blobSlice.arrayBuffer();

        // Detect actual image format from file content
        const imageFormat = detectImageFormat(headerBuffer);
        if (!imageFormat) {
          return new Response("Unsupported or invalid image format", { status: 400 });
        }

        const sessionUploadsDir = join(UPLOADS_DIR, sanitizedSessionId);
        if (!existsSync(sessionUploadsDir)) {
          mkdirSync(sessionUploadsDir, { recursive: true });
        }

        const id = generateId();
        const filename = `${id}.${imageFormat.ext}`;
        const filePath = join(sessionUploadsDir, filename);

        // Now read full file for saving
        const fullBuffer = await file.arrayBuffer();
        writeFileSync(filePath, Buffer.from(fullBuffer));

        return Response.json({
          id,
          filename,
          mediaType: imageFormat.mediaType,
          url: `/api/uploads/${sanitizedSessionId}/${filename}`,
        });
      } catch (err) {
        console.error("Upload error:", err);
        return new Response("Upload failed", { status: 500 });
      }
    })();
  }

  // GET /api/uploads/:sessionId/:filename
  if (req.method === "GET" && path.match(/^\/api\/uploads\/[^/]+\/[^/]+$/)) {
    const parts = path.split("/");
    const sessionId = parts[3];
    const filename = parts[4];

    // Sanitize sessionId and filename to prevent path traversal
    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '');

    if (sanitizedSessionId !== sessionId || sanitizedFilename !== filename ||
        sanitizedSessionId.length === 0 || sanitizedFilename.length === 0) {
      return new Response("Invalid parameters", { status: 400 });
    }

    const filePath = join(UPLOADS_DIR, sanitizedSessionId, sanitizedFilename);

    try {
      if (!existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }
      const content = readFileSync(filePath);
      const contentType = sanitizedFilename.endsWith(".png") ? "image/png"
        : sanitizedFilename.endsWith(".jpg") || sanitizedFilename.endsWith(".jpeg") ? "image/jpeg"
        : sanitizedFilename.endsWith(".gif") ? "image/gif"
        : sanitizedFilename.endsWith(".webp") ? "image/webp"
        : "application/octet-stream";
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // === Session Memories ===

  // GET /api/memories - List all memories
  if (req.method === "GET" && path === "/api/memories") {
    const memories = listMemories();
    return Response.json(memories);
  }

  // POST /api/memories/context - Get combined context from selected sessions
  if (req.method === "POST" && path === "/api/memories/context") {
    return (async () => {
      const body = await req.json().catch(() => ({})) as { sessionIds?: string[] };
      if (!body.sessionIds || !Array.isArray(body.sessionIds)) {
        return new Response("sessionIds array required", { status: 400 });
      }
      const context = getCombinedContext(body.sessionIds);
      return Response.json({ context });
    })();
  }

  // GET /api/memories/:id - Get a specific memory
  if (req.method === "GET" && path.match(/^\/api\/memories\/[^/]+$/)) {
    const id = path.split("/")[3];
    const content = getMemory(id);
    if (!content) return new Response("Not found", { status: 404 });
    return new Response(content, { headers: { "Content-Type": "text/markdown" } });
  }

  // PUT /api/memories/:id - Save/update a memory manually
  if (req.method === "PUT" && path.match(/^\/api\/memories\/[^/]+$/)) {
    return (async () => {
      const id = path.split("/")[3];
      const content = await req.text();
      if (!content.trim()) return new Response("Content required", { status: 400 });
      saveMemory(id, content);
      return Response.json({ success: true, sessionId: id });
    })();
  }

  // POST /api/memories/:id/generate - Auto-generate memory from conversation
  if (req.method === "POST" && path.match(/^\/api\/memories\/[^/]+\/generate$/)) {
    return (async () => {
      const id = path.split("/")[3];
      const session = getSession(id);
      const title = session?.name || id;
      try {
        const memory = await generateMemory(id, title);
        return Response.json({ success: true, sessionId: id, content: memory });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 400 });
      }
    })();
  }

  // DELETE /api/memories/:id - Delete a memory
  if (req.method === "DELETE" && path.match(/^\/api\/memories\/[^/]+$/)) {
    const id = path.split("/")[3];
    const deleted = deleteMemory(id);
    if (!deleted) return new Response("Not found", { status: 404 });
    return new Response(null, { status: 204 });
  }

  // GET /api/keepalive/status - Check if keepalive process is running
  if (req.method === "GET" && path === "/api/keepalive/status") {
    return (async () => {
      try {
        // Check if process is running using pgrep
        const result = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const output = await new Response(result.stdout).text();
        const pid = output.trim();

        if (pid) {
          return Response.json({
            running: true,
            pid: parseInt(pid)
          });
        }

        return Response.json({ running: false });
      } catch (err) {
        console.error("Failed to check keepalive status:", err);
        return Response.json({ running: false, error: String(err) }, { status: 500 });
      }
    })();
  }

  // POST /api/keepalive/start - Start the keepalive process
  if (req.method === "POST" && path === "/api/keepalive/start") {
    return (async () => {
      try {
        // Check if already running
        const checkResult = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const pid = (await new Response(checkResult.stdout).text()).trim();

        if (pid) {
          console.log(`[Keepalive] Already running (PID: ${pid})`);
          return Response.json({
            success: true,
            message: "Keepalive already running",
            pid: parseInt(pid)
          });
        }

        // Start keepalive as background process
        const scriptPath = join(process.env.HOME || "/home/sprite", ".sprite-mobile/scripts/session-keepalive.sh");
        const logPath = join(process.env.HOME || "/home/sprite", ".sprite-mobile/data/keepalive.log");

        spawn(["bash", scriptPath], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: process.env,
          detached: true,
          // Redirect output to log file
          onExit: (proc, code) => {
            console.log(`[Keepalive] Process exited with code ${code}`);
          }
        });

        // Wait a moment for process to start
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify it started
        const verifyResult = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const newPid = (await new Response(verifyResult.stdout).text()).trim();

        if (newPid) {
          console.log(`[Keepalive] Started successfully (PID: ${newPid})`);
          return Response.json({ success: true, message: "Keepalive started", pid: parseInt(newPid) });
        } else {
          console.error("[Keepalive] Failed to start (process not found after spawn)");
          return Response.json({ success: false, error: "Failed to start keepalive process" }, { status: 500 });
        }
      } catch (err) {
        console.error("[Keepalive] Error starting:", err);
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    })();
  }

  // === Network Knowledge ===

  // GET /api/network/knowledge - Fetch shared knowledge from network
  if (req.method === "GET" && path === "/api/network/knowledge") {
    return (async () => {
      const type = url.searchParams.get("type") || undefined;
      const from = url.searchParams.get("from") || undefined;
      const selfOnly = url.searchParams.get("self") === "true";

      const knowledge = selfOnly
        ? await fetchAllKnowledge(type, getHostname())
        : await (from ? fetchAllKnowledge(type, from) : fetchNetworkKnowledge(type));

      return Response.json(knowledge);
    })();
  }

  // POST /api/network/knowledge/publish - Publish this sprite's knowledge
  if (req.method === "POST" && path === "/api/network/knowledge/publish") {
    return (async () => {
      await publishAll();
      return Response.json({ ok: true });
    })();
  }

  // GET /api/network/capabilities - Get all sprites' capabilities
  if (req.method === "GET" && path === "/api/network/capabilities") {
    return (async () => {
      const all = await fetchAllCapabilities();
      return Response.json(all);
    })();
  }

  // GET /api/network/capabilities/self - Get this sprite's capabilities
  if (req.method === "GET" && path === "/api/network/capabilities/self") {
    return Response.json(collectCapabilities());
  }

  // === Network Tasks ===

  // POST /api/network/tasks - Submit a task to another sprite
  if (req.method === "POST" && path === "/api/network/tasks") {
    return (async () => {
      const body = await req.json().catch(() => ({})) as { to?: string; prompt?: string; context?: string };
      if (!body.to || !body.prompt) {
        return new Response("to and prompt required", { status: 400 });
      }
      const task = await submitTask(body.to, body.prompt, body.context);
      return Response.json(task);
    })();
  }

  // GET /api/network/tasks - List tasks
  if (req.method === "GET" && path === "/api/network/tasks") {
    return (async () => {
      const status = url.searchParams.get("status") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const from = url.searchParams.get("from") || undefined;
      const mine = url.searchParams.get("mine") === "true";

      const tasks = mine
        ? await getMySubmittedTasks()
        : await listTasks({ status, to, from });

      return Response.json(tasks);
    })();
  }

  // GET /api/network/tasks/:id - Get task result
  if (req.method === "GET" && path.match(/^\/api\/network\/tasks\/[^/]+$/)) {
    return (async () => {
      const taskId = path.split("/")[4];
      const task = await getTaskResult(taskId);
      if (!task) return new Response("Not found", { status: 404 });
      return Response.json(task);
    })();
  }

  // DELETE /api/network/tasks/:id - Delete a task
  if (req.method === "DELETE" && path.match(/^\/api\/network\/tasks\/[^/]+$/)) {
    return (async () => {
      const taskId = path.split("/")[4];
      await deleteTask(taskId);
      return Response.json({ ok: true });
    })();
  }

  // POST /api/keepalive/stop - Stop the keepalive process
  if (req.method === "POST" && path === "/api/keepalive/stop") {
    return (async () => {
      try {
        // Find the process
        const checkResult = spawn(["pgrep", "-f", "session-keepalive.sh"], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const pid = (await new Response(checkResult.stdout).text()).trim();

        if (!pid) {
          return Response.json({ success: true, message: "Keepalive not running" });
        }

        // Kill the process
        const killResult = spawn(["kill", pid], {
          stdout: "pipe",
          stderr: "pipe"
        });

        await killResult.exited;

        if (killResult.exitCode === 0) {
          console.log(`[Keepalive] Stopped process (PID: ${pid})`);
          return Response.json({ success: true, message: "Keepalive stopped" });
        } else {
          const error = await new Response(killResult.stderr).text();
          console.error("[Keepalive] Failed to stop:", error);
          return Response.json({ success: false, error }, { status: 500 });
        }
      } catch (err) {
        console.error("[Keepalive] Error stopping:", err);
        return Response.json({ success: false, error: String(err) }, { status: 500 });
      }
    })();
  }

  return null;
}
