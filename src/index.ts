import { Hono } from "hono";
import { DurableObjectNamespace } from "@cloudflare/workers-types";

type Bindings = {
  CHAT_ROOM: DurableObjectNamespace;
};

// ChatRoom Durable Object class
export class ChatRoom {
  private state: DurableObjectState;
  private sessions: Map<WebSocket, string> = new Map();
  private users: Map<string, WebSocket> = new Map();

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle API requests
    if (url.pathname === "/api/users") {
      return new Response(
        JSON.stringify({
          users: Array.from(this.users.keys()),
          count: this.users.size,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        }
      );
    }

    // Handle WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    // Handle WebSocket messages
    server.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleMessage(server, data);
      } catch (error) {
        console.error("Error parsing message:", error);
        server.send(
          JSON.stringify({
            type: "error",
            message: "Invalid message format",
          })
        );
      }
    });

    // Handle WebSocket close
    server.addEventListener("close", () => {
      const username = this.sessions.get(server);
      if (username) {
        this.sessions.delete(server);
        this.users.delete(username);
        this.broadcast(
          {
            type: "userLeft",
            username,
            timestamp: Date.now(),
          },
          server
        );
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleMessage(server: WebSocket, data: any) {
    switch (data.type) {
      case "join":
        this.handleJoin(server, data.username);
        break;
      case "message":
        this.handleChatMessage(server, data);
        break;
      case "ping":
        // Handle ping for connection health
        server.send(JSON.stringify({ type: "pong" }));
        break;
      default:
        server.send(
          JSON.stringify({
            type: "error",
            message: "Unknown message type",
          })
        );
    }
  }

  private handleJoin(server: WebSocket, username: string) {
    if (!username || username.trim() === "") {
      server.send(
        JSON.stringify({
          type: "error",
          message: "Username is required",
        })
      );
      return;
    }

    // Check if username is already taken
    if (this.users.has(username)) {
      server.send(
        JSON.stringify({
          type: "error",
          message: "Username is already taken",
        })
      );
      return;
    }

    // Add user to the room
    this.sessions.set(server, username);
    this.users.set(username, server);

    // Notify all users about the new user
    this.broadcast(
      {
        type: "userJoined",
        username,
        timestamp: Date.now(),
      },
      server
    );

    // Send success response to the new user
    server.send(
      JSON.stringify({
        type: "joined",
        username,
        message: `Welcome to the crypto game chat, ${username}!`,
        timestamp: Date.now(),
      })
    );
  }

  private handleChatMessage(server: WebSocket, data: any) {
    const username = this.sessions.get(server);
    if (!username) {
      server.send(
        JSON.stringify({
          type: "error",
          message: "You must join the chat first",
        })
      );
      return;
    }

    if (!data.message || data.message.trim() === "") {
      return;
    }

    const message = {
      type: "message",
      username,
      message: data.message.trim(),
      timestamp: Date.now(),
    };

    this.broadcast(message);
  }

  private broadcast(message: any, exclude?: WebSocket) {
    const messageStr = JSON.stringify(message);

    for (const [server, username] of this.sessions) {
      if (
        server !== exclude &&
        server.readyState === WebSocket.READY_STATE_OPEN
      ) {
        server.send(messageStr);
      }
    }
  }
}

const app = new Hono<{ Bindings: Bindings }>();

// Health check endpoint
app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "crypto-game-chat-backend",
    timestamp: Date.now(),
  });
});

// WebSocket endpoint for chat
app.get("/chat", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader !== "websocket") {
    return c.text("Expected websocket", 400);
  }

  const id = c.env.CHAT_ROOM.idFromName("crypto-game-chat");
  const durableObject = c.env.CHAT_ROOM.get(id);

  return durableObject.fetch(c.req.raw);
});

// API endpoint to get online users
app.get("/api/users", async (c) => {
  const id = c.env.CHAT_ROOM.idFromName("crypto-game-chat");
  const durableObject = c.env.CHAT_ROOM.get(id);

  const response = await durableObject.fetch(
    new Request("http://localhost/api/users")
  );
  return response;
});

// CORS middleware for API endpoints
app.use("/api/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");

  if (c.req.method === "OPTIONS") {
    return c.text("", 200);
  }

  await next();
});

// Export the app as default
export default app;
