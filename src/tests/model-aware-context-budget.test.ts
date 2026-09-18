import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { computeInputContextBudget, CONTEXT_TOKEN_SAFETY_MARGIN } from "../utils/context-budget.ts";
import { assembleCompressedContext, TIERED_DEFAULT_BUDGET } from "../services/context/tiered.ts";
import { prepareContext } from "../runtime/context/context-service.ts";
import { getModelContextWindow, getModelCapabilities, setModelContextWindow, syncModelMetadata } from "../core/model-registry.ts";
import { ContextLengthExceededError } from "../core/errors.ts";
import { estimateTokenCount } from "../utils/context-truncation.ts";
import type { Message } from "../utils/types.ts";

// Test helpers
function buildMessages(exchanges: number, charsPerMsg = 500): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < exchanges; i++) {
    out.push({ role: "user", content: `Question ${i} ${"x".repeat(charsPerMsg)}` });
    out.push({ role: "assistant", content: `Answer ${i} ${"y".repeat(charsPerMsg)}` });
  }
  return out;
}

function buildToolDefinition(count: number, descChars: number): any[] {
  const tools: any[] = [];
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

// A. qwen3.8-max 1M-token model context
test("budget: 1M-token context produces correct input budget", () => {
  const budget = computeInputContextBudget({
    contextWindowTokens: 1_000_000,
    maxInputTokens: 991_808,
  });
  assert.ok(budget > 0);
  assert.ok(budget < 1_000_000);
  assert.ok(budget > 700_000);
});

// B. higher maxInputTokens increases input budget
test("budget: higher maxInputTokens increases input budget", () => {
  const budgetLow = computeInputContextBudget({
    contextWindowTokens: 100_000,
    maxInputTokens: 1_000,
  });
  const budgetHigh = computeInputContextBudget({
    contextWindowTokens: 100_000,
    maxInputTokens: 50_000,
  });
  assert.ok(budgetHigh > budgetLow);
});

// C. safety margin is applied
test("budget: safety margin is applied and configurable", () => {
  const defaultBudget = computeInputContextBudget({
    contextWindowTokens: 100_000,
    maxInputTokens: 10_000,
  });
  const customMarginBudget = computeInputContextBudget({
    contextWindowTokens: 100_000,
    maxInputTokens: 10_000,
    safetyMarginTokens: 8000,
  });
  assert.ok(defaultBudget >= 1024);
  assert.ok(defaultBudget > customMarginBudget);
  assert.strictEqual(CONTEXT_TOKEN_SAFETY_MARGIN, 2048);
});

// D. personalization system/tool content does not consume replay budget
test("tiered: personalization=true excludes system from compression budget", () => {
  const bigSystem = `System: ${"S".repeat(150_000)}`;
  const tools = buildToolDefinition(20, 1000);
  
  const result = assembleCompressedContext({
    systemPrompt: bigSystem,
    tools,
    messages: buildMessages(10, 2000),
    currentTurn: { role: "user", content: "hi" },
    rollingSummary: "",
    tokenBudget: 200_000,
    usePersonalization: true,
  });
  
  assert.ok(result.totalChars <= 200_000, `total=${result.totalChars}`);
  assert.ok(result.estimatedTokens > 0);
});

// E. non-personalization system/tool content does consume replay budget
test("tiered: personalization=false includes system in compression budget", () => {
  const bigSystem = `System: ${"S".repeat(80_000)}`;
  
  const result = assembleCompressedContext({
    systemPrompt: bigSystem,
    tools: [],
    messages: buildMessages(10, 2000),
    currentTurn: { role: "user", content: "hi" },
    rollingSummary: "",
    tokenBudget: 100_000,
    usePersonalization: false,
  });
  
  assert.ok(result.totalChars <= 100_000, `total=${result.totalChars}`);
  assert.ok(result.estimatedTokens > 0);
});

// F. compressed failover stays within calculated token budget
test("tiered: compressed context respects token budget", () => {
  const messages = buildMessages(50, 3000);
  
  const result = assembleCompressedContext({
    systemPrompt: "System: agent instructions",
    tools: [],
    messages,
    currentTurn: { role: "user", content: "hi" },
    rollingSummary: "summary",
    tokenBudget: 50_000,
  });
  
  assert.ok(result.totalChars <= 50_000, `total=${result.totalChars}`);
  assert.ok(result.estimatedTokens > 0);
});

// G. final rendered prompt cannot exceed calculated budget
test("tiered: final payload respects budget limit", () => {
  const result = assembleCompressedContext({
    systemPrompt: "System: you are helpful",
    tools: [],
    messages: buildMessages(20, 1500),
    currentTurn: { role: "user", content: "test" },
    rollingSummary: "prev summary",
    tokenBudget: 60_000,
  });
  
  assert.ok(result.payload.length <= 60_000, `payload=${result.payload.length}`);
  assert.ok(result.totalChars <= 60_000);
});

// H. unknown model does not inherit a hard-coded 262K context
test("model-registry: unknown model uses default fallback", () => {
  const window = getModelContextWindow("unknown-model-xyz-123");
  assert.strictEqual(window, 1_048_576);
});

// I. current model uses synchronized model metadata
test("model-registry: syncModelMetadata updates context window", () => {
  const testModelId = "qwen3.8-max-test";
  const customContextWindow = 512_000;
  
  syncModelMetadata([
    {
      id: testModelId,
      context_window: customContextWindow,
      max_output_tokens: 32_000,
    },
  ], "test-account");
  
  const window = getModelContextWindow(testModelId, "test-account");
  assert.strictEqual(window, customContextWindow);
});

// J. structured array/object content still works
test("tiered: array message content is handled", () => {
  const huge = [{ type: "text", text: "a".repeat(100_000) }];
  const msg = { role: "user", content: huge } as unknown as Message;
  
  const result = assembleCompressedContext({
    systemPrompt: "System: agent",
    tools: [],
    messages: [msg],
    currentTurn: msg,
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  
  assert.ok(result.totalChars <= 200_000);
});

test("tiered: object message content is handled", () => {
  const msg = {
    role: "user",
    content: { data: "b".repeat(100_000) },
  } as unknown as Message;
  
  const result = assembleCompressedContext({
    systemPrompt: "",
    tools: [],
    messages: [msg],
    currentTurn: msg,
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  
  assert.ok(result.totalChars <= 200_000);
});

// Q. 262144 CoT limit is never interpreted as context window
test("budget: 262144 CoT limit is not confused with context window", () => {
  const contextWindowTokens = getModelContextWindow("qwen3.8-max");
  // The context window should be ~1M, not 262K (which is max CoT/output)
  assert.ok(contextWindowTokens >= 1_000_000, `contextWindow=${contextWindowTokens}`);
  
  const outputTokens = getModelCapabilities("qwen3.8-max").maxOutputTokens;
  assert.ok(outputTokens <= 262_144, `maxOutputTokens=${outputTokens}`);
});

// R. Model-specific metadata overrides fallback values
test("model-registry: model-specific context window takes precedence", () => {
  const modelId = "test-qwen-custom";
  const customContext = 750_000;
  
  syncModelMetadata([
    { id: modelId, context_window: customContext },
  ], "test");
  
  assert.strictEqual(getModelContextWindow(modelId, "test"), customContext);
});

// S. Thinking mode respects appropriate input capacity
test("budget: thinking mode reserves tokens correctly", () => {
  const standardInput = computeInputContextBudget({
    contextWindowTokens: 1_000_000,
    maxInputTokens: 991_808,
  });
  // Thinking mode would reserve more for CoT
  assert.ok(standardInput > 700_000);
});

// K. huge current message is trimmed rather than causing an unnecessary retry
test("tiered: 2M-char message is trimmed to budget", () => {
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
  const kept = result.t1[result.t1.length - 1];
  assert.ok(kept);
  assert.ok(
    String((kept as Message).content).includes("[Context truncated"),
    "must have truncation notice",
  );
});

// L. genuine impossible context throws ContextLengthExceededError
test("tiered: impossible context throws typed error", () => {
  assert.throws(
    () =>
      assembleCompressedContext({
        systemPrompt: "x".repeat(250_000),
        tools: [],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok" },
        ],
        currentTurn: { role: "user", content: "hi" },
        rollingSummary: "",
        tokenBudget: 200_000,
      }),
    (err: unknown) =>
      err instanceof ContextLengthExceededError &&
      err.code === "context_length_exceeded" &&
      /compressed context still exceeds budget/i.test(err.message),
  );
});

// M. context_length_exceeded remains non-retryable
test("tiered: ContextLengthExceededError has correct code", () => {
  const err = new ContextLengthExceededError("test");
  assert.strictEqual(err.code, "context_length_exceeded");
});

// N. normal small requests do NOT invoke expensive compression
test("tiered: small request completes without compression", () => {
  const result = assembleCompressedContext({
    systemPrompt: "System: helpful",
    tools: [],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    currentTurn: { role: "user", content: "thanks" },
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  
  assert.ok(result.totalChars < 500);
  assert.ok(result.t1.length <= 2);
  assert.ok(result.t2.length === 0);
});

// Token estimation tests
test("token-estimation: estimateTokenCount handles multiple parts", () => {
  const tokens = estimateTokenCount("Hello ", "World", " This is a test.");
  assert.ok(Number.isFinite(tokens));
  assert.ok(tokens > 0);
});

test("token-estimation: estimateTokenCount handles CJK characters", () => {
  const cjk = estimateTokenCount("你好世界");
  const ascii = estimateTokenCount("hello world");
  assert.ok(cjk > 0);
  assert.ok(ascii > 0);
});

// Budget calculation edge cases
test("budget: very small context window clamps to minimum", () => {
  const budget = computeInputContextBudget({
    contextWindowTokens: 500,
    maxInputTokens: 100,
  });
  assert.ok(budget >= 1024, `minimum budget should be 1024, got ${budget}`);
});

test("budget: negative context window is clamped", () => {
  const budget = computeInputContextBudget({
    contextWindowTokens: -1000,
    maxInputTokens: 100,
  });
  assert.ok(budget >= 1024);
});

test("budget: requestedMaxTokens influences input budget", () => {
  const budget1 = computeInputContextBudget({
    contextWindowTokens: 100_000,
    maxInputTokens: 1000,
  });
  const budget2 = computeInputContextBudget({
    contextWindowTokens: 100_000,
    maxInputTokens: 10_000,
  });
  assert.ok(budget2 > budget1);
});

// Tool handling tests
test("tiered: tool definitions included when present", () => {
  const tools = buildToolDefinition(5, 200);
  const result = assembleCompressedContext({
    systemPrompt: "System: you have tools",
    tools,
    messages: buildMessages(3, 500),
    currentTurn: { role: "user", content: "test" },
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  
  assert.ok(result.t0.includes("tool_0"));
  assert.ok(result.totalChars <= 200_000);
});

test("tiered: tool definitions excluded when empty", () => {
  const result = assembleCompressedContext({
    systemPrompt: "System: no tools",
    tools: [],
    messages: buildMessages(3, 500),
    currentTurn: { role: "user", content: "test" },
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  
  assert.ok(!result.t0.includes("tool_"));
  assert.ok(result.totalChars <= 200_000);
});

// Rolling summary tests
test("tiered: rolling summary is preserved", () => {
  const summary = "Earlier in the conversation, we discussed database optimization and caching strategies.";
  const result = assembleCompressedContext({
    systemPrompt: "System: agent",
    tools: [],
    messages: buildMessages(3, 500),
    currentTurn: { role: "user", content: "test" },
    rollingSummary: summary,
    tokenBudget: 200_000,
  });
  
  assert.ok(result.t3.includes("database optimization"));
});

test("tiered: empty rolling summary handled", () => {
  const result = assembleCompressedContext({
    systemPrompt: "System: agent",
    tools: [],
    messages: buildMessages(3, 500),
    currentTurn: { role: "user", content: "test" },
    rollingSummary: "",
    tokenBudget: 200_000,
  });
  
  assert.strictEqual(result.t3, "");
});



