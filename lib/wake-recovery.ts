import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

export interface RecoverableSession {
  claudeSessionId: string;
  jsonlPath: string;
  modifiedAt: number;
  cwdDir: string;
}

const CLAUDE_PROJECTS_DIR = join(process.env.HOME || "/home/sprite", ".claude", "projects");
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Scan ~/.claude/projects/ for recent .jsonl files that could be resumed.
 */
export function findRecoverableSessions(): RecoverableSession[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const sessions: RecoverableSession[] = [];
  const now = Date.now();

  try {
    const cwdDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const cwdDir of cwdDirs) {
      const dirPath = join(CLAUDE_PROJECTS_DIR, cwdDir);
      try {
        const dirStat = statSync(dirPath);
        if (!dirStat.isDirectory()) continue;

        const files = readdirSync(dirPath);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(dirPath, file);
          const stat = statSync(filePath);
          if (now - stat.mtimeMs < MAX_AGE_MS) {
            sessions.push({
              claudeSessionId: file.replace(".jsonl", ""),
              jsonlPath: filePath,
              modifiedAt: stat.mtimeMs,
              cwdDir,
            });
          }
        }
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return sessions;
}

/**
 * Get the most recent recoverable session.
 */
export function getMostRecentSession(): RecoverableSession | null {
  const sessions = findRecoverableSessions();
  return sessions.length > 0 ? sessions[0] : null;
}
