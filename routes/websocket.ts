import { loadMessages, getSession, updateSession, getInProgressMessage } from "../lib/storage";
import { generateChatName } from "../lib/claude";

// Track all connected clients for broadcast messages (e.g., reload)
export const allClients = new Set<any>();

// Track hub WebSocket connections per client
const hubConnections = new Map<any, WebSocket>();

const GO_HUB_URL = process.env.GO_HUB_URL || "ws://localhost:9090";

// Start keepalive session to keep sprite awake during generation
async function startKeepalive() {
  try {
    const response = await fetch('http://localhost:8081/api/keepalive/start', {
      method: 'POST',
    });
    if (response.ok) {
      console.log('[Keepalive] Started successfully');
    }
  } catch (err) {
    console.error('[Keepalive] Failed to start:', err);
  }
}

// Proxy WebSocket connection to Go hub
function proxyToGoHub(clientWs: any, sessionId: string) {
  const hubUrl = `${GO_HUB_URL}/ws?session=${sessionId}`;

  try {
    const hubWs = new WebSocket(hubUrl);

    // Store hub connection for this client
    hubConnections.set(clientWs, hubWs);

    // Forward messages from hub to client
    hubWs.onmessage = (event: any) => {
      if (clientWs.readyState === 1) {
        clientWs.send(event.data);
      }
    };

    // Handle hub connection open
    hubWs.onopen = () => {
      console.log(`[Hub] Connected for session ${sessionId}`);
    };

    // Handle hub connection close
    hubWs.onclose = () => {
      console.log(`[Hub] Disconnected for session ${sessionId}`);
      hubConnections.delete(clientWs);
      if (clientWs.readyState === 1) {
        clientWs.close();
      }
    };

    // Handle hub connection error
    hubWs.onerror = (error: any) => {
      console.error(`[Hub] Error for session ${sessionId}:`, error);
      hubConnections.delete(clientWs);
      if (clientWs.readyState === 1) {
        try {
          clientWs.send(JSON.stringify({
            type: "error",
            message: "Failed to connect to hub"
          }));
        } catch {}
        clientWs.close();
      }
    };

  } catch (error) {
    console.error(`[Hub] Failed to create proxy for session ${sessionId}:`, error);
    try {
      clientWs.send(JSON.stringify({
        type: "error",
        message: "Failed to connect to hub"
      }));
    } catch {}
    clientWs.close();
  }
}

export const websocketHandlers = {
  open(ws: any) {
    allClients.add(ws);
    const data = ws.data as { type?: string; sessionId?: string; cwd?: string; claudeSessionId?: string };

    // Handle keepalive connections
    if (data.type === "keepalive") {
      console.log("Keepalive connection opened");
      return;
    }

    if (data.sessionId) {
      console.log(`[Hub] Proxying session ${data.sessionId}`);
      proxyToGoHub(ws, data.sessionId);
    }
  },

  async message(ws: any, message: any) {
    const wsData = ws.data as { type?: string; sessionId?: string };

    // Ignore messages on keepalive connections
    if (wsData.type === "keepalive") return;

    const hubWs = hubConnections.get(ws);
    if (hubWs && hubWs.readyState === 1) {
      // Start keepalive when user sends a message (keeps sprite awake during generation)
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "user") {
          startKeepalive().catch(() => {}); // Fire and forget

          // Auto-generate chat title for first message
          const sessionId = wsData.sessionId;
          if (sessionId && data.content) {
            const existingMessages = loadMessages(sessionId);
            const session = getSession(sessionId);
            if (existingMessages.length === 0 && session?.name.match(/^Chat \d+$/)) {
              generateChatName(data.content, sessionId).then(title => {
                // Notify all clients in this session to refresh
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: "refresh_sessions" }));
                }
              }).catch(() => {});
            }
          }
        }
      } catch {}

      hubWs.send(message.toString());
    }
  },

  close(ws: any) {
    allClients.delete(ws);
    const wsData = ws.data as { type?: string; sessionId?: string };

    // Handle keepalive disconnections
    if (wsData.type === "keepalive") {
      console.log("Keepalive connection closed");
      return;
    }

    const hubWs = hubConnections.get(ws);
    if (hubWs) {
      hubConnections.delete(ws);
      if (hubWs.readyState === 1) {
        hubWs.close();
      }
    }
  },
};
