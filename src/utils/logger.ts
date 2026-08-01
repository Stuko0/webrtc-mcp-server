/**
 * Logger estructurado con niveles.
 */
const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;

export function createLogger(namespace: string, level: Level = "info") {
  const threshold = levels[level];

  function log(lvl: Level, msg: string, meta?: Record<string, unknown>) {
    if (levels[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const metaStr = meta ? " " + JSON.stringify(meta) : "";
    const line = `[${ts}] [${lvl.toUpperCase()}] [${namespace}] ${msg}${metaStr}`;
    if (lvl === "error") console.error(line);
    else console.warn(line);
  }

  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  };
}
