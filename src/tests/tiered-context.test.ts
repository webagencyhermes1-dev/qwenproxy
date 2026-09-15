import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { assembleCompressedContext } from "../services/context/tiered.ts";
import type { Message } from "../utils/types.ts";

function buildMessages(exchanges: number, charsPerMsg = 4000): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < exchanges; i++) {
    out.push({ role: "user", content: `Question ${i} ${"x".repeat(charsPerMsg)}` });
    out.push({ role: "assistant", content: `Answer ${i} ${"y".repeat(charsPerMsg)}` });
  }
  return out;
}

function buildToolMessages(): Message[] {
  return [
    { role: "user", content: "fix it" },
    {
      role: "assistant",
      content: "calling",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    } as Message,
    { role: "tool", content: "file contents", tool_call_id: "call_1", name: "read_file" } as Message,
    { role: "user", content: "continue" },
    { role: "assistant", content: "done" },
  ];
}

test("tiered: 500-message conversation compresses to <100k", () => {
  const messages = buildMessages(250, 4000); // 500 messages, ~2M chars
  const total = messages.reduce((s, m) => s + String(m.content).length, 0);
  assert.ok(total > 1_000_000, `total=${total}`);
  const result = assembleCompressedContext({
    systemPrompt: "System: you are helpful",
    tools: [],
    messages,
    currentTurn: messages[messages.length - 2],
    rollingSummary: "Summary of earlier work",
    tokenBudget: 100_000,
  });
  assert.ok(result.totalChars <= 100_000, `total=${result.totalChars}`);
  assert.ok(result.payload.length <= 100_000);
});

test("tiered: T0 is byte-identical", () => {
  const sys = "System: custom instructions 123";
  const result = assembleCompressedContext({
    systemPrompt: sys,
    tools: [],
    messages: buildMessages(5, 100),
    currentTurn: { role: "user", content: "hi" },
    rollingSummary: "",
    tokenBudget: 100_000,
  });
  assert.equal(result.t0, sys);
});

test("tiered: T1 is exactly last 3 exchanges", () => {
  const messages = buildMessages(10, 50);
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages,
    currentTurn: messages[messages.length - 1],
    rollingSummary: "",
    tokenBudget: 100_000,
  });
  // Last 3 exchanges = 6 messages (user+assistant x3).
  assert.equal(result.t1.length, 6);
  assert.ok(String(result.t1[0].content).includes("Question 7"));
});

test("tiered: tool call/result pairs stay together", () => {
  const messages = buildToolMessages();
  // Force budget pressure with many older exchanges + tiny budget.
  const older: Message[] = [];
  for (let i = 0; i < 20; i++) {
    older.push({ role: "user", content: `old ${i} ${"z".repeat(2000)}` });
    older.push({ role: "assistant", content: `old ans ${i}` });
  }
  const all = [...older, ...messages];
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages: all,
    currentTurn: { role: "user", content: "continue" },
    rollingSummary: "",
    tokenBudget: 100_000,
  });
  const hasCall = [...result.t1, ...result.t2].some(
    (m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
  const hasResult = [...result.t1, ...result.t2].some((m) => m.role === "tool");
  // Either both retained or both dropped — never orphaned.
  assert.equal(hasCall, hasResult);
});

test("tiered: refs contains every retained message", () => {
  const messages = buildMessages(10, 200);
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages,
    currentTurn: messages[messages.length - 1],
    rollingSummary: "sum",
    tokenBudget: 100_000,
  });
  const retained = result.t1.length + result.t2.length;
  assert.equal(Object.keys(result.refs).length, retained);
});
