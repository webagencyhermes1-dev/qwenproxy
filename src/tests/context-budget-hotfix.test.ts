import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { buildCompressedFailoverPrompt } from "../routes/chat/account.ts";
import {
  assembleCompressedContext,
  TIERED_DEFAULT_BUDGET,
} from "../services/context/tiered.ts";
import {
  classifyRetryAction,
  isContextLengthExceededError,
  isTerminalLocalError,
} from "../routes/chat/retry-policy.ts";
import { ContextLengthExceededError } from "../core/errors.ts";
import type { Message } from "../utils/types.ts";
import type { FunctionToolDefinition } from "../tools/types.ts";

function buildMessages(exchanges: number, charsPerMsg = 500): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < exchanges; i++) {
    out.push({ role: "user", content: `Question ${i} ${"x".repeat(charsPerMsg)}` });
    out.push({ role: "assistant", content: `Answer ${i} ${"y".repeat(charsPerMsg)}` });
  }
  return out;
}

function buildBigTools(count: number, descChars: number): FunctionToolDefinition[] {
  const tools: FunctionToolDefinition[] = [];
  for (let i = 0; i < count; i++) {
    tools.push({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `Tool ${i} ${"d".repeat(descChars)}`,
        parameters: { type: "object", properties: {} },
      },
    });
  }
  return tools;
}

// A. personalization=true: a 400k+ system/tool payload must not make the
// compressor exceed the conversation budget solely because of T0.
test("hotfix A: personalization=true ignores system/tools in compression budget", () => {
  const bigSystem = `System: ${"S".repeat(300_000)}`;
  const bigTools = buildBigTools(40, 2_500); // ~100k+ chars of tool JSON
  assert.ok(bigSystem.length + JSON.stringify(bigTools).length > 400_000);

  const prompt = buildCompressedFailoverPrompt({
    systemPrompt: bigSystem,
    toolInstructions: "",
    tools: bigTools,
    messages: buildMessages(20, 2_000),
    usePersonalization: true,
    reason: "hotfix-test",
  });

  assert.ok(prompt.length <= TIERED_DEFAULT_BUDGET, `prompt=${prompt.length}`);
  assert.ok(!prompt.includes("SSSS"), "system text must not ride the prompt");
  assert.ok(prompt.includes("Question 19"), "recent conversation retained");
});

// B. genuine context overflow returns a typed context_length_exceeded error.
test("hotfix B: genuine overflow throws ContextLengthExceededError", () => {
  assert.throws(
    () =>
      assembleCompressedContext({
        systemPrompt: "x".repeat(300_000),
        tools: [],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
        ],
        currentTurn: { role: "user", content: "hi" },
        rollingSummary: "",
        tokenBudget: TIERED_DEFAULT_BUDGET,
      }),
    (err: unknown) =>
      err instanceof ContextLengthExceededError &&
      err.code === "context_length_exceeded" &&
      /compressed context still exceeds budget/i.test(err.message),
  );
});

// C. context_length_exceeded is not retryable.
test("hotfix C: context_length_exceeded is terminal and not retryable", () => {
  const action = classifyRetryAction(
    new ContextLengthExceededError("Compressed context still exceeds budget (464423 > 200000)"),
  );
  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
  assert.equal(action.reason, "terminal_local");
});

// D. no repeated retry loop: every budget failure shape is terminal, never
// unknown_upstream_default_retry / account failover.
test("hotfix D: budget failures never enter the default retry loop", () => {
  const variants: unknown[] = [
    new ContextLengthExceededError("anything"),
    Object.assign(new Error("budget blew up"), { code: "context_length_exceeded" }),
    new Error("Compressed context still exceeds budget (464423 > 200000); refusing to send full context"),
    new Error("Serialized payload exceeds budget (210000 > 200000); refusing full context"),
    new Error("Failover prompt exceeds budget (205000 > 200000); refusing to send full context"),
  ];
  for (const err of variants) {
    assert.equal(isContextLengthExceededError(err), true, String(err));
    assert.equal(isTerminalLocalError(err), true, String(err));
    const action = classifyRetryAction(err);
    assert.equal(action.retryable, false, String(err));
    assert.equal(action.switchAccount, false, String(err));
    assert.equal(action.reason, "terminal_local", String(err));
    assert.notEqual(action.reason, "unknown_upstream_default_retry");
  }
});

