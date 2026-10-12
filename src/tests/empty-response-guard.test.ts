import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { app } from "../api/server.js";
import {
  toRetryableStreamError,
  classifyRetryAction,
} from "../routes/chat/retry-policy.ts";
import {
  RetryableQwenStreamError,
  getQwenErrorCode,
} from "../services/qwen-errors.ts";

// A turn that ends with no content, no tool calls and no reasoning is a silent
// upstream failure. Before the guard it finished as a clean `stop`, so clients
// (OpenCode included) persisted an empty assistant message and carried on with
// a permanent hole in the conversation. Both the streaming and the non-streaming
// path now throw a retryable `empty_response` instead.

function sseResponse(...chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function setupQwenFetchMock(
  completionHandler: (callIndex: number, body: any) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);

    if (!url.includes("chat.qwen.ai")) return originalFetch(input, init);

    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.7-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chats/new")) {
      return new Response(
        JSON.stringify({ chat_id: `mock-chat-empty-${Date.now()}-${completionCalls}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      completionCalls += 1;
      return completionHandler(completionCalls, body);
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCompletionCalls: () => completionCalls,
  };
}

async function postChat(messages: any[], stream = false) {
  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3.7-plus", stream, messages }),
    }),
  );
}

/** Upstream answers a turn with zero content, zero reasoning, zero tool calls. */
function emptyTurn(tag: string): Response {
  return sseResponse(
    `data: {"response.created":{"chat_id":"chat-empty-${tag}","response_id":"resp-empty-${tag}"}}\n\n`,
    "data: [DONE]\n\n",
  );
}

function answeredTurn(tag: string, content: string): Response {
  return sseResponse(
    `data: {"response.created":{"chat_id":"chat-${tag}","response_id":"resp-${tag}"}}\n\n`,
    `data: {"response_id":"resp-${tag}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n\n`,
    "data: [DONE]\n\n",
  );
}

test("stream: empty upstream turn ends as a terminal error, never a clean empty stop", async () => {
  const mock = setupQwenFetchMock(() => emptyTurn("first"));

  try {
    const res = await postChat([{ role: "user", content: "go" }], true);
    assert.equal(res.status, 200);
    const text = await res.text();

    // The turn produced nothing. A clean `stop` would make the client persist
    // an empty assistant message; instead the stream must terminate with an
    // explicit retryable error so the client retries.
    assert.match(text, /"code":"empty_response"/);
    assert.match(text, /"finish_reason":"error"/);

    // No assistant content may be smuggled in alongside the error.
    const contentChunks = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          return null;
        }
      })
      .filter((chunk) => chunk && chunk.choices)
      .flatMap((chunk) => chunk.choices)
      .map((choice: any) => choice?.delta?.content)
      .filter((content: any) => typeof content === "string" && content.length > 0);

    assert.deepEqual(
      contentChunks,
      [],
      "an empty upstream turn must not emit assistant content",
    );
    assert.equal(mock.getCompletionCalls(), 1);
  } finally {
    mock.restore();
  }
});

test("non-stream: empty upstream turn is retried instead of returning empty content", async () => {
  const mock = setupQwenFetchMock((callIndex) =>
    callIndex === 1
      ? emptyTurn("first")
      : answeredTurn("recovered", "non-stream-recovered"),
  );

  try {
    const res = await postChat([{ role: "user", content: "go" }], false);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as any;
    const content = payload.choices?.[0]?.message?.content;
    assert.equal(
      typeof content === "string" && content.trim() ? content.trim() : null,
      "non-stream-recovered",
      "an empty turn must never reach the client as an empty 200",
    );
    assert.ok(
      mock.getCompletionCalls() >= 2,
      `empty turn must trigger a retry, got ${mock.getCompletionCalls()} completion call(s)`,
    );
  } finally {
    mock.restore();
  }
});

test("empty_response: guard error is retryable and rotates accounts", () => {
  const err = toRetryableStreamError(
    "empty_response",
    "upstream produced no content, reasoning, or tool calls",
    { reason: "empty_response", switchAccount: true },
  );

  assert.ok(
    err instanceof RetryableQwenStreamError,
    "must be retryable so the stream error handler emits a terminal SSE error",
  );

  const policy = classifyRetryAction(err);
  assert.equal(policy.retryable, true);
  assert.equal(policy.switchAccount, true);
});

test("empty_response: code survives into the SSE error event", () => {
  const err = toRetryableStreamError(
    "empty_response",
    "upstream produced no content, reasoning, or tool calls",
    { reason: "empty_response", switchAccount: true },
  );

  assert.equal(getQwenErrorCode(err), "empty_response");
});

test("empty_response: not misclassified as a rate limit", () => {
  // RetryableQwenStreamError inherits UpstreamRateLimit; the guard must not
  // surface as `rate_limit_error` or the client backs off instead of retrying.
  const err = toRetryableStreamError(
    "empty_response",
    "upstream produced no content, reasoning, or tool calls",
    { reason: "empty_response", switchAccount: true },
  );

  const code = (getQwenErrorCode(err) || "").toLowerCase();
  assert.ok(
    !["rate_limit", "rate_limit_exceeded", "ratelimited", "quota_limit"].includes(
      code,
    ),
    `empty_response must not present as a rate limit, got "${code}"`,
  );
});