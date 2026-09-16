import test from "node:test";
import assert from "node:assert";

import {
  estimateTokens,
  groupSemanticUnits,
  isGroupDroppable,
  prepareContext,
} from "./context-service.ts";
import type { CompactionPassRecord, ModelCapabilitySource } from "./context-service.ts";
import { CONTEXT_COMPACTION_MAX_PASSES } from "../../domain/context.ts";
import { buildContextBudget } from "../../domain/context.ts";
import type { Message } from "../../domain/session.ts";
import type { ToolDefinition } from "../../domain/tools.ts";
import { TOOL_CALL_OPEN } from "../../tools/toolcall-tags.ts";

// Hermetic: no DB, no network, no filesystem. Model limits are faked.
const FAKE_CAPS: ModelCapabilitySource = {
  getContextWindowTokens: () => 200_000,
  getMaxOutputTokens: () => 8_192,
};

const SMALL_WINDOW_CAPS: ModelCapabilitySource = {
  getContextWindowTokens: () => 32_000,
  getMaxOutputTokens: () => 4_096,
};

let seq = 0;
function mk(
  role: Message["role"],
  content: string,
  extra: Partial<Message> = {},
): Message {
  seq += 1;
  return {
    messageId: `msg_${seq}`,
    sessionId: "sess_test",
    role,
    content,
    sequenceNumber: seq,
    parentMessageId: null,
    branchId: "br_test",
    createdAt: 1_000 + seq,
    ...extra,
  };
}

function padTo(text: string, len: number): string {
  if (text.length >= len) return text.slice(0, len);
  return text.repeat(Math.ceil(len / text.length) + 1).slice(0, len);
}

// ─── The regression: ~412k chars against a 200k ceiling ───────────────────────

test("regression: ~412689-char session converges within MAX_PASSES and never full-sends", () => {
  const messages: Message[] = [mk("system", "You are a helpful assistant.")];
  for (let i = 0; i < 200; i++) {
    messages.push(mk("user", padTo(`question number ${i} `, 2063)));
  }
  const originalChars = messages.reduce((s, m) => s + m.content.length, 0);
  assert.ok(originalChars > 412_000, `expected ~412k chars, got ${originalChars}`);

  const result = prepareContext({
    messages,
    systemPrompt: "You are a helpful assistant.",
    modelId: "qwen-test",
    capabilities: FAKE_CAPS,
    legacyCharBudget: 200_000,
  });

  // Either it converged on a strictly smaller candidate, or it failed closed.
  // It must never return the original oversized payload.
  if (result.ok) {
    assert.ok(
      result.prepared.renderedPrompt.length <= 200_000,
      `rendered ${result.prepared.renderedPrompt.length} > 200000`,
    );
    assert.ok(
      result.prepared.renderedPrompt.length < originalChars,
      "compaction must shrink the payload",
    );
    // J.9: invariant content is compacted away by nobody.
    assert.ok(
      result.prepared.renderedPrompt.includes("You are a helpful assistant."),
      "system prompt must survive compaction",
    );
    assert.ok(
      result.prepared.renderedPrompt.includes("question number 199"),
      "current turn must survive compaction",
    );
    assert.equal(result.prepared.validated, true);
    assert.equal(Object.isFrozen(result.prepared), true);
  } else {
    assert.equal(result.errorCode, "CONTEXT_COMPACTION_NON_CONVERGENT");
    assert.ok(result.attempts.length <= CONTEXT_COMPACTION_MAX_PASSES);
  }
});

test("regression: terminates within MAX_PASSES regardless of outcome", () => {
  const messages: Message[] = [mk("system", "sys")];
  for (let i = 0; i < 400; i++) {
    messages.push(mk("user", padTo(`turn ${i} `, 1032)));
  }
  const result = prepareContext({
    messages,
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: FAKE_CAPS,
    legacyCharBudget: 50_000,
  });
  const attempts = result.ok ? [] : result.attempts;
  if (!result.ok) {
    assert.ok(attempts.length <= CONTEXT_COMPACTION_MAX_PASSES);
  } else {
    assert.ok(result.prepared.renderedPrompt.length <= 50_000);
  }
});

// ─── Fail-closed on structurally impossible input ─────────────────────────────

