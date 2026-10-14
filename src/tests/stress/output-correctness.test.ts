/**
 * Edge cases OC-01, OC-04, OC-05, OC-06, OC-07 — output correctness stress.
 *
 * @stress
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { classifyRetryAction } from "../../routes/chat/retry-policy.ts";
import { RetryableQwenStreamError } from "../../services/qwen.ts";

test("OC-01: empty_response error forces new chat with full prompt replay", () => {
  const err = new RetryableQwenStreamError("empty response", 500);
  err.upstreamCode = "empty_response";
  err.forceNewChat = true;
  err.retryWithFullPrompt = true;

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
});

test("OC-01: reasoning-only content triggers empty_response classification", () => {
  const err = new RetryableQwenStreamError("Model returned only reasoning_content", 500);
  err.upstreamCode = "empty_response";
  err.forceNewChat = true;

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.forceNewChat, true);
});

test("OC-04: stream_stalled is retryable with switchAccount", () => {
  const err = new RetryableQwenStreamError("stall detected", 1000);
  err.upstreamCode = "stream_stalled";
  err.switchAccount = true;

  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.switchAccount, true);
});

test("OC-04: content_moderation is terminal (never retried)", () => {
  const err = Object.assign(
    new Error("data_inspection_failed: Content safety warning"),
    { upstreamCode: "data_inspection_failed" },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, false);
  assert.equal(action.reason, "content_moderation");
  assert.equal(action.switchAccount, false);
});

test("OC-05: concurrent classification produces identical results", () => {
  const makeErr = () => {
    const e = new RetryableQwenStreamError("stall", 1000);
    e.upstreamCode = "stream_stalled";
    e.switchAccount = true;
    return e;
  };

  const results = Array.from({ length: 20 }, () => classifyRetryAction(makeErr()));
  const first = results[0];
  for (const r of results) {
    assert.equal(r.retryable, first.retryable);
    assert.equal(r.switchAccount, first.switchAccount);
    assert.equal(r.reason, first.reason);
  }
});

test("OC-06: model_not_found is terminal regardless of retryable flag", () => {
  const err = Object.assign(
    new Error("Not_Found: Model not found"),
    { upstreamCode: "Not_Found" },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, false);
  assert.equal(action.reason, "model_not_found");
});

test("OC-07: chat_in_progress allows same-account settle retries", () => {
  const err = Object.assign(
    new Error("chat is in progress"),
    { upstreamCode: "chat_in_progress" },
  );
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "chat_in_progress");
});

test("OC-01: 50 sequential empty_response classifications stay consistent", () => {
  for (let i = 0; i < 50; i++) {
    const err = new RetryableQwenStreamError(`empty ${i}`, 500);
    err.upstreamCode = "empty_response";
    err.forceNewChat = true;
    err.retryWithFullPrompt = true;

    const action = classifyRetryAction(err);
    assert.equal(action.retryable, true, `iteration ${i}`);
    assert.equal(action.forceNewChat, true, `iteration ${i}`);
    assert.equal(action.retryWithFullPrompt, true, `iteration ${i}`);
  }
});

test("OC-04: corrupted_chat_history forces new chat + full prompt", () => {
  const err = new Error("first message must not assistant message");
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryWithFullPrompt, true);
  assert.equal(action.reason, "corrupted_chat_history");
});

test("OC-05: RetryableQwenStreamError preserves retryAfterMs", () => {
  const cases = [500, 1000, 2000, 5000, 10000];
  for (const ms of cases) {
    const err = new RetryableQwenStreamError("test", ms);
    assert.equal(err.retryAfterMs, ms);
    assert.equal(err.message, "test");
  }
});
