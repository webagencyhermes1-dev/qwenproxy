/**
 * Account Pool 2.0 — persistent per-account health.
 *
 * Bounded health score (0–100, starts at 100). Transient failures decrement
 * modestly so a single blip never destroys priority; sustained success
 * recovers gradually. All counters persist in SQLite `account_health` so
 * restarts keep history. Writes are coalesced (dirty-set + debounced flush)
 * to stay cheap with 50–200 accounts.
 */

import { getDatabase } from "./database.ts";
import { metrics } from "./metrics.ts";

export type AccountFailureKind =
  | "rate_limit"
  | "quota"
  | "auth"
  | "network"
  | "waf"
  | "generic";

export interface AccountHealthRecord {
  accountId: string;
  healthScore: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  rateLimitEvents: number;
  quotaEvents: number;
  authFailures: number;
  networkFailures: number;
  wafEvents: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  lastRequestAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  initFailCount: number;
  /** Rolling TTFB samples (last 10) for p50 latency tracking. */
  ttfbSamples: number[];
}

/** Consecutive init failures before the account is considered BROKEN. */
export const BROKEN_INIT_FAIL_THRESHOLD = 3;

/**
 * Prefix of the cooldown reason written by the permanent-auth init path
 * (`isPermanentInitFailure` / `PermanentAuthError` in services/playwright.ts →
 * `AuthPermanentFailure: ...`). It is the persisted evidence of an
 * ACCOUNT-SPECIFIC init failure — the one class that legitimately stays
 * BROKEN instead of being treated as a transient/systemic condition.
 */
export const PERMANENT_INIT_COOLDOWN_PREFIX = "AuthPermanentFailure";

// ─── Systemic vs account-specific init failures ─────────────────────────────
//
// Escalation used to count EVERY init failure, so one systemic cause (an
// occluded composer, a WAF change, an init-deadline storm) poisoned the whole
// pool: `init_fail_count` is persisted, survived restarts, and nothing ever
// cleared it — a transient pool-wide failure was recorded as a permanent
// per-account one. Two rules keep the escalation honest:
//
//   1. MULTI-ACCOUNT STORMS ARE SYSTEMIC. When >= POOL_INIT_STORM_MIN_ACCOUNTS
//      distinct accounts fail init inside POOL_INIT_STORM_WINDOW_MS the cause
//      is the environment, not any single account: the failure still lands in
//      the health ledger (score/counters) but does NOT increment
//      `initFailCount`, the BROKEN escalation counter. Isolated failures still
//      escalate exactly as before (3 in a row → BROKEN).
//   2. PERMANENT AUTH EVIDENCE IS ACCOUNT-SPECIFIC AND STICKY. An account with
//      `auth_failures > 0` or a persisted `AuthPermanentFailure*` cooldown
//      always counts toward escalation (even mid-storm) and never ages out:
//      that is the genuinely broken credential, which `isPermanentInitFailure`
//      already models.
//
// Bounded recovery: an init-failure BROKEN that has been quiet for
// POOL_BROKEN_RECOVERY_AGE_MS stops counting (see isAccountBrokenByHealth) and
// is actively re-armed by runtime/readiness/broken-recovery.ts, so no systemic
// era can strand an account forever. No manual step is required.

