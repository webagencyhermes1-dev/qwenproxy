/**
 * Coverage for the session/message persistence layer against an isolated
 * in-memory SQLite database. The real repo database (data/db/qwenproxy.db) is
 * never touched: tables come straight from the exported v2 DDL.
 */
import Database from "better-sqlite3";
import assert from "node:assert";
import test from "node:test";

import type { ToolCall } from "../../domain/tools.ts";
import { NEW_TABLE_DDL } from "./schema.ts";
import type { AdvanceResult } from "./session-repository.ts";
import { MessageRepository } from "./message-repository.ts";
import { SessionRepository } from "./session-repository.ts";

let db: Database.Database;

test.beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const ddl of NEW_TABLE_DDL) db.exec(ddl);
});

test.afterEach(() => {
  db.close();
});

/** Asserts the write lost the optimistic race and reports the live version. */
function assertConflict(result: AdvanceResult, currentVersion: number): void {
  if (result.advanced) throw new Error("expected a version conflict");
  assert.strictEqual(result.conflict, true);
  assert.strictEqual(result.currentVersion, currentVersion);
}

test("SessionRepository: create + getById roundtrip preserves epoch-ms", () => {
  const sessions = new SessionRepository(db);
  const before = Date.now();

  const created = sessions.createSession({
    sessionId: "sess_roundtrip",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });
  const after = Date.now();

  assert.strictEqual(created.version, 1);
  assert.strictEqual(created.tenantId, "tenant_a");
  assert.strictEqual(created.modelId, "qwen-max");
  assert.ok(created.currentBranchId.startsWith("br_"));
  assert.ok(created.createdAt >= before && created.createdAt <= after);
  assert.strictEqual(created.createdAt, created.updatedAt);

  const reloaded = sessions.getById("sess_roundtrip");
  assert.notStrictEqual(reloaded, null);
  assert.strictEqual(reloaded!.sessionId, "sess_roundtrip");
  assert.strictEqual(reloaded!.version, 1);
  assert.strictEqual(reloaded!.currentBranchId, created.currentBranchId);
  assert.strictEqual(reloaded!.createdAt, created.createdAt);
  assert.strictEqual(reloaded!.upstreamMapping, undefined);

  // The row really is epoch-ms INTEGER, and the default branch landed too.
  const row = db
    .prepare(
      "SELECT created_at, updated_at, version, current_branch_id FROM sessions WHERE session_id = ?",
    )
    .get("sess_roundtrip") as {
    created_at: number;
    updated_at: number;
    version: number;
    current_branch_id: string;
  };
  assert.strictEqual(row.created_at, created.createdAt);
  assert.strictEqual(row.updated_at, created.updatedAt);
  assert.strictEqual(row.version, 1);
  assert.strictEqual(row.current_branch_id, created.currentBranchId);

  const branch = db
    .prepare("SELECT COUNT(*) AS n FROM branches WHERE session_id = ?")
    .get("sess_roundtrip") as { n: number };
  assert.strictEqual(branch.n, 1);
});

test("SessionRepository: getById is null for a missing session", () => {
  const sessions = new SessionRepository(db);
  assert.strictEqual(sessions.getById("sess_nope"), null);
});

test("SessionRepository: advanceVersion race — exactly one writer wins", async () => {
  const sessions = new SessionRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_race",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });
  const now = Date.now();

  // Real parallel scheduling: both claims are queued on the event loop before
  // either runs, so the atomic UPDATE is the only thing keeping them apart.
  const schedule = <T>(fn: () => T): Promise<T> =>
    new Promise<T>((resolve) => setImmediate(() => resolve(fn())));

  const [first, second] = await Promise.all([
    schedule(() =>
      sessions.advanceVersion({
        sessionId: session.sessionId,
        fromVersion: 1,
        toVersion: 2,
        updatedAt: now,
      }),
    ),
    schedule(() =>
      sessions.advanceVersion({
        sessionId: session.sessionId,
        fromVersion: 1,
        toVersion: 2,
        updatedAt: now,
      }),
    ),
  ]);

  const outcomes = [first, second];
  assert.strictEqual(
    outcomes.filter((outcome) => outcome.advanced).length,
    1,
    "exactly one racer must claim the version",
  );

  const loser = outcomes.find((outcome) => !outcome.advanced);
  assert.ok(loser, "expected a losing racer");
  assertConflict(loser as Extract<AdvanceResult, { advanced: false }>, 2);
  assert.strictEqual(sessions.getById(session.sessionId)!.version, 2);

  // A late retry from the stale version keeps losing; from the live one wins.
  assertConflict(
    sessions.advanceVersion({
      sessionId: session.sessionId,
      fromVersion: 1,
      toVersion: 2,
      updatedAt: now,
    }),
    2,
  );
  assert.deepStrictEqual(
    sessions.advanceVersion({
      sessionId: session.sessionId,
      fromVersion: 2,
      toVersion: 3,
      updatedAt: now + 1,
    }),
    { advanced: true },
  );
  assert.strictEqual(sessions.getById(session.sessionId)!.version, 3);
});

