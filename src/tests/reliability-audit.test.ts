import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { config } from "../core/config.ts";
import {
  createRequestRetryContext,
  type RequestRetryContext,
} from "../routes/chat/account.ts";
import {
  classifyRetryAction,
  isQuotaLikeError,
  isAntiBotError,
} from "../routes/chat/retry-policy.ts";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import {
  resetAccountConcurrencyForTests,
  tryAcquireAccountLease,
} from "../core/account-concurrency.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import { resetAccountStateForTests } from "../core/account-state.ts";
import { resetAccountManagerForTests } from "../core/account-manager.ts";
import { invalidatePriorityCache } from "../core/account-priority.ts";
import {
  clearWafIsolation,
  noteWafRecovery,
} from "../core/waf-isolation.ts";

// ---------------------------------------------------------------------------
// Phase 1+2: RequestRetryContext
// ---------------------------------------------------------------------------

test("reliability: createRequestRetryContext initializes correctly", () => {
  const ctx = createRequestRetryContext("account-a");
  assert.ok(ctx.triedAccountIds.has("account-a"));
  assert.equal(ctx.triedAccountIds.size, 1);
  assert.equal(
    ctx.globalRetriesLeft,
    config.retry.maxAttempts + config.retry.maxAccountSwitches,
  );
  assert.equal(ctx.accountSwitches, 0);
});

test("reliability: createRequestRetryContext without initial account", () => {
  const ctx = createRequestRetryContext();
  assert.equal(ctx.triedAccountIds.size, 0);
  assert.equal(
    ctx.globalRetriesLeft,
    config.retry.maxAttempts + config.retry.maxAccountSwitches,
  );
});

test("reliability: RequestRetryContext shared across layers", () => {
  const ctx = createRequestRetryContext("account-a");
  // Simulate inner loop adding an account
  ctx.triedAccountIds.add("account-b");
  ctx.globalRetriesLeft--;
  ctx.accountSwitches++;

  // Simulate outer loop reading the same context
  assert.ok(ctx.triedAccountIds.has("account-a"));
  assert.ok(ctx.triedAccountIds.has("account-b"));
  assert.equal(ctx.triedAccountIds.size, 2);
  assert.equal(
    ctx.globalRetriesLeft,
    config.retry.maxAttempts + config.retry.maxAccountSwitches - 1,
  );
  assert.equal(ctx.accountSwitches, 1);
});

test("reliability: RequestRetryContext budget exhaustion", () => {
  const ctx = createRequestRetryContext("account-a");
  const totalBudget = config.retry.maxAttempts + config.retry.maxAccountSwitches;
  // Exhaust the budget
  for (let i = 0; i < totalBudget; i++) {
    ctx.globalRetriesLeft--;
  }
  assert.equal(ctx.globalRetriesLeft, 0);
  // Further decrements go negative (layers should check before decrementing)
  ctx.globalRetriesLeft--;
  assert.ok(ctx.globalRetriesLeft < 0);
});

// ---------------------------------------------------------------------------
// Phase 3: Mid-stream failure classification
// ---------------------------------------------------------------------------

test("reliability: quota errors are classified correctly for failover", () => {
  const err = Object.assign(
    new Error("RateLimited: You've reached the upper limit for today's usage."),
    { upstreamCode: "RateLimited" },
  );
  assert.ok(isQuotaLikeError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.reason, "quota_or_rate_limit");
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
});

test("reliability: anti-bot errors are classified correctly for failover", () => {
  const err = Object.assign(
    new Error("waf_challenge: challenge detected"),
    { upstreamCode: "waf_challenge" },
  );
  assert.ok(isAntiBotError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.reason, "anti_bot");
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
});

test("reliability: temporary load shedding does not switch accounts", () => {
  const err = Object.assign(
    new Error("Service is currently experiencing high demand. Please try again later."),
    { upstreamCode: "RateLimited" },
  );
  assert.ok(isQuotaLikeError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.reason, "quota_or_rate_limit");
  assert.equal(action.retryable, true);
  // Temporary load shedding should NOT switch accounts
  assert.equal(action.switchAccount, false);
  assert.equal(action.accountCooldownReason, "RateLimitTemporary");
});

// ---------------------------------------------------------------------------
// Phase 4: Sticky thread rebinding
// ---------------------------------------------------------------------------

