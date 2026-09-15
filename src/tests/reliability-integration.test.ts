import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { config } from "../core/config.ts";
import {
  computeQuotaCooldownMs,
  clearAccountCooldown,
  getAccountCooldownInfo,
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  markAccountRateLimited,
  resetAccountManagerForTests,
} from "../core/account-manager.ts";
import {
  createRequestRetryContext,
  healthKindForFailure,
  jitterChatInProgressDelay,
  quarantineChallengedAccountOnce,
  shouldWaitQueueForever,
} from "../routes/chat/account.ts";
import {
  classifyRetryAction,
  isContentModerationError,
  isModelNotFoundError,
  isQuotaLikeError,
  isAntiBotError,
  isNetworkLikeError,
  isCorruptedChatHistoryError,
  shouldRetryChatInProgressOnSameAccount,
  shouldRetryInvalidInputOnSameAccount,
} from "../routes/chat/retry-policy.ts";
import {
  clearWafIsolation,
  getWafHardBlockCount,
  noteWafRecovery,
  recordWafHardBlock,
} from "../core/waf-isolation.ts";
import {
  resetAccountConcurrencyForTests,
  tryAcquireAccountLease,
  hasActiveAccountLease,
} from "../core/account-concurrency.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import { resetAccountStateForTests } from "../core/account-state.ts";
import { invalidatePriorityCache } from "../core/account-priority.ts";

// ---------------------------------------------------------------------------
// healthKindForFailure mapping
// ---------------------------------------------------------------------------

test("healthKindForFailure: terminal errors return null (no health penalty)", () => {
  assert.equal(healthKindForFailure("terminal_local"), null);
  assert.equal(healthKindForFailure("content_moderation"), null);
  assert.equal(healthKindForFailure("model_not_found"), null);
  assert.equal(healthKindForFailure("client_abort"), null);
  assert.equal(healthKindForFailure("unknown_not_retryable"), null);
});

test("healthKindForFailure: quota maps to quota or rate_limit by cooldown reason", () => {
  assert.equal(healthKindForFailure("quota_or_rate_limit", "RateLimitTemporary"), "rate_limit");
  assert.equal(healthKindForFailure("quota_or_rate_limit", "RateLimited"), "quota");
  assert.equal(healthKindForFailure("quota_or_rate_limit"), "quota");
});

test("healthKindForFailure: anti_bot maps to waf", () => {
  assert.equal(healthKindForFailure("anti_bot"), "waf");
});

test("healthKindForFailure: network-like reasons map to network", () => {
  assert.equal(healthKindForFailure("account_initialization_failed"), "network");
  assert.equal(healthKindForFailure("network_error"), "network");
  assert.equal(healthKindForFailure("upstream_unavailable"), "network");
  assert.equal(healthKindForFailure("upstream_error"), "network");
  assert.equal(healthKindForFailure("account_busy"), "network");
  assert.equal(healthKindForFailure("stream_aborted"), "network");
});

test("healthKindForFailure: unknown reasons map to generic", () => {
  assert.equal(healthKindForFailure("chat_not_exist"), "generic");
  assert.equal(healthKindForFailure("invalid_input"), "generic");
  assert.equal(healthKindForFailure("some_future_reason"), "generic");
});

// ---------------------------------------------------------------------------
// computeQuotaCooldownMs
// ---------------------------------------------------------------------------

test("computeQuotaCooldownMs: mid-day returns hours until midnight + margin", () => {
  const noonUtc = new Date("2026-09-15T12:00:00Z").getTime();
  const cooldown = computeQuotaCooldownMs(noonUtc);
  const expectedMs = 12 * 60 * 60 * 1000 + 5 * 60 * 1000;
  assert.equal(cooldown, expectedMs);
});