// E. normal failover still preserves recent conversation.
test("hotfix E: normal failover preserves recent conversation", () => {
  const messages = buildMessages(10, 500);
  const prompt = buildCompressedFailoverPrompt({
    systemPrompt: "System: agent instructions v1",
    toolInstructions: "Tool: shell",
    tools: [],
    messages,
    usePersonalization: false,
    reason: "hotfix-test",
  });
  assert.ok(prompt.length <= TIERED_DEFAULT_BUDGET);
  assert.ok(prompt.includes("Question 9"), "most recent user turn retained");
  assert.ok(prompt.includes("Answer 9"), "most recent assistant turn retained");
});

// F. personalization=false still includes system/tools in the replay budget.
test("hotfix F: personalization=false keeps system in the replay budget", () => {
  const sys = `System: verbatim instructions ${"z".repeat(50_000)}`;
  const prompt = buildCompressedFailoverPrompt({
    systemPrompt: sys,
    toolInstructions: "",
    tools: [],
    messages: buildMessages(10, 500),
    usePersonalization: false,
    reason: "hotfix-test",
  });
  assert.ok(prompt.startsWith(sys), "system prefix must be verbatim");
  assert.ok(prompt.length <= TIERED_DEFAULT_BUDGET);

  // And an oversized system payload still counts (fails closed, typed).
  assert.throws(
    () =>
      buildCompressedFailoverPrompt({
        systemPrompt: `System: ${"S".repeat(1_500_000)}`,
        toolInstructions: "",
        tools: buildBigTools(40, 2_500),
        messages: buildMessages(5, 100),
        usePersonalization: false,
        reason: "hotfix-test",
      }),
    (err: unknown) =>
      err instanceof ContextLengthExceededError &&
      err.code === "context_length_exceeded",
  );
});

// Structured content: array/object message.content is trimmable by the
// last-resort guard instead of failing closed.
test("hotfix: 2M-char array content is trimmed, not errored", () => {
  const huge = [{ type: "text", text: "a".repeat(2_000_000) }];
  const msg = { role: "user", content: huge } as unknown as Message;
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages: [msg],
    currentTurn: msg,
    rollingSummary: "",
    tokenBudget: TIERED_DEFAULT_BUDGET,
  });
  assert.ok(result.totalChars <= TIERED_DEFAULT_BUDGET);
  assert.ok(result.payload.length <= TIERED_DEFAULT_BUDGET);
});

test("hotfix: 2M-char object content is trimmed, not errored", () => {
  const msg = {
    role: "user",
    content: { data: "b".repeat(2_000_000) },
  } as unknown as Message;
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages: [msg],
    currentTurn: msg,
    rollingSummary: "",
    tokenBudget: TIERED_DEFAULT_BUDGET,
  });
  assert.ok(result.totalChars <= TIERED_DEFAULT_BUDGET);
  assert.ok(result.payload.length <= TIERED_DEFAULT_BUDGET);
});

// Tool metadata survives last-resort trimming of structured content.
test("hotfix: trimmer preserves tool metadata on the trimmed message", () => {
  const huge = "c".repeat(2_000_000);
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: huge }],
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
    ],
  } as unknown as Message;
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages: [msg],
    currentTurn: msg,
    rollingSummary: "",
    tokenBudget: TIERED_DEFAULT_BUDGET,
  });
  const trimmed = result.t1[result.t1.length - 1];
  assert.ok(Array.isArray(trimmed.tool_calls));
  assert.equal(trimmed.tool_calls?.[0]?.function.name, "read_file");
});
