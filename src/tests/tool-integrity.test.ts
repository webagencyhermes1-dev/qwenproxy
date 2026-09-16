/**
 * Appendix 55 — Tool Integrity test suite.
 *
 * Covers the normalized tool domain model in `src/domain/tools.ts` (pure: no DB,
 * no network, no browser): round completion semantics, callId correlation of
 * out-of-order parallel results, idempotent duplicate result delivery, pending
 * rounds at compaction time, failover/replay safety via attributable
 * ToolCallEvents, structural validation, hash stability, and argument
 * canonicalization.
 *
 * Deterministic by construction: no timers, no sleeps, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { MessageToolCall } from "../utils/types.ts";
import {
  type ToolCall,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolResult,
  type ToolRound,
  assertToolRoundStructurallyValid,
  canonicalizeToolArguments,
  isToolRoundComplete,
  toolCallFingerprint,
  toolSetHash,
} from "../domain/tools.ts";
import {
  type Generation,
  canAcceptResult,
  nextAttempt,
} from "../domain/generation.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCall(
  callId: string,
  name: string,
  args: string,
  status: ToolCall["status"] = "completed",
): ToolCall {
  return { callId, name, arguments: args, status };
}

function makeResult(
  callId: string,
  content: string,
  isError = false,
  completedAt = 1000,
): ToolResult {
  return { callId, content, isError, completedAt };
}

function makeRound(
  assistantMessageId: string,
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
  isComplete: boolean,
): ToolRound {
  return { assistantMessageId, calls, results, isComplete };
}

function makeToolSet(): readonly ToolDefinition[] {
  return [
    {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      strict: true,
    },
    {
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  ];
}

/**
 * Idempotent result-delivery model (stands in for the delivery reducer): a
 * flaky client may redeliver the same result; the semantic outcome is recorded
 * exactly once, so the round's results never contain a duplicate callId.
 */
function deliverResult(round: ToolRound, result: ToolResult): ToolRound {
  if (round.results.some((r) => r.callId === result.callId)) return round;
  return { ...round, results: [...round.results, result] };
}

/**
 * getPendingToolCalls model: calls with no matching result by callId. A pending
 * round must stay pending — never summarized as resolved.
 */
function getPendingToolCalls(round: ToolRound): ToolCall[] {
  const resolved = new Set(round.results.map((r) => r.callId));
  return round.calls.filter((c) => !resolved.has(c.callId));
}

/**
 * Replay guard for attributable tool events: an event that does not name the
 * CURRENT physical attempt is a stale replay of a superseded attempt.
 */
function isStaleToolEvent(currentAttemptId: string, ev: ToolCallEvent): boolean {
  return ev.attemptId !== currentAttemptId;
}

function makeGeneration(generationId: string): Generation {
  return {
    generationId,
    tenantId: "tenant-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sessionVersionAtStart: 1,
    state: "STREAMING",
    attemptIds: [],
    attemptedAccountIds: [],
    snapshotId: null,
    leaseId: null,
    deadline: Number.MAX_SAFE_INTEGER,
    createdAt: 1000,
    terminalAt: null,
    sideEffects: {
      outputEmittedToClient: false,
      toolCallsExecuted: [],
      lastUpdatedAt: 0,
    },
    idempotencyKey: null,
  };
}

// ─── 1. Single tool call ───────────────────────────────────────────────────────

test("single tool call: one call plus its matching result completes the round", () => {
  const call = makeCall("call-1", "read_file", '{"path":"/etc/hosts"}');
  const round = makeRound("msg-1", [call], [makeResult("call-1", "127.0.0.1 localhost")], false);

  assert.equal(isToolRoundComplete(round), true);
  assert.equal(getPendingToolCalls(round).length, 0);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(round));
});

// ─── 2. Multiple parallel calls, arbitrary arrival order ──────────────────────

