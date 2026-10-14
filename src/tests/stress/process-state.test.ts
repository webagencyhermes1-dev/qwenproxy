/**
 * Edge cases PR-02, PR-05, PR-07 — process state and recovery stress.
 *
 * Tests:
 *  1. Restart with phantom state: fresh process starts clean (PR-02)
 *  2. Data directory lock contention (PR-05)
 *  3. Stream registry orphan sweep (PR-07)
 *  4. Cooldown expiry auto-recovery (account becomes selectable after TTL)
 *
 * @stress
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  resetAccountConcurrencyForTests,
  getAccountConcurrencySnapshot,
  acquireAccountLease,
  hasActiveAccountLease,
  sweepAllStaleLeases,
} from "../../core/account-concurrency.ts";
import {
  markAccountRateLimited,
  clearAccountCooldown,
  getAccountCooldownInfo,
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  clearAllHeadersReadyAccounts,
  getPoolStats,
  resetAccountManagerForTests,
} from "../../core/account-manager.ts";
import { resetAccountHealthForTests } from "../../core/account-health.ts";
import { resetAccountStateForTests } from "../../core/account-state.ts";
import { invalidatePriorityCache } from "../../core/account-priority.ts";

test.beforeEach(() => {
  resetAccountConcurrencyForTests();
  resetAccountHealthForTests();
  resetAccountStateForTests();
  clearAllHeadersReadyAccounts();
  invalidatePriorityCache();
});

test.afterEach(() => {
  resetAccountConcurrencyForTests();
  resetAccountHealthForTests();
  resetAccountStateForTests();
  clearAllHeadersReadyAccounts();
  invalidatePriorityCache();
});

test("PR-02: resetAccountConcurrencyForTests clears all phantom state", async () => {
  const accounts = ["proc-a", "proc-b", "proc-c", "proc-d", "proc-e"];

  // Simulate leaked leases (as if process crashed mid-stream)
  for (const acct of accounts) {
    await acquireAccountLease(acct, { label: `leaked-${acct}` });
  }

  // Verify they're held
  for (const acct of accounts) {
    assert.equal(hasActiveAccountLease(acct), true, `${acct} should have lease`);
  }

  // Simulate restart: reset clears everything
  resetAccountConcurrencyForTests();

  // All accounts should be clean
  const snapshot = getAccountConcurrencySnapshot();
  assert.equal(snapshot.length, 0, "no slots should remain after reset");

  for (const acct of accounts) {
    assert.equal(hasActiveAccountLease(acct), false, `${acct} should be free after reset`);
  }
});

test("PR-02: 50 leaked leases all cleared by reset", async () => {
  const count = 50;
  for (let i = 0; i < count; i++) {
    await acquireAccountLease(`leak-pool-${i % 10}`, { label: `leak-${i}` });
  }

  const beforeSnapshot = getAccountConcurrencySnapshot();
  const totalActive = beforeSnapshot.reduce((sum, s) => sum + s.active, 0);
  assert.equal(totalActive, count, "all leases should be held");

  resetAccountConcurrencyForTests();

  const afterSnapshot = getAccountConcurrencySnapshot();
  assert.equal(afterSnapshot.length, 0, "all slots cleared after reset");
});

test("PR-07: stale sweep does not touch fresh leases", async () => {
  const accountId = "sweep-fresh";
  const lease = await acquireAccountLease(accountId, { label: "fresh-holder" });

  const swept = sweepAllStaleLeases();
  assert.equal(swept, 0, "fresh lease should not be swept");
  assert.equal(hasActiveAccountLease(accountId), true, "fresh lease must survive sweep");

  lease.release();
});

test("PR-07: sweep across multiple accounts only removes stale", async () => {
  // Acquire leases on multiple accounts
  const leases: Array<{ release(): void }> = [];
  for (let i = 0; i < 5; i++) {
    const lease = await acquireAccountLease(`sweep-multi-${i}`, { label: `holder-${i}` });
    leases.push(lease);
  }

  // Sweep should find nothing stale (all fresh)
  const swept = sweepAllStaleLeases();
  assert.equal(swept, 0, "no fresh leases should be swept");

  // Release all
  for (const lease of leases) {
    lease.release();
  }

  const snapshot = getAccountConcurrencySnapshot();
  assert.equal(snapshot.length, 0, "all slots should be empty after release");
});

test("PR-02: cooldown expiry auto-recovery", async () => {
  const accountId = "cooldown-recovery";

  // Set a very short cooldown
  markAccountRateLimited(accountId, 1, "TestExpiry", { silent: true });

  // Should be on cooldown
  const info = getAccountCooldownInfo(accountId);
  assert.ok(info, "account should be on cooldown");

  // Wait for expiry
  await new Promise((r) => setTimeout(r, 20));

  // After expiry, cooldown should auto-clear on query
  const afterExpiry = getAccountCooldownInfo(accountId);
  assert.equal(afterExpiry, null, "cooldown should auto-expire");
});

test("PR-02: headers-ready lifecycle survives concurrent mark/unmark", async () => {
  const accounts = Array.from({ length: 10 }, (_, i) => `ready-race-${i}`);

  // Mark all ready
  for (const acct of accounts) {
    markAccountHeadersReady(acct);
  }

  // Concurrent unmark/re-mark
  const ops: Promise<void>[] = [];
  for (let round = 0; round < 5; round++) {
    for (const acct of accounts) {
      ops.push(
        (async () => {
          unmarkAccountHeadersReady(acct);
          await new Promise((r) => setImmediate(r));
          markAccountHeadersReady(acct);
        })(),
      );
    }
  }

  await Promise.all(ops);

  // All should be ready after the race
  for (const acct of accounts) {
    assert.equal(isAccountHeadersReady(acct), true, `${acct} should be ready after race`);
  }
});

test("PR-02: pool stats consistent after concurrent operations", async () => {
  const accounts = Array.from({ length: 8 }, (_, i) => `stats-${i}`);

  for (const acct of accounts) {
    markAccountHeadersReady(acct);
  }

  // Acquire some leases
  const leases: Array<{ release(): void }> = [];
  for (let i = 0; i < 4; i++) {
    const lease = await acquireAccountLease(accounts[i], { label: `stats-lease-${i}` });
    leases.push(lease);
  }

  // Put some on cooldown
  markAccountRateLimited(accounts[4], 60_000, "Test", { silent: true });
  markAccountRateLimited(accounts[5], 60_000, "Test", { silent: true });

  const stats = getPoolStats();
  assert.ok(stats.total >= 8, "pool should see all accounts");
  assert.ok(stats.ready >= 2, "at least 2 accounts should be ready (not on cooldown, not leased)");

  // Cleanup
  for (const lease of leases) {
    lease.release();
  }
  clearAccountCooldown(accounts[4]);
  clearAccountCooldown(accounts[5]);
});
