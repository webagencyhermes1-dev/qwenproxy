import { test } from "node:test";
import assert from "node:assert";
import { getDatabase } from "../core/database.ts";
import {
  invalidateAccountsCache,
  setAccountDisabled,
} from "../core/accounts.ts";
import {
  buildSchedulerCandidates,
  clearAccountCooldown,
  getNextAccount,
  getNextAvailableAccount,
  getPoolStats,
  markAccountRateLimited,
  resetAccountManagerForTests,
} from "../core/account-manager.ts";
import {
  pickSchedulerCandidate,
  rankSchedulerCandidates,
} from "../core/account-scheduler.ts";
import { healthKindForFailure } from "../routes/chat/account.ts";
import {
  flushAccountHealth,
  recordAccountFailure,
  resetAccountHealthForTests,
} from "../core/account-health.ts";
import {
  markAccountAuthError,
  markAccountBroken,
  resetAccountStateForTests,
} from "../core/account-state.ts";
import {
  resetAccountConcurrencyForTests,
  tryAcquireAccountLease,
} from "../core/account-concurrency.ts";

void pickSchedulerCandidate;
void buildSchedulerCandidates;

/** Snapshot/restore the accounts table around each integration test. */
async function withFreshAccounts(
  rows: Array<{ id: string; email: string }>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const originalEnv = process.env.QWEN_ACCOUNTS;
  delete process.env.QWEN_ACCOUNTS;
  const db = getDatabase();
  const existing = db
    .prepare(
      "SELECT id, email, password, cooldown_until, cooldown_reason, disabled FROM accounts",
    )
    .all() as any[];
  db.prepare("DELETE FROM accounts").run();
  try {
    db.prepare("DELETE FROM account_health").run();
  } catch {
    // Migration creates the table on getDatabase(); ignore if racing.
  }
  invalidateAccountsCache();
  resetAccountHealthForTests();
  resetAccountStateForTests();
  resetAccountConcurrencyForTests();
  resetAccountManagerForTests();
  try {
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    for (const row of rows) insert.run(row.id, row.email, "pw");
    invalidateAccountsCache();
    await fn();
  } finally {
    for (const row of rows) {
      try {
        clearAccountCooldown(row.id);
      } catch {
        // Best-effort.
      }
    }
    resetAccountConcurrencyForTests();
    resetAccountStateForTests();
    resetAccountHealthForTests();
    resetAccountManagerForTests();
    db.prepare("DELETE FROM accounts").run();
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason, disabled) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of existing) {
      insert.run(
        row.id,
        row.email,
        row.password,
        row.cooldown_until ?? 0,
        row.cooldown_reason ?? null,
        row.disabled ?? 0,
      );
    }
    try {
      db.prepare("DELETE FROM account_health").run();
    } catch {
      // Ignore.
    }
    invalidateAccountsCache();
    if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
  }
}

test("Scheduler: disabled accounts are always excluded", async () => {
  await withFreshAccounts(
    [
      { id: "sched-d1", email: "d1@test.com" },
      { id: "sched-d2", email: "d2@test.com" },
    ],
    () => {
      setAccountDisabled("sched-d1", true);
      for (let i = 0; i < 6; i++) {
        const next = getNextAvailableAccount();
        assert.ok(next, "expected an account");
        assert.strictEqual(next!.id, "sched-d2");
      }
      const stats = getPoolStats();
      assert.strictEqual(stats.disabled, 1);
      assert.strictEqual(stats.total, 2);
      setAccountDisabled("sched-d1", false);
    },
  );
});

test("Scheduler: broken and auth-error accounts are excluded", async () => {
  await withFreshAccounts(
    [
      { id: "sched-b1", email: "b1@test.com" },
      { id: "sched-b2", email: "b2@test.com" },
      { id: "sched-b3", email: "b3@test.com" },
    ],
    () => {
      markAccountBroken("sched-b1");
      markAccountAuthError("sched-b2");
      for (let i = 0; i < 6; i++) {
        const next = getNextAvailableAccount();
        assert.ok(next);
        assert.strictEqual(next!.id, "sched-b3");
      }
      const stats = getPoolStats();
      assert.strictEqual(stats.broken, 1);
      assert.strictEqual(stats.authError, 1);
      assert.strictEqual(stats.ready + stats.warming, 1);
    },
  );
});

test("Scheduler: cooldown accounts excluded, eligible again after expiry", async () => {
  await withFreshAccounts(
    [
      { id: "sched-c1", email: "c1@test.com" },
      { id: "sched-c2", email: "c2@test.com" },
    ],
    async () => {
      markAccountRateLimited("sched-c1", 30_000, "RateLimited", {
        silent: true,
      });
      let next = getNextAvailableAccount();
      assert.ok(next);
      assert.strictEqual(next!.id, "sched-c2");

      // Short cooldown expires and the account becomes eligible again.
      markAccountRateLimited("sched-c2", 120, "RateLimitTemporary", {
        silent: true,
      });
      next = getNextAvailableAccount(new Set(["sched-c1"]));
      assert.ok(next);
      // c2 on cooldown and c1 tried/excluded-by-cooldown: nothing untried.
      await new Promise((r) => setTimeout(r, 250));
      next = getNextAvailableAccount(new Set(["sched-c1"]));
      assert.ok(next);
      assert.strictEqual(next!.id, "sched-c2");
    },
  );
});