function envInt(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

let initStormWindowMsCache: number | null = null;
/** Window in which distinct-account init failures count as one systemic storm. */
export function getInitFailureStormWindowMs(): number {
  if (initStormWindowMsCache === null) {
    initStormWindowMsCache = envInt("POOL_INIT_STORM_WINDOW_MS", 5 * 60_000, 1_000);
  }
  return initStormWindowMsCache;
}

let initStormMinAccountsCache: number | null = null;
/** Distinct accounts failing init inside the window before it is systemic. */
export function getInitFailureStormMinAccounts(): number {
  if (initStormMinAccountsCache === null) {
    initStormMinAccountsCache = envInt("POOL_INIT_STORM_MIN_ACCOUNTS", 3, 1);
  }
  return initStormMinAccountsCache;
}

let brokenRecoveryAgeMsCache: number | null = null;
/**
 * Idle age after which an init-failure BROKEN is re-armed: it stops counting
 * at read time and the reconciliation pass zeroes the escalation counter (the
 * account then gets a fresh, bounded number of warmup attempts).
 */
export function getBrokenRecoveryAgeMs(): number {
  if (brokenRecoveryAgeMsCache === null) {
    brokenRecoveryAgeMsCache = envInt("POOL_BROKEN_RECOVERY_AGE_MS", 60 * 60_000, 0);
  }
  return brokenRecoveryAgeMsCache;
}

/** Health deltas per failure kind (negative) and success (positive). */
const DELTA: Record<AccountFailureKind, number> = {
  rate_limit: -8,
  quota: -15,
  auth: -25,
  network: -6,
  waf: -10,
  generic: -5,
};
const SUCCESS_DELTA = 3;

const cache = new Map<string, AccountHealthRecord>();
const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 2000;

interface RollingEvent {
  timestamp: number;
  isRateLimited: boolean;
}

const ROLLING_WINDOW_SIZE = 20;
const rollingEvents = new Map<string, RollingEvent[]>();

export function recordRollingRequestEvent(accountId: string, isRateLimited: boolean): void {
  let events = rollingEvents.get(accountId);
  if (!events) {
    events = [];
    rollingEvents.set(accountId, events);
  }
  events.push({ timestamp: Date.now(), isRateLimited });
  if (events.length > ROLLING_WINDOW_SIZE) {
    events.splice(0, events.length - ROLLING_WINDOW_SIZE);
  }
}

function defaultRecord(accountId: string): AccountHealthRecord {
  return {
    accountId,
    healthScore: 100,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    rateLimitEvents: 0,
    quotaEvents: 0,
    authFailures: 0,
    networkFailures: 0,
    wafEvents: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    initFailCount: 0,
    ttfbSamples: [],
  };
}

function rowToRecord(
  accountId: string,
  row: Record<string, number | null> | undefined,
): AccountHealthRecord {
  const base = defaultRecord(accountId);
  if (!row) return base;
  const total = Number(row.success_count ?? 0) + Number(row.failure_count ?? 0);
  const totalLatency = Number(row.total_latency_ms ?? 0);
  return {
    accountId,
    healthScore: Math.max(
      0,
      Math.min(100, Number(row.health_score ?? 100)),
    ),
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    rateLimitEvents: Number(row.rate_limit_events ?? 0),
    quotaEvents: Number(row.quota_events ?? 0),
    authFailures: Number(row.auth_failures ?? 0),
    networkFailures: Number(row.network_failures ?? 0),
    wafEvents: Number(row.waf_events ?? 0),
    totalLatencyMs: totalLatency,
    averageLatencyMs: total > 0 ? Math.round(totalLatency / total) : 0,
    lastRequestAt:
      row.last_request_at != null ? Number(row.last_request_at) : null,
    lastSuccessAt:
      row.last_success_at != null ? Number(row.last_success_at) : null,
    lastFailureAt:
      row.last_failure_at != null ? Number(row.last_failure_at) : null,
    initFailCount: Number(row.init_fail_count ?? 0),
    ttfbSamples: [],
  };
}

function loadFromDb(accountId: string): AccountHealthRecord {
  try {
    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM account_health WHERE account_id = ?")
      .get(accountId) as Record<string, number | null> | undefined;
    return rowToRecord(accountId, row);
  } catch {
    return defaultRecord(accountId);
  }
}

/** Read-through cache; never throws. */
export function getAccountHealth(accountId: string): AccountHealthRecord {
  const cached = cache.get(accountId);
  if (cached) return { ...cached };
  const rec = loadFromDb(accountId);
  cache.set(accountId, { ...rec });
  return { ...rec };
}

/** Bulk read for pool views — single SELECT, updates cache. */
export function getAllAccountHealth(
  accountIds?: string[],
): Map<string, AccountHealthRecord> {
  const out = new Map<string, AccountHealthRecord>();
  try {
    const db = getDatabase();
    const rows = (
      accountIds && accountIds.length > 0
        ? db
            .prepare(
              `SELECT * FROM account_health WHERE account_id IN (${accountIds.map(() => "?").join(",")})`,
            )
            .all(...accountIds)
        : db.prepare("SELECT * FROM account_health").all()
    ) as Array<Record<string, number | string | null>>;
    for (const r of rows) {
      const id = String((r as Record<string, unknown>).account_id);
      const rec = rowToRecord(id, r as Record<string, number | null>);
      cache.set(id, { ...rec });
      out.set(id, { ...rec });
    }
  } catch {
    // Fall through to cache/defaults.
  }
  if (accountIds) {
    for (const id of accountIds) {
      if (!out.has(id)) out.set(id, getAccountHealth(id));
    }
  }
  return out;
}

function markDirty(accountId: string): void {
  dirty.add(accountId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushAccountHealth();
    } catch {
      // Persistence is best-effort; cache already served this run.
    }
  }, FLUSH_DEBOUNCE_MS);
  const t = flushTimer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
}

