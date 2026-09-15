import {
  QwenAccount,
  isAccountDisabledRecord,
  loadAccounts,
  updateAccountCooldown,
} from "./accounts.ts";
import { getAccountsByPriority } from "./account-priority.ts";
import { formatCooldownUntil } from "./logger.ts";
import { config } from "./config.ts";
import { metrics } from "./metrics.ts";
import {
  getAccountConcurrencySnapshot,
  hasActiveAccountLease,
  isAccountBusy,
  isAccountTemporarilyBusy,
} from "./account-concurrency.ts";
import {
  getAccountHealth,
  getAllAccountHealth,
  getPoolHealthAggregates,
} from "./account-health.ts";
import {
  deriveAccountState,
  isAccountEffectivelyBroken,
  isAccountFlaggedAuthError,
  isAccountFlaggedSessionExpired,
  type AccountState,
} from "./account-state.ts";
import {
  pickSchedulerCandidate,
  rankSchedulerCandidates,
  type SchedulerCandidate,
} from "./account-scheduler.ts";

let currentIndex = 0;

interface CooldownEntry {
  until: number;
  reason: string;
}

const cooldowns = new Map<string, CooldownEntry>();

/**
 * Milliseconds until the next UTC midnight plus a safety margin. The Qwen
 * daily quota resets at 00:00 UTC, so this is the correct "when is this
 * account usable again" for a quota exhaust — regardless of the upstream
 * "Wait about N hour(s)" hint (accurate mid-day, but rounds to ~24h near
 * midnight when the real reset is minutes away).
 */
export function computeQuotaCooldownMs(
  nowMs: number,
  marginMs = 5 * 60 * 1000,
): number {
  const nextMidnight = new Date(nowMs);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const targetMs = nextMidnight.getTime() - nowMs + marginMs;
  // A daily quota cooldown must never exceed 24h (cap to 24h - 1m so it never spills over
  // during the first marginMs window after 00:00 UTC).
  const maxCooldownMs = 24 * 60 * 60 * 1000 - 60_000;
  return Math.min(maxCooldownMs, Math.max(60_000, targetMs));
}

// The long-ago 24h blind fallback was the source of "treated available accounts
// as unavailable": when no explicit duration was given (e.g. a quota exhaust
// without the wait hint) the account was parked for a full day even though the
// Qwen daily quota resets at the next UTC midnight. Fall back to the same
// midnight-based behavior instead.
function defaultCooldownDurationMs(): number {
  return computeQuotaCooldownMs(Date.now());
}

export function markAccountRateLimited(
  accountId: string,
  cooldownMs?: number,
  reason?: string,
  options: { silent?: boolean } = {},
): void {
  const duration = cooldownMs ?? defaultCooldownDurationMs();
  const until = Date.now() + duration;
  const cooldownReason = reason ?? "RateLimited";

  cooldowns.set(accountId, {
    until,
    reason: cooldownReason,
  });

  // Persist to database
  if (accountId !== "global") {
    try {
      updateAccountCooldown(accountId, until, cooldownReason);
    } catch (err) {
      console.error(
        `❌ [AccountManager] Failed to save cooldown to DB for ${accountId}:`,
        (err as Error).message,
      );
    }
  }

  if (!options.silent) {
    console.log(
      `⏱️  [AccountManager] Cooldown set | ${accountId} | reason=${cooldownReason} | ${Math.round(duration / 1000)}s | until=${formatCooldownUntil(new Date(until))}`,
    );
  }

  // An account just left the active pool: check whether we need to warm a
  // replacement so the ready-account floor is maintained.
  if (duration > 60_000) {
    void import("./readiness-guard.ts")
      .then((m) => m.triggerReadinessCheck())
      .catch(() => {});
  }
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId);
  if (accountId !== "global") {
    try {
      updateAccountCooldown(accountId, 0, null);
    } catch (err) {
      console.error(
        `❌ [AccountManager] Failed to clear cooldown in DB for ${accountId}:`,
        (err as Error).message,
      );
    }
  }
}