test("parallel tool calls: results arriving in reverse order complete the round only when all are present", () => {
  const calls = [
    makeCall("call-a", "read_file", '{"path":"/a"}'),
    makeCall("call-b", "read_file", '{"path":"/b"}'),
    makeCall("call-c", "read_file", '{"path":"/c"}'),
  ];

  // Results land in arbitrary (reverse) completion order.
  const reverseResults = [
    makeResult("call-c", "C", false, 3000),
    makeResult("call-b", "B", false, 2000),
    makeResult("call-a", "A", false, 1000),
  ];

  // Completion only once EVERY result is present.
  assert.equal(
    isToolRoundComplete(makeRound("msg-1", calls, reverseResults.slice(0, 1), false)),
    false,
  );
  assert.equal(
    isToolRoundComplete(makeRound("msg-1", calls, reverseResults.slice(0, 2), false)),
    false,
  );

  const complete = makeRound("msg-1", calls, reverseResults, false);
  assert.equal(isToolRoundComplete(complete), true);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(complete));
});

// ─── 3. Out-of-order correlation is by callId, never by position ──────────────

test("out-of-order results correlate by callId, not by result array position", () => {
  const calls = [
    makeCall("call-a", "search", '{"query":"first"}'),
    makeCall("call-b", "search", '{"query":"second"}'),
    makeCall("call-c", "search", '{"query":"third"}'),
  ];
  // Deliberately reversed relative to the calls array: position must not be used.
  const results = [
    makeResult("call-c", "third-result"),
    makeResult("call-b", "second-result"),
    makeResult("call-a", "first-result"),
  ];
  const round = makeRound("msg-1", calls, results, true);

  assert.equal(isToolRoundComplete(round), true);
  for (const call of calls) {
    const matched = results.find((r) => r.callId === call.callId);
    assert.ok(matched, `result for ${call.callId} must be present`);
    // Content follows the callId, not the index: call-a ↔ first-result, etc.
    const expected = call.arguments.includes("first")
      ? "first-result"
      : call.arguments.includes("second")
        ? "second-result"
        : "third-result";
    assert.equal(matched.content, expected);
  }
  // No position-based assumption: shuffling results keeps the mapping identical.
  const shuffled = makeRound(
    "msg-1",
    calls,
    [results[1], results[2], results[0]],
    true,
  );
  assert.equal(isToolRoundComplete(shuffled), true);
  assert.equal(
    shuffled.results.find((r) => r.callId === "call-a")?.content,
    "first-result",
  );
});

// ─── 4. Duplicate result delivery is idempotent ───────────────────────────────

test("duplicate result delivery does not corrupt the round and is idempotent", () => {
  const call = makeCall("call-1", "read_file", '{"path":"/a"}', "in_progress");
  const fingerprintBefore = toolCallFingerprint(call);

  let round = makeRound("msg-1", [call], [], false);
  assert.equal(isToolRoundComplete(round), false);

  const result = makeResult("call-1", "contents-of-a");
  round = deliverResult(round, result);
  const afterFirst = round;
  round = deliverResult(round, result); // flaky client redelivers the same result.

  // Exactly one semantic result; no duplicate callId.
  assert.equal(round.results.length, 1);
  assert.equal(new Set(round.results.map((r) => r.callId)).size, 1);
  assert.equal(round, afterFirst); // referentially identical: a true no-op.
  assert.equal(isToolRoundComplete(round), true);
  assert.equal(getPendingToolCalls(round).length, 0);

  // Fingerprint dedup: the call's semantic identity is unchanged by redelivery.
  assert.equal(toolCallFingerprint(call), fingerprintBefore);
  assert.equal(
    toolCallFingerprint(makeCall("call-1", "read_file", '{"path":"/a"}', "completed")),
    fingerprintBefore, // callId/status are excluded from the fingerprint
  );
});