/** Persist all dirty records in one transaction. */
export function flushAccountHealth(): number {
  if (dirty.size === 0) return 0;
  const ids = Array.from(dirty);
  dirty.clear();
  try {
    const db = getDatabase();
    const upsert = db.prepare(`
      INSERT INTO account_health (
        account_id, health_score, success_count, failure_count,
        consecutive_failures, rate_limit_events, quota_events, auth_failures,
        network_failures, waf_events, total_latency_ms,
        last_request_at, last_success_at, last_failure_at,
        init_fail_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id) DO UPDATE SET
        health_score = excluded.health_score,
        success_count = excluded.success_count,
        failure_count = excluded.failure_count,
        consecutive_failures = excluded.consecutive_failures,
        rate_limit_events = excluded.rate_limit_events,
        quota_events = excluded.quota_events,
        auth_failures = excluded.auth_failures,
        network_failures = excluded.network_failures,
        waf_events = excluded.waf_events,
        total_latency_ms = excluded.total_latency_ms,
        last_request_at = excluded.last_request_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        init_fail_count = excluded.init_fail_count,
        updated_at = datetime('now')
    `);
    const tx = db.transaction(() => {
      for (const id of ids) {
        const rec = cache.get(id);
        if (!rec) continue;
        upsert.run(
          id,
          rec.healthScore,
          rec.successCount,
          rec.failureCount,
          rec.consecutiveFailures,
          rec.rateLimitEvents,
          rec.quotaEvents,
          rec.authFailures,
          rec.networkFailures,
          rec.wafEvents,
          rec.totalLatencyMs,
          rec.lastRequestAt,
          rec.lastSuccessAt,
          rec.lastFailureAt,
          rec.initFailCount,
        );
      }
    });
    tx();
    return ids.length;
  } catch {
    // Re-mark dirty so a later flush retries.
    for (const id of ids) dirty.add(id);
    return 0;
  }
}

function touchLatency(
  rec: AccountHealthRecord,
  latencyMs?: number,
): void {
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    rec.totalLatencyMs += Math.round(latencyMs);
  }
  const total = rec.successCount + rec.failureCount;
  rec.averageLatencyMs = total > 0 ? Math.round(rec.totalLatencyMs / total) : 0;
}

/**
 * Record a successful request. Recovers health gradually (+3, capped at 100)
 * and resets the consecutive-failure streak. Never throws.
 */
export function recordAccountSuccess(
  accountId: string,
  latencyMs?: number,
): AccountHealthRecord {
  if (!accountId || accountId === "global") {
    return defaultRecord(accountId || "global");
  }
  const rec = getAccountHealth(accountId);
  rec.healthScore = Math.min(100, rec.healthScore + SUCCESS_DELTA);
  rec.successCount += 1;
  rec.consecutiveFailures = 0;
  recordRollingRequestEvent(accountId, false);
  const now = Date.now();
  rec.lastRequestAt = now;
  rec.lastSuccessAt = now;
  touchLatency(rec, latencyMs);
  cache.set(accountId, { ...rec });
  markDirty(accountId);
  try {
    metrics.increment("pool.requests.success");
  } catch {
    // Metrics are best-effort.
  }
  return { ...rec };
}