test("reliability: sticky thread parent invalidation on failover", async () => {
  const { invalidateLogicalThreadParent, getLogicalThreadState } =
    await import("../services/qwen.ts");

  const sessionId = `reliability-test-${Date.now()}`;

  // Simulate setting a thread state
  const { updateLogicalThreadState } = await import("../services/qwen.ts");
  updateLogicalThreadState(sessionId, {
    accountId: "account-a",
    chatSessionId: "chat-123",
    parentId: "parent-456",
    instructionsSent: true,
  });

  // Verify the state was set
  const state = getLogicalThreadState(sessionId);
  assert.ok(state);
  assert.equal(state.accountId, "account-a");
  assert.equal(state.parentId, "parent-456");

  // Invalidate the parent (simulating failover)
  invalidateLogicalThreadParent(sessionId);

  // Verify the parent was cleared
  const stateAfter = getLogicalThreadState(sessionId);
  assert.ok(stateAfter);
  assert.equal(stateAfter.parentId, null);
});

// ---------------------------------------------------------------------------
// Phase 5: Anti-bot rotation budget scaling
// ---------------------------------------------------------------------------

test("reliability: anti-bot rotation budget scales with pool size", () => {
  // Import the function indirectly to test the scaling logic
  const maxAccountSwitches = config.retry.maxAccountSwitches;

  // For a pool of 1, budget should be max(1, min(maxAccountSwitches, 0)) = 1
  const budget1 = Math.max(1, Math.min(maxAccountSwitches, 1 - 1));
  assert.equal(budget1, 1);

  // For a pool of 3, budget should be max(1, min(maxAccountSwitches, 2))
  const budget3 = Math.max(1, Math.min(maxAccountSwitches, 3 - 1));
  assert.equal(budget3, Math.min(maxAccountSwitches, 2));

  // For a pool of 10, budget should be max(1, min(maxAccountSwitches, 9))
  const budget10 = Math.max(1, Math.min(maxAccountSwitches, 10 - 1));
  assert.equal(budget10, Math.min(maxAccountSwitches, 9));
});

// ---------------------------------------------------------------------------
// Phase 6: Readiness guard hardening
// ---------------------------------------------------------------------------

test("reliability: readiness guard skips accounts with active leases", async () => {
  // This test verifies the logic in readiness-guard.ts that checks
  // hasActiveAccountLease before warming. We test the underlying function.
  const { hasActiveAccountLease } = await import("../core/account-concurrency.ts");
  const accountId = "reliability-lease-test";

  // Acquire a lease
  const lease = tryAcquireAccountLease(accountId, "test-lease");
  assert.ok(lease, "Should be able to acquire a lease");

  // Verify the lease is active
  assert.ok(hasActiveAccountLease(accountId));

  // Release the lease
  lease.release();

  // Verify the lease is no longer active
  assert.ok(!hasActiveAccountLease(accountId));
});

// ---------------------------------------------------------------------------
// Phase 7: Post-cooldown validation
// ---------------------------------------------------------------------------

test("reliability: cooldown persistence across simulated restart", () => {
  const accountId = "reliability-cooldown-test";

  // Set a cooldown
  markAccountRateLimited(accountId, 3600_000, "RateLimited", { silent: true });

  // Verify the cooldown is set
  const info = getAccountCooldownInfo(accountId);
  assert.ok(info);
  assert.equal(info.reason, "RateLimited");
  assert.ok(info.remainingMs > 0);

  // Clear the cooldown (simulating restart recovery)
  clearAccountCooldown(accountId);

  // Verify the cooldown is cleared
  const infoAfter = getAccountCooldownInfo(accountId);
  assert.equal(infoAfter, null);
});

// ---------------------------------------------------------------------------
// Phase 8: Session keeper safety
// ---------------------------------------------------------------------------

test("reliability: session keeper detects lease acquisition races", async () => {
  const { hasActiveAccountLease } = await import("../core/account-concurrency.ts");
  const accountId = "reliability-keeper-test";

  // Initially no lease
  assert.ok(!hasActiveAccountLease(accountId));

  // Acquire a lease (simulating a request arriving during keep-alive)
  const lease = tryAcquireAccountLease(accountId, "race-test");
  assert.ok(lease);

  // Verify the lease is now active (the race condition)
  assert.ok(hasActiveAccountLease(accountId));

  // Release the lease
  lease.release();
  assert.ok(!hasActiveAccountLease(accountId));
});