test("SessionRepository: advanceVersion requires an exact +1 step", () => {
  const sessions = new SessionRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_step",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  assert.throws(
    () =>
      sessions.advanceVersion({
        sessionId: session.sessionId,
        fromVersion: 1,
        toVersion: 4,
        updatedAt: Date.now(),
      }),
    /exactly 1/,
  );
});

test("SessionRepository: the atomic UPDATE itself claims or rejects", () => {
  const sessions = new SessionRepository(db);
  sessions.createSession({
    sessionId: "sess_atomic",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  const claim = db.prepare(
    "UPDATE sessions SET version = version + 1, updated_at = ? WHERE session_id = ? AND version = ?",
  );
  assert.strictEqual(claim.run(1, "sess_atomic", 1).changes, 1);
  assert.strictEqual(claim.run(2, "sess_atomic", 1).changes, 0);
  assert.strictEqual(claim.run(3, "sess_atomic", 2).changes, 1);
});

test("SessionRepository: stale branch pointer is rejected", () => {
  const sessions = new SessionRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_branch",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  assertConflict(
    sessions.setCurrentBranch(session.sessionId, "br_new", {
      expectedVersion: 99,
    }),
    1,
  );
  assert.strictEqual(
    sessions.getById(session.sessionId)!.currentBranchId,
    session.currentBranchId,
  );

  assert.deepStrictEqual(
    sessions.setCurrentBranch(session.sessionId, "br_new", {
      expectedVersion: 1,
    }),
    { advanced: true },
  );
  assert.strictEqual(
    sessions.getById(session.sessionId)!.currentBranchId,
    "br_new",
  );
  assert.strictEqual(sessions.getById(session.sessionId)!.version, 2);
});

test("SessionRepository: upstream mapping roundtrip (handles only)", () => {
  const sessions = new SessionRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_upstream",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  assert.deepStrictEqual(
    sessions.saveUpstreamMapping(
      session.sessionId,
      {
        accountId: "acc_1",
        upstreamChatId: "chat_9",
        upstreamParentId: "parent_9",
        mappingVersion: 1,
      },
      1,
    ),
    { advanced: true },
  );

  const mapped = sessions.getById(session.sessionId)!.upstreamMapping;
  assert.deepStrictEqual(mapped, {
    accountId: "acc_1",
    upstreamChatId: "chat_9",
    upstreamParentId: "parent_9",
    mappingVersion: 1,
  });

  // A writer whose session version is stale cannot clobber the mapping.
  assertConflict(
    sessions.saveUpstreamMapping(
      session.sessionId,
      {
        accountId: "acc_2",
        upstreamChatId: "chat_10",
        upstreamParentId: "parent_10",
        mappingVersion: 2,
      },
      77,
    ),
    1,
  );
  assert.strictEqual(
    sessions.getById(session.sessionId)!.upstreamMapping!.accountId,
    "acc_1",
  );

  // Handles are replaceable detail, including with nulls.
  assert.deepStrictEqual(
    sessions.saveUpstreamMapping(
      session.sessionId,
      {
        accountId: null,
        upstreamChatId: null,
        upstreamParentId: null,
        mappingVersion: 3,
      },
      1,
    ),
    { advanced: true },
  );
  assert.deepStrictEqual(
    sessions.getById(session.sessionId)!.upstreamMapping,
    {
      accountId: null,
      upstreamChatId: null,
      upstreamParentId: null,
      mappingVersion: 3,
    },
  );
});

