/**
 * Health-aware account advisory for new sessions.
 *
 * Suggests (never claims) the best account for a brand-new session:
 * deterministic given the same inputs, filters unhealthy/quota/excluded,
 * sorts by (score * headroom) desc, tie-broken by least-recently-used.
 *
 * Advisory only: concurrent first turns may receive the same suggestion —
 * that race is closed atomically by the gateway claim
 * (`runtime/gateway.ts`), which is the sole authority that assigns accounts.
 * The old synchronous in-flight claim map was removed with the legacy
 * selector (Phase 1): suggestions must stay side-effect free so they are safe
 * to call from observability paths.
 */

import {
  getAccountCooldownInfo,
  isAccountHeadersReady,
} from "../../core/account-manager.ts";
import { isAccountBusy, isAccountTemporarilyBusy } from "../../core/account-concurrency.ts";
import { logger } from "../../core/logger.ts";
import type { HealthTracker } from "./health.ts";
import type { StickyMap, StickyBinding } from "../session/stickyMap.ts";

export interface AdvisoryContext {
  stickyMap: StickyMap;
  healthTracker: HealthTracker;
  availableAccounts: string[];
  excludeAccountIds?: string[];
  stickyKey?: string;
}

/**
 * Load pressure on an account = live sticky bindings (excluding the selecting
 * session's own binding). Used to steer new sessions away from accounts that
 * already serve sessions.
 */
function accountLoad(
  accountId: string,
  bindings: Array<{ key: string; binding: StickyBinding }>,
  stickyKey: string | undefined,
): number {
  let load = 0;
  for (const { key, binding } of bindings) {
    if (key === stickyKey) continue;
    if (binding.accountId === accountId) load++;
  }
  return load;
}

function headroomFor(accountId: string): number {
  if (getAccountCooldownInfo(accountId)) return 0;
  if (isAccountBusy(accountId) || isAccountTemporarilyBusy(accountId)) return 0.2;
  return 1.0;
}

export function suggestAccountForNewSession(ctx: AdvisoryContext): string | null {
  const excluded = new Set(ctx.excludeAccountIds ?? []);
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
    // NORMAL REQUESTS MAY ONLY EXECUTE ON HOT ACCOUNTS. The advisory must
    // never propose a WARM/COLD account; the caller would pin to it and then
    // discover readiness failure after lease acquisition.
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
    const load = accountLoad(id, liveBindings, ctx.stickyKey);
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
  if (logger.isLevelEnabled("info") || true) {
    console.log(
      `[Session] New session suggestion | key=${ctx.stickyKey ?? "n/a"} | account=${top.id} | score=${top.score.toFixed(3)} | load=${top.load} | pool_size=${ctx.availableAccounts.length}`,
    );
  }
  return top.id;
}
