import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareQwenRuntime } from "../api/server.ts";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import { config } from "../core/config.ts";
import {
  clearAccountBroken,
  isAccountFlaggedBroken,
} from "../core/account-state.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import {
  PERMANENT_INIT_COOLDOWN_MS,
  PermanentAuthError,
} from "../services/playwright.ts";

const accountId = "test-init-failure-cooldown";

async function runInitFailure(initAuth: () => Promise<void>): Promise<boolean> {
  return prepareQwenRuntime({
    accountId,
    successMessage: "ready",
    failureMessage: "init failed",
    initAuth,
    disableNativeTools: async () => {},
    warmQwenChatPool: async () => {},
  });
}

test("permanent auth failure parks the account for 24h instead of the short init cooldown", async () => {
  clearAccountCooldown(accountId);
  clearAccountBroken(accountId);
  try {
    const ok = await runInitFailure(async () => {
      throw new PermanentAuthError("wrong password");
    });
    assert.equal(ok, false);
    const info = getAccountCooldownInfo(accountId);
    assert.ok(info, "account must be on cooldown");
    assert.ok(
      info.reason.startsWith("AuthPermanentFailure"),
      `expected a permanent reason, got ${info.reason}`,
    );
    assert.ok(
      info.remainingMs > 12 * 60 * 60 * 1000,
      `permanent window must be ~24h, got ${info.remainingMs}ms`,
    );
    assert.ok(info.remainingMs <= PERMANENT_INIT_COOLDOWN_MS);
  } finally {
    clearAccountCooldown(accountId);
    clearAccountBroken(accountId);
  }
});

test("transient init failure keeps the short AuthInitFailed cooldown", async () => {
  clearAccountCooldown(accountId);
  try {
    const ok = await runInitFailure(async () => {
      throw new Error("Navigation timeout of 30000 ms exceeded");
    });
    assert.equal(ok, false);
    const info = getAccountCooldownInfo(accountId);
    assert.ok(info, "account must be on cooldown");
    assert.equal(info.reason, "AuthInitFailed");
    assert.ok(
      info.remainingMs <= config.concurrency.initFailureCooldownMs,
      `short cooldown expected, got ${info.remainingMs}ms`,
    );
    assert.ok(info.remainingMs > 0);
  } finally {
    clearAccountCooldown(accountId);
  }
});

test("a permanent window set during init is not shortened by the transient cooldown", async () => {
  clearAccountCooldown(accountId);
  try {
    const ok = await runInitFailure(async () => {
      markAccountRateLimited(
        accountId,
        PERMANENT_INIT_COOLDOWN_MS,
        "AuthPermanentFailure: invalid credentials",
      );
      throw new Error(
        `Session expired for ${accountId} and re-authentication failed`,
      );
    });
    assert.equal(ok, false);
    const info = getAccountCooldownInfo(accountId);
    assert.ok(info, "permanent window must survive the init failure cooldown");
    assert.equal(info.reason, "AuthPermanentFailure: invalid credentials");
    assert.ok(
      info.remainingMs > 60 * 60 * 1000,
      `must stay parked ~24h, got ${info.remainingMs}ms`,
    );
  } finally {
    clearAccountCooldown(accountId);
  }
});

test("repeated init failures still escalate the account to broken", async () => {
  clearAccountCooldown(accountId);
  clearAccountBroken(accountId);
  resetAccountHealthForTests();
  try {
    for (let i = 0; i < 3; i++) {
      clearAccountCooldown(accountId);
      const ok = await runInitFailure(async () => {
        throw new Error("boom");
      });
      assert.equal(ok, false);
    }
    assert.equal(
      isAccountFlaggedBroken(accountId),
      true,
      "escalation must still mark the account broken",
    );
  } finally {
    clearAccountCooldown(accountId);
    clearAccountBroken(accountId);
    resetAccountHealthForTests();
  }
});