test("computeQuotaCooldownMs: near midnight returns short cooldown", () => {
  const almostMidnight = new Date("2026-09-15T23:50:00Z").getTime();
  const cooldown = computeQuotaCooldownMs(almostMidnight);
  const expectedMs = 10 * 60 * 1000 + 5 * 60 * 1000;
  assert.equal(cooldown, expectedMs);
});

test("computeQuotaCooldownMs: just after midnight is capped at 24h - 1m", () => {
  const justAfterMidnight = new Date("2026-09-15T00:01:00Z").getTime();
  const cooldown = computeQuotaCooldownMs(justAfterMidnight);
  const maxCooldown = 24 * 60 * 60 * 1000 - 60_000;
  assert.equal(cooldown, maxCooldown);
});

test("computeQuotaCooldownMs: never returns less than 60s", () => {
  const edge = new Date("2026-09-15T23:59:30Z").getTime();
  const cooldown = computeQuotaCooldownMs(edge);
  assert.ok(cooldown >= 60_000);
});

// ---------------------------------------------------------------------------
// Content moderation: non-retryable
// ---------------------------------------------------------------------------

test("content moderation errors are non-retryable", () => {
  const err = Object.assign(
    new Error("data_inspection_failed: Content safety warning"),
    { upstreamCode: "data_inspection_failed" },
  );
  assert.ok(isContentModerationError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, false);
  assert.equal(action.reason, "content_moderation");
  assert.equal(action.switchAccount, false);
});

test("content moderation: Portuguese variant detected", () => {
  const err = Object.assign(
    new Error("Aviso de segurança do conteúdo: os dados inseridos podem conter conteúdo inadequado!"),
    { upstreamCode: "data_inspection_failed" },
  );
  assert.ok(isContentModerationError(err));
});

test("content moderation: healthKindForFailure returns null", () => {
  assert.equal(healthKindForFailure("content_moderation"), null);
});

// ---------------------------------------------------------------------------
// Model not found: non-retryable
// ---------------------------------------------------------------------------

test("model not found errors are non-retryable", () => {
  const err = Object.assign(
    new Error("Not_Found: Model not found"),
    { upstreamCode: "Not_Found" },
  );
  assert.ok(isModelNotFoundError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, false);
  assert.equal(action.reason, "model_not_found");
  assert.equal(action.switchAccount, false);
});

test("model not found: message-only variant", () => {
  const err = new Error("The requested model not found in this account");
  assert.ok(isModelNotFoundError(err));
});

// ---------------------------------------------------------------------------
// WAF isolation escalation
// ---------------------------------------------------------------------------

test("waf isolation: first block uses base cooldown", () => {
  const accountId = "waf-test-1";
  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
  resetAccountHealthForTests();

  const result = recordWafHardBlock(accountId);
  assert.equal(result.cooldownMs, config.captcha.accountCooldownMs);
  assert.equal(result.escalated, false);
  assert.equal(result.fingerprintRotated, true);
  assert.equal(getWafHardBlockCount(accountId), 1);

  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
});

test("waf isolation: consecutive blocks escalate cooldown exponentially", () => {
  const accountId = "waf-test-2";
  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
  resetAccountHealthForTests();

  const base = config.captcha.accountCooldownMs;
  const cap = config.captcha.hardBlockMaxCooldownMs;

  const r1 = recordWafHardBlock(accountId);
  assert.equal(r1.cooldownMs, base);
  assert.equal(r1.escalated, false);

  clearAccountCooldown(accountId);
  const r2 = recordWafHardBlock(accountId);
  assert.equal(r2.cooldownMs, Math.min(cap, base * 2));
  assert.equal(r2.escalated, true);

  clearAccountCooldown(accountId);
  const r3 = recordWafHardBlock(accountId);
  assert.equal(r3.cooldownMs, Math.min(cap, base * 4));
  assert.equal(r3.escalated, true);

  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
});

