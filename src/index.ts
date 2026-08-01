#!/usr/bin/env node
/**
 * WebRTC MCP Server — Entry Point (MCP Protocol v20241113 compatible).
 *
 * Modos de señalización:
 *   stdio → MCP nativo sobre stdin/stdout (Lydia CLI/TUI)
 *   ws    → WebSocket para peers externos (OpenCode, Claude Code)
 *   both  → Ambos simultáneamente
 *
 * Protocolo MCP:
 *   - Recibe: {"jsonrpc":"2.0","id":N,"method":"initialize",...}
 *   - Responde: {"jsonrpc":"2.0","id":N,"result":{"protocolVersion":"20241113",...}}
 *   - Luego: {"jsonrpc":"2.0","method":"initialized","params":{}}
 */
import { loadConfig } from "./config.js";
import { SignalingServer } from "./signaling/server.js";
import { WsSignalingServer } from "./signaling/ws-server.js";
import { RoomManager } from "./signaling/room.js";
import { McpHandler } from "./mcp-handler.js";
import { WorkerPool } from "./workers/pool.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("webrtc-mcp");
const PROTOCOL_VERSION = "2025-03-26";

// Estado del protocolo MCP
let initialized = false;

async function main(): Promise<void> {
  const config = loadConfig();

  // Subsistemas compartidos
  const signaling = new SignalingServer(config);
  const rooms = new RoomManager(config);
  let wsServer: WsSignalingServer | null = null;

  // Handler de tools MCP
  const handler = new McpHandler(signaling, rooms, wsServer);

  // ── Worker Pool (no bloqueante) ────────────────────────
  const pool = new WorkerPool(config);
  pool.start((workerId, msg) => {
    switch (msg.type) {
      case "connected":
        logger.info("peer connected", { peerId: msg.peerId, workerId });
        break;
      case "ice":
        signaling.routeIceCandidate(String(msg.peerId), msg.candidate as any);
        break;
      case "message":
        // Reenviar DataChannel messages al handler MCP
        (handler as any).__pool = pool;
        break;
      case "error":
        logger.error("worker error", { peerId: msg.peerId, error: msg.error });
        break;
    }
  }).catch((err) => {
    logger.error("pool start error", { error: String(err) });
  });
  (handler as any).__pool = pool;

  // ── WebSocket signaling ───────────────────────────────
  if (config.signaling.mode === "ws" || config.signaling.mode === "both") {
    wsServer = new WsSignalingServer(rooms, config);
    wsServer.start();

    signaling.on("signal", (msg) => {
      if (!wsServer) return;
      if (msg.to) wsServer.relayToPeer(msg.to, msg);
      else if (msg.room) wsServer.broadcastToRoom(msg.room, msg, msg.from);
    });
  }

  // ── stdio MCP ─────────────────────────────────────────
  if (config.signaling.mode === "stdio" || config.signaling.mode === "both") {
    logger.info("ready", {
      mode: config.signaling.mode,
      workers: config.maxWorkers,
    });

    process.stdin.setEncoding("utf-8");
    let buffer = "";

    for await (const chunk of process.stdin) {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          const request = JSON.parse(line);
          await handleMcpRequest(request, handler, config);
        } catch (err) {
          logger.error("json parse error", { error: String(err) });
        }
      }
    }
  } else {
    logger.info("ws-only mode", { port: config.signaling.wsPort });
    await new Promise(() => {});
  }

  await pool.stop();
  wsServer?.stop();
}

async function handleMcpRequest(request: any, handler: McpHandler, config: any): Promise<void> {
  const { jsonrpc, id, method, params } = request;

  // ── Protocol handshake ─────────────────────────────────
  if (method === "initialize") {
    initialized = true;
    writeJson({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
        serverInfo: {
          name: "webrtc-mcp-server",
          version: "0.4.0",
        },
      },
    });
    return;
  }

  if (method === "initialized") {
    logger.debug("client initialized");
    return;
  }

  // ── Tool methods ───────────────────────────────────────
  if (method === "tools/list") {
    writeJson({
      jsonrpc: "2.0",
      id,
      result: { tools: handler.toolDefinitions },
    });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const result = await handler.handleToolCall(name, args ?? {});
    writeJson({ jsonrpc: "2.0", id, result });
    return;
  }

  // ── Ping (legacy / health) ─────────────────────────────
  if (method === "ping" || (jsonrpc === "2.0" && !method)) {
    writeJson({
      jsonrpc: "2.0",
      id,
      result: { pong: true, uptime: process.uptime(), initialized, workers: config.maxWorkers },
    });
    return;
  }

  // ── Error: unknown method ──────────────────────────────
  writeJson({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

main().catch((err) => {
  logger.error("fatal", { error: String(err) });
  process.exit(1);
});
