import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { getDatabase } from "../core/database.ts";
import {
  invalidateAccountsCache,
  loadAccounts,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  pickNextHotCandidate,
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
  getAccountOwnership,
  initAccountOwnership,
  resetAccountOwnershipForTests,
} from "../runtime/account/instance.ts";
import type { OwnershipFence } from "../runtime/contracts.ts";
import {
  ReadinessController,
  type WarmupOutcome,
} from "../runtime/readiness/readiness-controller.ts";

const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };

/** Bind the ownership pool (all STANDBY) for the given ids. */
function bindPool(ids: string[]): void {
  initAccountOwnership(
    ids.map((accountId) => ({
      accountId,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    })),
  );
}

/** Production-shaped warmup executor with call + concurrency tracking. */
function makeExecutor(
  initCalls: string[],
  opts: { initDelayMs?: number; active?: { value: number; peak: number } } = {},
): (id: string) => Promise<WarmupOutcome> {
  return async (id: string) => {
    initCalls.push(id);
    if (opts.active) {
      opts.active.value++;
      opts.active.peak = Math.max(opts.active.peak, opts.active.value);
    }
    try {
      if (opts.initDelayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, opts.initDelayMs);
          timer.unref?.();
        });
      }
      const ownership = getAccountOwnership();
      const claimed = ownership.transition(id, "WARMING", SYSTEM_FENCE, "warmup-start");
      if (!claimed.transitioned) return "failed";
      markAccountHeadersReady(id);
      return ownership.getAccountStatus(id) === "READY" ? "ready" : "failed";
    } finally {
      if (opts.active) opts.active.value--;
    }
  };
}

function makeController(
  targetReady: number,
  warmupConcurrency: number,
  warmWarmup: (id: string) => Promise<WarmupOutcome>,
): ReadinessController {
  return new ReadinessController(
    getAccountOwnership(),
    {
      targetReady,
      warmupConcurrency,
      warmupTimeoutMs: 5000,
      maxWarmupFailures: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
    },
    { warmWarmup, jitter: () => 0 },
  );
}

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



test("Scheduler: equal healthy accounts distribute requests", async () => {
  const ids = ["dist-a", "dist-b", "dist-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    () => {
      for (const id of ids) markAccountHeadersReady(id);

      const counts = new Map<string, number>();
      for (let i = 0; i < 30; i++) {
        const next = pickNextHotCandidate();
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

      const excluded = pickNextHotCandidate(new Set(["tried-a"]));
      assert.strictEqual(
        excluded,
        null,
        "tried account must be skipped for that request",
      );

      const eligible = pickNextHotCandidate(new Set());
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

      const next = pickNextHotCandidate();
      assert.ok(next, "pool must still serve despite one broken account");
      assert.strictEqual(next!.id, "blk-b");

      // blk-c is standby (never warmed): not executable. The picker returns
      // null and the readiness controller warms it in the background.
      assert.strictEqual(
        pickNextHotCandidate(new Set(["blk-b"])),
        null,
        "standby account must not be executed on; it gets warmed instead",
      );
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
        const next = pickNextHotCandidate();
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
      const next = pickNextHotCandidate();
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

test("Readiness: parallel warmup is bounded (warmupConcurrency=1)", async () => {
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
      bindPool(ids);
      const active = { value: 0, peak: 0 };
      const initCalls: string[] = [];
      const controller = makeController(
        2,
        1,
        makeExecutor(initCalls, { initDelayMs: 50, active }),
      );
      try {
        for (let i = 0; i < 5; i++) {
          await controller.tick();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          timer.unref?.();
        });
        assert.ok(
          initCalls.length >= 1,
          "at least one standby account should have been warmed",
        );
        assert.ok(
          active.peak <= 1,
          `peak concurrent warmups was ${active.peak}, expected at most 1`,
        );
      } finally {
        controller.stop();
        resetAccountOwnershipForTests();
      }
    },
  );
});

test("Readiness: reconciliation is idempotent under rapid ticks", async () => {
  const ids = ["idem-1", "idem-2", "idem-3"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      bindPool(ids);
      const initCalls: string[] = [];
      const controller = makeController(
        3,
        2,
        makeExecutor(initCalls, { initDelayMs: 20 }),
      );
      try {
        // Ten rapid ticks with no awaits: the pass chain coalesces them.
        const pending = Array.from({ length: 10 }, () => controller.tick());
        await Promise.all(pending);
        await controller.tick();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
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
        controller.stop();
        resetAccountOwnershipForTests();
      }
    },
  );
});