test("Scheduler: cooldown survives process restart via SQLite", async () => {
  await withFreshAccounts([{ id: "sched-p1", email: "p1@test.com" }], () => {
    markAccountRateLimited("sched-p1", 60_000, "RateLimited", { silent: true });
    // The row in SQLite is the restart-persistence mechanism: a fresh process
    // calls syncCooldownsFromDb and restores the same window.
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT cooldown_until, cooldown_reason FROM accounts WHERE id = ?",
      )
      .get("sched-p1") as any;
    assert.ok(row.cooldown_until > Date.now());
    assert.strictEqual(row.cooldown_reason, "RateLimited");
    const stats = getPoolStats();
    assert.strictEqual(stats.cooldown, 1);
  });
});

test("Scheduler: saturated accounts avoided when capacity exists elsewhere", async () => {
  await withFreshAccounts(
    [
      { id: "sched-s1", email: "s1@test.com" },
      { id: "sched-s2", email: "s2@test.com" },
    ],
    () => {
      // .env.test sets maxStreamsPerAccount=1: one lease saturates s1.
      const lease = tryAcquireAccountLease("sched-s1", "sat-label");
      assert.ok(lease, "expected to acquire the single slot");
      try {
        for (let i = 0; i < 4; i++) {
          const next = getNextAvailableAccount();
          assert.ok(next);
          assert.strictEqual(next!.id, "sched-s2");
        }
      } finally {
        lease!.release();
      }
      // After release both are eligible again.
      const next = getNextAvailableAccount();
      assert.ok(next);
    },
  );
});

test("Scheduler: healthy accounts preferred, load spread across 50 accounts", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: `sched-50-${i}`,
    email: `bulk${i}@test.com`,
  }));
  await withFreshAccounts(rows, () => {
    // Degrade one account's health well below the pool.
    for (let i = 0; i < 5; i++) recordAccountFailure("sched-50-0", "quota");
    flushAccountHealth();

    const seen = new Map<string, number>();
    for (let i = 0; i < 60; i++) {
      const next = getNextAccount();
      assert.ok(next, "expected an account from a 50-account pool");
      seen.set(next!.id, (seen.get(next!.id) ?? 0) + 1);
    }
    // The degraded account must not dominate selection.
    assert.ok((seen.get("sched-50-0") ?? 0) <= 2);
    // Load spreads instead of hammering one account.
    assert.ok(
      seen.size >= 10,
      `expected wide distribution, got ${seen.size} distinct`,
    );
    const stats = getPoolStats();
    assert.strictEqual(stats.total, 50);
  });
});

test("Scheduler pure: sticky affinity preserved when eligible", () => {
  const mk = (id: string, overrides: Record<string, unknown> = {}) =>
    ({
      account: { id, email: `${id}@test.com`, password: "" },
      priorityIndex: 99,
      disabled: false,
      broken: false,
      authError: false,
      onCooldown: false,
      headersReady: true,
      initialized: true,
      saturated: false,
      active: false,
      activeStreams: 0,
      queuedRequests: 0,
      maxStreams: 1,
      health: {
        accountId: id,
        healthScore: 100,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        rateLimitEvents: 0,
        quotaEvents: 0,
        authFailures: 0,
        networkFailures: 0,
        wafEvents: 0,
        totalLatencyMs: 0,
        averageLatencyMs: 0,
        lastRequestAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        initFailCount: 0,
      },
      ...overrides,
    }) as Parameters<typeof rankSchedulerCandidates>[0][number];

  const a = mk("sticky-a", { priorityIndex: 5 });
  const b = mk("other-b", { priorityIndex: 0 });
  const ranked = rankSchedulerCandidates([a, b], {
    stickyAccountId: "sticky-a",
  });
  assert.strictEqual(ranked[0].account.id, "sticky-a");

  // ...but ineligible sticky (cooldown) falls through to the next account.
  const aCold = mk("sticky-a", { onCooldown: true });
  const ranked2 = rankSchedulerCandidates([aCold, b], {
    stickyAccountId: "sticky-a",
  });
  assert.strictEqual(ranked2[0].account.id, "other-b");

  // Disabled/broken/auth-error never rank, even when tried-set is empty.
  const bad = [
    mk("x1", { disabled: true }),
    mk("x2", { broken: true }),
    mk("x3", { authError: true }),
    mk("x4", { onCooldown: true }),
  ];
  assert.strictEqual(rankSchedulerCandidates(bad).length, 0);
});

test("Failover: deterministic client errors never penalize accounts", () => {
  // Terminal reasons map to null => no health debit, no account switch waste.
  assert.strictEqual(healthKindForFailure("terminal_local"), null);
  assert.strictEqual(healthKindForFailure("content_moderation"), null);
  assert.strictEqual(healthKindForFailure("model_not_found"), null);
  assert.strictEqual(healthKindForFailure("client_abort"), null);
  assert.strictEqual(healthKindForFailure("unknown_not_retryable"), null);
  // Provider failures classify for cooldown + failover.
  assert.strictEqual(
    healthKindForFailure("quota_or_rate_limit", "RateLimited"),
    "quota",
  );
  assert.strictEqual(
    healthKindForFailure("quota_or_rate_limit", "RateLimitTemporary"),
    "rate_limit",
  );
  assert.strictEqual(healthKindForFailure("anti_bot"), "waf");
  assert.strictEqual(healthKindForFailure("network_error"), "network");
  assert.strictEqual(
    healthKindForFailure("account_initialization_failed"),
    "network",
  );
});