test("waf isolation: recovery resets escalation streak", () => {
  const accountId = "waf-test-3";
  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
  resetAccountHealthForTests();

  recordWafHardBlock(accountId);
  recordWafHardBlock(accountId);
  assert.equal(getWafHardBlockCount(accountId), 2);

  noteWafRecovery(accountId);
  assert.equal(getWafHardBlockCount(accountId), 0);

  clearAccountCooldown(accountId);
  const result = recordWafHardBlock(accountId);
  assert.equal(result.cooldownMs, config.captcha.accountCooldownMs);
  assert.equal(result.escalated, false);

  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
});

// ---------------------------------------------------------------------------
// quarantineChallengedAccountOnce idempotency
// ---------------------------------------------------------------------------

test("quarantineChallengedAccountOnce: quarantines only once per challenge", () => {
  const accountId = "quarantine-test-1";
  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
  resetAccountHealthForTests();

  const err = Object.assign(
    new Error("waf_challenge: verify you are human"),
    { upstreamCode: "waf_challenge" },
  );

  const first = quarantineChallengedAccountOnce(err, accountId, "test@example.com", {});
  assert.ok(first);
  assert.ok(first.cooldownMs > 0);

  const second = quarantineChallengedAccountOnce(err, accountId, "test@example.com", {});
  assert.equal(second, null);

  clearWafIsolation(accountId);
  clearAccountCooldown(accountId);
});

test("quarantineChallengedAccountOnce: skips global account", () => {
  const err = new Error("waf_challenge");
  const result = quarantineChallengedAccountOnce(err, "global", "global", {});
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// jitterChatInProgressDelay
// ---------------------------------------------------------------------------

test("jitterChatInProgressDelay: base delay for early retries", () => {
  const delay = jitterChatInProgressDelay(1, 1500, () => 0.5);
  assert.ok(delay >= 1);
  assert.ok(delay <= 20_000);
});

test("jitterChatInProgressDelay: doubles base from 4th retry", () => {
  const early = jitterChatInProgressDelay(1, 1500, () => 0.5);
  const late = jitterChatInProgressDelay(4, 1500, () => 0.5);
  assert.ok(late > early);
});

test("jitterChatInProgressDelay: scales with prompt size", () => {
  const small = jitterChatInProgressDelay(1, 1500, () => 0.5, 100);
  const large = jitterChatInProgressDelay(1, 1500, () => 0.5, 3_000_000);
  assert.ok(large > small);
});

test("jitterChatInProgressDelay: capped at 20s", () => {
  const delay = jitterChatInProgressDelay(10, 100_000, () => 1.0, 5_000_000);
  assert.ok(delay <= 20_000);
});

// ---------------------------------------------------------------------------
// shouldWaitQueueForever
// ---------------------------------------------------------------------------

test("shouldWaitQueueForever: thread owner same session waits", () => {
  assert.equal(shouldWaitQueueForever(true, false, true), true);
});

test("shouldWaitQueueForever: thread owner held by other session does not wait", () => {
  assert.equal(shouldWaitQueueForever(true, true, true), false);
});

test("shouldWaitQueueForever: no free alternate forces wait", () => {
  assert.equal(shouldWaitQueueForever(false, false, false), true);
});

test("shouldWaitQueueForever: free alternate available allows rotation", () => {
  assert.equal(shouldWaitQueueForever(false, false, true), false);
});

// ---------------------------------------------------------------------------
// shouldRetryChatInProgressOnSameAccount
// ---------------------------------------------------------------------------

test("shouldRetryChatInProgressOnSameAccount: allows up to 3 same-account retries", () => {
  assert.equal(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 0), true);
  assert.equal(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 1), true);
  assert.equal(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 2), true);
  assert.equal(shouldRetryChatInProgressOnSameAccount("chat_in_progress", 3), false);
});

test("shouldRetryChatInProgressOnSameAccount: other reasons never match", () => {
  assert.equal(shouldRetryChatInProgressOnSameAccount("quota_or_rate_limit", 0), false);
  assert.equal(shouldRetryChatInProgressOnSameAccount("anti_bot", 0), false);
});

