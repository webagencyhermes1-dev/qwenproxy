import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { getDatabase } from "../core/database.ts";
import {
  invalidateAccountsCache,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
  getAccountStateSnapshot,
  getHeadersReadyAccountIds,
  isAccountHeadersReady,
  markAccountHeadersReady,
  markAccountRateLimited,
  resetAccountManagerForTests,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { resetAccountStateForTests } from "../core/account-state.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import { resetAccountConcurrencyForTests } from "../core/account-concurrency.ts";
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

interface AccountRow {
  id: string;
  email: string;
  password: string;
  cooldown_until: number | null;
  cooldown_reason: number | null;
  disabled: number | null;
}

const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };

beforeEach(() => {
  resetAccountOwnershipForTests();
});

afterEach(() => {
  resetAccountOwnershipForTests();
  resetAccountManagerForTests();
  resetAccountStateForTests();
  resetAccountHealthForTests();
  resetAccountConcurrencyForTests();
  invalidateAccountsCache();
});

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
    .all() as AccountRow[];
  db.prepare("DELETE FROM accounts").run();
  try {
    db.prepare("DELETE FROM account_health").run();
  } catch {
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
      }
    }
    resetAccountConcurrencyForTests();
    resetAccountStateForTests();
    resetAccountHealthForTests();
    resetAccountManagerForTests();
    resetAccountOwnershipForTests();
    db.prepare("DELETE FROM accounts").run();
    const restore = db.prepare(
      "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason, disabled) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of existing) {
      restore.run(
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
    }
    invalidateAccountsCache();
    if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
  }
}

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

/** Mark READY through the state machine (bound equivalent of a warmup). */
function markReadyBound(id: string): void {
  const ownership = getAccountOwnership();
  ownership.transition(id, "WARMING", SYSTEM_FENCE, "test-warm");
  markAccountHeadersReady(id);
  assert.equal(ownership.getAccountStatus(id), "READY");
}

interface ExecutorOpts {
  initDelayMs?: number;
  failFor?: (accountId: string) => boolean;
}

function makeExecutor(
  initCalls: string[],
  opts: ExecutorOpts = {},
): (id: string) => Promise<WarmupOutcome> {
  return async (id: string) => {
    initCalls.push(id);
    if (opts.failFor?.(id)) return "failed";
    if (opts.initDelayMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts.initDelayMs);
        timer.unref?.();
      });
    }
    const ownership = getAccountOwnership();
    if (ownership.getAccountStatus(id) === "RECOVERING") {
      ownership.transition(id, "STANDBY", SYSTEM_FENCE, "recovery-requeue");
    }
    const claimed = ownership.transition(id, "WARMING", SYSTEM_FENCE, "warmup-start");
    if (!claimed.transitioned) return "failed";
    markAccountHeadersReady(id);
    return ownership.getAccountStatus(id) === "READY" ? "ready" : "failed";
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

function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
  assert.ok(predicate(), "timed out waiting for condition");
}

test("pool readiness: three accounts warm independently", async () => {
  const ids = ["apr-warm-a", "apr-warm-b", "apr-warm-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      bindPool(ids);
      const initCalls: string[] = [];
      const controller = makeController(3, 2, makeExecutor(initCalls));
      try {
        for (let pass = 0; pass < ids.length; pass++) {
          await controller.tick();
        }
        await waitFor(
          () => ids.every((id) => isAccountHeadersReady(id)),
          2000,
        );
        const ready = ids.filter((id) => isAccountHeadersReady(id));
        assert.ok(
          ready.length >= 2,
          `expected >= 2 READY accounts, got ${ready.length}`,
        );
        assert.equal(
          new Set(initCalls).size,
          initCalls.length,
          "no account may warm twice",
        );
      } finally {
        controller.stop();
      }
    },
  );
});

test("pool readiness: one account fails warmup, another still becomes ready", async () => {
  const ids = ["apr-fail-a", "apr-fail-b", "apr-fail-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      bindPool(ids);
      const initCalls: string[] = [];
      const controller = makeController(
        3,
        2,
        makeExecutor(initCalls, { failFor: (id) => id === "apr-fail-a" }),
      );
      try {
        for (let pass = 0; pass < 8; pass++) {
          if (
            isAccountHeadersReady("apr-fail-b") &&
            isAccountHeadersReady("apr-fail-c")
          ) {
            break;
          }
          await controller.tick();
          await settle(10);
        }
        assert.ok(
          !isAccountHeadersReady("apr-fail-a"),
          "failed account must not become READY",
        );
        assert.ok(isAccountHeadersReady("apr-fail-b"), "account B must become READY");
        assert.ok(isAccountHeadersReady("apr-fail-c"), "account C must become READY");
        assert.ok(initCalls.includes("apr-fail-b"));
        assert.ok(initCalls.includes("apr-fail-c"));
      } finally {
        controller.stop();
      }
    },
  );
});