/**
 * Record a failed request. Applies a bounded decrement per kind so one
 * transient blip cannot destroy priority. Never throws. Deterministic client
 * errors (validation/content/model) must NOT call this — see call sites.
 */
export function recordAccountFailure(
  accountId: string,
  kind: AccountFailureKind = "generic",
  latencyMs?: number,
): AccountHealthRecord {
  if (!accountId || accountId === "global") {
    return defaultRecord(accountId || "global");
  }
  const rec = getAccountHealth(accountId);
  rec.healthScore = Math.max(0, rec.healthScore + (DELTA[kind] ?? DELTA.generic));
  rec.failureCount += 1;
  rec.consecutiveFailures += 1;
  if (kind === "rate_limit") rec.rateLimitEvents += 1;
  if (kind === "quota") rec.quotaEvents += 1;
  if (kind === "auth") rec.authFailures += 1;
  if (kind === "network") rec.networkFailures += 1;
  if (kind === "waf") rec.wafEvents += 1;
  if (kind === "rate_limit" || kind === "quota") {
    recordRollingRequestEvent(accountId, true);
  }
  const now = Date.now();
  rec.lastRequestAt = now;
  rec.lastFailureAt = now;
  touchLatency(rec, latencyMs);
  cache.set(accountId, { ...rec });
  markDirty(accountId);
  try {
    metrics.increment("pool.requests.failure", 1, { kind });
  } catch {
    // Metrics are best-effort.
  }
  return { ...rec };
}

// ─── Init-failure classification (systemic storm vs single account) ─────────

interface InitFailureEvent {
  accountId: string;
  at: number;
}

/** Chronological ring of recent init failures across the pool (in-memory). */
const initFailureEvents: InitFailureEvent[] = [];
const INIT_FAILURE_EVENT_CAP = 1024;
/** Init failures that were classified systemic (observability only, in-memory). */
let systemicInitFailureCount = 0;
let stormAnnounced = false;

function noteInitFailureEvent(accountId: string, now: number): void {
  initFailureEvents.push({ accountId, at: now });
  if (initFailureEvents.length > INIT_FAILURE_EVENT_CAP) {
    initFailureEvents.splice(0, initFailureEvents.length - INIT_FAILURE_EVENT_CAP);
  }
}

/**
 * True when >= getInitFailureStormMinAccounts() DISTINCT accounts failed init
 * within the storm window — the signature of a pool-wide (systemic) cause
 * such as an init-deadline, WAF or page-occlusion storm, as opposed to one
 * account failing on its own.
 */
function isInitFailureStorm(now: number): boolean {
  const windowMs = getInitFailureStormWindowMs();
  const minAccounts = getInitFailureStormMinAccounts();
  const seen = new Set<string>();
  for (let i = initFailureEvents.length - 1; i >= 0; i--) {
    const event = initFailureEvents[i];
    if (now - event.at > windowMs) break; // events are chronological
    seen.add(event.accountId);
    if (seen.size >= minAccounts) return true;
  }
  return false;
}

/** Distinct accounts with an init failure inside the storm window (diagnostics). */
export function getRecentInitFailureAccounts(now: number = Date.now()): number {
  const windowMs = getInitFailureStormWindowMs();
  const seen = new Set<string>();
  for (let i = initFailureEvents.length - 1; i >= 0; i--) {
    if (now - initFailureEvents[i].at > windowMs) break;
    seen.add(initFailureEvents[i].accountId);
  }
  return seen.size;
}

/** Init failures suppressed as systemic since process start (diagnostics). */
export function getSystemicInitFailureCount(): number {
  return systemicInitFailureCount;
}

function readPersistedCooldownReason(accountId: string): string | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare("SELECT cooldown_reason FROM accounts WHERE id = ?")
      .get(accountId) as { cooldown_reason?: string | null } | undefined;
    return row?.cooldown_reason ?? null;
  } catch {
    return null;
  }
}