test("SessionRepository: listByTenant scopes and limits", () => {
  const sessions = new SessionRepository(db);
  sessions.createSession({ sessionId: "s1", tenantId: "tA", modelId: "m" });
  sessions.createSession({ sessionId: "s2", tenantId: "tA", modelId: "m" });
  sessions.createSession({ sessionId: "s3", tenantId: "tB", modelId: "m" });

  assert.strictEqual(sessions.listByTenant("tA").length, 2);
  assert.strictEqual(sessions.listByTenant("tA", 1).length, 1);
  assert.strictEqual(sessions.listByTenant("tB").length, 1);
  assert.deepStrictEqual(sessions.listByTenant("tC"), []);
});

test("MessageRepository: append assigns stable monotonic sequences", () => {
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);

  const session = sessions.createSession({
    sessionId: "sess_msg",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });
  const other = sessions.createSession({
    sessionId: "sess_other",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  const m1 = messages.append({
    messageId: "m1",
    sessionId: session.sessionId,
    role: "user",
    content: "hello",
  });
  const m2 = messages.append({
    messageId: "m2",
    sessionId: session.sessionId,
    role: "assistant",
    content: "hi",
  });
  const m3 = messages.append({
    messageId: "m3",
    sessionId: session.sessionId,
    role: "user",
    content: "again",
  });

  assert.deepStrictEqual(
    [m1.sequenceNumber, m2.sequenceNumber, m3.sequenceNumber],
    [1, 2, 3],
  );
  assert.strictEqual(m1.branchId, session.currentBranchId);
  assert.strictEqual(m2.parentMessageId, null);

  // Sequences are per-session, so a sibling session restarts at 1.
  const otherMessage = messages.append({
    messageId: "o1",
    sessionId: other.sessionId,
    role: "user",
    content: "other",
  });
  assert.strictEqual(otherMessage.sequenceNumber, 1);

  assert.deepStrictEqual(
    messages
      .getBySession(session.sessionId)
      .map((message) => message.messageId),
    ["m1", "m2", "m3"],
  );
  assert.deepStrictEqual(
    messages
      .getBySession(session.sessionId, { fromSequence: 2 })
      .map((message) => message.messageId),
    ["m2", "m3"],
  );
  assert.deepStrictEqual(
    messages
      .getBySession(session.sessionId, { limit: 1 })
      .map((message) => message.messageId),
    ["m1"],
  );
  assert.deepStrictEqual(
    messages
      .getBySession(session.sessionId, { fromSequence: 2, limit: 1 })
      .map((message) => message.messageId),
    ["m2"],
  );

  assert.strictEqual(messages.getById("m2")!.content, "hi");
  assert.strictEqual(messages.getById("missing"), null);
});

test("MessageRepository: tool calls serialize and deserialize", () => {
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_tool_json",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  const calls: readonly ToolCall[] = [
    {
      callId: "call_a",
      name: "search",
      arguments: '{"q": "x"}',
      status: "pending",
    },
  ];
  const assistant = messages.append({
    messageId: "ma_json",
    sessionId: session.sessionId,
    role: "assistant",
    content: "",
    toolCalls: calls,
  });
  assert.strictEqual(assistant.toolCalls!.length, 1);

  const reloaded = messages.getById("ma_json")!;
  assert.strictEqual(reloaded.role, "assistant");
  assert.deepStrictEqual(reloaded.toolCalls, [
    {
      callId: "call_a",
      name: "search",
      arguments: '{"q": "x"}',
      status: "pending",
    },
  ]);

  // An assistant message without calls reads back without the property.
  const plain = messages.append({
    messageId: "ma_plain",
    sessionId: session.sessionId,
    role: "assistant",
    content: "no tools",
  });
  assert.strictEqual(plain.toolCalls, undefined);
  assert.strictEqual(messages.getById("ma_plain")!.toolCalls, undefined);
});