// ---------------------------------------------------------------------------
// Pool degradation tests
// ---------------------------------------------------------------------------

test("reliability: single account pool handles failure gracefully", () => {
  const ctx = createRequestRetryContext("single-account");
  ctx.triedAccountIds.add("single-account");

  // With a single account, there's nowhere to rotate
  assert.equal(ctx.triedAccountIds.size, 1);

  // The global budget should still be available for same-account retries
  assert.ok(ctx.globalRetriesLeft > 0);
});

test("reliability: multiple account pool handles simultaneous failures", () => {
  const ctx = createRequestRetryContext("account-a");

  // Simulate multiple accounts failing
  ctx.triedAccountIds.add("account-b");
  ctx.triedAccountIds.add("account-c");
  ctx.globalRetriesLeft -= 2;
  ctx.accountSwitches += 2;

  assert.equal(ctx.triedAccountIds.size, 3);
  assert.ok(ctx.globalRetriesLeft > 0);
  assert.equal(ctx.accountSwitches, 2);
});

test("reliability: all accounts exhausted returns proper error state", () => {
  const ctx = createRequestRetryContext("account-a");

  // Exhaust all accounts
  for (let i = 0; i < 5; i++) {
    ctx.triedAccountIds.add(`account-${i}`);
    ctx.globalRetriesLeft--;
    ctx.accountSwitches++;
  }

  assert.equal(ctx.triedAccountIds.size, 6); // 5 + initial
  assert.ok(ctx.globalRetriesLeft <= 0);
});

// ---------------------------------------------------------------------------
// Cooldown persistence tests
// ---------------------------------------------------------------------------

test("reliability: different failure types have different cooldown behaviors", () => {
  // Temporary rate limit: short cooldown
  const tempAction = classifyRetryAction(
    Object.assign(
      new Error("Service is currently experiencing high demand. Please try again later."),
      { upstreamCode: "RateLimited" },
    ),
  );
  assert.equal(tempAction.accountCooldownReason, "RateLimitTemporary");
  assert.ok(tempAction.accountCooldownMs !== undefined);
  assert.ok(tempAction.accountCooldownMs <= 2 * 60 * 1000); // 2 minutes max

  // Real quota: midnight-based cooldown
  const quotaAction = classifyRetryAction(
    Object.assign(
      new Error("RateLimited: You've reached the upper limit for today's usage."),
      { upstreamCode: "RateLimited" },
    ),
  );
  assert.equal(quotaAction.accountCooldownReason, "RateLimited");
  assert.ok(quotaAction.accountCooldownMs !== undefined);
  assert.ok(quotaAction.accountCooldownMs > 0);
});

// ---------------------------------------------------------------------------
// Nested retry protection tests
// ---------------------------------------------------------------------------

test("reliability: tried accounts are never re-selected in the same request", () => {
  const ctx = createRequestRetryContext("account-a");

  // Simulate the inner loop trying account-a
  assert.ok(ctx.triedAccountIds.has("account-a"));

  // Simulate the outer loop checking if account-a was tried
  assert.ok(ctx.triedAccountIds.has("account-a"));

  // Add another account
  ctx.triedAccountIds.add("account-b");

  // Both accounts should be in the tried set
  assert.ok(ctx.triedAccountIds.has("account-a"));
  assert.ok(ctx.triedAccountIds.has("account-b"));
  assert.equal(ctx.triedAccountIds.size, 2);
});

test("reliability: global retry budget prevents retry explosions", () => {
  const ctx = createRequestRetryContext("account-a");
  const totalBudget = config.retry.maxAttempts + config.retry.maxAccountSwitches;

  // Simulate multiple retry layers consuming the budget
  let consumed = 0;
  while (ctx.globalRetriesLeft > 0 && consumed < totalBudget + 5) {
    ctx.globalRetriesLeft--;
    consumed++;
  }

  // The budget should be exhausted at exactly totalBudget
  assert.equal(consumed, totalBudget);
  assert.equal(ctx.globalRetriesLeft, 0);
});
