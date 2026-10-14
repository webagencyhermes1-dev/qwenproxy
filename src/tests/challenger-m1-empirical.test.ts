import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// Exercise real SQLite persistence path
delete process.env.TEST_MOCK_QWEN_AUTH;

const {
  updateLogicalThreadState,
  getLogicalThreadState,
  flushLogicalThreadState,
  invalidateLogicalThreadParent,
  purgeLogicalThreadState,
  clearAllSessionsForAccount,
  setToolCapNotice,
  consumeToolCapNotice,
} = await import("../services/qwen-thread-state.ts");

const { buildFinalContext } = await import("../routes/chat/context.ts");
const { deriveSessionId } = await import("../utils/session-id.ts");
const { RetryableQwenStreamError } = await import("../services/qwen-errors.ts");
const {
  classifyRetryAction,
  toRetryableStreamError,
} = await import("../routes/chat/retry-policy.ts");
const { getDatabase, closeDatabase } = await import("../core/database.ts");

const TEST_ACCOUNT = "challenger-m1-account";
const UNIQ = `${Date.now()}`;

function getRow(sessionId: string):
  | {
      session_id: string;
      account_id: string;
      chat_session_id: string;
      parent_id: string | null;
      instructions_sent: number;
    }
  | undefined {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT session_id, account_id, chat_session_id, parent_id, instructions_sent FROM logical_thread_states WHERE session_id = ?",
    )
    .get(sessionId) as
    | {
      session_id: string;
      account_id: string;
      chat_session_id: string;
      parent_id: string | null;
      instructions_sent: number;
    }
    | undefined;
}

function countRows(sessionId: string): number {
  const db = getDatabase();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM logical_thread_states WHERE session_id = ?",
    )
    .get(sessionId) as { c: number };
  return row.c;
}

afterEach(() => {
  flushLogicalThreadState();
  clearAllSessionsForAccount(TEST_ACCOUNT);
});

after(() => {
  flushLogicalThreadState();
  closeDatabase();
});

describe("M1 Empirical Challenge: purgeLogicalThreadState", () => {
  test("purges in-memory cache and prevents debounced flush from writing to SQLite", async () => {
    const sessionId = `purge-dirty-${UNIQ}`;
    const chatId = `chat-purge-${UNIQ}`;

    // 1. Queue a thread state (dirty debounce timer active)
    updateLogicalThreadState(sessionId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: chatId,
      parentId: "p-dirty",
      instructionsSent: true,
    });

    // Verify in-memory before purge
    assert.ok(getLogicalThreadState(sessionId));

    // 2. Immediately purge while dirty
    purgeLogicalThreadState(sessionId);

    // 3. In-memory must be gone immediately
    assert.equal(getLogicalThreadState(sessionId), null);

    // 4. Wait longer than the 300ms debounce timer to ensure no write occurs
    await new Promise((resolve) => setTimeout(resolve, 450));

    // 5. Must NOT exist in SQLite
    assert.equal(countRows(sessionId), 0);
  });

  test("purges already-persisted row from SQLite and memory", () => {
    const sessionId = `purge-persisted-${UNIQ}`;
    const chatId = `chat-persisted-${UNIQ}`;

    // Create and flush to SQLite
    updateLogicalThreadState(sessionId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: chatId,
      parentId: "p-persisted",
      instructionsSent: true,
    });
    flushLogicalThreadState();

    // Verify row exists in SQLite
    assert.equal(countRows(sessionId), 1);
    const rowBefore = getRow(sessionId);
    assert.equal(rowBefore?.parent_id, "p-persisted");

    // Purge
    purgeLogicalThreadState(sessionId);

    // Verify removed from memory and SQLite
    assert.equal(getLogicalThreadState(sessionId), null);
    assert.equal(countRows(sessionId), 0);
  });

  test("purge does not prevent other dirty sessions from being flushed", async () => {
    const sessionKeep = `keep-${UNIQ}`;
    const sessionPurge = `purge-coalesce-${UNIQ}`;

    updateLogicalThreadState(sessionKeep, {
      accountId: TEST_ACCOUNT,
      chatSessionId: `chat-keep-${UNIQ}`,
      parentId: "p-keep",
      instructionsSent: true,
    });

    updateLogicalThreadState(sessionPurge, {
      accountId: TEST_ACCOUNT,
      chatSessionId: `chat-purge2-${UNIQ}`,
      parentId: "p-purge",
      instructionsSent: true,
    });

    // Purge only sessionPurge
    purgeLogicalThreadState(sessionPurge);

    // Wait for debounce timer to flush sessionKeep
    await new Promise((resolve) => setTimeout(resolve, 450));

    // sessionKeep must have landed in SQLite
    assert.equal(countRows(sessionKeep), 1);
    assert.equal(getRow(sessionKeep)?.parent_id, "p-keep");

    // sessionPurge must NOT have landed in SQLite
    assert.equal(countRows(sessionPurge), 0);
  });

  test("handles null, undefined, empty string, and non-existent IDs gracefully", () => {
    assert.doesNotThrow(() => purgeLogicalThreadState(null));
    assert.doesNotThrow(() => purgeLogicalThreadState(undefined));
    assert.doesNotThrow(() => purgeLogicalThreadState(""));
    assert.doesNotThrow(() => purgeLogicalThreadState("non-existent-session-id"));
  });
});

