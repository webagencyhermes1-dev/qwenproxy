import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { getDatabase } from "../core/database.ts";
import {
  invalidateAccountsCache,
  loadAccounts,
  type QwenAccount,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  getNextAccount,
  getNextAvailableAccount,
  isAccountHeadersReady,
  markAccountHeadersReady,
  markAccountRateLimited,
  resetAccountManagerForTests,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  markAccountBroken,
  resetAccountStateForTests,
} from "../core/account-state.ts";
import { resetAccountConcurrencyForTests } from "../core/account-concurrency.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import {
  ensurePoolReadiness,
  registerReadinessGuardDeps,
  stopReadinessGuardSweep,
  triggerReadinessCheck,
} from "../core/readiness-guard.ts";

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
      unmarkAccountHeadersReady(row.id);
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

function registerGuardDeps(
  opts: {
    initDelayMs?: number;
    active?: { value: number; peak: number };
  } = {},
): {
  initCalls: string[];
  release: () => void;
} {
  const initCalls: string[] = [];

  registerReadinessGuardDeps({
    getAccountCredentials: (id) =>
      ({
        id,
        email: `${id}@example.com`,
        username: id,
        password: "secret",
      }) as QwenAccount,
    initPlaywrightForAccount: async (account) => {
      initCalls.push(account.id);
      if (opts.active) {
        opts.active.value++;
        opts.active.peak = Math.max(opts.active.peak, opts.active.value);
      }
      const delay = opts.initDelayMs ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
      }
      if (opts.active) opts.active.value--;
    },
    disableNativeTools: async () => {},
    warmQwenChatPool: async () => {},
  });

  return {
    initCalls,
    release: () => {
      registerReadinessGuardDeps(null as never);
    },
  };
}

test("Scheduler: equal healthy accounts distribute requests", async () => {
  const ids = ["dist-a", "dist-b", "dist-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    () => {
      for (const id of ids) markAccountHeadersReady(id);

      const counts = new Map<string, number>();
      for (let i = 0; i < 30; i++) {
        const next = getNextAvailableAccount();
        assert.ok(next, "expected an account from a healthy 3-account pool");
        counts.set(next!.id, (counts.get(next!.id) ?? 0) + 1);
      }

      assert.strictEqual(counts.size, 3, "all three accounts should be used");
      for (const [id, count] of counts) {
        assert.ok(
          count <= 18,
          `${id} received ${count}/30 selections, exceeding the 60% cap`,
        );
      }
    },
  );
});

test("Scheduler: request tried-set does not poison future requests", async () => {
  await withFreshAccounts(
    [{ id: "tried-a", email: "tried-a@test.com" }],
    () => {
      markAccountHeadersReady("tried-a");

      const excluded = getNextAvailableAccount(new Set(["tried-a"]));
      assert.strictEqual(
        excluded,
        null,
        "tried account must be skipped for that request",
      );

      const eligible = getNextAvailableAccount(new Set());
      assert.ok(eligible, "account must be eligible again on a fresh request");
      assert.strictEqual(eligible!.id, "tried-a");
    },
  );
});

test("Failover: one broken account does not block all others", async () => {
  await withFreshAccounts(
    [
      { id: "blk-a", email: "blk-a@test.com" },
      { id: "blk-b", email: "blk-b@test.com" },
      { id: "blk-c", email: "blk-c@test.com" },
    ],
    () => {
      markAccountBroken("blk-a");
      markAccountHeadersReady("blk-b");

      const next = getNextAvailableAccount();
      assert.ok(next, "pool must still serve despite one broken account");
      assert.strictEqual(next!.id, "blk-b");

      const fallback = getNextAvailableAccount(new Set(["blk-b"]));
      assert.ok(fallback, "standby account must remain selectable/warmable");
      assert.strictEqual(fallback!.id, "blk-c");
    },
  );
});

test("Failover: WAF quarantine resets browser readiness", async () => {
  await withFreshAccounts(
    [
      { id: "waf-a", email: "waf-a@test.com" },
      { id: "waf-b", email: "waf-b@test.com" },
    ],
    () => {
      markAccountHeadersReady("waf-a");
      markAccountHeadersReady("waf-b");
      assert.strictEqual(isAccountHeadersReady("waf-a"), true);

      unmarkAccountHeadersReady("waf-a");
      markAccountRateLimited("waf-a", 30_000, "WafChallenge", {
        silent: true,
      });

      assert.strictEqual(
        isAccountHeadersReady("waf-a"),
        false,
        "WAF quarantine must drop the headers-ready flag",
      );

      for (let i = 0; i < 5; i++) {
        const next = getNextAvailableAccount();
        assert.ok(next);
        assert.notStrictEqual(
          next!.id,
          "waf-a",
          "quarantined account must never be selected",
        );
      }
    },
  );
});

test("Readiness: forge-imported accounts participate in readiness", async () => {
  await withFreshAccounts([], () => {
    const db = getDatabase();
    const forgeIds = ["forge-import-1", "forge-import-2"];
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    try {
      for (const id of forgeIds) {
        insert.run(id, `${id}@forge.test`, "forge-pw");
      }
      invalidateAccountsCache();

      const loadedIds = loadAccounts().map((a) => a.id);
      for (const id of forgeIds) {
        assert.ok(
          loadedIds.includes(id),
          `forge-imported account ${id} must appear in loadAccounts()`,
        );
      }

      markAccountHeadersReady("forge-import-1");
      const next = getNextAccount();
      assert.ok(next, "a headers-ready forge account must be selectable");
      assert.strictEqual(next!.id, "forge-import-1");
    } finally {
      for (const id of forgeIds) {
        unmarkAccountHeadersReady(id);
        try {
          clearAccountCooldown(id);
        } catch {
          // Best-effort.
        }
      }
    }
  });
});

test("Readiness: parallel warmup is bounded (MAX_CONCURRENT_WARMING=1)", async () => {
  stopReadinessGuardSweep();
  const ids = [
    "warm-bnd-1",
    "warm-bnd-2",
    "warm-bnd-3",
    "warm-bnd-4",
    "warm-bnd-5",
  ];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      const active = { value: 0, peak: 0 };
      const { initCalls, release } = registerGuardDeps({
        initDelayMs: 50,
        active,
      });
      try {
        for (let i = 0; i < 5; i++) {
          await ensurePoolReadiness();
        }
        assert.ok(
          initCalls.length >= 1,
          "at least one standby account should have been warmed",
        );
        assert.ok(
          active.peak <= 1,
          `peak concurrent warmups was ${active.peak}, expected at most 1`,
        );
      } finally {
        release();
      }
    },
  );
});

test("Readiness: reconciliation is idempotent under rapid triggers", async () => {
  stopReadinessGuardSweep();
  const ids = ["idem-1", "idem-2", "idem-3"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      const { initCalls, release } = registerGuardDeps({ initDelayMs: 20 });
      try {
        for (let i = 0; i < 10; i++) {
          triggerReadinessCheck("idempotence-probe");
        }
        await ensurePoolReadiness();
        await ensurePoolReadiness();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 120);
          timer.unref?.();
        });

        assert.ok(initCalls.length >= 1, "expected at least one warmup");
        const counts = new Map<string, number>();
        for (const id of initCalls) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        for (const [id, count] of counts) {
          assert.ok(
            count <= 1,
            `${id} was warmed ${count} times; reconciliation must warm each account at most once`,
          );
        }
      } finally {
        release();
      }
    },
  );
});
