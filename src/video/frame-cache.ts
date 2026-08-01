import type { StreamFrame } from "./types.js";

export class FrameCache {
  private buffers = new Map<string, StreamFrame[]>();
  private maxSize: number;

  constructor(maxSize = 5) {
    this.maxSize = maxSize;
  }

  /** Agregar un frame al ring buffer. */
  push(frame: StreamFrame): void {
    let buf = this.buffers.get(frame.streamId);
    if (!buf) {
      buf = [];
      this.buffers.set(frame.streamId, buf);
    }
    buf.push(frame);
    if (buf.length > this.maxSize) {
      buf.shift(); // descarta el más viejo
    }
  }

  /** Obtener el último frame de un stream. */
  getLatest(streamId: string): StreamFrame | null {
    const buf = this.buffers.get(streamId);
    return buf && buf.length > 0 ? buf[buf.length - 1] : null;
  }

  /** Obtener todos los frames del ring buffer (para thumbnails). */
  getAll(streamId: string): StreamFrame[] {
    return this.buffers.get(streamId) ?? [];
  }

  /** Limpiar frames de un stream. */
  clear(streamId: string): void {
    this.buffers.delete(streamId);
  }

  /** Tamaño actual del buffer para un stream. */
  size(streamId: string): number {
    return this.buffers.get(streamId)?.length ?? 0;
  }
}