test("duplicate delivery with conflicting content keeps the first outcome (no corruption)", () => {
  const call = makeCall("call-9", "read_file", '{"path":"/x"}');
  let round = makeRound("msg-9", [call], [], false);

  round = deliverResult(round, makeResult("call-9", "first-content"));
  round = deliverResult(round, makeResult("call-9", "contradictory-late-content"));

  assert.equal(round.results.length, 1);
  assert.equal(round.results[0].content, "first-content");
  assert.equal(isToolRoundComplete(round), true);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(round));
});

// ─── 5. Missing results stay pending ───────────────────────────────────────────

test("missing results: a round with calls but no results is not complete and reports all calls pending", () => {
  const calls = [
    makeCall("call-a", "read_file", '{"path":"/a"}'),
    makeCall("call-b", "read_file", '{"path":"/b"}'),
    makeCall("call-c", "read_file", '{"path":"/c"}'),
  ];

  const empty = makeRound("msg-1", calls, [], false);
  assert.equal(isToolRoundComplete(empty), false);
  assert.equal(getPendingToolCalls(empty).length, 3);
  // Never treated as resolved: a pending round passes structural validation
  // only while it honestly declares isComplete=false.
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(empty));

  // Partial: 2 of 3 delivered — still not complete, exactly one pending.
  const partial = makeRound(
    "msg-1",
    calls,
    [makeResult("call-a", "A"), makeResult("call-c", "C")],
    false,
  );
  assert.equal(isToolRoundComplete(partial), false);
  assert.deepEqual(
    getPendingToolCalls(partial).map((c) => c.callId),
    ["call-b"],
  );
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(partial));
});

// ─── 6. Pending rounds at compaction time ──────────────────────────────────────

test("compaction: a pending tool round is representable as pending and is never summarized as resolved", () => {
  const calls = [makeCall("call-1", "read_file", '{"path":"/a"}')];

  // Pending state is legal and survives validation.
  const pending = makeRound("msg-1", calls, [], false);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(pending));
  assert.equal(isToolRoundComplete(pending), false);
  assert.equal(getPendingToolCalls(pending).length, 1);

  // The same round falsely claiming completeness is rejected: a missing result
  // must stay pending, never be summarized as resolved.
  const falselyComplete = makeRound("msg-1", calls, [], true);
  assert.throws(
    () => assertToolRoundStructurallyValid(falselyComplete),
    /Completed tool round is missing result for callId: call-1/,
  );
  // And its honest counterpart validates once the result arrives.
  const resolved = makeRound("msg-1", calls, [makeResult("call-1", "A")], true);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(resolved));
});

// ─── 7. Failover after a tool result: attributable events ─────────────────────

test("failover: ToolCallEvents from attempt 1 are distinguishable from attempt 2 and replays are detectable", () => {
  const gen = makeGeneration("gen-100");
  const attempt1 = nextAttempt(gen, "account-a");
  assert.ok(attempt1, "first attempt must open while no irreversible side effects are recorded");
  const attempt2 = nextAttempt(attempt1.generation, "account-b");
  assert.ok(attempt2, "failover must open a fresh physical attempt");

  assert.equal(attempt1.attempt.attemptId, "gen-100_attempt_1");
  assert.equal(attempt2.attempt.attemptId, "gen-100_attempt_2");
  assert.equal(attempt2.generation.attemptIds.length, 2);

  // The same logical tool call is re-issued on the failover attempt. Both events
  // carry the shared generationId but distinct attemptIds.
  const ev1: ToolCallEvent = {
    callId: "call-1",
    generationId: gen.generationId,
    attemptId: attempt1.attempt.attemptId,
    sessionId: gen.sessionId,
    at: 100,
  };
  const ev2: ToolCallEvent = {
    callId: "call-1",
    generationId: gen.generationId,
    attemptId: attempt2.attempt.attemptId,
    sessionId: gen.sessionId,
    at: 200,
  };

  assert.equal(ev1.generationId, ev2.generationId); // logical continuity
  assert.notEqual(ev1.attemptId, ev2.attemptId); // physical attempts differ

  // Replay safety: after failover, an event from the superseded attempt is stale.
  const current = attempt2.generation.attemptIds[attempt2.generation.attemptIds.length - 1];
  assert.equal(isStaleToolEvent(current, ev1), true);
  assert.equal(isStaleToolEvent(current, ev2), false);

  // Late-callback guard: a result naming the superseded attempt is refused.
  assert.equal(
    canAcceptResult(attempt2.generation, attempt1.attempt.attemptId, "STREAMING"),
    false,
  );
  assert.equal(
    canAcceptResult(attempt2.generation, attempt2.attempt.attemptId, "STREAMING"),
    true,
  );
});

