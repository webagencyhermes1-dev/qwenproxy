import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
  clearAccountCooldown,
  getNextHotAccount,
  getRequestPathInvariantCounters,
  isAccountHeadersReady,
  markAccountHeadersReady,
  resetRequestPathInvariantCountersForTests,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import { resolveInitialAccount } from "../routes/chat/account.ts";
import {
  isAccountBusy,
  isAccountTemporarilyBusy,
  resetAccountConcurrencyForTests,
  tryAcquireAccountLease,
} from "../core/account-concurrency.ts";

function withTempAccounts(
  accounts: Array<{ id: string; email: string; password: string }>,
  fn: () => void | Promise<void>,
) {
  return async () => {
    const originalEnv = process.env.QWEN_ACCOUNTS;
    delete process.env.QWEN_ACCOUNTS;
    const originalMock = process.env.TEST_MOCK_QWEN_AUTH;
    delete process.env.TEST_MOCK_QWEN_AUTH;

    const db = getDatabase();
    const existing = db
      .prepare("SELECT id, email, password FROM accounts")
      .all() as Array<{ id: string; email: string; password: string }>;
    db.prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();

    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    for (const acc of accounts) {
      insert.run(acc.id, acc.email, acc.password);
      clearAccountCooldown(acc.id);
    }
    invalidateAccountsCache();

    try {
      await fn();
    } finally {
      for (const acc of accounts) {
        clearAccountCooldown(acc.id);
        unmarkAccountHeadersReady(acc.id);
      }
      db.prepare("DELETE FROM accounts").run();
      const restore = db.prepare(
        "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
      );
      for (const row of existing) restore.run(row.id, row.email, row.password);
      invalidateAccountsCache();
      if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
      if (originalMock !== undefined) {
        process.env.TEST_MOCK_QWEN_AUTH = originalMock;
      } else {
        process.env.TEST_MOCK_QWEN_AUTH = "true";
      }
    }
  };
}

test(
  "HOT selection: WARM preferred account -> HOT account selected instead",
  withTempAccounts(
    [
      { id: "hot-1", email: "hot1@t", password: "p" },
      { id: "warm-1", email: "warm1@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-1");
      // warm-1 is NOT headers-ready (WARM state)

      const resolved = resolveInitialAccount("warm-1");
      assert.equal(
        resolved.account?.id,
        "hot-1",
        "WARM preferred must be rejected; HOT account selected instead",
      );
      assert.notEqual(resolved.account?.id, "warm-1");
    },
  ),
);

test(
  "HOT selection: COLD preferred account -> HOT account selected instead",
  withTempAccounts(
    [
      { id: "hot-1", email: "hot1@t", password: "p" },
      { id: "cold-1", email: "cold1@t", password: "p" },
      { id: "cold-2", email: "cold2@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-1");
      // cold-1 and cold-2 are NOT headers-ready

      const resolved = resolveInitialAccount("cold-1");
      assert.equal(
        resolved.account?.id,
        "hot-1",
        "COLD preferred must be rejected; HOT account selected instead",
      );
    },
  ),
);

test(
  "HOT selection: sticky account WARM -> failover to HOT",
  withTempAccounts(
    [
      { id: "hot-a", email: "hota@t", password: "p" },
      { id: "warm-sticky", email: "warmsticky@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-a");
      // warm-sticky is NOT headers-ready

      // preferredAccountId=string simulates sticky pin
      const resolved = resolveInitialAccount("warm-sticky");
      assert.equal(
        resolved.account?.id,
        "hot-a",
        "WARM sticky must failover to HOT account",
      );
    },
  ),
);

