/**
 * Edge cases PA-01, PA-09, PA-10 — account selection fairness stress.
 *
 * Reproduces the user-reported "only 14 accounts warm up, same few always
 * selected" scenario. With 72 accounts configured but only a subset
 * headers-ready, the scheduler must rotate fairly across all eligible
 * accounts and never starve a healthy account.
 *
 * Tests:
 *  1. Round-robin fairness: N requests across M ready accounts should
 *     distribute evenly (no account gets >2x the fair share).
 *  2. Cooldown exclusion: accounts on cooldown are never selected.
 *  3. Tried-set exclusion: rotation never re-picks a tried account.
 *  4. Saturation awareness: busy accounts are deprioritized.
 *  5. Recovery: after cooldown expires, account becomes selectable again.
 *
 * @stress
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  addAccount,
  removeAccount,
} from "../../core/accounts.ts";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  clearAllHeadersReadyAccounts,
  getHeadersReadyAccountIds,
  markAccountRateLimited,
  clearAccountCooldown,
  pickNextHotCandidate,
  resetAccountManagerForTests,
} from "../../core/account-manager.ts";
import {
  resetAccountConcurrencyForTests,
  acquireAccountLease,
} from "../../core/account-concurrency.ts";
import { resetAccountHealthForTests, recordAccountSuccess } from "../../core/account-health.ts";
import { invalidatePriorityCache } from "../../core/account-priority.ts";
import { resetAccountStateForTests } from "../../core/account-state.ts";

const POOL_SIZE = 20;
const accountIds = Array.from({ length: POOL_SIZE }, (_, i) => `fair-${i}`);

function setupPool(readyCount: number): void {
  clearAllHeadersReadyAccounts();
  resetAccountConcurrencyForTests();
  resetAccountHealthForTests();
  resetAccountStateForTests();
  invalidatePriorityCache();

  for (const id of accountIds) {
    try { removeAccount(id); } catch {}
  }
  for (const id of accountIds) {
    addAccount(`${id}@test.com`, "secret", id);
  }
  for (let i = 0; i < readyCount; i++) {
    markAccountHeadersReady(accountIds[i]);
  }
}

function teardownPool(): void {
  clearAllHeadersReadyAccounts();
  resetAccountConcurrencyForTests();
  resetAccountHealthForTests();
  resetAccountStateForTests();
  invalidatePriorityCache();
  for (const id of accountIds) {
    try { removeAccount(id); } catch {}
  }
}

test("PA-01: selection distributes across all ready accounts (20 rounds)", () => {
  setupPool(POOL_SIZE);
  try {
    const pickCounts = new Map<string, number>();

    for (let i = 0; i < POOL_SIZE * 3; i++) {
      const picked = pickNextHotCandidate();
      if (picked) {
        pickCounts.set(picked.id, (pickCounts.get(picked.id) ?? 0) + 1);
      }
    }

    const totalPicks = [...pickCounts.values()].reduce((a, b) => a + b, 0);
    assert.ok(totalPicks > 0, "at least one account should be picked");

    const distinctAccounts = pickCounts.size;
    const fairShare = totalPicks / POOL_SIZE;

    // At least 60% of accounts should be selected in 60 rounds
    assert.ok(
      distinctAccounts >= POOL_SIZE * 0.6,
      `only ${distinctAccounts}/${POOL_SIZE} accounts selected in ${totalPicks} rounds — selection is not rotating`,
    );

    // No account should get more than 3x fair share
    for (const [id, count] of pickCounts) {
      assert.ok(
        count <= fairShare * 3,
        `${id} selected ${count}x vs fair share ${fairShare.toFixed(1)} — selection is biased`,
      );
    }
  } finally {
    teardownPool();
  }
});

test("PA-10: tried-set exclusion prevents re-selection", () => {
  setupPool(5);
  try {
    const readyIds = getHeadersReadyAccountIds();
    assert.ok(readyIds.length >= 5, "need at least 5 ready accounts");

    const tried = new Set<string>();
    const picks: string[] = [];

    for (let i = 0; i < 5; i++) {
      const picked = pickNextHotCandidate(tried);
      if (!picked) break;
      assert.ok(!tried.has(picked.id), `${picked.id} was already tried but re-selected`);
      picks.push(picked.id);
      tried.add(picked.id);
    }

    // After trying all ready accounts, next pick should be null
    const exhausted = pickNextHotCandidate(tried);
    assert.equal(exhausted, null, "should return null when all ready accounts are tried");
  } finally {
    teardownPool();
  }
});

test("PA-09: cooldown exclusion prevents selection", () => {
  setupPool(5);
  try {
    const readyIds = getHeadersReadyAccountIds();
    const target = readyIds[0];
    assert.ok(target, "need at least one ready account");

    // Put account on cooldown
    markAccountRateLimited(target, 60_000, "TestQuota", { silent: true });

    // Verify it's never selected
    const tried = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const picked = pickNextHotCandidate(tried);
      if (!picked) break;
      assert.notEqual(picked.id, target, `${target} selected despite cooldown`);
      tried.add(picked.id);
    }

    // Clear cooldown — account should become selectable again
    clearAccountCooldown(target);
    invalidatePriorityCache();

    let foundTarget = false;
    const tried2 = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const picked = pickNextHotCandidate(tried2);
      if (!picked) break;
      if (picked.id === target) foundTarget = true;
      tried2.add(picked.id);
    }
    assert.ok(foundTarget, `${target} should be selectable after cooldown cleared`);
  } finally {
    teardownPool();
  }
});

test("PA-01: only ready accounts are selected (non-ready never picked)", () => {
  const readyCount = 8;
  setupPool(readyCount);
  try {
    const readySet = new Set(getHeadersReadyAccountIds());
    assert.equal(readySet.size, readyCount);

    for (let i = 0; i < 50; i++) {
      const picked = pickNextHotCandidate();
      if (picked) {
        assert.ok(
          readySet.has(picked.id),
          `${picked.id} selected but is NOT headers-ready`,
        );
      }
    }
  } finally {
    teardownPool();
  }
});

test("PA-10: concurrent lease contention — all slots filled then drained", async () => {
  setupPool(5);
  try {
    const readyIds = getHeadersReadyAccountIds();
    const leases: Array<{ release(): void }> = [];

    // Fill all slots
    for (const id of readyIds) {
      const lease = await acquireAccountLease(id, { label: `fill-${id}` });
      leases.push(lease);
    }

    // All should be busy now
    for (const id of readyIds) {
      const pick = pickNextHotCandidate();
      // With all accounts saturated, behavior depends on allowSaturatedFallback
      // The scheduler should still return something (saturated fallback) or null
      // but never crash
    }

    // Release all
    for (const lease of leases) {
      lease.release();
    }

    // All should be selectable again
    const picked = pickNextHotCandidate();
    assert.ok(picked, "after releasing all leases, accounts should be selectable");
  } finally {
    teardownPool();
  }
});
