/**
 * Account Pool 2.0 — load-aware scheduler (pure, no I/O).
 *
 * The manager builds enriched candidates from existing truth
 * (cooldown map, headers-ready set, concurrency snapshot, health cache,
 * priority order) and this module ranks them. Keeping it pure avoids
 * import cycles and keeps per-request cost O(N log N) on in-memory data
 * with zero browser or DB work.
 */

import type { QwenAccount } from "./accounts.ts";
import type { AccountHealthRecord } from "./account-health.ts";
import { getTtfbFactor, getRecent429Rate } from "./account-health.ts";

export interface SchedulerCandidate {
  account: QwenAccount;
  /** Priority-file index (lower = better); unknown = Infinity. */
  priorityIndex: number;
  disabled: boolean;
  broken: boolean;
  authError: boolean;
  onCooldown: boolean;
  headersReady: boolean;
  initialized: boolean;
  /** All lease slots taken (or temporarily busy). */
  saturated: boolean;
  /** Currently serving at least one stream. */
  active: boolean;
  activeStreams: number;
  queuedRequests: number;
  maxStreams: number;
  health: AccountHealthRecord;
}

export interface SchedulerOptions {
  triedAccountIds?: Set<string>;
  /** Sticky thread owner — preserved whenever eligible. */
  stickyAccountId?: string | null;
  /** Explicit pin (same semantics as preferredAccountId string). */
  preferredAccountId?: string | null;
  /** True when no other eligible account exists (last-usable stays lossless). */
  allowSaturatedFallback?: boolean;
  /**
   * Normal-request invariant: ONLY headers-ready (HOT) accounts are eligible.
   * No degradation to the full eligible pool when no ready account is
   * unsaturated, and a pinned/sticky account is returned only when it is
   * itself ready. Returns an empty ranking when zero HOT accounts exist so
   * the caller surfaces a bounded capacity error instead of executing on a
   * WARM/COLD account.
   */
  strictHeadersReady?: boolean;
}

/**
 * Eligibility first (in order):
 *  1. disabled excluded
 *  2. broken/auth-error excluded (SESSION_EXPIRED stays eligible for recovery)
 *  3. cooldown excluded
 *  4. tried excluded
 * Then preference: sticky/pin > healthy + capacity > priority tiebreak.
 */
export function rankSchedulerCandidates(
  candidates: SchedulerCandidate[],
  options: SchedulerOptions = {},
): SchedulerCandidate[] {
  const tried = options.triedAccountIds;

  const eligible = candidates.filter((c) => {
    if (c.disabled) return false;
    if (c.broken || c.authError) return false;
    if (c.onCooldown) return false;
    if (tried?.has(c.account.id)) return false;
    return true;
  });

  if (eligible.length === 0) return [];

  // NORMAL REQUESTS MAY ONLY EXECUTE ON HOT ACCOUNTS. Enforce the
  // headers-ready gate BEFORE any pin/sticky handling so a non-HOT
  // preferred or sticky account is never returned — the caller must
  // immediately rotate to a HOT account instead of discovering readiness
  // failure after lease acquisition.
  if (options.strictHeadersReady) {
    const hotPool = eligible.filter((c) => c.headersReady);
    if (hotPool.length === 0) return [];
    const pin =
      options.preferredAccountId ?? options.stickyAccountId ?? undefined;
    if (pin) {
      const pinned = hotPool.find((c) => c.account.id === pin);
      if (pinned) {
        return [pinned, ...hotPool.filter((c) => c.account.id !== pin)];
      }
    }
    const unsaturatedHot = hotPool.filter((c) => !c.saturated);
    const selectable = unsaturatedHot.length > 0 ? unsaturatedHot : hotPool;
    return rankByScore(selectable);
  }

  // Sticky / explicit pin wins whenever eligible (conversation correctness).
  const pin =
    options.preferredAccountId ?? options.stickyAccountId ?? undefined;
  if (pin) {
    const pinned = eligible.find((c) => c.account.id === pin);
    if (pinned) return [pinned, ...eligible.filter((c) => c.account.id !== pin)];
  }

  // Headers-ready gate: prefer ready accounts while at least one ready account
  // is actually usable (unsaturated). If every ready account is busy, tried,
  // cooldown, broken, etc., fall back to the full eligible pool so non-ready
  // accounts can be selected and warmed on demand instead of ping-ponging
  // between the same few ready lanes.
  const anyReady = eligible.some((c) => c.headersReady);
  const readyPool = anyReady ? eligible.filter((c) => c.headersReady) : eligible;
  const unsaturatedReady = readyPool.filter((c) => !c.saturated);
  const pool = anyReady
    ? unsaturatedReady.length > 0
      ? unsaturatedReady
      : eligible
    : eligible;

  // Prefer unsaturated; fall back to saturated only when nothing else exists
  // or the caller allows it (last-usable must queue, not fail).
  const unsaturated = pool.filter((c) => !c.saturated);
  const selectable = unsaturated.length > 0 ? unsaturated : pool;

  // Health band (±10) + load-aware spread + TTFB/429 penalty:
  // score = healthScore * ttfbFactor * (1 - recent429Rate)
  // Sort by composite score desc, then utilization asc, then priority order.
  return rankByScore(selectable);
}

