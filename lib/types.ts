import type { Subprocess } from "bun";

export interface ChatSession {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastMessageAt: number;
  lastMessage?: string;
  claudeSessionId?: string;
  isProcessing?: boolean;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  image?: {
    id: string;
    filename: string;
    mediaType: string;
  };
}

export interface SpriteProfile {
  id: string;
  name: string;
  address: string;
  port: number;
  publicUrl?: string;
  createdAt: number;
}

export interface BackgroundProcess {
  process: Subprocess;
  buffer: string;
  assistantBuffer: string;
  sessionId: string;
  clients: Set<WebSocket>;
  startedAt: number;
  isGenerating: boolean;
}

export interface NetworkSprite {
  hostname: string;
  org: string;
  tailscaleUrl: string;
  publicUrl: string;
  ownerEmail?: string;
  registeredAt: number;
  lastSeen: number;
  capabilities?: SpriteCapabilities;
}

export interface SpriteCapabilities {
  plugins: string[];
  skills: string[];
  knowledgeTopics: string[];
}

export interface SharedKnowledge {
  id: string;
  hostname: string;
  type: "memory" | "summary" | "claude-md" | "decision";
  title: string;
  content: string;
  updatedAt: number;
}

export interface NetworkTask {
  id: string;
  from: string;
  to: string | "*";
  prompt: string;
  context?: string;
  status: "pending" | "claimed" | "running" | "done" | "failed";
  claimedBy?: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