export function clearAllAccountCooldowns(): number {
  const accounts = loadAccounts();
  let count = 0;
  for (const account of accounts) {
    if (cooldowns.has(account.id) || (account.cooldown_until && account.cooldown_until > 0)) {
      clearAccountCooldown(account.id);
      count++;
    }
  }
  cooldowns.delete("global");
  return count;
}

export function getAccountCooldownInfo(
  accountId: string,
): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(accountId);
  if (!entry) return null;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(accountId);
    if (accountId !== "global") {
      try {
        updateAccountCooldown(accountId, 0, null);
      } catch (err) {
        console.error(
          `❌ [AccountManager] Failed to clear expired cooldown in DB:`,
          (err as Error).message,
        );
      }
    }
    return null;
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason };
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null;
}

// ─── Headers-ready gate (mirrors upstream `markAccountReady`) ───────────────
// Accounts whose anti-bot headers were successfully captured are "ready". The
// rotation pickers below skip not-ready accounts whenever at least one account
// IS ready, so a request never lands on a lane that is still warming up or
// whose context just died (Playwright page unavailable → 300s init cooldown).
// The gate degrades to "all accounts pass" when NO account is ready (startup
// warmup / freshly-restored headers) so a single-account or cold pool stays
// lossless — exactly the upstream `anyReady` rule.
const headersReadyAccounts = new Set<string>();

export function markAccountHeadersReady(accountId: string): void {
  if (!accountId || accountId === "global") return;
  headersReadyAccounts.add(accountId);
}

export function unmarkAccountHeadersReady(accountId: string): void {
  if (!accountId) return;
  headersReadyAccounts.delete(accountId);
}

export function isAccountHeadersReady(accountId: string): boolean {
  return headersReadyAccounts.has(accountId);
}

export function getHeadersReadyAccountIds(): string[] {
  return Array.from(headersReadyAccounts);
}

function anyUsableAccountHeadersReady(
  accounts: QwenAccount[],
  triedSet?: Set<string>,
): boolean {
  return accounts.some(
    (a) =>
      (!triedSet || !triedSet.has(a.id)) &&
      !isAccountOnCooldown(a.id) &&
      isAccountHeadersReady(a.id),
  );
}

function passesHeadersReadyGate(
  accountId: string,
  anyReady: boolean,
): boolean {
  return !anyReady || isAccountHeadersReady(accountId);
}

export function syncCooldownsFromDb(accounts: QwenAccount[]): void {
  const now = Date.now();
  for (const account of accounts) {
    if (account.cooldown_until && account.cooldown_until > now) {
      if (!cooldowns.has(account.id)) {
        cooldowns.set(account.id, {
          until: account.cooldown_until,
          reason: account.cooldown_reason || "RateLimited",
        });
      }
    } else {
      if (cooldowns.has(account.id)) {
        cooldowns.delete(account.id);
      }
    }
  }
}

/**
 * Build enriched scheduler candidates from existing truth. All inputs are
 * in-memory (cooldown map, ready set, concurrency snapshot, health cache,
 * priority order) — no browser or per-account DB reads per request.
 */
