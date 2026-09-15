/**
 * Loop 1 recovery test: personalization mutex must never block a chat request.
 *
 * Reproduction (from the recovery log):
 *   WARN [Mutex:personalization:8662d127] TIMEOUT key=... waited=60000ms heldBy=... heldFor=62011ms
 *   ❌ [Chat] Request failed | 5umqitru9w7 | unknown | Mutex[personalization:8662d127] acquire timeout
 *
 * A sync held the per-account personalization mutex for 62 seconds; a second
 * chat request for the SAME account waited 60s and then FAILED. Every
 * subsequent request to that account timed out the same way.
 *
 * Contract after the fix:
 *  - A chat request acquires the lock with a 2s budget.
 *  - On timeout it SKIPS personalization and proceeds to stream creation.
 *  - The request completes in a few seconds (never ~60s) and never fails
 *    because of the personalization lock.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.js";
import { acquirePersonalizationLockForTests } from "../routes/chat/account.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockUpstream() {
  const originalFetch = globalThis.fetch;
  const completionCalls: string[] = [];
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.6-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      completionCalls.push(url);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices": [{"delta": {"phase": "answer", "content": "ok"}}]}\n\n',
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  };
  return { originalFetch, completionCalls };
}

test("chat request succeeds even when the personalization lock is held indefinitely", async () => {
  // Hold the per-account personalization lock for the mock account forever
  // (simulates a hung personalization sync holding the mutex, as in the log).
  const releaseLock = await acquirePersonalizationLockForTests("mock-account");

  const { originalFetch, completionCalls } = mockUpstream();
  const startedAt = Date.now();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "personalization-lock-skip-test",
          messages: [
            { role: "system", content: "Agent instructions: be brief." },
            { role: "user", content: "hi" },
          ],
          stream: true,
        }),
      }),
    );
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(
      res.status,
      200,
      `chat must NOT fail because of the personalization lock, got status ${res.status}`,
    );
    await res.text();

    // The lock wait is bounded at 2s, so the whole request must finish in a
    // few seconds — NOT ~60s as in the recovery log.
    assert.ok(
      elapsed < 8_000,
      `request must not wait ~60s on the personalization lock, took ${elapsed}ms`,
    );
    assert.ok(
      completionCalls.length >= 1,
      "the upstream completion must have been reached after the lock skip",
    );
  } finally {
    globalThis.fetch = originalFetch;
    releaseLock();
  }
});

test("normal request (no lock contention) syncs personalization and succeeds", async () => {
  const { originalFetch, completionCalls } = mockUpstream();
  const startedAt = Date.now();
  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          session_id: "personalization-lock-normal-test",
          messages: [
            { role: "system", content: "Agent instructions: be concise." },
            { role: "user", content: "hello" },
          ],
          stream: true,
        }),
      }),
    );
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(res.status, 200);
    await res.text();
    assert.ok(elapsed < 8_000, `normal request took ${elapsed}ms`);
    assert.ok(
      completionCalls.length >= 1,
      "the upstream completion must be reached",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the personalization lock releases fast after a normal sync (no leak)", async () => {
  const lock1 = await acquirePersonalizationLockForTests("mock-account-consecutive");
  lock1();
  await tick(5);
  // A second acquire must succeed immediately after release (no residual lock).
  const lock2 = await acquirePersonalizationLockForTests("mock-account-consecutive");
  lock2();
});