describe("M1 Empirical Challenge: invalidateLogicalThreadParent", () => {
  test("immediately persists parent_id = null to SQLite without debounce delay", () => {
    const sessionId = `inval-imm-${UNIQ}`;
    const chatId = `chat-imm-${UNIQ}`;

    // 1. Establish thread in SQLite
    updateLogicalThreadState(sessionId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: chatId,
      parentId: "parent-active-123",
      instructionsSent: true,
    });
    flushLogicalThreadState();

    const rowBefore = getRow(sessionId);
    assert.equal(rowBefore?.parent_id, "parent-active-123");

    // 2. Invalidate parent
    invalidateLogicalThreadParent(sessionId);

    // 3. Immediately inspect SQLite (NO setTimeout, NO manual flush)
    const rowAfter = getRow(sessionId);
    assert.ok(rowAfter, "Row must still exist in SQLite");
    assert.equal(rowAfter.parent_id, null, "parent_id must be null in SQLite immediately");
    assert.equal(rowAfter.chat_session_id, chatId, "chat_session_id must be preserved");
    assert.equal(rowAfter.account_id, TEST_ACCOUNT, "account_id must be preserved");

    // 4. Verify in-memory state
    const memState = getLogicalThreadState(sessionId);
    assert.ok(memState);
    assert.equal(memState.parentId, null);
    assert.equal(memState.chatSessionId, chatId);
  });

  test("invalidates parent even when thread is only in SQLite (evicted from memory)", () => {
    const sessionId = `inval-evicted-${UNIQ}`;
    const chatId = `chat-evicted-${UNIQ}`;

    updateLogicalThreadState(sessionId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: chatId,
      parentId: "p-evicted",
      instructionsSent: true,
    });
    flushLogicalThreadState();

    // Calling invalidateLogicalThreadParent directly:
    invalidateLogicalThreadParent(sessionId);

    const row = getRow(sessionId);
    assert.ok(row);
    assert.equal(row.parent_id, null);
  });

  test("handles null, undefined, and non-existent IDs without throwing", () => {
    assert.doesNotThrow(() => invalidateLogicalThreadParent(null));
    assert.doesNotThrow(() => invalidateLogicalThreadParent(undefined));
    assert.doesNotThrow(() => invalidateLogicalThreadParent("non-existent-session"));
  });
});