test(
  "HOT selection: parallel escape never selects WARM/COLD",
  withTempAccounts(
    [
      { id: "hot-free", email: "hotfree@t", password: "p" },
      { id: "warm-busy", email: "warmbusy@t", password: "p" },
      { id: "cold-busy", email: "coldbusy@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-free");
      resetAccountConcurrencyForTests();

      // Parallel escape excludes sticky owner via resolveInitialAccount(null, [sticky])
      const resolved = resolveInitialAccount(null, ["warm-busy"]);
      if (resolved.account !== null) {
        assert.equal(
          isAccountHeadersReady(resolved.account.id),
          true,
          "parallel escape must only select HOT accounts",
        );
        assert.notEqual(resolved.account.id, "cold-busy");
      }
    },
  ),
);

test(
  "HOT selection: zero HOT accounts -> null (no cold account executed)",
  withTempAccounts(
    [
      { id: "cold-1", email: "cold1@t", password: "p" },
      { id: "cold-2", email: "cold2@t", password: "p" },
    ],
    () => {
      // No accounts marked headers-ready
      const resolved = resolveInitialAccount(undefined);
      assert.equal(
        resolved.account,
        null,
        "zero HOT accounts must return null, never a cold account",
      );
    },
  ),
);

test(
  "HOT selection: getNextHotAccount never returns non-HOT",
  withTempAccounts(
    [
      { id: "hot-x", email: "hotx@t", password: "p" },
      { id: "cold-y", email: "coldy@t", password: "p" },
      { id: "cold-z", email: "coldz@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-x");

      const picked = getNextHotAccount();
      assert.equal(picked?.id, "hot-x");

      // With hot-x excluded, no other HOT exists
      const picked2 = getNextHotAccount(new Set(["hot-x"]));
      assert.equal(picked2, null, "no HOT fallback when all HOT are excluded");
    },
  ),
);

test(
  "HOT selection: no repeated same-account 'not warmed' retry loop",
  withTempAccounts(
    [
      { id: "hot-a", email: "hota@t", password: "p" },
      { id: "cold-b", email: "coldb@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-a");
      resetRequestPathInvariantCountersForTests();

      // Simulate repeated selection attempts: the picker must never return
      // cold-b, so no retry loop can form on a non-HOT account.
      for (let i = 0; i < 10; i++) {
        const picked = getNextHotAccount();
        if (picked !== null) {
          assert.equal(
            isAccountHeadersReady(picked.id),
            true,
            `iteration ${i}: picker must only return HOT`,
          );
        }
      }

      const counters = getRequestPathInvariantCounters();
      assert.equal(counters.requestPathColdInitCount, 0);
      assert.equal(counters.requestPathWarmInitCount, 0);
      assert.equal(counters.requestPathNotHotExecutionCount, 0);
    },
  ),
);

test(
  "HOT selection: 40 concurrent requests never execute against non-HOT",
  withTempAccounts(
    [
      { id: "hot-pool-1", email: "hp1@t", password: "p" },
      { id: "hot-pool-2", email: "hp2@t", password: "p" },
      { id: "cold-pool-1", email: "cp1@t", password: "p" },
      { id: "cold-pool-2", email: "cp2@t", password: "p" },
    ],
    () => {
      markAccountHeadersReady("hot-pool-1");
      markAccountHeadersReady("hot-pool-2");
      resetAccountConcurrencyForTests();
      resetRequestPathInvariantCountersForTests();

      const selections: string[] = [];
      for (let i = 0; i < 40; i++) {
        const picked = getNextHotAccount();
        if (picked !== null) {
          selections.push(picked.id);
          assert.equal(
            isAccountHeadersReady(picked.id),
            true,
            `request ${i}: only HOT accounts may be selected`,
          );
        }
      }

      // Every selection must be a HOT account
      for (const id of selections) {
        assert.equal(
          isAccountHeadersReady(id),
          true,
          `selected account ${id} must be HOT`,
        );
        assert.ok(
          id === "hot-pool-1" || id === "hot-pool-2",
          `selected account ${id} must be from the HOT pool`,
        );
      }

      const counters = getRequestPathInvariantCounters();
      assert.equal(counters.requestPathNotHotExecutionCount, 0);
    },
  ),
);