// ---------------------------------------------------------------------------
// shouldRetryInvalidInputOnSameAccount
// ---------------------------------------------------------------------------

test("shouldRetryInvalidInputOnSameAccount: first retry stays on same account", () => {
  assert.equal(shouldRetryInvalidInputOnSameAccount("invalid_input", false), true);
  assert.equal(shouldRetryInvalidInputOnSameAccount("corrupted_chat_history", false), true);
});

test("shouldRetryInvalidInputOnSameAccount: second retry rotates", () => {
  assert.equal(shouldRetryInvalidInputOnSameAccount("invalid_input", true), false);
  assert.equal(shouldRetryInvalidInputOnSameAccount("corrupted_chat_history", true), false);
});

// ---------------------------------------------------------------------------
// Corrupted chat history classification
// ---------------------------------------------------------------------------

test("corrupted chat history: forces new chat with full prompt", () => {
  const err = new Error("first message must not assistant message");
  assert.ok(isCorruptedChatHistoryError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
  assert.equal(action.reason, "corrupted_chat_history");
});

// ---------------------------------------------------------------------------
// Network-like error classification
// ---------------------------------------------------------------------------

test("network errors: retryable with switch", () => {
  const err = new Error("fetch failed");
  assert.ok(isNetworkLikeError(err));
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "network");
  assert.equal(action.forceNewChat, true);
});

test("network errors: ECONNRESET variant", () => {
  const err = new Error("read ECONNRESET");
  assert.ok(isNetworkLikeError(err));
});

test("network errors: socket hang up", () => {
  const err = new Error("socket hang up");
  assert.ok(isNetworkLikeError(err));
});

// ---------------------------------------------------------------------------
// RequestRetryContext isolation between inner/outer loops
// ---------------------------------------------------------------------------

test("retry context: inner loop uses its own triedAccounts set", () => {
  const ctx = createRequestRetryContext("account-a");
  assert.ok(ctx.triedAccountIds.has("account-a"));
  assert.equal(ctx.triedAccountIds.size, 1);

  ctx.triedAccountIds.add("account-b");
  assert.equal(ctx.triedAccountIds.size, 2);

  ctx.globalRetriesLeft--;
  ctx.accountSwitches++;
  assert.equal(ctx.accountSwitches, 1);
  assert.equal(
    ctx.globalRetriesLeft,
    config.retry.maxAttempts + config.retry.maxAccountSwitches - 1,
  );
});

test("retry context: single-account pool retains budget for same-account retries", () => {
  const ctx = createRequestRetryContext("only-account");
  const totalBudget = config.retry.maxAttempts + config.retry.maxAccountSwitches;
  assert.equal(ctx.globalRetriesLeft, totalBudget);
  assert.equal(ctx.triedAccountIds.size, 1);
  assert.ok(ctx.triedAccountIds.has("only-account"));
});

test("retry context: budget decremented only on actual account switch", () => {
  const ctx = createRequestRetryContext("account-a");
  const initial = ctx.globalRetriesLeft;

  ctx.globalRetriesLeft--;
  ctx.accountSwitches++;
  ctx.triedAccountIds.add("account-b");

  assert.equal(ctx.globalRetriesLeft, initial - 1);
  assert.equal(ctx.accountSwitches, 1);
  assert.equal(ctx.triedAccountIds.size, 2);
});

// ---------------------------------------------------------------------------
// Headers-ready gate
// ---------------------------------------------------------------------------

test("headers-ready gate: mark/unmark/isReady lifecycle", () => {
  const id = "gate-test-account";
  unmarkAccountHeadersReady(id);
  assert.equal(isAccountHeadersReady(id), false);

  markAccountHeadersReady(id);
  assert.equal(isAccountHeadersReady(id), true);

  unmarkAccountHeadersReady(id);
  assert.equal(isAccountHeadersReady(id), false);
});

