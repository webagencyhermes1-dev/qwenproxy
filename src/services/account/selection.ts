/**
 * Health-aware account selection for new sessions (Loop 4).
 *
 * Deterministic given same inputs. Filters unhealthy/quota/excluded,
 * sorts by (score * headroom) desc, tie-broken by least-recently-used.
 */

import {
  getAccountCooldownInfo,
  isAccountHeadersReady,
} from "../../core/account-manager.ts";
import { isAccountBusy, isAccountTemporarilyBusy } from "../../core/account-concurrency.ts";
import { logger } from "../../core/logger.ts";
import type { HealthTracker } from "./health.ts";
import type { StickyMap, StickyBinding } from "../session/stickyMap.ts";

export interface SelectionContext {
  stickyMap: StickyMap;
  healthTracker: HealthTracker;
  availableAccounts: string[];
  excludeAccountIds?: string[];
  stickyKey?: string;
}

/**
 * Short-lived "first-turn in flight" claims. When a brand-new session selects
 * an account, it claims it synchronously so a CONCURRENT new session cannot
 * pick the same account during the async gap (lease acquisition, stream
 * setup) before the sticky binding commits. Claims expire via TTL and are
 * released once the binding lands (or by falling out of the TTL window).
 */
const CLAIM_TTL_MS = 5_000;
const pendingClaims = new Map<string, { accountId: string; claimedAt: number }>();

function gcClaims(now: number): void {
  if (pendingClaims.size === 0) return;
  for (const [key, claim] of pendingClaims) {
    if (now - claim.claimedAt > CLAIM_TTL_MS) {
      pendingClaims.delete(key);
    }
  }
}

/** Drop a session's in-flight claim after the sticky binding is committed. */
export function releaseAccountClaim(stickyKey: string): void {
  pendingClaims.delete(stickyKey);
}

/** Test hook: wipe all in-flight claims. */
export function clearSelectionClaimsForTests(): void {
  pendingClaims.clear();
}

/**
 * Load pressure on an account = live sticky bindings (excluding the selecting
 * session's own binding) + in-flight claims from OTHER sessions. Used to steer
 * concurrent/new sessions away from accounts that already serve sessions.
 */
function accountLoad(
  accountId: string,
  bindings: Array<{ key: string; binding: StickyBinding }>,
  stickyKey: string | undefined,
  now: number,
): number {
  let load = 0;
  for (const { key, binding } of bindings) {
    if (key === stickyKey) continue;
    if (binding.accountId === accountId) load++;
  }
  for (const [key, claim] of pendingClaims) {
    if (key === stickyKey) continue;
    gcClaims(now);
    if (now - claim.claimedAt > CLAIM_TTL_MS) continue;
    if (claim.accountId === accountId) load++;
  }
  return load;
}

function headroomFor(accountId: string): number {
  if (getAccountCooldownInfo(accountId)) return 0;
  if (isAccountBusy(accountId) || isAccountTemporarilyBusy(accountId)) return 0.2;
  return 1.0;
}

export function selectAccountForNewSession(ctx: SelectionContext): string | null {
  const excluded = new Set(ctx.excludeAccountIds ?? []);
  const now = Date.now();
  gcClaims(now);
  const liveBindings = ctx.stickyMap.entries();
  const candidates: Array<{
    id: string;
    score: number;
    headroom: number;
    load: number;
    composite: number;
    lastUsed: number;
  }> = [];

  for (const id of ctx.availableAccounts) {
    if (excluded.has(id)) continue;
    // NORMAL REQUESTS MAY ONLY EXECUTE ON HOT ACCOUNTS. The advisory new-session
    // selection must never propose a WARM/COLD account; the caller would pin to
    // it and then discover readiness failure after lease acquisition.
    if (!isAccountHeadersReady(id)) continue;
    if (getAccountCooldownInfo(id)) continue;
    if (ctx.healthTracker.isQuotaExhausted(id)) continue;
    const score = ctx.healthTracker.score(id);
    if (score < 0.2) continue;
    const headroom = headroomFor(id);
    if (headroom <= 0) continue;
    const h = ctx.healthTracker.getHealth(id);
    // Load-degraded accounts are still eligible (a small pool must never turn
    // away overflow), but a new session prefers the least-served account.
    const load = accountLoad(id, liveBindings, ctx.stickyKey, now);
    const loadFactor = 1 / (1 + load);
    candidates.push({
      id,
      score,
      headroom,
      load,
      composite: score * headroom * loadFactor,
      lastUsed: h.lastUsedAt || 0,
    });
  }

  if (candidates.length === 0) return null;

  // Deterministic: composite desc, then LRU (oldest lastUsed first),
  // then lexicographic id as final tiebreak.
  candidates.sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite;
    if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const top = candidates[0];
  // Claim the pick for in-flight first turns so a concurrency sibling cannot
  // collide on the same account during the pre-bind window.
  if (ctx.stickyKey) {
    pendingClaims.set(ctx.stickyKey, { accountId: top.id, claimedAt: now });
  }
  if (logger.isLevelEnabled("info") || true) {
    console.log(
      `[Session] New session bound | key=${ctx.stickyKey ?? "n/a"} | account=${top.id} | score=${top.score.toFixed(3)} | load=${top.load} | pool_size=${ctx.availableAccounts.length}`,
    );
  }
  return top.id;
}
