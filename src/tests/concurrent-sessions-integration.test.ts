import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.ACCOUNT_MAX_CONCURRENT_STREAMS = "1";

import { StickyMap, STICKY_TTL_MS } from "../services/session/stickyMap.ts";
import { generateStickyKey } from "../services/session/key.ts";
import { HealthTracker } from "../services/account/health.ts";
import {
  selectAccountForNewSession,
  clearSelectionClaimsForTests,
} from "../services/account/selection.ts";
import { resetAccountConcurrencyForTests } from "../core/account-concurrency.ts";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import type { Message } from "../utils/types.ts";

const ACCOUNTS = ["acc-a", "acc-b", "acc-c"];

function freshStickyKey(text: string): string {
  return generateStickyKey({
    messages: [{ role: "user", content: text }] as Message[],
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("concurrent sessions: first turns racing an idle pool bind to different accounts", async () => {
  const sticky = new StickyMap({ autoSweep: false });
  sticky.clearForTests();
  const health = new HealthTracker();
  resetAccountConcurrencyForTests();
  clearSelectionClaimsForTests();
  try {
    for (const acc of ACCOUNTS) {
      markAccountHeadersReady(acc);
      for (let i = 0; i < 3; i++) health.recordSuccess(acc, 700);
    }

    // Two brand-new coding sessions fire their FIRST turns at the same moment.
    const keyA = freshStickyKey("session A: refactor auth module");
    const keyB = freshStickyKey("session B: optimize database queries");

    // The route's first-turn flow: selection (sync) -> upstream lease
    // (async gap) -> sticky bind. Run both concurrently so the second
    // selection runs after the first has claimed its account but before the
    // first bind commits.
    const [pairA, pairB] = await Promise.all([
      (async () => {
        const pick = selectAccountForNewSession({
          stickyMap: sticky,
          healthTracker: health,
          availableAccounts: ACCOUNTS,
          stickyKey: keyA,
        });
        await delay(40); // lease acquisition + stream setup
        sticky.set(keyA, {
          accountId: pick!,
          proxyId: null,
          boundAt: Date.now(),
          lastUsedAt: Date.now(),
          ttlMs: STICKY_TTL_MS,
        });
        return { key: keyA, account: pick! };
      })(),
      (async () => {
        const pick = selectAccountForNewSession({
          stickyMap: sticky,
          healthTracker: health,
          availableAccounts: ACCOUNTS,
          stickyKey: keyB,
        });
        await delay(40);
        sticky.set(keyB, {
          accountId: pick!,
          proxyId: null,
          boundAt: Date.now(),
          lastUsedAt: Date.now(),
          ttlMs: STICKY_TTL_MS,
        });
        return { key: keyB, account: pick! };
      })(),
    ]);

    assert.notEqual(
      pairA.account,
      pairB.account,
      `session A and B collided on ${pairA.account} during concurrent first turns`,
    );
    assert.equal(sticky.get(keyA)!.accountId, pairA.account);
    assert.equal(sticky.get(keyB)!.accountId, pairB.account);

    // A third session starting after A and B bound must land on the third
    // account (live-binding load spread), not re-pile on A's account.
    const keyC = freshStickyKey("session C: write integration tests");
    const pickC = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ACCOUNTS,
      stickyKey: keyC,
    });
    assert.ok(pickC);
    assert.notEqual(pickC, pairA.account, "session C must not pile on the most-loaded account");
    assert.notEqual(
      pickC,
      pairB.account,
      "session C must not pile on the single-loaded account either",
    );
  } finally {
    for (const acc of ACCOUNTS) unmarkAccountHeadersReady(acc);
    sticky.clearForTests();
    resetAccountConcurrencyForTests();
    clearSelectionClaimsForTests();
  }
});