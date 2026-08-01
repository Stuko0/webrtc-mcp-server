/**
 * Worker Pool — spawns N Worker Threads, distribuye peers round-robin.
 *
 * Cada worker corre su propio event loop con sus propias RTCPeerConnections.
 * El pool maneja failover: si un worker muere, re-asigna sus peers.
 */
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../types.js";
import { createLogger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createLogger("worker-pool");

export interface WorkerMessage {
  type: string;
  peerId?: string;
  [key: string]: unknown;
}

type MessageHandler = (workerId: number, msg: WorkerMessage) => void;

export class WorkerPool {
  private workers: Worker[] = [];
  private workerReady: boolean[] = [];
  private assignments = new Map<string, number>(); // peerId → workerId
  private peerCounts: number[] = [];
  private messageHandler: MessageHandler | null = null;
  private config: ServerConfig;
  private _ready = false;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  get ready(): boolean { return this._ready; }

  /** Iniciar el pool: spawn N workers. */
  async start(handler: MessageHandler): Promise<void> {
    this.messageHandler = handler;
    const count = Math.min(this.config.maxWorkers, cpus().length);
    this.peerCounts = new Array(count).fill(0);
    this.workerReady = new Array(count).fill(false);

    for (let i = 0; i < count; i++) {
      await this._spawnWorker(i);
    }

    // Esperar a que todos los workers estén listos
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.workerReady.every(Boolean)) {
          clearInterval(check);
          this._ready = true;
          resolve();
        }
      }, 50);
    });

    logger.info("pool ready", { workers: count, capacity: count * this.config.limits.maxPeersPerWorker });
  }

  /** Detener todos los workers. */
  async stop(): Promise<void> {
    for (const w of this.workers) {
      w.postMessage({ type: "shutdown" });
    }
    for (const w of this.workers) {
      await w.terminate();
    }
    this.workers = [];
    this.assignments.clear();
    this._ready = false;
    logger.info("pool stopped");
  }

  /** Enviar mensaje al worker que tiene asignado un peer. */
  sendToPeer(peerId: string, msg: WorkerMessage): boolean {
    const wid = this.assignments.get(peerId);
    if (wid == null) return false;
    return this.sendToWorker(wid, msg);
  }

  /** Enviar mensaje a un worker específico. */
  sendToWorker(workerId: number, msg: WorkerMessage): boolean {
    const worker = this.workers[workerId];
    if (!worker) return false;
    worker.postMessage(msg);
    return true;
  }

  /** Asignar un peer al worker con menos carga. Envía el mensaje automáticamente. */
  assign(peerId: string, msg: WorkerMessage): number {
    const minIdx = this.peerCounts.indexOf(Math.min(...this.peerCounts));
    this.peerCounts[minIdx]++;
    this.assignments.set(peerId, minIdx);
    this.workers[minIdx].postMessage(msg);
    return minIdx;
  }

  /** Liberar un peer de su worker. */
  release(peerId: string): void {
    const wid = this.assignments.get(peerId);
    if (wid != null) {
      this.peerCounts[wid] = Math.max(0, this.peerCounts[wid] - 1);
      this.assignments.delete(peerId);
      this.sendToWorker(wid, { type: "disconnect", peerId });
    }
  }

  /** Carga de cada worker. */
  get load(): number[] {
    return [...this.peerCounts];
  }

  get totalPeers(): number {
    return this.assignments.size;
  }

  get totalWorkers(): number {
    return this.workers.length;
  }

  // ─── Privado ────────────────────────────────────────────────

  private _spawnWorker(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, "worker-instance.js");
      const worker = new Worker(workerPath, {
        workerData: { workerId: id },
      });

      worker.on("message", (msg: WorkerMessage) => {
        if (msg.type === "ready") {
          this.workerReady[id] = true;
          resolve();
        }
        this.messageHandler?.(id, msg);
      });

      worker.on("error", (err) => {
        logger.error("worker error", { workerId: id, error: err.message });
      });

      worker.on("exit", (code) => {
        logger.warn("worker exited", { workerId: id, code });
        this.workerReady[id] = false;
        // Re-asignar peers de este worker
        const orphaned: string[] = [];
        for (const [peerId, wid] of Array.from(this.assignments)) {
          if (wid === id) orphaned.push(peerId);
        }
        for (const peerId of orphaned) {
          this.assignments.delete(peerId);
          this.peerCounts[id] = Math.max(0, this.peerCounts[id] - 1);
        }
        // Re-spawn (solo si no fue terminado intencionalmente)
        this._spawnWorker(id);
      });

      this.workers[id] = worker;
    });
  }
}