// ─── 8. Structural validity rejection ──────────────────────────────────────────

test("structural validity: a result referencing an unknown callId is rejected", () => {
  const round = makeRound(
    "msg-1",
    [makeCall("call-1", "read_file", '{"path":"/a"}')],
    [makeResult("call-unknown", "ghost")],
    false,
  );
  assert.throws(
    () => assertToolRoundStructurallyValid(round),
    /Tool result references unknown callId: call-unknown/,
  );
});

test("structural validity: a round marked complete with a missing required result is rejected", () => {
  const round = makeRound(
    "msg-1",
    [makeCall("call-1", "read_file", '{"path":"/a"}'),
     makeCall("call-2", "read_file", '{"path":"/b"}')],
    [makeResult("call-1", "A")],
    true, // claims complete, but call-2 has no result
  );
  assert.throws(
    () => assertToolRoundStructurallyValid(round),
    /Completed tool round is missing result for callId: call-2/,
  );
});

test("structural validity: a fully correlated round passes regardless of result order", () => {
  const round = makeRound(
    "msg-1",
    [makeCall("call-1", "a", "{}"), makeCall("call-2", "b", "{}")],
    [makeResult("call-2", "B"), makeResult("call-1", "A")],
    true,
  );
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(round));
});

// ─── 9. Hash stability ─────────────────────────────────────────────────────────

test("toolSetHash is order-insensitive and deterministic across definitions", () => {
  const [readFile, search] = makeToolSet();

  const forward = toolSetHash([readFile, search]);
  const reversed = toolSetHash([search, readFile]);
  assert.equal(forward, reversed, "definition order must not affect the hash");
  assert.equal(forward, toolSetHash([readFile, search])); // stable on recompute

  // Logically distinct sets hash differently.
  const altered = toolSetHash([
    { ...readFile, description: "Read a file (v2)" },
    search,
  ]);
  assert.notEqual(forward, altered);
  assert.notEqual(forward, toolSetHash([readFile]));
  assert.match(forward, /^[0-9a-f]{16}$/);
});

test("toolCallFingerprint is identical across attempts for the same logical call (callId/status excluded)", () => {
  const attempt1 = makeCall("call-attempt-1", "read_file", '{"path":"/a","encoding":"utf8"}', "in_progress");
  const attempt2 = makeCall("call-attempt-2", "read_file", '{"encoding":"utf8","path":"/a"}', "completed");

  assert.equal(toolCallFingerprint(attempt1), toolCallFingerprint(attempt2));

  // Different arguments ⇒ different fingerprint.
  const different = makeCall("call-attempt-3", "read_file", '{"path":"/b"}');
  assert.notEqual(toolCallFingerprint(attempt1), toolCallFingerprint(different));
  // Different name ⇒ different fingerprint.
  const renamed = makeCall("call-attempt-4", "write_file", '{"path":"/a"}');
  assert.notEqual(toolCallFingerprint(attempt1), toolCallFingerprint(renamed));
});

// ─── 10. Argument canonicalization ─────────────────────────────────────────────

