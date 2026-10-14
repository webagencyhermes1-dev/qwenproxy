import { getDatabase } from "./database.ts";

export interface UsageTotals {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

export interface DailyUsage {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadUsageTotals(): UsageTotals {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT total_requests, total_prompt_tokens, total_completion_tokens, total_tokens FROM usage_totals WHERE id = 1",
      )
      .get() as Record<string, number> | undefined;
    if (!row) return { totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 };
    return {
      totalRequests: row.total_requests ?? 0,
      totalPromptTokens: row.total_prompt_tokens ?? 0,
      totalCompletionTokens: row.total_completion_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
    };
  } catch {
    return { totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 };
  }
}

/**
 * Coalesced write buffer.
 *
 * Writing both rows synchronously per request put two blocking SQLite
 * statements on the request hot path, which is invisible at a trickle and a
 * measurable event-loop stall at sustained throughput. Requests now only add
 * to this in-memory delta (a few integer adds) and one timer flushes the
 * accumulated total. The SUM is identical — batching changes WHEN the write
 * happens, never WHAT is recorded.
 */
interface PendingDelta {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const pending: PendingDelta = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/** Guard against unbounded growth if the database is permanently unwritable. */
const MAX_PENDING = 1_000_000_000;

const FLUSH_INTERVAL_MS = 1_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushScheduled = false;
    flushUsagePersist();
  }, FLUSH_INTERVAL_MS);
  // Never hold the process open just for accounting.
  flushTimer.unref?.();
}

/**
 * Persist everything buffered so far in exactly two statements. Safe to call
 * at any time; a no-op when there is nothing pending.
 *
 * On write failure the delta is KEPT so the next flush retries it (both
 * statements are additive, so retrying the same delta cannot double-count).
 */
export function flushUsagePersist(): boolean {
  if (
    pending.requests === 0 &&
    pending.promptTokens === 0 &&
    pending.completionTokens === 0 &&
    pending.totalTokens === 0
  ) {
    return true;
  }
  try {
    const db = getDatabase();
    const apply = db.transaction((delta: PendingDelta) => {
      db.prepare(
        "UPDATE usage_totals SET \
           total_requests = total_requests + @requests, \
           total_prompt_tokens = total_prompt_tokens + @promptTokens, \
           total_completion_tokens = total_completion_tokens + @completionTokens, \
           total_tokens = total_tokens + @totalTokens, \
           updated_at = datetime('now') \
         WHERE id = 1",
      ).run(delta);
      db.prepare(
        "INSERT INTO usage_daily (day, requests, prompt_tokens, completion_tokens, total_tokens) \
         VALUES (@day, @requests, @promptTokens, @completionTokens, @totalTokens) \
         ON CONFLICT(day) DO UPDATE SET \
           requests = requests + @requests, \
           prompt_tokens = prompt_tokens + @promptTokens, \
           completion_tokens = completion_tokens + @completionTokens, \
           total_tokens = total_tokens + @totalTokens",
      ).run({ ...delta, day: todayKey() });
    });
    apply(pending);
    pending.requests = 0;
    pending.promptTokens = 0;
    pending.completionTokens = 0;
    pending.totalTokens = 0;
    return true;
  } catch {
    // Best-effort: keep the delta for the next flush. In-memory totals are
    // unaffected either way, so the proxy never blocks on the database.
    return false;
  }
}

/**
 * Accumulate one request's usage. Cheap by design: four integer adds on the
 * caller's hot path, no I/O.
 */
export function recordUsagePersist(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): void {
  if (pending.requests >= MAX_PENDING) return;
  pending.requests += 1;
  pending.promptTokens += promptTokens;
  pending.completionTokens += completionTokens;
  pending.totalTokens += totalTokens;
  scheduleFlush();
}

/** Buffered-but-not-yet-written usage, for diagnostics. */
export function getPendingUsage(): PendingDelta {
  return { ...pending };
}

/** Stop the flush timer (tests / shutdown). Does NOT discard the buffer. */
export function stopUsageFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushScheduled = false;
}

// Last-chance flush. better-sqlite3 writes are synchronous, so this is safe
// inside an 'exit' handler (async work would not run there). Registered once at
// import; harmless in tests.
process.once("exit", () => {
  stopUsageFlushTimer();
  flushUsagePersist();
});

export function getDailyUsage(days: number = 30): DailyUsage[] {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        "SELECT day, requests, prompt_tokens, completion_tokens, total_tokens FROM usage_daily ORDER BY day DESC LIMIT ?",
      )
      .all(days) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      day: String(r.day),
      requests: Number(r.requests ?? 0),
      promptTokens: Number(r.prompt_tokens ?? 0),
      completionTokens: Number(r.completion_tokens ?? 0),
      totalTokens: Number(r.total_tokens ?? 0),
    }));
  } catch {
    return [];
  }
}

export function getTodayUsage(): DailyUsage {
  const today = todayKey();
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT day, requests, prompt_tokens, completion_tokens, total_tokens FROM usage_daily WHERE day = ?",
      )
      .get(today) as Record<string, number | string> | undefined;
    if (!row) {
      return { day: today, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }
    return {
      day: today,
      requests: Number(row.requests ?? 0),
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
    };
  } catch {
    return { day: today, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}