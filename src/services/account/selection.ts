/**
 * Health-aware account selection for new sessions (Loop 4).
 *
 * Deterministic given same inputs. Filters unhealthy/quota/excluded,
 * sorts by (score * headroom) desc, tie-broken by least-recently-used.
 */

import { getAccountCooldownInfo } from "../../core/account-manager.ts";
import { isAccountBusy, isAccountTemporarilyBusy } from "../../core/account-concurrency.ts";
import { logger } from "../../core/logger.ts";
import type { HealthTracker } from "./health.ts";
import type { StickyMap } from "../session/stickyMap.ts";

export interface SelectionContext {
  stickyMap: StickyMap;
  healthTracker: HealthTracker;
  availableAccounts: string[];
  excludeAccountIds?: string[];
  stickyKey?: string;
}

function headroomFor(accountId: string): number {
  if (getAccountCooldownInfo(accountId)) return 0;
  if (isAccountBusy(accountId) || isAccountTemporarilyBusy(accountId)) return 0.2;
  return 1.0;
}

export function selectAccountForNewSession(ctx: SelectionContext): string | null {
  const excluded = new Set(ctx.excludeAccountIds ?? []);
  const candidates: Array<{
    id: string;
    score: number;
    headroom: number;
    composite: number;
    lastUsed: number;
  }> = [];

  for (const id of ctx.availableAccounts) {
    if (excluded.has(id)) continue;
    if (getAccountCooldownInfo(id)) continue;
    if (ctx.healthTracker.isQuotaExhausted(id)) continue;
    const score = ctx.healthTracker.score(id);
    if (score < 0.2) continue;
    const headroom = headroomFor(id);
    if (headroom <= 0) continue;
    const h = ctx.healthTracker.getHealth(id);
    candidates.push({
      id,
      score,
      headroom,
      composite: score * headroom,
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
      `[Session] New session bound | key=${ctx.stickyKey ?? "n/a"} | account=${top.id} | score=${top.score.toFixed(3)} | pool_size=${ctx.availableAccounts.length}`,
    );
  }
  return top.id;
}
