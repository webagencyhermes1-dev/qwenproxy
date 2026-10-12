import fs from "node:fs";
import path from "node:path";
import { getLogsDir } from "./paths.ts";
import { getRequestId } from "./request-context.ts";
import type { LogEntry } from "./logger.ts";

/**
 * File log sink: durable, readable, self-cleaning.
 *
 * - One file per proxy run: `qwenproxy-<ISO timestamp>-pid<pid>-<seq>.log`,
 *   one redacted JSON object per line (same shape as LOG_FORMAT=json).
 * - Hot path never blocks: lines are buffered in memory and drained to the
 *   open fd on setImmediate (async write).
 * - Size rotation: when the active file would exceed `maxSizeBytes` it is
 *   rolled to `.1` (older segments shift to `.2..N`; the segment beyond
 *   `maxRotatedFiles` is deleted) and a fresh file is opened.
 * - TTL auto-delete: files whose mtime is older than `ttlMs` are unlinked
 *   once at startup (reaper for crashed-run leftovers) and then every 5
 *   minutes by an unref'd interval. The currently active file is protected.
 * - Shutdown: `stopFileLogger()` drains the buffer and closes the fd; it is
 *   called from the single server cleanup funnel. Files stay on disk until
 *   their TTL expires (kept for post-mortem reads).
 */

const FILE_PREFIX = "qwenproxy-";
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Backstop so a stalled disk cannot grow the pending buffer without bound. */
const MAX_PENDING_LINES = 100_000;

export interface FileLoggerOptions {
  /** Directory override (defaults to QWEN_LOG_DIR / ./logs). */
  dir?: string;
  ttlMs?: number;
  maxSizeBytes?: number;
  maxRotatedFiles?: number;
}

interface ResolvedOptions {
  dir: string;
  ttlMs: number;
  maxSizeBytes: number;
  maxRotatedFiles: number;
}

let fileSeq = 0;

class FileLogSink {
  private fd: number | null = null;
  private basePath = "";
  private bytesWritten = 0;
  private buffer: string[] = [];
  private flushScheduled = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: ResolvedOptions) {}

  start(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true });
    pruneExpiredLogFiles(this.opts.dir, this.opts.ttlMs);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.basePath = path.join(
      this.opts.dir,
      `${FILE_PREFIX}${stamp}-pid${process.pid}-${++fileSeq}.log`,
    );
    this.fd = fs.openSync(this.basePath, "a");
    this.sweepTimer = setInterval(() => {
      try {
        pruneExpiredLogFiles(this.opts.dir, this.opts.ttlMs, this.basePath);
      } catch {
        // Sweeping is best-effort; never let it throw into the event loop.
      }
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  get filePath(): string {
    return this.basePath;
  }

  append(line: string): void {
    if (this.closed) return;
    if (this.buffer.length >= MAX_PENDING_LINES) {
      this.buffer.splice(0, this.buffer.length - MAX_PENDING_LINES + 1);
    }
    this.buffer.push(line);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        void this.drain();
      });
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Already gone; the rename below is what matters.
      }
      this.fd = null;
    }
    const base = this.basePath;
    const max = this.opts.maxRotatedFiles;
    try {
      fs.unlinkSync(`${base}.${max}`);
    } catch {
      // Oldest segment may not exist yet.
    }
    for (let i = max - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${base}.${i}`, `${base}.${i + 1}`);
      } catch {
        // Gap in the rotation chain is fine.
      }
    }
    try {
      fs.renameSync(base, `${base}.1`);
    } catch {
      // Nothing to roll; a fresh file is opened anyway.
    }
    this.fd = fs.openSync(base, "a");
    this.bytesWritten = 0;
  }

  private async drain(): Promise<void> {
    this.flushScheduled = false;
    const lines = this.buffer;
    this.buffer = [];
    if (lines.length === 0) return;
    const chunk = lines.join("\n") + "\n";
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    try {
      if (
        this.opts.maxSizeBytes > 0 &&
        this.bytesWritten + chunkBytes > this.opts.maxSizeBytes &&
        this.bytesWritten > 0
      ) {
        this.rotate();
      }
      if (this.fd === null) return;
      fs.writeSync(this.fd, chunk);
      this.bytesWritten += chunkBytes;
    } catch (err) {
      console.warn(
        `[FileLog] write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.drain().catch(() => {});
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Best-effort close.
      }
      this.fd = null;
    }
  }
}

let activeSink: FileLogSink | null = null;

/**
 * Start the file log sink (idempotent). Returns the active log file path, or
 * null when initialization failed (file logging then stays disabled; console
 * output is unaffected).
 */
export function initFileLogger(options: FileLoggerOptions = {}): string | null {
  if (activeSink) return activeSink.filePath;
  const opts: ResolvedOptions = {
    dir: getLogsDir(options.dir),
    ttlMs: options.ttlMs ?? 3_600_000,
    maxSizeBytes: options.maxSizeBytes ?? 10 * 1024 * 1024,
    maxRotatedFiles: options.maxRotatedFiles ?? 5,
  };
  try {
    const sink = new FileLogSink(opts);
    sink.start();
    activeSink = sink;
    return sink.filePath;
  } catch (err) {
    console.warn(
      `[FileLog] disabled — failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Append one already-redacted log entry as a JSON line. No-op when the sink
 * is not active (file logging disabled or never initialized).
 */
export function writeToFileLog(entry: LogEntry): void {
  const sink = activeSink;
  if (!sink) return;
  const requestId = getRequestId();
  const line = JSON.stringify({
    timestamp: entry.timestamp.toISOString(),
    level: entry.level,
    ...(entry.context ? { context: entry.context } : {}),
    ...(requestId ? { requestId } : {}),
    message: entry.message,
    ...(entry.data !== undefined ? { data: entry.data } : {}),
  });
  sink.append(line);
}

export function isFileLogActive(): boolean {
  return activeSink !== null;
}

export function getActiveLogFilePath(): string | null {
  return activeSink?.filePath ?? null;
}

/**
 * Flush the buffer and close the file handle (idempotent). Files remain on
 * disk until their TTL expires. Called from the server cleanup funnel.
 */
export async function stopFileLogger(): Promise<void> {
  const sink = activeSink;
  activeSink = null;
  if (sink) await sink.close();
}

/**
 * Delete `qwenproxy-*` log files in `dir` whose mtime is older than `ttlMs`.
 * `protectPath` (the currently active file) is never deleted. Returns the
 * number of files removed.
 */
export function pruneExpiredLogFiles(
  dir: string,
  ttlMs: number,
  protectPath?: string,
): number {
  if (ttlMs <= 0) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  const protectedName = protectPath ? path.basename(protectPath) : null;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX)) continue;
    if (protectedName && name === protectedName) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > ttlMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // Concurrent deletion or unreadable entry: skip.
    }
  }
  return removed;
}
