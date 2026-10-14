import test, { describe } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { app } from "../api/server.js";
import {
  getLogicalThreadState,
  purgeLogicalThreadState,
  invalidateLogicalThreadParent,
  updateLogicalThreadState,
} from "../services/qwen-thread-state.ts";
import { deriveSessionId } from "../utils/session-id.ts";
import { getSessionParent } from "../services/qwen-thread-state.ts";
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
  completionHandler: (callIndex: number, body: any, url: string) => Response | Promise<Response>,
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
        JSON.stringify({ chat_id: `mock-chat-ch3-${Date.now()}-${completionCalls}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      completionCalls += 1;
      return completionHandler(completionCalls, body, url);
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
  options: { signal?: AbortSignal; tools?: any[] } = {},
) {
  const bodyPayload: any = { model: "qwen3.7-plus", stream, messages };
  if (options.tools) {
    bodyPayload.tools = options.tools;
  }
  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(bodyPayload),
      signal: options.signal,
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
  const respId = responseId ?? `resp-valid-${tag}`;
  return sseResponse(
    `data: {"response.created":{"chat_id":"chat-${tag}","response_id":"${respId}"}}\n\n`,
    `data: {"response_id":"${respId}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n\n`,
    "data: [DONE]\n\n",
  );
}

function getResolvedThreadState(rawSessionId: string, messages: any[] = []) {
  const derivedId = deriveSessionId(messages as any, "", rawSessionId);
  return getLogicalThreadState(derivedId) ?? getLogicalThreadState(rawSessionId);
}

function getDbThreadState(sessionId: string) {
  try {
    const db = getDatabase();
    return db
      .prepare(
        "SELECT session_id, account_id, chat_session_id, parent_id, instructions_sent, updated_at FROM logical_thread_states WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          session_id: string;
          account_id: string;
          chat_session_id: string;
          parent_id: string | null;
          instructions_sent: number;
          updated_at: string;
        }
      | undefined;
  } catch {
    return undefined;
  }
}

describe("Empirical Challenger M3: Comprehensive Stress & Invariant Verification", () => {
  test("C1: Acceptance Criterion 2 — Zero-token turn strictly does NOT persist ghost response_id to thread state or SQLite", async () => {
    const sessionId = `ch3-ghost-prevention-${Date.now()}`;
    const messages = [{ role: "user", content: "ghost test" }];
    const derivedId = deriveSessionId(messages as any, "", sessionId);
    const ghostRespId = "resp-ghost-poison-attempt";

    // Pre-populate derivedId in-memory thread state with prior valid state
    updateLogicalThreadState(derivedId, {
      accountId: "mock-account",
      chatSessionId: "chat-pre-existing",
      parentId: "prior-valid-parent",
      instructionsSent: true,
    });

    const mock = setupQwenFetchMock(() => emptyTurn("always-empty", ghostRespId));

    try {
      const res = await postChat(messages, true, { "x-session-id": sessionId });
      assert.equal(res.status, 200);
      const text = await res.text();

      // Must end with error, not clean stop
      assert.match(text, /"code":"empty_response"/);

      // Verify thread state
      const state = getLogicalThreadState(derivedId);
      assert.notEqual(
        state?.parentId,
        ghostRespId,
        `Ghost parentId ${ghostRespId} must NEVER be persisted in in-memory state`,
      );
      assert.equal(
        state?.parentId ?? null,
        null,
        "Thread state parentId must be invalidated to null",
      );

      const dbRow = getDbThreadState(derivedId);
      assert.ok(
        !dbRow || dbRow.parent_id !== ghostRespId,
        `SQLite row must NEVER contain ghost parent_id ${ghostRespId}`,
      );
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
      purgeLogicalThreadState(derivedId);
    }
  });

  test("C2: Acceptance Criterion 3 — Cascading 3-attempt transparent failover across multiple accounts", async () => {
    const sessionId = `ch3-cascading-${Date.now()}`;
    const messages = [{ role: "user", content: "cascade test" }];
    const derivedId = deriveSessionId(messages as any, "", sessionId);

    const mock = setupQwenFetchMock((callIndex) => {
      if (callIndex === 1) return emptyTurn("acc1", "resp-ghost-acc1");
      if (callIndex === 2) return emptyTurn("acc2", "resp-ghost-acc2");
      return answeredTurn("acc3", "recovered-on-attempt-3", "resp-valid-acc3");
    });

    try {
      const res = await postChat(messages, true, { "x-session-id": sessionId });
      assert.equal(res.status, 200);
      const text = await res.text();

      assert.ok(
        text.includes("recovered-on-attempt-3"),
        "Client must receive the recovered answer tokens from 3rd attempt",
      );
      assert.ok(text.includes("data: [DONE]"), "Stream must cleanly complete with [DONE]");
      assert.ok(!text.includes('"finish_reason":"error"'), "Must not contain error finish_reason");
      assert.ok(!text.includes('"code":"empty_response"'), "Must not leak empty_response error chunk");

      assert.ok(
        mock.getCompletionCalls() >= 3,
        `Expected at least 3 completion calls for 2 failovers, got ${mock.getCompletionCalls()}`,
      );

      const resolvedState = getResolvedThreadState(sessionId, messages);
      assert.notEqual(resolvedState?.parentId, "resp-ghost-acc1");
      assert.notEqual(resolvedState?.parentId, "resp-ghost-acc2");
      assert.equal(resolvedState?.parentId, "resp-valid-acc3", "Valid 3rd attempt parentId must be committed!");
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
      purgeLogicalThreadState(derivedId);
    }
  });

  test("C3: Acceptance Criterion 4 — Post-recovery multi-turn continuity (Turn 1 recovered -> Turn 2 continues)", async () => {
    const sessionId = `ch3-multiturn-${Date.now()}`;
    const messagesT1 = [{ role: "user", content: "turn 1" }];
    const derivedId1 = deriveSessionId(messagesT1 as any, "", sessionId);

    const mock = setupQwenFetchMock((callIndex, body) => {
      if (callIndex === 1) {
        return emptyTurn("turn1-fail", "resp-ghost-t1");
      }
      if (callIndex === 2) {
        return answeredTurn("turn1-success", "Answer to turn 1", "resp-valid-t1");
      }
      return answeredTurn("turn2-success", "Answer to turn 2", "resp-valid-t2");
    });

    try {
      // --- Turn 1 ---
      const res1 = await postChat(messagesT1, true, {
        "x-session-id": sessionId,
      });
      assert.equal(res1.status, 200);
      const text1 = await res1.text();
      assert.ok(text1.includes("Answer to turn 1"));
      assert.ok(text1.includes("data: [DONE]"));

      const stateAfterTurn1 = getResolvedThreadState(sessionId, messagesT1);
      assert.equal(stateAfterTurn1?.parentId, "resp-valid-t1");

      // --- Turn 2 ---
      const messagesTurn2 = [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "Answer to turn 1" },
        { role: "user", content: "turn 2" },
      ];
      const res2 = await postChat(messagesTurn2, true, {
        "x-session-id": sessionId,
      });
      assert.equal(res2.status, 200);
      const text2 = await res2.text();
      assert.ok(text2.includes("Answer to turn 2"));
      assert.ok(text2.includes("data: [DONE]"));

      const stateAfterTurn2 = getResolvedThreadState(sessionId, messagesTurn2);
      assert.equal(stateAfterTurn2?.parentId, "resp-valid-t2");
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
      purgeLogicalThreadState(derivedId1);
    }
  });

  test("C4: Acceptance Criterion 4 — High-concurrency stress test (20 simultaneous streams with mixed profiles)", async () => {
    const count = 20;
    const sessionIds = Array.from({ length: count }, (_, i) => `ch3-conc-${Date.now()}-${i}`);

    const callCounts = new Map<string, number>();

    const mock = setupQwenFetchMock((callIndex, body) => {
      const prompt = body.messages?.[0]?.content || body.prompt || "";
      const streamIdxMatch = prompt.match(/stream-(\d+)/);
      const streamIdx = streamIdxMatch ? parseInt(streamIdxMatch[1], 10) : 0;
      const currentCall = (callCounts.get(`s-${streamIdx}`) || 0) + 1;
      callCounts.set(`s-${streamIdx}`, currentCall);

      if (streamIdx < 5) {
        // Immediate clean success
        return answeredTurn(`clean-${streamIdx}`, `Clean-Content-${streamIdx}`, `resp-clean-${streamIdx}`);
      } else if (streamIdx < 10) {
        // Recover on attempt 2
        if (currentCall === 1) {
          return emptyTurn(`ghost-r2-${streamIdx}`, `resp-ghost-r2-${streamIdx}`);
        }
        return answeredTurn(`rec2-${streamIdx}`, `Rec2-Content-${streamIdx}`, `resp-rec2-${streamIdx}`);
      } else if (streamIdx < 15) {
        // Recover on attempt 3
        if (currentCall <= 2) {
          return emptyTurn(`ghost-r3-${streamIdx}-${currentCall}`, `resp-ghost-r3-${streamIdx}-${currentCall}`);
        }
        return answeredTurn(`rec3-${streamIdx}`, `Rec3-Content-${streamIdx}`, `resp-rec3-${streamIdx}`);
      } else {
        // Exhausted retries
        return emptyTurn(`ghost-ex-${streamIdx}`, `resp-ghost-ex-${streamIdx}`);
      }
    });

    try {
      const promises = sessionIds.map(async (sid, i) => {
        const msgs = [{ role: "user", content: `stream-${i}` }];
        const res = await postChat(
          msgs,
          true,
          { "x-session-id": sid },
        );
        assert.equal(res.status, 200);
        const text = await res.text();
        return { index: i, sid, text, msgs };
      });

      const results = await Promise.all(promises);

      for (const { index, sid, text, msgs } of results) {
        const resolved = getResolvedThreadState(sid, msgs);
        if (index < 5) {
          // Clean success
          assert.ok(text.includes(`Clean-Content-${index}`));
          assert.ok(text.includes("data: [DONE]"));
          assert.ok(!text.includes('"finish_reason":"error"'));
          assert.equal(resolved?.parentId, `resp-clean-${index}`);
        } else if (index < 10) {
          // Recovered on 2nd attempt
          assert.ok(text.includes(`Rec2-Content-${index}`));
          assert.ok(text.includes("data: [DONE]"));
          assert.ok(!text.includes('"finish_reason":"error"'));
          assert.equal(resolved?.parentId, `resp-rec2-${index}`);
        } else if (index < 15) {
          // Recovered on 3rd attempt
          assert.ok(text.includes(`Rec3-Content-${index}`));
          assert.ok(text.includes("data: [DONE]"));
          assert.ok(!text.includes('"finish_reason":"error"'));
          assert.equal(resolved?.parentId, `resp-rec3-${index}`);
        } else {
          // Exhausted retries
          assert.match(text, /"code":"empty_response"/);
          assert.match(text, /"finish_reason":"error"/);
          assert.ok(!text.includes("Rec3-Content"));
          assert.equal(resolved?.parentId ?? null, null);
        }
      }
    } finally {
      mock.restore();
      for (const sid of sessionIds) {
        purgeLogicalThreadState(sid);
      }
    }
  });

  test("C5: Acceptance Criterion 4 — Partial model output emitted prohibits transparent recovery (no duplicate client output)", async () => {
    const sessionId = `ch3-partial-guard-${Date.now()}`;
    const messages = [{ role: "user", content: "partial test" }];

    const mock = setupQwenFetchMock((callIndex) => {
      if (callIndex === 1) {
        return sseResponse(
          `data: {"response.created":{"chat_id":"chat-partial","response_id":"resp-partial-123"}}\n\n`,
          `data: {"response_id":"resp-partial-123","choices":[{"delta":{"phase":"answer","content":"Partial start..."}}]}\n\n`,
        );
      }
      return answeredTurn("should-not-reach", "DUPLICATE CONTENT", "resp-dup");
    });

    try {
      const res = await postChat(messages, true, { "x-session-id": sessionId });
      assert.equal(res.status, 200);
      const text = await res.text();

      // Client saw the partial start
      assert.ok(text.includes("Partial start..."));

      // Invariant: MUST NOT have triggered transparent recovery and replayed from scratch
      assert.ok(
        !text.includes("DUPLICATE CONTENT"),
        "Must NOT trigger transparent recovery after partial model output was already emitted",
      );

      // Incomplete response_id must NOT be committed as parent
      const state = getResolvedThreadState(sessionId, messages);
      assert.notEqual(
        state?.parentId,
        "resp-partial-123",
        "Incomplete stream turn must not commit its parentId",
      );
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
    }
  });

  test("C6: Acceptance Criterion 4 — Reasoning-only stream turn promotes to content and commits valid parent", async () => {
    const sessionId = `ch3-reasoning-only-${Date.now()}`;
    const messages = [{ role: "user", content: "think only" }];
    const respId = "resp-reasoning-valid-789";

    const mock = setupQwenFetchMock(() => {
      return sseResponse(
        `data: {"response.created":{"chat_id":"chat-reasoning","response_id":"${respId}"}}\n\n`,
        `data: {"response_id":"${respId}","choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_thought":{"content":["I have carefully analyzed the puzzle."]}},"status":"typing"}}]}\n\n`,
        `data: {"response_id":"${respId}","choices":[{"delta":{"phase":"thinking_summary","status":"finished"}}]}\n\n`,
        "data: [DONE]\n\n",
      );
    });

    try {
      const res = await postChat(messages, true, { "x-session-id": sessionId });
      assert.equal(res.status, 200);
      const text = await res.text();

      // Client must receive reasoning promoted to content
      assert.ok(
        text.includes("I have carefully analyzed the puzzle."),
        "Reasoning must be promoted to content when no answer content is emitted",
      );
      assert.ok(text.includes("data: [DONE]"));
      assert.ok(!text.includes('"finish_reason":"error"'));

      // Invariant: reasoning-only turn is VALID and must commit its parentId
      const state = getResolvedThreadState(sessionId, messages);
      assert.equal(
        state?.parentId,
        respId,
        "Reasoning-promoted turn is valid and MUST commit its response_id as parentId",
      );
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
    }
  });

  test("C7: Acceptance Criterion 4 — Tool-calls-only turn (zero content text) commits valid parent", async () => {
    const sessionId = `ch3-tool-only-${Date.now()}`;
    const messages = [{ role: "user", content: "use tool" }];
    const respId = "resp-tool-valid-456";
    const tools = [
      {
        type: "function",
        function: {
          name: "calc",
          description: "Calculator",
          parameters: { type: "object", properties: { expr: { type: "string" } } },
        },
      },
    ];

    const mock = setupQwenFetchMock(() => {
      return sseResponse(
        `data: {"response.created":{"chat_id":"chat-tool","response_id":"${respId}"}}\n\n`,
        `data: {"response_id":"${respId}","choices":[{"delta":{"phase":"answer","content":"<tool_call>\\n{\\"name\\":\\"calc\\",\\"arguments\\":{\\"expr\\":\\"2+2\\"}}\\n</tool_call>"}}]}\n\n`,
        "data: [DONE]\n\n",
      );
    });

    try {
      const res = await postChat(
        messages,
        true,
        { "x-session-id": sessionId },
        { tools },
      );
      assert.equal(res.status, 200);
      const text = await res.text();

      assert.ok(text.includes("calc"), `Stream must emit parsed tool call, got: ${text}`);
      assert.ok(text.includes("data: [DONE]"));
      assert.ok(!text.includes('"finish_reason":"error"'));

      // Invariant: tool-calls-only turn is VALID and commits its parentId.
      // With tools declared the server folds the generated tool instructions
      // into the session-id anchor, so the key a caller can derive locally is
      // NOT the stored one. Assert on the upstream chat binding instead — it is
      // key-independent and is exactly what the next turn appends to.
      assert.equal(
        getSessionParent("chat-tool"),
        respId,
        "Tool-call turn is valid and MUST commit its response_id as parentId",
      );
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
    }
  });

  test("C8: Acceptance Criterion 4 — Client abort mid-flight during empty turn bypasses recovery and leaves null parent", async () => {
    const sessionId = `ch3-abort-${Date.now()}`;
    const messages = [{ role: "user", content: "abort test" }];
    const abortController = new AbortController();

    const mock = setupQwenFetchMock((callIndex) => {
      abortController.abort();
      return emptyTurn("aborted", "resp-ghost-abort");
    });

    try {
      const res = await postChat(
        messages,
        true,
        { "x-session-id": sessionId },
        { signal: abortController.signal },
      ).catch(() => null);

      if (res) {
        await res.text().catch(() => null);
      }

      const state = getResolvedThreadState(sessionId, messages);
      assert.notEqual(state?.parentId, "resp-ghost-abort");
      assert.equal(state?.parentId ?? null, null);
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
    }
  });

  test("C9: Acceptance Criterion 4 — Race condition stress on identical session key", async () => {
    const sessionId = `ch3-same-session-${Date.now()}`;
    let callNum = 0;

    const mock = setupQwenFetchMock(() => {
      callNum++;
      if (callNum % 2 === 1) {
        return emptyTurn(`race-${callNum}`, `resp-ghost-race-${callNum}`);
      } else {
        return answeredTurn(`race-${callNum}`, `Race-Answer-${callNum}`, `resp-valid-race-${callNum}`);
      }
    });

    try {
      const req1 = postChat([{ role: "user", content: "req 1" }], true, {
        "x-session-id": sessionId,
      });
      const req2 = postChat([{ role: "user", content: "req 2" }], true, {
        "x-session-id": sessionId,
      });

      const [res1, res2] = await Promise.all([req1, req2]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);

      const [text1, text2] = await Promise.all([res1.text(), res2.text()]);

      assert.ok(text1.length > 0);
      assert.ok(text2.length > 0);

      const state = getResolvedThreadState(sessionId, [{ role: "user", content: "req 1" }]);
      assert.ok(!state?.parentId?.startsWith("resp-ghost-"));
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
    }
  });

  test("C10: Acceptance Criterion 4 — Non-streaming transparent recovery cascading and clean state", async () => {
    const sessionId = `ch3-nonstream-${Date.now()}`;
    const messages = [{ role: "user", content: "nonstream cascade" }];

    const mock = setupQwenFetchMock((callIndex) => {
      if (callIndex === 1) return emptyTurn("ns-1", "resp-ghost-ns1");
      if (callIndex === 2) return emptyTurn("ns-2", "resp-ghost-ns2");
      return answeredTurn("ns-3", "nonstream-recovered-on-call-3", "resp-valid-ns3");
    });

    try {
      const res = await postChat(messages, false, { "x-session-id": sessionId });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as any;
      const content = payload.choices?.[0]?.message?.content;

      assert.equal(content, "nonstream-recovered-on-call-3");
      assert.ok(mock.getCompletionCalls() >= 3);

      const state = getResolvedThreadState(sessionId, messages);
      assert.notEqual(state?.parentId, "resp-ghost-ns1");
      assert.notEqual(state?.parentId, "resp-ghost-ns2");
      assert.equal(state?.parentId, "resp-valid-ns3");
    } finally {
      mock.restore();
      purgeLogicalThreadState(sessionId);
    }
  });
});