export function buildSchedulerCandidates(
  accounts: QwenAccount[],
): SchedulerCandidate[] {
  const prioritized = getAccountsByPriority(accounts);
  const priorityIndex = new Map<string, number>();
  prioritized.forEach((a, i) => {
    if (!priorityIndex.has(a.id)) priorityIndex.set(a.id, i);
  });
  const snapshot = new Map(
    getAccountConcurrencySnapshot().map((s) => [s.accountId, s]),
  );
  const maxStreams = Math.max(
    1,
    config.concurrency.maxStreamsPerAccount || 1,
  );
  const healthById = getAllAccountHealth(accounts.map((a) => a.id));

  return accounts.map((account) => {
    const slot = snapshot.get(account.id);
    const activeStreams = slot?.active ?? 0;
    const queuedRequests = slot?.waiting ?? 0;
    const limit = slot?.limit ?? maxStreams;
    const saturated =
      isAccountBusy(account.id) || isAccountTemporarilyBusy(account.id);
    return {
      account,
      priorityIndex: priorityIndex.get(account.id) ?? Number.MAX_SAFE_INTEGER,
      disabled: isAccountDisabledRecord(account),
      broken: isAccountEffectivelyBroken(account.id),
      authError: isAccountFlaggedAuthError(account.id),
      onCooldown: isAccountOnCooldown(account.id),
      headersReady: isAccountHeadersReady(account.id),
      initialized: isAccountHeadersReady(account.id),
      saturated,
      active: hasActiveAccountLease(account.id),
      activeStreams,
      queuedRequests,
      maxStreams: limit,
      health:
        healthById.get(account.id) ?? getAccountHealth(account.id),
    };
  });
}

function pickFromCandidates(
  candidates: SchedulerCandidate[],
  triedSet?: Set<string>,
): QwenAccount | null {
  const ranked = rankSchedulerCandidates(candidates, {
    triedAccountIds: triedSet,
    allowSaturatedFallback: true,
  });
  if (ranked.length === 0) return null;
  const span = Math.max(1, candidates.length);
  const picked =
    pickSchedulerCandidate(ranked, currentIndex, span) ?? ranked[0];
  // Advance the cursor in priority space (historic semantics: the next pick
  // scans forward from the account after the one just returned).
  currentIndex = (picked.priorityIndex + 1) % span;
  return picked.account;
}

function shortestCooldownFallback(
  accounts: QwenAccount[],
  triedSet?: Set<string>,
): QwenAccount | null {
  let best: QwenAccount | null = null;
  let bestRemaining = Infinity;
  for (const account of accounts) {
    if (triedSet?.has(account.id)) continue;
    const info = getAccountCooldownInfo(account.id);
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs;
      best = account;
    }
  }
  return best;
}

export function getNextAccount(): QwenAccount | null {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    return null;
  }

  syncCooldownsFromDb(accounts);

  const candidates = buildSchedulerCandidates(accounts);
  const picked = pickFromCandidates(candidates);
  if (picked) return picked;

  // All eligible accounts excluded (cooldown/disabled/broken/auth) — return
  // the one with the shortest remaining cooldown so callers can report wait.
  return shortestCooldownFallback(getAccountsByPriority(accounts));
}

export function getNextAvailableAccount(
  triedAccountIds?: Set<string> | string,
): QwenAccount | null {
  const accounts = loadAccounts();
  if (accounts.length === 0) return null;

  syncCooldownsFromDb(accounts);

  let triedSet: Set<string>;
  if (triedAccountIds instanceof Set) {
    triedSet = triedAccountIds;
  } else {
    triedSet = new Set(triedAccountIds ? [triedAccountIds] : []);
  }

  const candidates = buildSchedulerCandidates(accounts);
  const picked = pickFromCandidates(candidates, triedSet);
  if (picked) return picked;

  // 2. If all untried accounts are on cooldown, return the untried one with the shortest remaining cooldown
  return shortestCooldownFallback(getAccountsByPriority(accounts), triedSet);
}

/** Derive the display lifecycle state for one account (no I/O beyond caches). */
export function getAccountStateSnapshot(accountId: string): AccountState {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  const candidates = account ? buildSchedulerCandidates([account]) : [];
  const c = candidates[0];
  if (!c) return "WARMING";
  return deriveAccountState({
    disabled: c.disabled,
    onCooldown: c.onCooldown,
    headersReady: c.headersReady,
    initialized: c.initialized,
    busy: c.saturated || c.active,
    authError: c.authError,
    sessionExpired: isAccountFlaggedSessionExpired(accountId),
    broken: c.broken,
  });
}