test("MessageRepository: getToolRound reconstructs the atomic group", () => {
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_round",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  const calls: readonly ToolCall[] = [
    {
      callId: "call_a",
      name: "search",
      arguments: '{"q": "x"}',
      status: "pending",
    },
    {
      callId: "call_b",
      name: "search",
      arguments: '{"q": "y"}',
      status: "pending",
    },
  ];
  const assistant = messages.append({
    messageId: "ma",
    sessionId: session.sessionId,
    role: "assistant",
    content: "",
    toolCalls: calls,
  });

  // No results yet: the round exists but is incomplete, and both calls pending.
  const empty = messages.getToolRound("ma")!;
  assert.strictEqual(empty.assistantMessageId, "ma");
  assert.strictEqual(empty.calls.length, 2);
  assert.strictEqual(empty.results.length, 0);
  assert.strictEqual(empty.isComplete, false);
  assert.deepStrictEqual(
    messages
      .getPendingToolCalls(session.sessionId)
      .map((call) => call.callId),
    ["call_a", "call_b"],
  );
  assert.strictEqual(
    messages.getPendingToolCalls(session.sessionId)[0].status,
    "pending",
  );

  messages.append({
    messageId: "mt_a",
    sessionId: session.sessionId,
    role: "tool",
    content: "result-a",
    toolCallId: "call_a",
  });
  const partial = messages.getToolRound("ma")!;
  assert.strictEqual(partial.results.length, 1);
  assert.strictEqual(partial.results[0].callId, "call_a");
  assert.strictEqual(partial.results[0].content, "result-a");
  assert.strictEqual(partial.isComplete, false);
  assert.deepStrictEqual(
    messages
      .getPendingToolCalls(session.sessionId)
      .map((call) => call.callId),
    ["call_b"],
  );

  messages.append({
    messageId: "mt_b",
    sessionId: session.sessionId,
    role: "tool",
    content: "result-b",
    toolCallId: "call_b",
  });
  const complete = messages.getToolRound("ma")!;
  assert.strictEqual(complete.results.length, 2);
  assert.strictEqual(complete.isComplete, true);
  assert.deepStrictEqual(messages.getPendingToolCalls(session.sessionId), []);

  // Results are matched by callId, so an unrelated tool message is ignored.
  messages.append({
    messageId: "mt_x",
    sessionId: session.sessionId,
    role: "tool",
    content: "unrelated",
    toolCallId: "call_z",
  });
  const afterStray = messages.getToolRound("ma")!;
  assert.strictEqual(afterStray.results.length, 2);
  assert.strictEqual(afterStray.isComplete, true);

  // Only assistant messages anchor a round.
  assert.strictEqual(messages.getToolRound("mt_a"), null);
  assert.strictEqual(messages.getToolRound("missing"), null);
});

test("MessageRepository: a stored completed status never hides a missing result", () => {
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_pending",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  messages.append({
    messageId: "ma_liar",
    sessionId: session.sessionId,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        callId: "call_late",
        name: "search",
        arguments: "{}",
        status: "completed",
      },
    ],
  });

  const round = messages.getToolRound("ma_liar")!;
  assert.strictEqual(round.calls.length, 1);
  assert.strictEqual(round.results.length, 0);
  assert.strictEqual(round.isComplete, false);

  const pending = messages.getPendingToolCalls(session.sessionId);
  assert.deepStrictEqual(pending, [
    {
      callId: "call_late",
      name: "search",
      arguments: "{}",
      status: "pending",
    },
  ]);
});

test("MessageRepository: deleteFromSequence trims the tail and resequences", () => {
  const sessions = new SessionRepository(db);
  const messages = new MessageRepository(db);
  const session = sessions.createSession({
    sessionId: "sess_trim",
    tenantId: "tenant_a",
    modelId: "qwen-max",
  });

  for (let i = 1; i <= 3; i++) {
    messages.append({
      messageId: `t${i}`,
      sessionId: session.sessionId,
      role: "user",
      content: `msg-${i}`,
    });
  }

  assert.strictEqual(messages.deleteFromSequence(session.sessionId, 2), 2);
  assert.deepStrictEqual(
    messages
      .getBySession(session.sessionId)
      .map((message) => message.messageId),
    ["t1"],
  );

  // The next append takes max+1 of what remains, so numbers stay gap-free.
  const appended = messages.append({
    messageId: "t4",
    sessionId: session.sessionId,
    role: "user",
    content: "msg-4",
  });
  assert.strictEqual(appended.sequenceNumber, 2);
  assert.strictEqual(messages.deleteFromSequence(session.sessionId, 99), 0);
});