test("pool readiness: ready account entering cooldown warms replacement", async () => {
  const ids = ["apr-cd-a", "apr-cd-b", "apr-cd-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      bindPool(ids);
      markReadyBound("apr-cd-a");
      markReadyBound("apr-cd-b");
      const initCalls: string[] = [];
      const controller = makeController(2, 2, makeExecutor(initCalls, { initDelayMs: 40 }));
      try {
        markAccountRateLimited("apr-cd-a", 3_600_000, "DailyQuota", {
          silent: true,
        });
        await controller.tick();
        await waitFor(
          () =>
            initCalls.includes("apr-cd-c") ||
            getAccountOwnership().getAccountStatus("apr-cd-c") !== "STANDBY" ||
            isAccountHeadersReady("apr-cd-c"),
          3000,
        );
        assert.ok(initCalls.includes("apr-cd-c"), "replacement account C must warm");
      } finally {
        controller.stop();
      }
    },
  );
});

test("pool readiness: cooldown event followed by a tick warms the standby", async () => {
  const ids = ["apr-trig-a", "apr-trig-b", "apr-trig-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      bindPool(ids);
      markReadyBound("apr-trig-a");
      markReadyBound("apr-trig-b");
      const initCalls: string[] = [];
      const controller = makeController(2, 2, makeExecutor(initCalls));
      try {
        markAccountRateLimited("apr-trig-a", 120_000, "RateLimited", {
          silent: true,
        });
        await controller.tick();
        await waitFor(() => initCalls.includes("apr-trig-c"), 3000);
        assert.ok(
          initCalls.includes("apr-trig-c"),
          "post-cooldown tick must warm the standby",
        );
      } finally {
        controller.stop();
      }
    },
  );
});

test("pool readiness: cooldown expiry requires revalidation", async () => {
  const id = "apr-revalidate-a";
  await withFreshAccounts([{ id, email: `${id}@test.com` }], async () => {
    markAccountHeadersReady(id);
    markAccountRateLimited(id, 100, "RateLimitTemporary", { silent: true });
    unmarkAccountHeadersReady(id);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
    assert.ok(
      !isAccountHeadersReady(id),
      "expired cooldown must not auto-restore READY",
    );
    assert.ok(
      !getAccountCooldownInfo(id),
      "expired cooldown must be gone from the map",
    );
  });
});

test("pool readiness: browser context death removes ready state", async () => {
  const ids = ["apr-death-a", "apr-death-b"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    () => {
      markAccountHeadersReady("apr-death-a");
      markAccountHeadersReady("apr-death-b");
      assert.ok(isAccountHeadersReady("apr-death-a"));
      unmarkAccountHeadersReady("apr-death-a");
      assert.ok(!isAccountHeadersReady("apr-death-a"));
      assert.ok(!getHeadersReadyAccountIds().includes("apr-death-a"));
      assert.ok(getHeadersReadyAccountIds().includes("apr-death-b"));
      assert.equal(getAccountStateSnapshot("apr-death-a"), "WARMING");
    },
  );
});

test("pool readiness: lazy failover warms standby and publishes readiness", async () => {
  const ids = ["apr-lazy-a", "apr-lazy-b"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      bindPool(ids);
      markAccountRateLimited("apr-lazy-a", 3_600_000, "DailyQuota", {
        silent: true,
      });
      const initCalls: string[] = [];
      const controller = makeController(1, 2, makeExecutor(initCalls));
      try {
        await controller.tick();
        await waitFor(() => initCalls.includes("apr-lazy-b"), 2000);
        assert.ok(initCalls.includes("apr-lazy-b"), "standby account must warm on demand");
        await waitFor(() => isAccountHeadersReady("apr-lazy-b"), 2000);
        assert.ok(
          isAccountHeadersReady("apr-lazy-b"),
          "standby account must become headers-ready",
        );
      } finally {
        controller.stop();
      }
    },
  );
});