function rankByScore(selectable: SchedulerCandidate[]): SchedulerCandidate[] {
  return [...selectable].sort((a, b) => {
    const scoreA = a.health.healthScore * getTtfbFactor(a.account.id) * (1 - getRecent429Rate(a.account.id));
    const scoreB = b.health.healthScore * getTtfbFactor(b.account.id) * (1 - getRecent429Rate(b.account.id));
    const bandA = Math.floor(scoreA / 10);
    const bandB = Math.floor(scoreB / 10);
    if (bandA !== bandB) return bandB - bandA;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const utilA = a.maxStreams > 0 ? a.activeStreams / a.maxStreams : 0;
    const utilB = b.maxStreams > 0 ? b.activeStreams / b.maxStreams : 0;
    if (utilA !== utilB) return utilA - utilB;
    if (a.queuedRequests !== b.queuedRequests) {
      return a.queuedRequests - b.queuedRequests;
    }
    return a.priorityIndex - b.priorityIndex;
  });
}

/**
 * Pick one candidate with load spreading.
 *
 * Health band, utilization and queue depth stay primary (an idle healthy
 * account always beats a loaded or degraded one). Fully-tied candidates
 * (same band, same load, same queue) are scanned from `cursor` in priority
 * order — the same rotating-cursor semantics the pool used before Pool 2.0 —
 * so consecutive picks cycle instead of hammering account #1, while
 * remaining deterministic for a given cursor (no order-dependent flakes).
 *
 * `prioritySpan` must be the FULL pool size (including ineligible accounts)
 * so the cursor stays in priority space across picks, exactly like the
 * historic `currentIndex % prioritized.length` rotation.
 */
export function pickSchedulerCandidate(
  ranked: SchedulerCandidate[],
  cursor = 0,
  prioritySpan?: number,
  pinAccountId?: string | null,
): SchedulerCandidate | null {
  if (ranked.length === 0) return null;
  if (pinAccountId) {
    const pinned = ranked.find((c) => c.account.id === pinAccountId);
    if (pinned) return pinned;
  }
  if (ranked.length === 1) return ranked[0];
  const top = ranked[0];
  const topScore =
    top.health.healthScore *
    getTtfbFactor(top.account.id) *
    (1 - getRecent429Rate(top.account.id));
  const topBand = Math.floor(topScore / 10);
  // Similarly-healthy leaders under identical load share the pick.
  const group = ranked.filter((c) => {
    const scoreC =
      c.health.healthScore *
      getTtfbFactor(c.account.id) *
      (1 - getRecent429Rate(c.account.id));
    return (
      Math.floor(scoreC / 10) === topBand &&
      c.activeStreams === top.activeStreams &&
      c.queuedRequests === top.queuedRequests
    );
  });
  if (group.length === 1) return group[0];
  const span = Math.max(1, prioritySpan ?? ranked.length);
  let best = group[0];
  let bestDist = Infinity;
  for (const c of group) {
    const dist =
      (((c.priorityIndex - cursor) % span) + span) % span;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}
