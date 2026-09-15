import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { assembleCompressedContext } from "../services/context/tiered.ts";
import { buildFailoverPrompt, renderMessagesToPrompt } from "../services/context/tiered.ts";
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

test("tiered: 500-message conversation compresses to <200k", () => {
  const messages = buildMessages(250, 4000); // 500 messages, ~2M chars
  const total = messages.reduce((s, m) => s + String(m.content).length, 0);
  assert.ok(total > 1_000_000, `total=${total}`);
  const result = assembleCompressedContext({
    systemPrompt: "System: you are helpful",
    tools: [],
    messages,
    currentTurn: messages[messages.length - 2],
    rollingSummary: "Summary of earlier work",
    tokenBudget: 200_000,
  });
  assert.ok(result.totalChars <= 200_000, `total=${result.totalChars}`);
  assert.ok(result.payload.length <= 200_000);
});

test("tiered: T0 is byte-identical", () => {
  const sys = "System: custom instructions 123";
  const result = assembleCompressedContext({
    systemPrompt: sys,
    tools: [],
    messages: buildMessages(5, 100),
    currentTurn: { role: "user", content: "hi" },
    rollingSummary: "",
    tokenBudget: 200_000,
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
    tokenBudget: 200_000,
  });
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
    tokenBudget: 200_000,
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
    tokenBudget: 200_000,
  });
  const retained = result.t1.length + result.t2.length;
  assert.equal(Object.keys(result.refs).length, retained);
});

test("failover: no-personalization envelope keeps system prefix verbatim", () => {
  const sys = "System: agent instructions v1";
  const toolsText = "Tool: shell";
  const messages = buildMessages(10, 500);
  const { prompt, compressed } = buildFailoverPrompt({
    systemPrompt: sys,
    tools: [],
    toolInstructions: toolsText,
    messages,
    currentTurn: messages[messages.length - 1],
    rollingSummary: "",
    tokenBudget: 200_000,
    usePersonalization: false,
  });
  assert.ok(prompt.startsWith(sys), "system prefix must be verbatim T0");
  assert.ok(prompt.includes(toolsText));
  assert.ok(prompt.includes("User:"));
  assert.ok(prompt.includes("Assistant:"));
  assert.ok(prompt.length <= 200_000);
  assert.ok(Object.keys(compressed.refs).length > 0);
});

test("failover: personalization mode keeps system out of the prompt", () => {
  const sys = "System: secret agent instructions";
  const messages = buildMessages(10, 500);
  const { prompt } = buildFailoverPrompt({
    systemPrompt: sys,
    tools: [],
    toolInstructions: "Tool: shell",
    messages,
    currentTurn: messages[messages.length - 1],
    rollingSummary: "prior summary",
    tokenBudget: 200_000,
    usePersonalization: true,
  });
  assert.ok(!prompt.includes(sys), "system must ride personalization, not inline");
  assert.ok(prompt.includes("prior summary"));
  assert.ok(prompt.includes("Question 9"));
  assert.ok(prompt.length <= 200_000);
});

test("failover: tool call/result pairs render with tags intact", () => {
  const messages = buildToolMessages();
  const rendered = renderMessagesToPrompt(messages);
  assert.ok(rendered.includes("Assistant:"));
  assert.ok(rendered.includes("Tool Response (read_file):"));
  const { prompt } = buildFailoverPrompt({
    systemPrompt: "",
    tools: [],
    toolInstructions: "",
    messages,
    currentTurn: { role: "user", content: "continue" },
    rollingSummary: "",
    tokenBudget: 200_000,
    usePersonalization: true,
  });
  assert.ok(prompt.includes("Tool Response (read_file):"));
});

test("failover: 2M-char conversation renders under budget", () => {
  const messages = buildMessages(250, 4000);
  const { prompt } = buildFailoverPrompt({
    systemPrompt: "System: agent",
    tools: [],
    toolInstructions: "",
    messages,
    currentTurn: messages[messages.length - 1],
    rollingSummary: "summary",
    tokenBudget: 200_000,
    usePersonalization: false,
  });
  assert.ok(prompt.startsWith("System: agent"));
  assert.ok(prompt.length <= 200_000, `prompt=${prompt.length}`);
});

test("semantic retention: planted fact at message 100 survives failover", () => {
  const MARKER = "FACT_7F3A9B: the config key is REDACTED_XYZ";
  const topics = [
    "database optimization with indexes",
    "caching strategies with memoization",
    "frontend styling with variables",
    "authentication flow with tokens",
    "logging setup with rotation",
    "queue workers with retries",
  ];
  const messages: Message[] = [];
  for (let i = 0; i < 250; i++) {
    const topic = topics[i % topics.length];
    if (i === 50) {
      messages.push({
        role: "user",
        content: `Note for later ${MARKER}, store it safely. ${"n".repeat(2000)}`,
      });
      messages.push({ role: "assistant", content: `Stored your note. ${"o".repeat(500)}` });
    } else {
      messages.push({ role: "user", content: `Discuss ${topic} part ${i}. ${"x".repeat(2000)}` });
      messages.push({ role: "assistant", content: `On ${topic}: details ${i}. ${"y".repeat(2000)}` });
    }
  }
  assert.equal(messages.length, 500);
  const currentTurn: Message = {
    role: "user",
    content: "Quick question: what is the config key from my earlier note?",
  };
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages,
    currentTurn,
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  assert.ok(result.totalChars <= 200_000);
  const t12 = [...result.t1, ...result.t2].map((m) => String(m.content ?? ""));
  const refTexts = Object.values(result.refs).map((m) => String(m.content ?? ""));
  const inT12 = t12.some((t) => t.includes(MARKER));
  const inT3 = result.t3.includes(MARKER);
  const inRefs = refTexts.some((t) => t.includes(MARKER));
  assert.ok(
    inT12 || inT3 || inRefs,
    "planted fact must survive in T1/T2/T3 or be re-injectable via refs",
  );
  // Stronger: the fact must be in the scored selection itself, not just refs.
  assert.ok(inT12, "BM25 must retrieve the planted fact into T2");
});

test("tiered: a single 2M-char paste is trimmed to budget instead of throwing", () => {
  const giant = { role: "user", content: "x".repeat(2_000_000) } as Message;
  const result = assembleCompressedContext({
    systemPrompt: "System: agent",
    tools: [],
    messages: [giant],
    currentTurn: giant,
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  assert.ok(result.totalChars <= 200_000, `total=${result.totalChars}`);
  assert.ok(result.payload.length <= 200_000, `payload=${result.payload.length}`);
  const kept = result.t1[result.t1.length - 1];
  assert.ok(kept, "the current turn must still be present");
  assert.ok(
    String((kept as Message).content).length < 200_000,
    `content=${String((kept as Message).content).length}`,
  );
  assert.ok(
    String((kept as Message).content).includes("[Context truncated"),
    "the trimmed message must carry a truncation notice",
  );
});

test("failover: single 2M-char paste is served under budget, not errored", () => {
  const giant = { role: "user", content: "z".repeat(2_000_000) } as Message;
  const { prompt } = buildFailoverPrompt({
    systemPrompt: "System: agent",
    tools: [],
    toolInstructions: "",
    messages: [giant],
    currentTurn: giant,
    rollingSummary: "",
    tokenBudget: 200_000,
    usePersonalization: false,
  });
  assert.ok(prompt.length <= 200_000, `prompt=${prompt.length}`);
  assert.ok(prompt.includes("[Context truncated"));
});
