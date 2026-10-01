import { metrics } from "./metrics.js";

/**
 * Phase-3.2 durability: TTL for orphaned (crash-leaked) streams.
 *
 * First reported use: crash-leaked streams where `removeStream` was missed
 * (process crash between `registerStream` and `removeStream`). The sweep
 * below reaps entries older than `maxAgeMs` that never completed
 * (`emittedChunk === false`) so a single missed removal cannot leak forever.
 *
 * Creation times are kept in a side map so `register`/`remove`/`getStream`
 * semantics (including the shape returned by `getStream`) are unchanged.
 */
export const STREAM_ORPHAN_MAX_AGE_MS = 10 * 60 * 1000; // 10 min default
export const STREAM_SWEEP_INTERVAL_MS = 60 * 1000; // 60s default

const streamCreatedAt = new Map<string, number>();

let streamSweepTimer: ReturnType<typeof setInterval> | null = null;

const activeStreams = new Map<
  string,
  {
    abortController: AbortController;
    accountId: string;
    uiSessionId: string;
    targetResponseId: string;
    headers: Record<string, string>;
    /** True once at least one model chunk reached the client. */
    emittedChunk: boolean;
  }
>();

export function registerStream(
  key: string,
  entry: {
    abortController: AbortController;
    accountId: string;
    uiSessionId: string;
    targetResponseId: string;
    headers: Record<string, string>;
  },
): void {
  const existing = activeStreams.get(key);
  if (existing && existing.abortController !== entry.abortController) {
    existing.abortController.abort();
  }

  activeStreams.set(key, { emittedChunk: false, ...entry });
  streamCreatedAt.set(key, Date.now());
  metrics.gauge("streams.active", activeStreams.size);
}

export function getStream(key: string): ReturnType<typeof activeStreams.get> {
  return activeStreams.get(key);
}

export function getStreamKeysBySessionId(sessionId: string): string[] {
  const keys: string[] = [];
  for (const [key, entry] of activeStreams.entries()) {
    if (entry.uiSessionId === sessionId) {
      keys.push(key);
    }
  }
  return keys;
}

export function getStreamKeyBySessionAndResponse(
  sessionId: string,
  responseId: string,
): string | undefined {
  for (const [key, entry] of activeStreams.entries()) {
    if (
      entry.uiSessionId === sessionId &&
      entry.targetResponseId === responseId
    ) {
      return key;
    }
  }
  return undefined;
}

export function removeStream(key: string): void {
  activeStreams.delete(key);
  streamCreatedAt.delete(key);
  metrics.gauge("streams.active", activeStreams.size);
}

/**
 * Mark a stream as having emitted at least one model chunk to the client.
 * The emit-aware supersede uses this to avoid killing a generation the client
 * has not consumed yet (e.g. a parallel title request racing the main stream).
 */
export function markStreamEmitted(key: string): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.emittedChunk = true;
  }
}

export function updateStreamTargetResponseId(
  key: string,
  targetResponseId: string,
): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.targetResponseId = targetResponseId;
  }
}

export function updateStreamSessionId(key: string, uiSessionId: string): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.uiSessionId = uiSessionId;
  }
}

/**
 * Remove orphaned streams older than `maxAgeMs` that never completed
 * (`emittedChunk === false`). Entries that emitted at least one chunk are
 * treated as active/completed and are kept. Best-effort per entry; returns
 * the number of entries swept.
 */
export function sweepOrphanedStreams(
  maxAgeMs: number = STREAM_ORPHAN_MAX_AGE_MS,
): number {
  const now = Date.now();
  let swept = 0;
  for (const [key, entry] of Array.from(activeStreams.entries())) {
    try {
      const createdAt = streamCreatedAt.get(key);
      // No timestamp (e.g. registered before this phase) — treat as fresh.
      if (createdAt === undefined) continue;
      if (now - createdAt <= maxAgeMs) continue;
      // Completed/active streams (emitted) are kept.
      if (entry.emittedChunk) continue;
      activeStreams.delete(key);
      streamCreatedAt.delete(key);
      swept++;
    } catch {
      /* best-effort per-entry */
    }
  }
  if (swept > 0) {
    try {
      metrics.gauge("streams.active", activeStreams.size);
    } catch {
      /* best-effort */
    }
  }
  return swept;
}

/**
 * Start the periodic orphaned-stream sweep. Idempotent: a second call while
 * running is a no-op. The timer is unref'd so it never keeps the process
 * alive on its own.
 */
export function startStreamSweepTimer(
  intervalMs: number = STREAM_SWEEP_INTERVAL_MS,
): void {
  if (streamSweepTimer) return;
  streamSweepTimer = setInterval(() => {
    try {
      sweepOrphanedStreams();
    } catch {
      /* best-effort */
    }
  }, intervalMs);
  if (
    streamSweepTimer &&
    typeof streamSweepTimer === "object" &&
    "unref" in streamSweepTimer
  ) {
    (streamSweepTimer as unknown as NodeJS.Timeout).unref();
  }
}

/**
 * Stop the periodic sweep. Safe to call when not running (no-op).
 */
export function stopStreamSweepTimer(): void {
  if (streamSweepTimer) {
    clearInterval(streamSweepTimer);
    streamSweepTimer = null;
  }
}