test("canonicalizeToolArguments is key-order-insensitive for objects and arrays", () => {
  assert.equal(
    canonicalizeToolArguments('{"b":2,"a":1}'),
    canonicalizeToolArguments('{"a":1,"b":2}'),
  );
  assert.equal(canonicalizeToolArguments('{"a":1,"b":2}'), '{"a":1,"b":2}');

  // Nested structures canonicalize deeply.
  assert.equal(
    canonicalizeToolArguments('{"z":{"d":4,"c":3},"list":[{"y":2,"x":1}]}'),
    canonicalizeToolArguments('{"list":[{"x":1,"y":2}],"z":{"c":3,"d":4}}'),
  );
  // Whitespace is normalized away.
  assert.equal(
    canonicalizeToolArguments('  {"a" : 1 } '),
    canonicalizeToolArguments('{"a":1}'),
  );
  // Scalars pass through stably.
  assert.equal(canonicalizeToolArguments("42"), "42");
  assert.equal(canonicalizeToolArguments('"hi"'), '"hi"');
});

test("canonicalizeToolArguments is total: malformed JSON returns the trimmed original and never throws", () => {
  const malformed = '  {"broken":  ';
  assert.equal(canonicalizeToolArguments(malformed), '{"broken":');
  assert.equal(canonicalizeToolArguments("not-json-at-all"), "not-json-at-all");
  assert.equal(canonicalizeToolArguments(""), "");
  assert.equal(canonicalizeToolArguments("   "), "");
  // Totality: no input can make it throw.
  const hostile = ['{', '[1,', 'undefined', '{a:b}', '"\\q', '\x00\x01'];
  for (const input of hostile) {
    assert.doesNotThrow(() => canonicalizeToolArguments(input));
  }
  // A malformed variant of an otherwise-valid payload does NOT collide with the
  // canonical form of the valid payload.
  assert.notEqual(
    canonicalizeToolArguments('{"a":1'),
    canonicalizeToolArguments('{"a":1}'),
  );
});

// ─── 11. Degenerate round ──────────────────────────────────────────────────────

test("a round with no tool calls is never complete (vacuous truth is not resolution)", () => {
  const empty = makeRound("msg-1", [], [], false);
  assert.equal(isToolRoundComplete(empty), false);
  assert.equal(getPendingToolCalls(empty).length, 0);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(empty));
});

// ─── 12. Failed results still resolve the round ────────────────────────────────

test("a failed tool result (isError) still resolves its call by callId", () => {
  const calls = [
    makeCall("call-a", "read_file", '{"path":"/a"}'),
    makeCall("call-b", "read_file", '{"path":"/b"}'),
  ];
  const results = [
    makeResult("call-a", "A", false),
    makeResult("call-b", "ENOENT: no such file", true, 1500),
  ];
  const round = makeRound("msg-1", calls, results, true);

  assert.equal(isToolRoundComplete(round), true);
  assert.equal(getPendingToolCalls(round).length, 0);
  assert.doesNotThrow(() => assertToolRoundStructurallyValid(round));
  assert.equal(round.results.find((r) => r.callId === "call-b")?.isError, true);
});

// ─── 13. Legacy wire model → normalized model contrast ────────────────────────

test("legacy MessageToolCall maps to the normalized ToolCall and correlates by callId, not array position", () => {
  const legacy: readonly MessageToolCall[] = [
    { id: "legacy-2", type: "function", function: { name: "search", arguments: '{"query":"q"}' } },
    { id: "legacy-1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } },
  ];

  // Normalization lifts the wire shape; the positional `index` from the legacy
  // streaming delta model is discarded in favor of the stable callId.
  const normalized: readonly ToolCall[] = legacy.map((w) => ({
    callId: w.id,
    name: w.function.name,
    arguments: w.function.arguments,
    status: "pending",
  }));

  const round = makeRound(
    "msg-1",
    normalized,
    [
      makeResult("legacy-1", "A"),
      makeResult("legacy-2", "results"),
    ],
    false,
  );
  assert.equal(isToolRoundComplete(round), true);
  // Correlation holds even though the results array order is inverted relative
  // to both the wire order and the normalized calls order.
  assert.equal(round.results[0].callId, "legacy-1");
  assert.equal(round.results[0].content, "A");
  assert.equal(
    round.calls.find((c) => c.callId === "legacy-2")?.name,
    "search",
  );
});