export interface PoolStats {
  total: number;
  ready: number;
  warming: number;
  busy: number;
  cooldown: number;
  authError: number;
  broken: number;
  disabled: number;
  sessionExpired: number;
  totalActiveStreams: number;
  queuedRequests: number;
  successRate: number;
  failureRate: number;
  averageLatencyMs: number;
  averageHealth: number;
  states: Record<string, AccountState>;
}

/** Pool-wide aggregates for /health, /metrics and the TUI. */
export function getPoolStats(): PoolStats {
  const accounts = loadAccounts();
  if (accounts.length > 0) syncCooldownsFromDb(accounts);
  const candidates = buildSchedulerCandidates(accounts);
  const states: Record<string, AccountState> = {};
  let ready = 0;
  let warming = 0;
  let busy = 0;
  let cooldown = 0;
  let authError = 0;
  let broken = 0;
  let disabled = 0;
  let sessionExpired = 0;
  let totalActiveStreams = 0;
  let queuedRequests = 0;
  let healthSum = 0;

  for (const c of candidates) {
    const state = deriveAccountState({
      disabled: c.disabled,
      onCooldown: c.onCooldown,
      headersReady: c.headersReady,
      initialized: c.initialized,
      busy: c.saturated || c.active,
      authError: c.authError,
      sessionExpired: isAccountFlaggedSessionExpired(c.account.id),
      broken: c.broken,
    });
    states[c.account.id] = state;
    switch (state) {
      case "READY": ready++; break;
      case "WARMING": warming++; break;
      case "BUSY": busy++; break;
      case "COOLDOWN": cooldown++; break;
      case "AUTH_ERROR": authError++; break;
      case "BROKEN": broken++; break;
      case "DISABLED": disabled++; break;
      case "SESSION_EXPIRED": sessionExpired++; break;
    }
    totalActiveStreams += c.activeStreams;
    queuedRequests += c.queuedRequests;
    healthSum += c.health.healthScore;
  }

  const agg = getPoolHealthAggregates(accounts.map((a) => a.id));
  const stats: PoolStats = {
    total: accounts.length,
    ready,
    warming,
    busy,
    cooldown,
    authError,
    broken,
    disabled,
    sessionExpired,
    totalActiveStreams,
    queuedRequests,
    successRate: agg.successRate,
    failureRate: agg.failureRate,
    averageLatencyMs: agg.averageLatencyMs,
    averageHealth:
      accounts.length > 0 ? Math.round(healthSum / accounts.length) : 100,
    states,
  };

  // Pool gauges for Prometheus (best-effort; /metrics renders them).
  try {
    metrics.gauge("pool.accounts", stats.total, { state: "total" });
    metrics.gauge("pool.accounts", stats.ready, { state: "ready" });
    metrics.gauge("pool.accounts", stats.warming, { state: "warming" });
    metrics.gauge("pool.accounts", stats.busy, { state: "busy" });
    metrics.gauge("pool.accounts", stats.cooldown, { state: "cooldown" });
    metrics.gauge("pool.accounts", stats.authError, { state: "auth_error" });
    metrics.gauge("pool.accounts", stats.broken, { state: "broken" });
    metrics.gauge("pool.accounts", stats.disabled, { state: "disabled" });
    metrics.gauge("pool.streams.active", stats.totalActiveStreams);
    metrics.gauge("pool.streams.queued", stats.queuedRequests);
    metrics.gauge("pool.health.avg", stats.averageHealth);
    metrics.gauge("pool.latency.avg", stats.averageLatencyMs);
  } catch {
    // Best-effort.
  }
  return stats;
}

/** Test isolation: reset rotation offset (cooldown/health/state reset separately). */
export function resetAccountManagerForTests(): void {
  currentIndex = 0;
}

export function getCooldownStatus(): Record<
  string,
  { remainingMs: number; reason: string }
> {
  const result: Record<string, { remainingMs: number; reason: string }> = {};
  for (const [id, info] of cooldowns.entries()) {
    const remaining = info.until - Date.now();
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: info.reason };
    }
  }
  return result;
}
