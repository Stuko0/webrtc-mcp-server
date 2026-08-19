#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { SignalingServer } from "./signaling/server.js";
import { WsSignalingServer } from "./signaling/ws-server.js";
import { RoomManager } from "./signaling/room.js";
import { McpHandler } from "./mcp-handler.js";
import { WorkerPool } from "./workers/pool.js";
import { WebRTCConnectionManager } from "./webrtc/manager.js";
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

  // ── WebRTC real (hilo principal) ────────────────────────
  // @roamhq/wrtc no es thread-safe: las RTCPeerConnection viven aquí, no en workers.
  const webrtc = new WebRTCConnectionManager(config.iceServers as any, {
    onMessage: (peerId, msg) => handler.onInboundMessage({ from: peerId, data: msg }),
    onIceCandidate: (peerId, candidate) => {
      if (wsServer) {
        wsServer.relayToPeer(peerId, { type: "ice_candidate", from: "host", to: peerId, candidate } as any);
      }
    },
    onStateChange: (peerId, state) => logger.debug("webrtc peer state", { peerId, state }),
  });
  handler.setWebRTCManager(webrtc);

  // ── Worker Pool (no bloqueante) ────────────────────────
  const pool = new WorkerPool(config);
  pool.start((workerId, msg) => {
    switch (msg.type) {
      case "connected":
        logger.info("peer connected", { peerId: msg.peerId, workerId });
        break;
      case "error":
        logger.error("worker error", { peerId: msg.peerId, error: msg.error });
        break;
    }
  }).catch((err) => {
    logger.error("pool start error", { error: String(err) });
  });
  handler.setPool(pool);

  // ── WebSocket signaling ───────────────────────────────
  if (config.signaling.mode === "ws" || config.signaling.mode === "both") {
    wsServer = new WsSignalingServer(rooms, config);
    wsServer.start();
    handler.setWsServer(wsServer);
    // Mensajes dirigidos al cliente MCP (B → A) van al inbox del handler
    wsServer.setUndeliveredHandler((msg) => handler.onInboundMessage(msg));

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

    const stdioLoop = (async () => {
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
      logger.info("stdio EOF — stdin closed");
    })();

    // En modo both/ws el proceso vive por el WS signaling, no por stdin.
    if (config.signaling.mode === "both") {
      stdioLoop.catch(() => {});
      await new Promise(() => {}); // esperar forever (WS server activo)
    } else {
      await stdioLoop; // stdio puro: vivir mientras el cliente MCP hable
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
          version: "0.5.0",
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