/**
 * True when the account carries evidence of an ACCOUNT-SPECIFIC init failure:
 * a permanent-auth rejection recorded in the health ledger (`auth_failures`,
 * written by the `PermanentAuthError` path) or a persisted
 * `AuthPermanentFailure*` cooldown. Such accounts legitimately stay BROKEN and
 * are excluded from auto-recovery.
 *
 * `cooldownReason` lets callers that already hold it (reconciliation over
 * `loadAccounts()`) skip the single-row lookup.
 */
export function hasPermanentInitEvidence(
  accountId: string,
  rec?: AccountHealthRecord,
  cooldownReason?: string | null,
): boolean {
  if (!accountId || accountId === "global") return false;
  const health = rec ?? getAccountHealth(accountId);
  if (health.authFailures > 0) return true;
  const reason =
    cooldownReason !== undefined
      ? cooldownReason
      : readPersistedCooldownReason(accountId);
  return typeof reason === "string" && reason.startsWith(PERMANENT_INIT_COOLDOWN_PREFIX);
}

/**
 * Track repeated Playwright/session init failures (BROKEN at threshold).
 *
 * Systemic storms (>= N distinct accounts failing inside the window) are
 * recorded in the health ledger but do NOT escalate any single account —
 * see the classification note above. A permanent-auth account always counts.
 */
export function noteAccountInitFailure(accountId: string): AccountHealthRecord {
  if (!accountId || accountId === "global") {
    return defaultRecord(accountId || "global");
  }
  const now = Date.now();
  noteInitFailureEvent(accountId, now);
  const stormActive = isInitFailureStorm(now);
  if (stormActive && !stormAnnounced) {
    stormAnnounced = true;
    console.warn(
      `⚠️  [Health] Systemic init-failure storm | accounts=${getRecentInitFailureAccounts(now)} within ${Math.round(getInitFailureStormWindowMs() / 1000)}s | suppressing per-account BROKEN escalation`,
    );
  } else if (!stormActive) {
    stormAnnounced = false;
  }
  const rec = getAccountHealth(accountId);
  const permanent = hasPermanentInitEvidence(accountId, rec);
  if (stormActive && !permanent) {
    systemicInitFailureCount += 1;
  } else {
    rec.initFailCount += 1;
    cache.set(accountId, { ...rec });
    markDirty(accountId);
  }
  return recordAccountFailure(accountId, "generic");
}

/**
 * Clear the BROKEN escalation budget for one account (bounded recovery).
 * The account keeps its health score / failure history — only the init-fail
 * counter that drives BROKEN is reset, so the next era starts from zero.
 */
export function resetInitFailureEscalation(accountId: string): AccountHealthRecord {
  if (!accountId || accountId === "global") {
    return defaultRecord(accountId || "global");
  }
  const rec = getAccountHealth(accountId);
  if (rec.initFailCount !== 0) {
    rec.initFailCount = 0;
    cache.set(accountId, { ...rec });
    markDirty(accountId);
  }
  return { ...rec };
}

/** A successful init/recovery clears the init-failure streak gradually. */
export function noteAccountInitSuccess(accountId: string): AccountHealthRecord {
  if (!accountId || accountId === "global") {
    return defaultRecord(accountId || "global");
  }
  const rec = getAccountHealth(accountId);
  if (rec.initFailCount !== 0) {
    rec.initFailCount = 0;
    cache.set(accountId, { ...rec });
    markDirty(accountId);
  }
  return recordAccountSuccess(accountId);
}

/**
 * True when repeated init failures mark the account BROKEN.
 *
 * Escalation holds only while it is actionable:
 *  - permanent-auth evidence (auth ledger / `AuthPermanentFailure*` cooldown)
 *    is account-specific → sticky, the account legitimately stays BROKEN;
 *  - otherwise the escalation expires POOL_BROKEN_RECOVERY_AGE_MS after the
 *    last failure, so failures produced by a since-fixed systemic cause cannot
 *    strand an account forever (the reconciliation pass then zeroes the
 *    counter and re-arms the account with a fresh bounded attempt budget).
 */