test("system prompt alone too large -> CONTEXT_TOO_LARGE (never truncated)", () => {
  const result = prepareContext({
    messages: [mk("user", "hi")],
    systemPrompt: padTo("s", 200_000),
    modelId: "qwen-test",
    capabilities: SMALL_WINDOW_CAPS,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "CONTEXT_TOO_LARGE");
});

test("giant current user message larger than usable budget -> CONTEXT_TOO_LARGE", () => {
  const result = prepareContext({
    messages: [
      mk("system", "sys"),
      mk("user", "earlier turn that fits fine"),
      mk("assistant", "understood"),
      mk("user", padTo("giant ", 200_000)),
    ],
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: SMALL_WINDOW_CAPS,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "CONTEXT_TOO_LARGE");
  // The current turn is protected: it was neither dropped nor silently trimmed.
  assert.equal(result.attempts.length, 0);
});

// ─── Token-aware budgeting ────────────────────────────────────────────────────

test("tools consume most of the budget: toolReservation is subtracted before selection", () => {
  const tools: ToolDefinition[] = [];
  for (let i = 0; i < 60; i++) {
    tools.push({
      name: `tool_${i}`,
      description: padTo(`does work number ${i} `, 5_000),
      parameters: { type: "object", properties: {} },
    });
  }
  const toolSchemaTokens = estimateTokens(JSON.stringify(tools));
  const expected = buildContextBudget({
    contextWindowTokens: 100_000,
    maxOutputTokens: 4_096,
    maxThinkingTokens: 0,
    toolSchemaTokens,
    thinkingEnabled: false,
    toolsPresent: true,
  });
  assert.ok(toolSchemaTokens > 60_000);

  const messages: Message[] = [mk("system", "sys")];
  for (let i = 0; i < 100; i++) {
    messages.push(mk("user", padTo(`turn ${i} `, 2_000)));
  }

  const result = prepareContext({
    messages,
    systemPrompt: "sys",
    toolDefinitions: tools,
    modelId: "qwen-test",
    capabilities: {
      getContextWindowTokens: () => 100_000,
      getMaxOutputTokens: () => 4_096,
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    result.prepared.estimatedTokens <= expected.usableInputTokens,
    `${result.prepared.estimatedTokens} > ${expected.usableInputTokens}`,
  );
  assert.equal(result.prepared.compressed, true);
  assert.equal(result.prepared.validated, true);
  assert.equal(Object.isFrozen(result.prepared), true);
});

test("estimateTokens: unicode/code-heavy content exceeds the naive chars/4 figure", () => {
  const cjk = "中".repeat(1_000);
  assert.ok(estimateTokens(cjk) > Math.floor(cjk.length / 4));
  assert.ok(estimateTokens(cjk) >= 1_000);

  const json = '{"a":"b","c":[1,2,3]}'.repeat(100);
  assert.ok(estimateTokens(json) > Math.floor(json.length / 4));

  const ascii = "a".repeat(1_000);
  assert.ok(estimateTokens(ascii) >= Math.floor(ascii.length / 4));
  assert.ok(estimateTokens(cjk) > estimateTokens(ascii));
});

// ─── Group-atomic selection ───────────────────────────────────────────────────

test("a tool-call group is never split from its result", () => {
  const messages: Message[] = [
    mk("system", "sys"),
    mk("user", "please run the tool"),
    mk("assistant", padTo("running it now ", 60_000), {
      toolCalls: [
        { callId: "c1", name: "search", arguments: "{}", status: "completed" },
      ],
    }),
    mk("user", "thanks, what next?"),
    mk("tool", "result payload for c1", { toolCallId: "c1" }),
    mk("user", "current turn"),
  ];

  // The result lands in the SAME group as the call despite the user message
  // that separates them chronologically.
  const groups = groupSemanticUnits(messages);
  const callGroup = groups.find((g) =>
    g.messages.some((m) => m.role === "assistant" && m.toolCalls?.length),
  );
  assert.ok(callGroup, "assistant group must exist");
  assert.ok(
    callGroup.messages.some((m) => m.role === "tool"),
    "tool result must live in the same group as its call",
  );

  // Tight char budget: the whole group is dropped — never the call alone.
  const dropped = prepareContext({
    messages,
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: SMALL_WINDOW_CAPS,
    legacyCharBudget: 3_000,
  });
  assert.equal(dropped.ok, true);
  if (!dropped.ok) return;
  const rendered = dropped.prepared.renderedPrompt;
  assert.ok(
    rendered.length <= 3_000,
    `rendered ${rendered.length} must honor the char ceiling`,
  );
  const hasCall = rendered.includes(TOOL_CALL_OPEN);
  const hasResult = rendered.includes("Tool Response (search)");
  assert.ok(
    !(hasCall && !hasResult) && !(hasResult && !hasCall),
    "tool call and result must be retained or dropped together, never split",
  );
  assert.ok(
    !hasCall && !hasResult,
    "whole group must be dropped together under a tight budget",
  );

  // Generous budget: both halves of the pair survive together.
  const kept = prepareContext({
    messages,
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: FAKE_CAPS,
  });
  assert.equal(kept.ok, true);
  if (!kept.ok) return;
  const keptRendered = kept.prepared.renderedPrompt;
  assert.ok(keptRendered.includes(TOOL_CALL_OPEN));
  assert.ok(keptRendered.includes("Tool Response (search)"));
});

test("a pending tool round survives compaction as pending, never summarized as resolved", () => {
  const messages: Message[] = [
    mk("system", "sys"),
    mk("user", "run the big job"),
    mk("assistant", padTo("working ", 200_000), {
      toolCalls: [
        { callId: "c1", name: "search", arguments: "{}", status: "completed" },
      ],
    }),
    mk("tool", "big result", { toolCallId: "c1" }),
    mk("user", "now check the other job"),
    mk("assistant", "checking", {
      toolCalls: [
        { callId: "c2", name: "status", arguments: "{}", status: "pending" },
      ],
    }),
  ];

  // The pending round is in the current turn: invariant, never summarized.
  const groups = groupSemanticUnits(messages);
  const pending = groups.find((g) =>
    g.messages.some(
      (m) =>
        m.role === "assistant" && m.toolCalls?.some((c) => c.status === "pending"),
    ),
  );
  if (!pending) {
    assert.fail("expected a group holding the pending tool round");
    return;
  }
  assert.equal(pending.tier, 1);
  assert.equal(isGroupDroppable(pending), false);

  const result = prepareContext({
    messages,
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: SMALL_WINDOW_CAPS,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rendered = result.prepared.renderedPrompt;
  assert.ok(rendered.includes(TOOL_CALL_OPEN), "pending call must survive");
  assert.ok(
    !rendered.includes("Tool Response (status)"),
    "a pending round must never be rendered as resolved",
  );
  assert.equal(result.prepared.validated, true);
  assert.equal(Object.isFrozen(result.prepared), true);
});

// ─── Monotonic compaction ─────────────────────────────────────────────────────

test("non-droppable oversized group -> CONTEXT_COMPACTION_NON_CONVERGENT, bounded and monotonic", () => {
  const messages: Message[] = [
    mk("system", "sys"),
    mk("user", "go"),
    // Completed call with NO result present: incomplete round, not pending →
    // the group is not droppable, so no strategy can reduce it.
    mk("assistant", padTo("huge ", 400_000), {
      toolCalls: [
        { callId: "c1", name: "search", arguments: "{}", status: "completed" },
      ],
    }),
    mk("user", "current turn"),
  ];

  const result = prepareContext({
    messages,
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: {
      getContextWindowTokens: () => 100_000,
      getMaxOutputTokens: () => 4_096,
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, "CONTEXT_COMPACTION_NON_CONVERGENT");
  assert.ok(
    result.attempts.length <= CONTEXT_COMPACTION_MAX_PASSES,
    `pass count ${result.attempts.length} must be bounded`,
  );
  // No pass made progress: every pass repeated its predecessor, so the
  // strategy escalated each time instead of looping.
  for (let i = 1; i < result.attempts.length; i++) {
    const prev: CompactionPassRecord = result.attempts[i - 1];
    const cur: CompactionPassRecord = result.attempts[i];
    assert.ok(
      prev.strategy !== cur.strategy ||
        cur.retainedGroups !== prev.retainedGroups ||
        cur.estimatedTokens !== prev.estimatedTokens,
      `pass ${cur.pass} repeated pass ${prev.pass} without escalating`,
    );
  }
  assert.equal(result.attempts[result.attempts.length - 1].strategy, "HARD_FAILURE");
});

test("every successful result is validated and deep-frozen", () => {
  const result = prepareContext({
    messages: [
      mk("system", "sys"),
      mk("user", "hello"),
      mk("assistant", "hi there"),
      mk("user", "current turn"),
    ],
    systemPrompt: "sys",
    modelId: "qwen-test",
    capabilities: FAKE_CAPS,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.prepared.validated, true);
  assert.equal(Object.isFrozen(result.prepared), true);
  assert.equal(result.prepared.compressed, false);
  assert.equal(result.prepared.compactionPasses, 0);
  // Measurement reflects the exact serialized payload that would be sent.
  assert.equal(result.measurement.promptChars, result.prepared.renderedPrompt.length);
  assert.equal(
    result.measurement.estimatedTokens,
    result.prepared.estimatedTokens,
  );
  assert.equal(result.measurement.measurementSource, "estimate");
  assert.equal(result.measurement.actualPromptTokens, null);
  // Uncompressed pass-through preserves content verbatim.
  assert.ok(result.prepared.renderedPrompt.includes("current turn"));
});
