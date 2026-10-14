import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { app } from "../api/server.js";
import {
  getLogicalThreadState,
  purgeLogicalThreadState,
  invalidateLogicalThreadParent,
} from "../services/qwen-thread-state.ts";
import { deriveSessionId } from "../utils/session-id.ts";
import { getDatabase } from "../core/database.ts";

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
        JSON.stringify({ chat_id: `mock-chat-${Date.now()}-${completionCalls}` }),
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

async function postChat(
  messages: any[],
  stream = true,
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: "qwen3.7-plus", stream, messages }),
    }),
  );
}

function emptyTurn(tag: string, responseId?: string): Response {
  const respId = responseId ?? `resp-ghost-${tag}`;
  return sseResponse(
    `data: {"response.created":{"chat_id":"chat-empty-${tag}","response_id":"${respId}"}}\n\n`,
    "data: [DONE]\n\n",
  );
}

function answeredTurn(
  tag: string,
  content: string,
  responseId?: string,
): Response {
  const respId = responseId ?? `resp-${tag}`;
  return sseResponse(
    `data: {"response.created":{"chat_id":"chat-${tag}","response_id":"${respId}"}}\n\n`,
    `data: {"response_id":"${respId}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n\n`,
    "data: [DONE]\n\n",
  );
}

test("transparent recovery: simulates empty turn on call 1 and successful tokens on call 2", async () => {
  const rawKey = `transparent-e2e-${Date.now()}`;
  const messages = [{ role: "user", content: "hello" }];
  const derivedId = deriveSessionId(messages as any, "", rawKey);

  const mock = setupQwenFetchMock((callIndex) =>
    callIndex === 1
      ? emptyTurn("fail1", "resp-ghost-fail1")
      : answeredTurn("success2", "transparent-recovered-token", "resp-valid-success2"),
  );

  try {
    const res = await postChat(messages, true, {
      "x-session-id": rawKey,
    });

    assert.equal(res.status, 200);
    const text = await res.text();

    // 1. Recovered tokens emitted to downstream client
    assert.ok(
      text.includes("transparent-recovered-token"),
      "Must contain recovered token content",
    );
    // 2. Contains [DONE]
    assert.ok(text.includes("data: [DONE]"), "Must terminate with [DONE]");
    // 3. Does NOT contain error finish reason
    assert.ok(
      !text.includes('"finish_reason":"error"'),
      "Must not expose error finish_reason",
    );
    // 4. Does NOT expose empty_response error chunk
    assert.ok(
      !text.includes('"code":"empty_response"'),
      "Must not expose empty_response error to client",
    );
    // 5. Total completion calls >= 2
    assert.ok(
      mock.getCompletionCalls() >= 2,
      `Expected at least 2 completion calls, got ${mock.getCompletionCalls()}`,
    );

    // 6. Thread state verification across both rawKey and derivedId
    for (const sid of [rawKey, derivedId]) {
      const state = getLogicalThreadState(sid);
      assert.notEqual(
        state?.parentId,
        "resp-ghost-fail1",
        "Ghost parentId must NEVER be committed",
      );
    }
  } finally {
    mock.restore();
    purgeLogicalThreadState(rawKey);
    purgeLogicalThreadState(derivedId);
  }
});

test("transparent recovery: exhausted retries leaves thread state parent as null and terminates with SSE error", async () => {
  const rawKey = `transparent-exhausted-${Date.now()}`;
  const messages = [{ role: "user", content: "hello" }];
  const derivedId = deriveSessionId(messages as any, "", rawKey);

  const mock = setupQwenFetchMock(() => emptyTurn("always-empty", "resp-ghost-ex"));

  try {
    const res = await postChat(messages, true, {
      "x-session-id": rawKey,
    });

    assert.equal(res.status, 200);
    const text = await res.text();

    assert.match(
      text,
      /"code":"empty_response"/,
      "Stream must end with terminal empty_response error when all retries return 0 tokens",
    );
    assert.match(
      text,
      /"finish_reason":"error"/,
      "Stream must end with finish_reason: error",
    );

    for (const sid of [rawKey, derivedId]) {
      const state = getLogicalThreadState(sid);
      assert.notEqual(
        state?.parentId,
        "resp-ghost-ex",
        "Ghost parentId must NEVER be committed",
      );
      assert.equal(
        state?.parentId ?? null,
        null,
        "Thread state parentId must be null when retries exhausted",
      );
    }
  } finally {
    mock.restore();
    purgeLogicalThreadState(rawKey);
    purgeLogicalThreadState(derivedId);
  }
});

test("transparent recovery: preserves multi-chunk streaming deltas on recovery", async () => {
  const rawKey = `transparent-multichunk-${Date.now()}`;
  const messages = [{ role: "user", content: "multi chunk" }];
  const derivedId = deriveSessionId(messages as any, "", rawKey);

  const mock = setupQwenFetchMock((callIndex) => {
    if (callIndex === 1) {
      return emptyTurn("chunk-fail", "resp-ghost-multichunk");
    }
    return sseResponse(
      `data: {"response.created":{"chat_id":"chat-multi","response_id":"resp-valid-multi"}}\n\n`,
      `data: {"response_id":"resp-valid-multi","choices":[{"delta":{"phase":"answer","content":"Hello "}}]}\n\n`,
      `data: {"response_id":"resp-valid-multi","choices":[{"delta":{"phase":"answer","content":"world!"}}]}\n\n`,
      "data: [DONE]\n\n",
    );
  });

  try {
    const res = await postChat(messages, true, {
      "x-session-id": rawKey,
    });

    assert.equal(res.status, 200);
    const text = await res.text();

    assert.ok(text.includes("Hello "), "Must contain first delta chunk");
    assert.ok(text.includes("world!"), "Must contain second delta chunk");
    assert.ok(text.includes("data: [DONE]"), "Must contain [DONE]");
    assert.ok(!text.includes('"finish_reason":"error"'));

    for (const sid of [rawKey, derivedId]) {
      const state = getLogicalThreadState(sid);
      assert.notEqual(
        state?.parentId,
        "resp-ghost-multichunk",
        "Ghost parentId must NEVER be committed",
      );
    }
  } finally {
    mock.restore();
    purgeLogicalThreadState(rawKey);
    purgeLogicalThreadState(derivedId);
  }
});