describe("M1 Empirical Challenge: canReuseThreadDelta in buildFinalContext", () => {
  const dummyMessages = [
    { role: "user", content: "Tell me a joke" },
    { role: "assistant", content: "Why did the chicken cross the road?" },
    { role: "user", content: "Why?" },
  ];
  const fullPrompt = "Turn 1: Tell me a joke\nTurn 2: Why did the chicken cross the road?\nTurn 3: Why?";
  const currentPrompt = "Turn 3: Why?";

  test("falls back to full prompt when existingThread has parentId === null", async () => {
    const rawKey = `ctx-null-parent-${UNIQ}`;
    const derivedId = deriveSessionId(dummyMessages, "", rawKey);

    updateLogicalThreadState(derivedId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-ctx-1",
      parentId: null, // INVALIDATED / GHOST PREVENTED
      instructionsSent: true,
    });

    const ctx = await buildFinalContext({
      messages: dummyMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: currentPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "thread",
    });

    assert.equal(
      ctx.finalPrompt,
      fullPrompt,
      "When parentId is null, activePrompt MUST be fullPrompt (never currentPrompt delta)",
    );
  });

  test("uses currentPrompt delta when existingThread has valid parentId and chatSessionId", async () => {
    const rawKey = `ctx-valid-parent-${UNIQ}`;
    const derivedId = deriveSessionId(dummyMessages, "", rawKey);

    updateLogicalThreadState(derivedId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-ctx-2",
      parentId: "valid-parent-token-999",
      instructionsSent: true,
    });

    const ctx = await buildFinalContext({
      messages: dummyMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: currentPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "thread",
    });

    assert.equal(
      ctx.finalPrompt,
      currentPrompt,
      "When parentId is valid string, activePrompt MUST be currentPrompt delta",
    );
  });

  test("falls back to full prompt when existingThread is null (no thread)", async () => {
    const rawKey = `ctx-no-thread-${UNIQ}`;

    const ctx = await buildFinalContext({
      messages: dummyMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: currentPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "thread",
    });

    assert.equal(
      ctx.finalPrompt,
      fullPrompt,
      "When no thread exists, activePrompt MUST be fullPrompt",
    );
  });

  test("falls back to full prompt when isTempMode is true, regardless of thread state", async () => {
    const rawKey = `ctx-temp-mode-${UNIQ}`;
    const derivedId = deriveSessionId(dummyMessages, "", rawKey);

    updateLogicalThreadState(derivedId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-ctx-3",
      parentId: "valid-parent-token",
      instructionsSent: true,
    });

    const ctx = await buildFinalContext({
      messages: dummyMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: currentPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "temp",
    });

    assert.equal(
      ctx.finalPrompt,
      fullPrompt,
      "When isTempMode is true, activePrompt MUST be fullPrompt even with valid parent",
    );
  });
});

describe("M1 Empirical Challenge: classifyRetryAction for empty_response", () => {
  test("classifies empty_response error with switchAccount, forceNewChat, retryWithFullPrompt, retryAfterMs 0", () => {
    // 1. By upstreamCode
    const errByCode = Object.assign(new Error("upstream empty"), {
      upstreamCode: "empty_response",
    });
    const actionByCode = classifyRetryAction(errByCode);
    assert.equal(actionByCode.reason, "empty_response");
    assert.equal(actionByCode.switchAccount, true);
    assert.equal(actionByCode.forceNewChat, true);
    assert.equal(actionByCode.retryWithFullPrompt, true);
    assert.equal(actionByCode.retryAfterMs, 0);
    assert.equal(actionByCode.retryable, true);

    // 2. By reason property
    const errByReason = Object.assign(new Error("silent turn"), {
      reason: "empty_response",
    });
    const actionByReason = classifyRetryAction(errByReason);
    assert.equal(actionByReason.reason, "empty_response");
    assert.equal(actionByReason.switchAccount, true);
    assert.equal(actionByReason.forceNewChat, true);
    assert.equal(actionByReason.retryWithFullPrompt, true);
    assert.equal(actionByReason.retryAfterMs, 0);

    // 3. By message string
    const errByMessage = new Error("Qwen retryable upstream error: empty_response: upstream produced no content");
    const actionByMessage = classifyRetryAction(errByMessage);
    assert.equal(actionByMessage.reason, "empty_response");
    assert.equal(actionByMessage.switchAccount, true);
    assert.equal(actionByMessage.forceNewChat, true);
    assert.equal(actionByMessage.retryWithFullPrompt, true);
    assert.equal(actionByMessage.retryAfterMs, 0);
  });

  test("toRetryableStreamError preserves reason and 0ms retry delay", () => {
    const streamError = toRetryableStreamError(
      "empty_response",
      "upstream produced no content, reasoning, or tool calls",
      { reason: "empty_response" },
    );

    assert.ok(streamError instanceof RetryableQwenStreamError);
    assert.equal(streamError.upstreamCode, "empty_response");
    assert.equal(streamError.reason, "empty_response");
    assert.equal(streamError.retryAfterMs, 0, "0ms retry delay must NOT be overwritten by baseDelayMs");
    assert.equal(streamError.switchAccount, true);
    assert.equal(streamError.forceNewChat, true);
    assert.equal(streamError.retryWithFullPrompt, true);

    // Re-classifying the RetryableQwenStreamError preserves the reason and flags
    const reclassified = classifyRetryAction(streamError);
    assert.equal(reclassified.reason, "empty_response");
    assert.equal(reclassified.switchAccount, true);
    assert.equal(reclassified.forceNewChat, true);
    assert.equal(reclassified.retryWithFullPrompt, true);
  });
});

