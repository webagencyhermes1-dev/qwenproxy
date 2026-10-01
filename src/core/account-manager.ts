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
import {
  getAccountOwnership,
  isAccountOwnershipBound,
} from "../runtime/account/instance.ts";

/** Accounts currently warming (ownership WARMING status; empty when unbound). */
function getWarmingAccountIds(): string[] {
  if (isAccountOwnershipBound()) {
    return [...getAccountOwnership().listAccountsByStatus("WARMING")];
  }
  return [];
}
import type { OwnershipFence } from "../runtime/contracts.ts";
import { peekReadyAccountIds } from "../runtime/gateway.ts";

/** System fence for readiness marking (mirrors the resource manager's own). */
const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };

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

  // Single truth: mirror the window into the ownership authority so the
  // gateway (legality) and the controller (candidacy) observe it. The legacy
  // in-memory map stays as the request-path read cache.
  if (accountId !== "global" && isAccountOwnershipBound()) {
    try {
      getAccountOwnership().setCooldownUntil(accountId, until, cooldownReason);
    } catch {
      // Best-effort: the map + DB already hold the window.
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
    void import("../runtime/construct.ts")
      .then((m) => m.requestReadinessTick("cooldown-set"))
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
    if (isAccountOwnershipBound()) {
      try {
        getAccountOwnership().setCooldownUntil(accountId, 0, null);
      } catch {
        // Best-effort.
      }
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
    void import("../runtime/construct.ts")
      .then((m) => m.requestReadinessTick("cooldown-expired"))
      .catch(() => {});
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

/**
 * Single readiness truth with two backings:
 * - ownership BOUND (production, or tests that bind explicitly): the
 *   AccountResourceManager status machine is authoritative. Marking READY is
 *   idempotent; unmarking (context death) moves READY → RECOVERING so the
 *   ReadinessController re-warms instead of stranding the account.
 * - ownership UNBOUND (hermetic mock tests): the legacy in-memory set.
 */
export function markAccountHeadersReady(accountId: string): void {
  if (!accountId || accountId === "global") return;
  if (isAccountOwnershipBound()) {
    const ownership = getAccountOwnership();
    const status = ownership.getAccountStatus(accountId);
    if (status === "READY" || status === "RESERVED" || status === "GENERATING") {
      return; // Already serving-capable; a live lease must not be disturbed.
    }
    if (status === "WARMING" || status === "RECOVERING" || status === "DRAINING") {
      ownership.transition(accountId, "READY", SYSTEM_FENCE, "headers-ready");
      return;
    }
    // STANDBY / FAILED / COOLDOWN / DISABLED cannot legally become READY
    // without a warmup — leave for the controller; log at debug.
    return;
  }
  headersReadyAccounts.add(accountId);
}

export function unmarkAccountHeadersReady(accountId: string): void {
  if (!accountId) return;
  if (isAccountOwnershipBound()) {
    const ownership = getAccountOwnership();
    // Only a lease-free READY account may move; RESERVED/GENERATING carry a
    // live generation and recover through the release path instead.
    if (ownership.getAccountStatus(accountId) === "READY") {
      void ownership.recoverAccount(accountId, "context-death").catch(() => {});
    }
    return;
  }
  headersReadyAccounts.delete(accountId);
}

export function isAccountHeadersReady(accountId: string): boolean {
  if (isAccountOwnershipBound()) {
    const status = getAccountOwnership().getAccountStatus(accountId);
    // A leased account (RESERVED/GENERATING) is hot by construction: the set
    // stayed marked for the whole generation under the legacy model, and the
    // same-generation re-entry check depends on passing here.
    return status === "READY" || status === "RESERVED" || status === "GENERATING";
  }
  return headersReadyAccounts.has(accountId);
}

export function getHeadersReadyAccountIds(): string[] {
  if (isAccountOwnershipBound()) {
    return [...getAccountOwnership().listAccountsByStatus("READY")];
  }
  return Array.from(headersReadyAccounts);
}

export function clearAllHeadersReadyAccounts(): void {
  headersReadyAccounts.clear();
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

// ─── HOT-only selection boundary (normal request path) ──────────────────────
// Invariant: NORMAL REQUESTS MAY ONLY EXECUTE ON HOT ACCOUNTS. A HOT account
// is READY in the ownership state machine (bound) or headers-marked (unbound
// mock seam). WARM (warming in progress) and COLD (uninitialized) accounts
// must be rejected HERE, at the selection boundary — never discovered as a
// readiness failure after the lease was claimed. pickNextHotCandidate never
// degrades to a non-HOT account and never falls back to a cooldown or
// first-configured account; it returns null when zero HOT accounts exist so
// the caller emits one bounded retryable capacity error and lets the pool
// readiness controller warm a replacement.

/**
 * HOT-only rotation picker. Unbound-mode seam (hermetic mock tests) and
 * fallback behind pickNextHotCandidate. Accounts that are not headers-ready
 * are NEVER returned — no saturated-ready degradation, no shortest-cooldown
 * fallback. Returns null when zero HOT accounts are eligible.
 */
export function getNextHotAccount(
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
  const ranked = rankSchedulerCandidates(candidates, {
    triedAccountIds: triedSet,
    allowSaturatedFallback: true,
    strictHeadersReady: true,
  });
  if (ranked.length === 0) return null;
  const span = Math.max(1, candidates.length);
  const picked =
    pickSchedulerCandidate(ranked, currentIndex, span) ?? ranked[0];
  currentIndex = (picked.priorityIndex + 1) % span;
  return picked.account;
}

/**
 * Single rotation-resolution entry point for the request path.
 * - ownership BOUND (production): resolve through the gateway's READY-only
 *   peek (tried excluded, order preserved); the atomic claim still happens at
 *   the caller's claim site, which re-validates.
 * - ownership UNBOUND (hermetic mock tests): legacy HOT-only round-robin.
 * Returns null when zero HOT accounts are eligible.
 */
export function pickNextHotCandidate(
  triedAccountIds?: Set<string> | string,
): QwenAccount | null {
  if (isAccountOwnershipBound()) {
    const triedSet =
      triedAccountIds instanceof Set
        ? triedAccountIds
        : new Set(triedAccountIds ? [triedAccountIds] : []);
    const accounts = loadAccounts();
    if (accounts.length === 0) return null;
    syncCooldownsFromDb(accounts);
    for (const id of peekReadyAccountIds(triedSet)) {
      const account = accounts.find((a) => a.id === id);
      if (account) return account;
    }
    return null;
  }
  return getNextHotAccount(triedAccountIds);
}

// Request-path invariant counters. Normal chat requests must never
// cold-init, warm-init, or EXECUTE on a non-HOT account. The selection
// boundary enforces this; these counters make violations observable and
// regression-testable (all three must stay 0).
const requestPathInvariantCounters = {
  requestPathColdInitCount: 0,
  requestPathWarmInitCount: 0,
  requestPathNotHotExecutionCount: 0,
};

export function getRequestPathInvariantCounters(): {
  requestPathColdInitCount: number;
  requestPathWarmInitCount: number;
  requestPathNotHotExecutionCount: number;
} {
  return { ...requestPathInvariantCounters };
}

export function noteRequestPathColdInit(): void {
  requestPathInvariantCounters.requestPathColdInitCount += 1;
}

export function noteRequestPathWarmInit(): void {
  requestPathInvariantCounters.requestPathWarmInitCount += 1;
}

export function noteRequestPathNotHotExecution(): void {
  requestPathInvariantCounters.requestPathNotHotExecutionCount += 1;
}

export function resetRequestPathInvariantCountersForTests(): void {
  requestPathInvariantCounters.requestPathColdInitCount = 0;
  requestPathInvariantCounters.requestPathWarmInitCount = 0;
  requestPathInvariantCounters.requestPathNotHotExecutionCount = 0;
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
  readinessTarget: number;
  readinessDeficit: number;
  warmingAccounts: string[];
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
  const readinessTarget = config.pool?.targetReady ?? 2;
  const readinessDeficit = Math.max(0, readinessTarget - ready);
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
    readinessTarget,
    readinessDeficit,
    warmingAccounts: getWarmingAccountIds(),
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