export function isAccountBrokenByHealth(accountId: string): boolean {
  const rec = getAccountHealth(accountId);
  if (rec.initFailCount < BROKEN_INIT_FAIL_THRESHOLD) return false;
  if (rec.authFailures > 0) return true;
  const now = Date.now();
  const lastFailureAt = rec.lastFailureAt;
  if (lastFailureAt == null) return true; // counter without a timestamp: let recovery inspect it
  if (now - lastFailureAt <= getBrokenRecoveryAgeMs()) return true;
  return hasPermanentInitEvidence(accountId, rec);
}

/** Aggregate pool success/failure/latency for observability. */
export function getPoolHealthAggregates(
  accountIds: string[],
): {
  totalRequests: number;
  totalSuccess: number;
  totalFailure: number;
  successRate: number;
  failureRate: number;
  averageLatencyMs: number;
} {
  const all = getAllAccountHealth(accountIds);
  let success = 0;
  let failure = 0;
  let latencySum = 0;
  let latencyCount = 0;
  for (const rec of all.values()) {
    success += rec.successCount;
    failure += rec.failureCount;
    latencySum += rec.totalLatencyMs;
    latencyCount += rec.successCount + rec.failureCount;
  }
  const total = success + failure;
  return {
    totalRequests: total,
    totalSuccess: success,
    totalFailure: failure,
    successRate: total > 0 ? success / total : 1,
    failureRate: total > 0 ? failure / total : 0,
    averageLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
  };
}

/** Test isolation: clear cache + pending writes (flush first on best effort). */
export function resetAccountHealthForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  cache.clear();
  dirty.clear();
  rollingEvents.clear();
  initFailureEvents.length = 0;
  systemicInitFailureCount = 0;
  stormAnnounced = false;
}

// ─── TTFB Tracking (Cycle 2) ─────────────────────────────────────────────────

const MAX_TTFB_SAMPLES = 10;

/**
 * Record a time-to-first-byte sample for an account.
 * Keeps a rolling window of the last 10 samples for p50 computation.
 */
export function recordAccountTtfb(accountId: string, ttfbMs: number): void {
  if (!accountId || accountId === "global") return;
  if (!Number.isFinite(ttfbMs) || ttfbMs < 0) return;
  const rec = getAccountHealth(accountId);
  rec.ttfbSamples.push(Math.round(ttfbMs));
  if (rec.ttfbSamples.length > MAX_TTFB_SAMPLES) {
    rec.ttfbSamples.shift();
  }
  cache.set(accountId, { ...rec });
  markDirty(accountId);
}

/**
 * Compute the p50 (median) TTFB from the rolling sample window.
 * Returns 0 when no samples exist.
 */
export function getP50Ttfb(accountId: string): number {
  const rec = getAccountHealth(accountId);
  if (rec.ttfbSamples.length === 0) return 0;
  const sorted = [...rec.ttfbSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export function getRecent429Rate(accountId: string): number {
  const events = rollingEvents.get(accountId);
  if (!events || events.length === 0) return 0;
  const now = Date.now();
  if (now - events[events.length - 1].timestamp > RATE_LIMIT_WINDOW_MS) {
    return 0;
  }
  const rateLimited = events.filter((e) => e.isRateLimited).length;
  return rateLimited / events.length;
}

/**
 * TTFB factor for scheduler ranking:
 * - 1.0 when p50 < 5s (healthy)
 * - 0.8 when p50 < 15s (degraded)
 * - 0.5 when p50 >= 30s (severely degraded)
 * - Linear interpolation between thresholds
 */
export function getTtfbFactor(accountId: string): number {
  const p50 = getP50Ttfb(accountId);
  if (p50 <= 0) return 1.0;
  if (p50 < 5_000) return 1.0;
  if (p50 < 15_000) return 0.8;
  if (p50 < 30_000) return 0.6;
  return 0.5;
}
