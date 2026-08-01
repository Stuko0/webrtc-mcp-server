#!/usr/bin/env node
/**
 * agent-worker.mjs — Convierte a OpenCode (o cualquier CLI) en un peer del WebRTC hub.
 *
 * Flujo:
 *   hub (Lydia, modo both) ──WS──► worker (este script)
 *   - Recibe {type:"task", data:{id, spec, projectPath}}  → ejecuta `opencode run "<spec>"` en projectPath
 *   - Responde {type:"command", to: <from>, command:"task_result", data:{taskId, status, output}}
 *   - Al recibir {type:"command", command:"status"} → responde con el estado local de sus tareas
 *
 * Uso:
 *   node scripts/agent-worker.mjs --peer-id opencode --room team \
 *        --cmd 'opencode run' --workdir ~/proj-x
 *
 * Requiere: `npm i ws` (o correr desde el dir del server que ya lo tiene).
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:8765";
const ROOM = process.env.ROOM ?? "team";
const PEER_ID = process.env.PEER_ID ?? "opencode-worker";
const CMD = process.env.WORKER_CMD ?? "opencode run";
const WORKDIR = process.env.WORKER_WORKDIR ?? process.cwd();

// Tareas locales: taskId → {spec, status, output, pid, at}
const tasks = new Map();

function log(...a) { console.log(`[${PEER_ID}]`, ...a); }

// Reconexión con backoff si el hub aún no está listo
let activeWs = null;
function connect(retries = 10, delay = 1500) {
  const ws = new WebSocket(WS_URL);
  activeWs = ws;
  let settled = false;

  ws.on("open", () => {
    settled = true;
    ws.send(JSON.stringify({ type: "join", peerId: PEER_ID, room: ROOM, label: `${PEER_ID} (${CMD})` }));
    log(`conectado a ${WS_URL} room "${ROOM}"`);
    attach(ws);
  });

  ws.on("error", (e) => {
    if (settled) { console.error(`[${PEER_ID}] error:`, e.message); return; }
    if (retries <= 0) { console.error(`[${PEER_ID}] no se pudo conectar a ${WS_URL}`); process.exit(1); }
    log(`hub no listo (${e.message}), reintento en ${delay}ms (${retries} restantes)`);
    setTimeout(() => connect(retries - 1, Math.min(delay * 1.5, 8000)), delay);
  });

  ws.on("close", () => { if (settled) { log("conexión cerrada"); process.exit(0); } });
}

function attach(ws) {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "room_peers") {
      log(`room peers: ${msg.peers.join(", ") || "(solo yo)"}`);
    } else if (msg.type === "task" || (msg.type === "command" && msg.command === "task")) {
      const data = msg.data ?? msg;
      const taskId = data.id ?? `T-${Date.now()}`;
      const spec = data.spec ?? data.task ?? String(data);
      const projectPath = data.projectPath ?? WORKDIR;
      log(`📥 TAREA ${taskId} de ${msg.from}: ${spec.slice(0, 80)}`);
      runTask(taskId, spec, projectPath, msg.from);
    } else if (msg.type === "command" && msg.command === "status") {
      const summary = Array.from(tasks.values()).map((t) => ({ taskId: t.id, status: t.status, spec: t.spec.slice(0, 60) }));
      ws.send(JSON.stringify({ type: "command", to: msg.from, command: "status_result", data: { peerId: PEER_ID, tasks: summary } }));
      log(`📊 status consultado: ${summary.length} tareas`);
    } else if (msg.type === "command") {
      log(`comando desconocido de ${msg.from}:`, msg.command);
    }
  });

  // Heartbeat
  setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 15000);
}

connect();
log(`worker listo. comando: ${CMD} | workdir: ${resolve(WORKDIR)} | reconexión automática ON`);

function runTask(taskId, spec, projectPath, from) {
  const record = { id: taskId, spec, status: "in_progress", output: "", pid: null, at: Date.now() };
  tasks.set(taskId, record);
  log(`▶ ejecutando en ${projectPath}: ${CMD} "${spec.slice(0, 60)}…"`);

  const child = spawn(CMD, [spec], {
    cwd: resolve(projectPath),
    shell: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  record.pid = child.pid;

  child.stdout.on("data", (d) => { record.output += d.toString(); });
  child.stderr.on("data", (d) => { record.output += d.toString(); });

  child.on("error", (err) => {
    record.status = "failed";
    record.output = `spawn error: ${err.message}`;
    report(taskId, record, from);
  });

  child.on("close", (code) => {
    record.status = code === 0 ? "done" : "failed";
    record.output = record.output.slice(-4000);
    log(`✅ ${taskId} → ${record.status} (exit ${code})`);
    report(taskId, record, from);
  });
}

function report(taskId, record, from) {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
    log(`⚠ no se pudo reportar ${taskId}: WS no conectado`);
    return;
  }
  activeWs.send(JSON.stringify({
    type: "command",
    to: from ?? "host",
    command: "task_result",
    data: { taskId, status: record.status, output: record.output.slice(0, 2000), at: Date.now() },
  }));
}