test("headers-ready gate: global account id is ignored", () => {
  markAccountHeadersReady("global");
  assert.equal(isAccountHeadersReady("global"), false);
});

// ---------------------------------------------------------------------------
// Cooldown lifecycle
// ---------------------------------------------------------------------------

test("cooldown: set, query, clear lifecycle", () => {
  const id = "cooldown-lifecycle-test";
  clearAccountCooldown(id);

  assert.equal(getAccountCooldownInfo(id), null);

  markAccountRateLimited(id, 60_000, "TestReason", { silent: true });
  const info = getAccountCooldownInfo(id);
  assert.ok(info);
  assert.equal(info.reason, "TestReason");
  assert.ok(info.remainingMs > 0);
  assert.ok(info.remainingMs <= 60_000);

  clearAccountCooldown(id);
  assert.equal(getAccountCooldownInfo(id), null);
});

test("cooldown: expired cooldown auto-clears on query", () => {
  const id = "cooldown-expired-test";
  markAccountRateLimited(id, 1, "Expired", { silent: true });

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const info = getAccountCooldownInfo(id);
      assert.equal(info, null);
      resolve();
    }, 10);
  });
});

// ---------------------------------------------------------------------------
// Lease-based readiness guard protection
// ---------------------------------------------------------------------------

test("readiness guard: active lease prevents warmup interference", () => {
  const accountId = "readiness-lease-test";
  resetAccountConcurrencyForTests();

  assert.equal(hasActiveAccountLease(accountId), false);

  const lease = tryAcquireAccountLease(accountId, "warmup-guard");
  assert.ok(lease);
  assert.equal(hasActiveAccountLease(accountId), true);

  lease.release();
  assert.equal(hasActiveAccountLease(accountId), false);
});

// ---------------------------------------------------------------------------
// Anti-bot classification completeness
// ---------------------------------------------------------------------------

test("anti-bot: all known challenge forms are detected", () => {
  const variants = [
    { upstreamCode: "waf_challenge", message: "challenge detected" },
    { upstreamCode: "FAIL_SYS_USER_VALIDATE", message: "user validate" },
    { upstreamCode: "RGV587_ERROR", message: "_____tmd_____" },
    { upstreamCode: "RateLimited", message: "Please verify you are human" },
    { upstreamCode: "unknown", message: "security verification required" },
    { upstreamCode: "unknown", message: "CAPTCHA required" },
    { upstreamCode: "unknown", message: "anti-bot check" },
  ];

  for (const v of variants) {
    const err = Object.assign(new Error(v.message), { upstreamCode: v.upstreamCode });
    assert.ok(isAntiBotError(err), `Failed to detect: ${v.upstreamCode} / ${v.message}`);
  }
});

test("anti-bot: normal errors are not false-positived", () => {
  const normals = [
    new Error("quota exceeded"),
    new Error("chat is in progress"),
    new Error("model not found"),
    new Error("invalid input"),
  ];
  for (const err of normals) {
    assert.ok(!isAntiBotError(err), `False positive: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Quota classification completeness
// ---------------------------------------------------------------------------

test("quota: all known phrasings detected", () => {
  const phrasings = [
    "You've reached the upper limit for today's usage.",
    "maximum usage limits reached",
    "quota exceeded for this account",
    "daily limit reached",
    "insufficient quota remaining",
    "Service is currently experiencing high demand",
    "request rate increased too quickly",
    "allocated quota has been exhausted",
  ];

  for (const msg of phrasings) {
    const err = Object.assign(new Error(msg), { upstreamCode: "RateLimited" });
    assert.ok(isQuotaLikeError(err), `Failed to detect quota: "${msg}"`);
  }
});

test("quota: chat-not-exist is never quota", () => {
  const err = Object.assign(
    new Error("Invalid input the chat abc123 is not exist"),
    { upstreamCode: "RateLimited" },
  );
  assert.ok(!isQuotaLikeError(err));
});
