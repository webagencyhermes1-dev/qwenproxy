/**
 * Appendix G scenario 2 — tool-call integrity stress.
 *
 * Parallel tools, out-of-order results, failover after a tool call, and a
 * client disconnect while a result is pending. Asserts invalid tool round = 0
 * and no tool/result pair is ever split across semantic groups.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SeededPrng, StressCounters } from "./driver.ts";
import { newScenarioRecorder, type ScenarioResult, printStressSummary, registerScenarioResult } from "./summary.ts";
import {
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolRound,
  assertToolRoundStructurallyValid,
  isToolRoundComplete,
  toolCallFingerprint,
  toolSetHash,
} from "../../domain/tools.ts";
import {
  type Generation,
  type GenerationAttempt,
  canAcceptResult,
  isAttemptedAccount,
  nextAttempt,
} from "../../domain/generation.ts";
import type { Message } from "../../domain/session.ts";
import { TypedRuntimeError } from "../../domain/errors.ts";
import { groupSemanticUnits, isGroupDroppable } from "../../runtime/context/context-service.ts";
import { RetryCoordinator } from "../../runtime/retry/retry-coordinator.ts";

export const SCENARIO_NAME = "tool-integrity-stress";
export let STRESS_RESULT: ScenarioResult;

const counters = new StressCounters();
const recorder = newScenarioRecorder(SCENARIO_NAME, counters);
const prng = new SeededPrng("tool-integrity|v1");

const EXCHANGE_COUNT = 60;
const PARALLEL_CALLS = 3;

function makeCall(exchange: number, slot: number): ToolCall {
  return {
    callId: `call-${String(exchange).padStart(3, "0")}-${slot}`,
    name: `tool_${slot}`,
    arguments: JSON.stringify({ query: `q${exchange}`, limit: slot * 7 }),
    status: "completed",
  };
}

function makeResult(call: ToolCall, at: number): ToolResult {
  return {
    callId: call.callId,
    content: `result:${call.callId}`,
    isError: false,
    completedAt: at,
  };
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = prng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function expectValid(round: ToolRound): void {
  try {
    assertToolRoundStructurallyValid(round);
  } catch {
    counters.inc("invalidToolRound");
    throw new Error(`invalid tool round detected: ${round.assistantMessageId}`);
  }
}

function makeGeneration(id: string): Generation {
  return {
    generationId: id,
    tenantId: "stress",
    sessionId: "sess-tools",
    turnId: `turn_${id}`,
    sessionVersionAtStart: 1,
    state: "QUEUED",
    attemptIds: [],
    attemptedAccountIds: [],
    snapshotId: null,
    leaseId: null,
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    terminalAt: null,
    sideEffects: {
      outputEmittedToClient: false,
      toolCallsExecuted: [],
      lastUpdatedAt: Date.now(),
    },
    idempotencyKey: null,
  };
}

function makeAttempt(generation: Generation, accountId: string): {
  generation: Generation;
  attempt: GenerationAttempt;
} {
  const opened = nextAttempt(generation, accountId);
  if (opened === null) throw new Error("attempt budget exhausted");
  return opened;
}

const retry = new RetryCoordinator({
  maxAttempts: 4,
  maxAccountSwitches: 2,
  baseDelayMs: 1,
  maxDelayMs: 8,
  chatInProgressMaxSameChat: 2,
  jitter: () => prng.next(),
});

test(
  "tool-integrity: parallel calls resolve in arbitrary order",
  recorder.track("parallel out-of-order results", () => {
    const calls: ToolCall[] = [];
    for (let slot = 0; slot < 8; slot++) {
      calls.push({
        callId: `parallel-${slot}`,
        name: `tool_${slot % 3}`,
        arguments: JSON.stringify({ slot }),
        status: "in_progress",
      });
    }
    const results: ToolResult[] = shuffle(calls).map((c) => makeResult(c, 1_000));
    const round: ToolRound = {
      assistantMessageId: "msg-assistant-parallel",
      calls,
      results,
      isComplete: false,
    };
    expectValid(round);
    assert.equal(isToolRoundComplete(round), true, "out-of-order results still complete the round");
    const resolved = new Set(results.map((r) => r.callId));
    for (const call of calls) assert.ok(resolved.has(call.callId));
  }),
);

test(
  "tool-integrity: failover after an executed tool call is refused",
  recorder.track("side effects block replay", () => {
    const opened = makeAttempt(makeGeneration("gen-side-effects"), "acct-a");
    const withSideEffects: Generation = {
      ...opened.generation,
      state: "STREAMING",
      sideEffects: {
        outputEmittedToClient: false,
        toolCallsExecuted: [opened.attempt.attemptId],
        lastUpdatedAt: Date.now(),
      },
    };
    const decision = retry.decide({
      error: TypedRuntimeError.fromCode("UPSTREAM_TIMEOUT", "upstream timed out"),
      generation: withSideEffects,
      attempt: opened.attempt,
      chatCorrupted: false,
      accountLevelFailure: false,
    });
    assert.equal(decision.action, "FAIL_TERMINAL", "never replay executed tool work");
    assert.equal(nextAttempt(withSideEffects, "acct-b"), null, "domain refuses the replay too");
  }),
);

test(
  "tool-integrity: failover without side effects replays on an untried account",
  recorder.track("clean failover", () => {
    const opened = makeAttempt(makeGeneration("gen-clean-failover"), "acct-a");
    const decision = retry.decide({
      error: TypedRuntimeError.fromCode("UPSTREAM_TIMEOUT", "upstream timed out"),
      generation: { ...opened.generation, state: "STREAMING" },
      attempt: opened.attempt,
      chatCorrupted: false,
      accountLevelFailure: false,
    });
    assert.equal(decision.action, "RETRY");
    assert.equal(decision.tier, 1, "first timeout settles on the same account");
    assert.equal(isAttemptedAccount(opened.generation, "acct-a"), true);
    assert.equal(isAttemptedAccount(opened.generation, "acct-b"), false);
    const reopened = makeAttempt(opened.generation, "acct-b");
    assert.equal(reopened.attempt.attemptNumber, 2);
    assert.equal(isAttemptedAccount(reopened.generation, "acct-b"), true);
  }),
);

test(
  "tool-integrity: late result from a superseded attempt is dropped",
  recorder.track("late result dropped", () => {
    const opened = makeAttempt(makeGeneration("gen-late-result"), "acct-a");
    const streaming: Generation = {
      ...opened.generation,
      state: "WAITING_FOR_TOOL_RESULTS",
    };
    assert.equal(
      canAcceptResult(streaming, opened.attempt.attemptId, "WAITING_FOR_TOOL_RESULTS"),
      true,
    );
    const reopened = makeAttempt(opened.generation, "acct-b");
    assert.equal(
      canAcceptResult(reopened.generation, opened.attempt.attemptId, "WAITING_FOR_TOOL_RESULTS"),
      false,
      "a result naming a superseded attempt is a stray",
    );
    const terminal: Generation = { ...reopened.generation, state: "COMPLETED" };
    assert.equal(canAcceptResult(terminal, reopened.attempt.attemptId, "SETTLING"), false);
  }),
);

test(
  "tool-integrity: disconnect while a result is pending keeps the round honest",
  recorder.track("pending round at disconnect", () => {
    const calls: ToolCall[] = [makeCall(1, 0), makeCall(1, 1), makeCall(1, 2)];
    calls[2] = { ...calls[2], status: "pending" };
    const pendingRound: ToolRound = {
      assistantMessageId: "msg-pending",
      calls,
      results: [makeResult(calls[0] as ToolCall, 1), makeResult(calls[1] as ToolCall, 2)],
      isComplete: false,
    };
    expectValid(pendingRound);
    assert.equal(isToolRoundComplete(pendingRound), false, "missing result must stay pending");
    const late: ToolResult = makeResult(calls[2] as ToolCall, 3);
    const reopened = makeAttempt(makeGeneration("gen-pending"), "acct-b");
    const terminal: Generation = { ...reopened.generation, state: "FAILED" };
    const accepted = canAcceptResult(terminal, reopened.attempt.attemptId, "WAITING_FOR_TOOL_RESULTS");
    assert.equal(accepted, false, "a result arriving after terminal is dropped");
    void late;
  }),
);

test(
  "tool-integrity: a result for an unknown callId is rejected",
  recorder.track("unknown callId rejected", () => {
    const calls: ToolCall[] = [makeCall(2, 0)];
    const poisoned: ToolRound = {
      assistantMessageId: "msg-poisoned",
      calls,
      results: [{ ...makeResult(calls[0] as ToolCall, 1), callId: "call-unknown" }],
      isComplete: false,
    };
    let threw = false;
    try {
      assertToolRoundStructurallyValid(poisoned);
    } catch {
      threw = true;
    }
    if (!threw) counters.inc("invalidToolRound");
    assert.equal(threw, true, "the structural guard must reject unknown callIds");
  }),
);

test(
  "tool-integrity: no tool/result pair is split across semantic groups",
  recorder.track("group atomicity at scale", () => {
    const messages: Message[] = [
      {
        messageId: "msg-system",
        sessionId: "sess-tools",
        role: "system",
        content: "system prompt",
        sequenceNumber: 0,
        parentMessageId: null,
        branchId: "br-1",
        createdAt: 0,
      },
    ];
    let seq = 1;
    for (let exchange = 0; exchange < EXCHANGE_COUNT; exchange++) {
      const userMessageId = `msg-user-${exchange}`;
      const assistantMessageId = `msg-assistant-${exchange}`;
      messages.push({
        messageId: userMessageId,
        sessionId: "sess-tools",
        role: "user",
        content: `turn ${exchange}`,
        sequenceNumber: seq++,
        parentMessageId: null,
        branchId: "br-1",
        createdAt: exchange * 10,
      });
      const calls: ToolCall[] = [];
      for (let slot = 0; slot < PARALLEL_CALLS; slot++) calls.push(makeCall(exchange, slot));
      messages.push({
        messageId: assistantMessageId,
        sessionId: "sess-tools",
        role: "assistant",
        content: exchange % 4 === 0 ? "" : `thinking ${exchange}`,
        sequenceNumber: seq++,
        parentMessageId: userMessageId,
        branchId: "br-1",
        createdAt: exchange * 10 + 1,
        toolCalls: calls,
      });
      for (const result of shuffle(calls)) {
        messages.push({
          messageId: `msg-tool-${exchange}-${result.callId}`,
          sessionId: "sess-tools",
          role: "tool",
          content: makeResult(result, exchange * 10 + 2).content,
          sequenceNumber: seq++,
          parentMessageId: assistantMessageId,
          branchId: "br-1",
          createdAt: exchange * 10 + 3,
          toolCallId: result.callId,
        });
      }
    }

    const groups = groupSemanticUnits(messages);
    counters.setMetric("semantic-groups", groups.length);
    const groupByMessageId = new Map<string, string>();
    for (const group of groups) {
      for (const message of group.messages) {
        groupByMessageId.set(message.messageId, group.groupId);
      }
    }
    for (const group of groups) {
      const calls: ToolCall[] = [];
      const results: string[] = [];
      for (const message of group.messages) {
        if (message.role === "assistant" && message.toolCalls) calls.push(...message.toolCalls);
        if (message.role === "tool" && message.toolCallId) results.push(message.toolCallId);
      }
      const known = new Set(calls.map((c) => c.callId));
      for (const callId of results) {
        if (!known.has(callId)) {
          counters.inc("invalidToolRound");
          throw new Error(`tool result ${callId} split from its call group ${group.groupId}`);
        }
      }
      const round: ToolRound = {
        assistantMessageId: group.messages.find((m) => m.role === "assistant")?.messageId ??
          group.groupId,
        calls,
        results: results.map((callId) => ({
          callId,
          content: "r",
          isError: false,
          completedAt: 0,
        })),
        isComplete: false,
      };
      expectValid(round);
      if (round.calls.length > 0 && group.tier === 2) {
        assert.equal(
          isGroupDroppable(group),
          isToolRoundComplete(round),
          "a resolved tier-2 round must be droppable as a whole",
        );
      }
    }
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    assert.equal(
      groupByMessageId.size,
      messages.length,
      "every message belongs to exactly one group",
    );
    counters.setMetric("tool-calls", assistantCount * PARALLEL_CALLS);
  }),
);

test(
  "tool-integrity: fingerprints and tool-set hashes are stable under reordering",
  recorder.track("stable identity", () => {
    const a: ToolCall = {
      callId: "c1",
      name: "search",
      arguments: JSON.stringify({ limit: 5, query: "q" }),
      status: "pending",
    };
    const b: ToolCall = {
      callId: "c1",
      name: "search",
      arguments: JSON.stringify({ query: "q", limit: 5 }),
      status: "pending",
    };
    assert.equal(toolCallFingerprint(a), toolCallFingerprint(b));
    const defs: ToolDefinition[] = [
      {
        name: "zeta",
        parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
      {
        name: "alpha",
        parameters: { type: "object", required: ["b"], properties: { b: { type: "number" } } },
      },
    ];
    assert.equal(toolSetHash(defs), toolSetHash([...defs].reverse()));
  }),
);

test.after(() => {
  STRESS_RESULT = recorder.finalize();
  registerScenarioResult(STRESS_RESULT);
  printStressSummary();
});