describe("M1 Empirical Challenge: Adversarial Stress & Concurrency", () => {
  test("50 concurrent sessions: updates and immediate invalidations under load", async () => {
    const N = 50;
    const sessionIds = Array.from({ length: N }, (_, i) => `stress-sess-${UNIQ}-${i}`);
    const chatIds = Array.from({ length: N }, (_, i) => `stress-chat-${UNIQ}-${i}`);

    // Create 50 threads in parallel
    await Promise.all(
      sessionIds.map((sid, i) => {
        updateLogicalThreadState(sid, {
          accountId: TEST_ACCOUNT,
          chatSessionId: chatIds[i],
          parentId: `parent-${i}`,
          instructionsSent: i % 2 === 0,
        });
        return Promise.resolve();
      }),
    );

    // Invalidate 25 of them immediately in parallel
    await Promise.all(
      sessionIds.slice(0, 25).map((sid) => {
        invalidateLogicalThreadParent(sid);
        return Promise.resolve();
      }),
    );

    // Verify all 25 invalidated sessions immediately have parent_id = null in SQLite
    for (let i = 0; i < 25; i++) {
      const row = getRow(sessionIds[i]);
      assert.ok(row, `Row ${sessionIds[i]} must exist in SQLite`);
      assert.equal(row.parent_id, null, `Session ${sessionIds[i]} must have parent_id null`);
      assert.equal(row.chat_session_id, chatIds[i]);
      assert.equal(row.instructions_sent, i % 2 === 0 ? 1 : 0);
    }

    // Flush the remaining 25
    flushLogicalThreadState();

    // Verify the remaining 25 have valid parent_id in SQLite
    for (let i = 25; i < N; i++) {
      const row = getRow(sessionIds[i]);
      assert.ok(row, `Row ${sessionIds[i]} must exist in SQLite`);
      assert.equal(row.parent_id, `parent-${i}`);
      assert.equal(row.chat_session_id, chatIds[i]);
    }

    // Now purge all 50 in parallel
    await Promise.all(
      sessionIds.map((sid) => {
        purgeLogicalThreadState(sid);
        return Promise.resolve();
      }),
    );

    // Verify all 50 are completely deleted from SQLite and memory
    for (let i = 0; i < N; i++) {
      assert.equal(countRows(sessionIds[i]), 0, `Row ${sessionIds[i]} must be deleted`);
      assert.equal(getLogicalThreadState(sessionIds[i]), null);
    }
  });

  test("interleaved debounce race: 10 sessions dirty, 5 purged before timer, 5 persist", async () => {
    const kept = Array.from({ length: 5 }, (_, i) => `race-keep-${UNIQ}-${i}`);
    const purged = Array.from({ length: 5 }, (_, i) => `race-purge-${UNIQ}-${i}`);

    for (let i = 0; i < 5; i++) {
      updateLogicalThreadState(kept[i], {
        accountId: TEST_ACCOUNT,
        chatSessionId: `chat-k-${i}`,
        parentId: `pk-${i}`,
        instructionsSent: true,
      });
      updateLogicalThreadState(purged[i], {
        accountId: TEST_ACCOUNT,
        chatSessionId: `chat-p-${i}`,
        parentId: `pp-${i}`,
        instructionsSent: true,
      });
    }

    // Purge half of them while debounce timer is ticking
    for (const sid of purged) {
      purgeLogicalThreadState(sid);
    }

    // Wait for the 300ms debounce timer to fire
    await new Promise((resolve) => setTimeout(resolve, 450));

    // Verify kept sessions are in SQLite
    for (const sid of kept) {
      assert.equal(countRows(sid), 1);
      assert.ok(getRow(sid)?.parent_id?.startsWith("pk-"));
    }

    // Verify purged sessions NEVER landed in SQLite
    for (const sid of purged) {
      assert.equal(countRows(sid), 0);
      assert.equal(getLogicalThreadState(sid), null);
    }
  });

  test("idempotent invalidation: 10 consecutive calls do not corrupt state or error", () => {
    const sessionId = `idem-inval-${UNIQ}`;
    updateLogicalThreadState(sessionId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-idem",
      parentId: "parent-initial",
      instructionsSent: true,
    });
    flushLogicalThreadState();

    for (let i = 0; i < 10; i++) {
      assert.doesNotThrow(() => invalidateLogicalThreadParent(sessionId));
      const row = getRow(sessionId);
      assert.equal(row?.parent_id, null);
      assert.equal(row?.chat_session_id, "chat-idem");
    }
  });

  test("canReuseThreadDelta with empty-string parentId falls back to full prompt", async () => {
    const dummyMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "again" },
    ];
    const fullPrompt = "Turn 1: hello\nTurn 2: world\nTurn 3: again";
    const currentPrompt = "Turn 3: again";

    const rawKey = `ctx-empty-str-parent-${UNIQ}`;
    const derivedId = deriveSessionId(dummyMessages, "", rawKey);

    updateLogicalThreadState(derivedId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-empty-str",
      parentId: "", // EMPTY STRING
      instructionsSent: true,
    });

    const ctx = await buildFinalContext({
      messages: dummyMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: currentPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "thread",
    });

    assert.equal(
      ctx.finalPrompt,
      fullPrompt,
      "When parentId is empty string, finalPrompt MUST be fullPrompt (never delta)",
    );
  });

  test("toolCapNotices: properly set, consumed, and purged on thread purge", () => {
    const sessionId = `cap-notice-${UNIQ}`;
    assert.equal(consumeToolCapNotice(sessionId), false);

    setToolCapNotice(sessionId);
    assert.equal(consumeToolCapNotice(sessionId), true);
    assert.equal(consumeToolCapNotice(sessionId), false);

    setToolCapNotice(sessionId);
    purgeLogicalThreadState(sessionId);
    assert.equal(consumeToolCapNotice(sessionId), false);
  });

  test("classifyRetryAction: client abort takes precedence over empty_response", () => {
    const abortErr = new Error("empty_response: client cancelled connection");
    const action = classifyRetryAction(abortErr, { clientDisconnected: true });

    assert.equal(action.reason, "client_abort");
    assert.equal(action.retryable, false);
  });

  test("tool-loop continuation without assistant role: sends delta if parentId set, full prompt if null", async () => {
    const toolMessages = [
      { role: "user", content: "run task" },
      { role: "tool", tool_call_id: "call_abc", name: "bash", content: "result ok" },
    ];
    const fullPrompt = "User: run task\nTool: result ok\nUser: next turn";
    const deltaPrompt = "Tool: result ok\nUser: next turn";
    const rawKey = `tool-loop-cont-${UNIQ}`;
    const derivedId = deriveSessionId(toolMessages, "", rawKey);

    // Case 1: parentId is null -> full prompt
    updateLogicalThreadState(derivedId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-tool-loop",
      parentId: null,
      instructionsSent: true,
    });

    const ctxNull = await buildFinalContext({
      messages: toolMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: deltaPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "thread",
    });
    assert.equal(ctxNull.finalPrompt, fullPrompt);

    // Case 2: parentId is valid -> delta prompt
    updateLogicalThreadState(derivedId, {
      accountId: TEST_ACCOUNT,
      chatSessionId: "chat-tool-loop",
      parentId: "p-tool-ok",
      instructionsSent: true,
    });

    const ctxValid = await buildFinalContext({
      messages: toolMessages,
      systemPrompt: "",
      toolInstructions: "",
      prompt: fullPrompt,
      currentPrompt: deltaPrompt,
      modelId: "qwen-max",
      enableThinking: false,
      conversationKey: rawKey,
      hasExplicitConversationKey: true,
      chatMode: "thread",
    });
    assert.equal(ctxValid.finalPrompt, deltaPrompt);
  });
});

