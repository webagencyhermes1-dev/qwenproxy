/**
 * Edge cases EX-04, EX-09, EX-10, OC-01 — stream stall and recovery stress.
 *
 * @stress
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { config } from "../../core/config.ts";
import { classifyRetryAction } from "../../routes/chat/retry-policy.ts";
import { RetryableQwenStreamError } from "../../services/qwen.ts";

test("EX-04: stall timeout error is retryable with switchAccount", () => {
  const err = new RetryableQwenStreamError("Stream stalled: no data received", 1000);
  err.upstreamCode = "stream_stalled";
  err.switchAccount = true;

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.ok(action.retryAfterMs >= 0);
});

test("EX-04: idle stream timeout config is sane", () => {
  assert.ok(config.timeouts.idleStreamTimeout > 0);
  assert.ok(config.timeouts.idleStreamTimeout <= 600_000);
});

test("EX-09: acquire deadline error classification", () => {
  const err = new Error("Stream creation timed out: acquire deadline exceeded") as Error & {
    code?: string;
  };
  err.code = "acquire_deadline";

  const action = classifyRetryAction(err);
  assert.ok(
    action.reason === "account_initialization_failed" || !action.retryable,
    `acquire_deadline should be init failure or terminal, got: ${action.reason}`,
  );
});

test("EX-09: create_budget_deadline is NOT charged to account", () => {
  const err = new Error("Request create budget exhausted") as Error & {
    code?: string;
  };
  err.code = "create_budget_deadline";

  const action = classifyRetryAction(err);
  assert.equal(action.accountCooldownMs, undefined);
});

test("EX-10: empty response error is retryable with forceNewChat", () => {
  const err = new RetryableQwenStreamError("Empty response from upstream", 500);
  err.upstreamCode = "empty_response";
  err.forceNewChat = true;
  err.retryWithFullPrompt = true;

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
});

test("EX-04: multiple stall errors in sequence — all retryable", () => {
  for (let i = 0; i < 20; i++) {
    const err = new RetryableQwenStreamError(`Stream stalled iteration ${i}`, 1000);
    err.upstreamCode = "stream_stalled";
    err.switchAccount = true;

    const action = classifyRetryAction(err);
    assert.equal(action.retryable, true, `iteration ${i}`);
  }
});

test("EX-11: browser context death classified correctly", () => {
  const err = new Error("Target page, context or browser has been closed") as Error & {
    code?: string;
  };
  err.code = "account_not_hot";

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
  assert.equal(action.accountCooldownMs, undefined);
});

test("EX-04: network timeout variants all retryable", () => {
  const variants = [
    "fetch failed",
    "read ECONNRESET",
    "socket hang up",
    "connect ETIMEDOUT 8.219.122.25:443",
  ];

  for (const msg of variants) {
    const err = new Error(msg);
    const action = classifyRetryAction(err);
    assert.equal(action.retryable, true, `"${msg}" must be retryable, got reason=${action.reason}`);
  }
});

test("EX-04: concurrent stall detection — 10 simultaneous stall errors", () => {
  const results = Array.from({ length: 10 }, (_, i) => {
    const err = new RetryableQwenStreamError(`Concurrent stall ${i}`, 1000);
    err.upstreamCode = "stream_stalled";
    err.switchAccount = true;
    return classifyRetryAction(err);
  });

  for (const action of results) {
    assert.equal(action.retryable, true);
    assert.equal(action.switchAccount, true);
  }
});
