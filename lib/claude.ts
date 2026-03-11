import { spawn } from "bun";
import { updateSession } from "./storage";

// Generate a chat name from the first message using Claude
export async function generateChatName(message: string, sessionId: string): Promise<string> {
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
    return title;
  } catch (err) {
    console.error("Failed to generate chat name:", err);
    const fallback = message.slice(0, 40).trim() + (message.length > 40 ? "..." : "");
    const title = fallback || "New Chat";
    updateSession(sessionId, { name: title });
    return title;
  }
}
