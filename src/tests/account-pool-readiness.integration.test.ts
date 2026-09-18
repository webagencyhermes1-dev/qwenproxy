import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { getDatabase } from "../core/database.ts";
import {
  invalidateAccountsCache,
  type QwenAccount,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
  getAccountStateSnapshot,
  getHeadersReadyAccountIds,
  getPoolStats,
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
  ensurePoolReadiness,
  getWarmingAccountIds,
  registerReadinessGuardDeps,
  stopReadinessGuardSweep,
} from "../core/readiness-guard.ts";
import { config } from "../core/config.ts";

interface AccountRow {
  id: string;
  email: string;
  password: string;
  cooldown_until: number | null;
  cooldown_reason: string | null;
  disabled: number | null;
}

let priorChatPoolModels: string[] = [];

beforeEach(() => {
  stopReadinessGuardSweep();
  priorChatPoolModels = config.qwen.chatPoolModels;
  config.qwen.chatPoolModels = ["qwen3.6-plus"];
});

afterEach(() => {
  registerReadinessGuardDeps(null);
  stopReadinessGuardSweep();
  config.qwen.chatPoolModels = priorChatPoolModels;
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
    registerReadinessGuardDeps(null);
    resetAccountConcurrencyForTests();
    resetAccountStateForTests();
    resetAccountHealthForTests();
    resetAccountManagerForTests();
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

function registerDeps(
  opts: {
    initDelayMs?: number;
    failFor?: (accountId: string) => boolean;
    onInitFailure?: (accountId: string) => void;
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
        password: "secret",
      }) as QwenAccount,
    initPlaywrightForAccount: async (account) => {
      initCalls.push(account.id);
      if (opts.failFor?.(account.id)) {
        opts.onInitFailure?.(account.id);
        throw new Error(`mock warmup failure: ${account.id}`);
      }
      const delay = opts.initDelayMs ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
      }
    },
    disableNativeTools: async () => {},
    warmQwenChatPool: async () => {},
  });

  return {
    initCalls,
    release: () => {
      registerReadinessGuardDeps(null);
    },
  };
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
      const { initCalls, release } = registerDeps();
      try {
        for (let pass = 0; pass < ids.length; pass++) {
          await ensurePoolReadiness();
        }
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
        release();
      }
    },
  );
});

test("pool readiness: one account fails warmup, another still becomes ready", async () => {
  const ids = ["apr-fail-a", "apr-fail-b", "apr-fail-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      const { initCalls, release } = registerDeps({
        failFor: (id) => id === "apr-fail-a",
      });
      try {
        for (let pass = 0; pass < 8; pass++) {
          if (
            isAccountHeadersReady("apr-fail-b") &&
            isAccountHeadersReady("apr-fail-c")
          ) {
            break;
          }
          await ensurePoolReadiness();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10);
            timer.unref?.();
          });
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
        release();
      }
    },
  );
});

test("pool readiness: ready account entering cooldown warms replacement", async () => {
  const ids = ["apr-cd-a", "apr-cd-b", "apr-cd-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      markAccountHeadersReady("apr-cd-a");
      markAccountHeadersReady("apr-cd-b");
      const { initCalls, release } = registerDeps({ initDelayMs: 40 });
      try {
        markAccountRateLimited("apr-cd-a", 3_600_000, "DailyQuota", {
          silent: true,
        });
        await waitFor(
          () =>
            initCalls.includes("apr-cd-c") ||
            getWarmingAccountIds().includes("apr-cd-c") ||
            isAccountHeadersReady("apr-cd-c"),
          3000,
        );
        assert.ok(initCalls.includes("apr-cd-c"), "replacement account C must warm");
      } finally {
        release();
      }
    },
  );
});

test("pool readiness: cooldown event triggers readiness controller", async () => {
  const ids = ["apr-trig-a", "apr-trig-b", "apr-trig-c"];
  await withFreshAccounts(
    ids.map((id) => ({ id, email: `${id}@test.com` })),
    async () => {
      markAccountHeadersReady("apr-trig-a");
      markAccountHeadersReady("apr-trig-b");
      const { initCalls, release } = registerDeps();
      try {
        markAccountRateLimited("apr-trig-a", 120_000, "RateLimited", {
          silent: true,
        });
        await waitFor(() => initCalls.includes("apr-trig-c"), 3000);
        assert.ok(
          initCalls.includes("apr-trig-c"),
          "cooldown trigger must run a readiness check that warms the standby",
        );
      } finally {
        release();
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
    const { initCalls, release } = registerDeps();
    try {
      await ensurePoolReadiness();
      await waitFor(() => initCalls.includes(id), 2000);
      assert.ok(isAccountHeadersReady(id));
    } finally {
      release();
    }
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
      markAccountRateLimited("apr-lazy-a", 3_600_000, "DailyQuota", {
        silent: true,
      });
      const { initCalls, release } = registerDeps();
      try {
        await ensurePoolReadiness();
        assert.ok(initCalls.includes("apr-lazy-b"), "standby account must warm on demand");
        assert.ok(
          isAccountHeadersReady("apr-lazy-b"),
          "standby account must become headers-ready",
        );
        const stats = getPoolStats();
        assert.equal(stats.ready, 1);
        assert.equal(stats.states["apr-lazy-b"], "READY");
        assert.equal(stats.states["apr-lazy-a"], "COOLDOWN");
      } finally {
        release();
      }
    },
  );
});
