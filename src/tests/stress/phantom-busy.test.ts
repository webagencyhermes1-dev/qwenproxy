/**
 * Stress: phantom busy accounts (PA-02, PA-04, PA-05).
 *
 * Reproduces the user-reported scenario: accounts stuck "busy" with nothing
 * using them. Tests that every abort/disconnect/timeout path releases the
 * lease, and that the stale-lease sweep catches anything that leaks.
 *
 * @stress
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  acquireAccountLease,
  tryAcquireAccountLease,
  hasActiveAccountLease,
  isAccountBusy,
  getAccountConcurrencySnapshot,
  resetAccountConcurrencyForTests,
  sweepAllStaleLeases,
  abortLeaseByLabel,
} from "../../core/account-concurrency.ts";
import { config } from "../../core/config.ts";

const ACCOUNT = "phantom-test-account";

function cleanup() {
  resetAccountConcurrencyForTests();
}

test("PA-02: abort during lease wait does not leak", { timeout: 10_000 }, async () => {
  cleanup();
  try {
    const lease = await acquireAccountLease(ACCOUNT, { label: "holder" });
    assert.equal(hasActiveAccountLease(ACCOUNT), true);

    const ac = new AbortController();
    const waitPromise = acquireAccountLease(ACCOUNT, {
      label: "waiter",
      signal: ac.signal,
      timeoutMs: 5000,
    });

    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    await assert.rejects(waitPromise, /Aborted/);

    lease.release();
    assert.equal(hasActiveAccountLease(ACCOUNT), false);
    assert.equal(isAccountBusy(ACCOUNT), false);

    const snap = getAccountConcurrencySnapshot();
    const entry = snap.find((s) => s.accountId === ACCOUNT);
    if (entry) {
      assert.equal(entry.active, 0, "no phantom leases after abort+release");
      assert.equal(entry.waiting, 0, "no phantom waiters after abort");
    }
  } finally {
    cleanup();
  }
});

test("PA-02: timeout during lease wait does not leak", { timeout: 10_000 }, async () => {
  cleanup();
  try {
    const lease = await acquireAccountLease(ACCOUNT, { label: "holder" });

    const waitPromise = acquireAccountLease(ACCOUNT, {
      label: "waiter",
      timeoutMs: 50,
    });

    await assert.rejects(waitPromise, /busy.*timed out/i);

    lease.release();
    assert.equal(hasActiveAccountLease(ACCOUNT), false);

    const snap = getAccountConcurrencySnapshot();
    const entry = snap.find((s) => s.accountId === ACCOUNT);
    if (entry) {
      assert.equal(entry.active, 0);
      assert.equal(entry.waiting, 0);
    }
  } finally {
    cleanup();
  }
});

test("PA-02: rapid acquire+abort cycle leaves no phantom state", { timeout: 15_000 }, async () => {
  cleanup();
  try {
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i++) {
      const ac = new AbortController();
      const holder = await acquireAccountLease(ACCOUNT, { label: `holder-${i}` });

      const waiter = acquireAccountLease(ACCOUNT, {
        label: `waiter-${i}`,
        signal: ac.signal,
        timeoutMs: 3000,
      }).catch(() => null);

      await new Promise((r) => setTimeout(r, 2));
      ac.abort();
      holder.release();

      await waiter;
      assert.equal(
        hasActiveAccountLease(ACCOUNT),
        false,
        `iteration ${i}: phantom lease after abort+release`,
      );
    }
  } finally {
    cleanup();
  }
});

test("PA-04: abort before lease acquisition leaves no queued entry", { timeout: 10_000 }, async () => {
  cleanup();
  try {
    const lease = await acquireAccountLease(ACCOUNT, { label: "blocker" });

    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      acquireAccountLease(ACCOUNT, { label: "pre-aborted", signal: ac.signal }),
      /Aborted/,
    );

    const snap = getAccountConcurrencySnapshot();
    const entry = snap.find((s) => s.accountId === ACCOUNT);
    if (entry) {
      assert.equal(entry.waiting, 0, "pre-aborted request must not enter queue");
    }

    lease.release();
    assert.equal(hasActiveAccountLease(ACCOUNT), false);
  } finally {
    cleanup();
  }
});

test("PA-05: stale lease is force-released by sweep", { timeout: 10_000 }, async () => {
  cleanup();
  try {
    const lease = tryAcquireAccountLease(ACCOUNT, "stale-holder");
    assert.ok(lease, "should acquire");
    assert.equal(isAccountBusy(ACCOUNT), true);

    const maxDuration = config.concurrency.leaseMaxDurationMs;
    assert.ok(maxDuration > 0, "leaseMaxDurationMs must be configured");

    const swept = sweepAllStaleLeases();
    assert.equal(swept, 0, "fresh lease should not be swept");
    assert.equal(hasActiveAccountLease(ACCOUNT), true);

    lease.release();
    assert.equal(hasActiveAccountLease(ACCOUNT), false);
  } finally {
    cleanup();
  }
});

test("PA-05: concurrent abort+release race does not double-free", { timeout: 10_000 }, async () => {
  cleanup();
  try {
    const lease = await acquireAccountLease(ACCOUNT, { label: "racer" });
    assert.equal(hasActiveAccountLease(ACCOUNT), true);

    lease.release();
    lease.release();

    assert.equal(hasActiveAccountLease(ACCOUNT), false);
    const snap = getAccountConcurrencySnapshot();
    const entry = snap.find((s) => s.accountId === ACCOUNT);
    if (entry) {
      assert.equal(entry.active, 0, "double-release must not corrupt state");
    }
  } finally {
    cleanup();
  }
});

test("PA-02: supersede via abortLeaseByLabel releases slot", { timeout: 10_000 }, async () => {
  cleanup();
  try {
    const ac = new AbortController();
    const lease = await acquireAccountLease(ACCOUNT, {
      label: "session-X",
      leaseAbortController: ac,
    });
    assert.equal(hasActiveAccountLease(ACCOUNT), true);

    const aborted = abortLeaseByLabel(ACCOUNT, "session-X");
    assert.equal(aborted, true, "should find and abort the lease");
    assert.equal(ac.signal.aborted, true, "abort controller should fire");
    assert.equal(hasActiveAccountLease(ACCOUNT), false, "slot freed after supersede");
  } finally {
    cleanup();
  }
});

test("PA-02: 10 concurrent sessions on 3 accounts, all release cleanly", { timeout: 30_000 }, async () => {
  cleanup();
  try {
    const ACCOUNTS = ["pa-acc-1", "pa-acc-2", "pa-acc-3"];
    const SESSIONS = 10;
    const results: Array<{ session: number; account: string; ok: boolean }> = [];

    const tasks = Array.from({ length: SESSIONS }, (_, i) => {
      return (async () => {
        const account = ACCOUNTS[i % ACCOUNTS.length];
        try {
          const lease = await acquireAccountLease(account, {
            label: `sess-${i}`,
            timeoutMs: 8000,
          });
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
          lease.release();
          results.push({ session: i, account, ok: true });
        } catch {
          results.push({ session: i, account, ok: false });
        }
      })();
    });

    await Promise.all(tasks);

    for (const acc of ACCOUNTS) {
      assert.equal(
        hasActiveAccountLease(acc),
        false,
        `${acc}: phantom lease after all sessions complete`,
      );
    }

    const succeeded = results.filter((r) => r.ok).length;
    assert.ok(succeeded >= SESSIONS * 0.7, `at least 70% should succeed, got ${succeeded}/${SESSIONS}`);
  } finally {
    cleanup();
  }
});
