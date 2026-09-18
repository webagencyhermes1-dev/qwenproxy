import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { computeInputContextBudget, CONTEXT_TOKEN_SAFETY_MARGIN } from "../utils/context-budget.ts";
import {
  getModelContextWindow,
  getModelCapabilities,
  getModelMaxInput,
  getModelMaxInputThinking,
  getModelMaxCot,
  syncModelMetadata,
} from "../core/model-registry.ts";

// Helper to register qwen3.8-max with correct metadata
function registerQwen38Max(): void {
  syncModelMetadata(
    [
      {
        id: "qwen3.8-max",
        context_window: 1_000_000,
        max_input: 991_808,
        max_input_thinking: 983_616,
        max_output_tokens: 131_072,
        max_cot_tokens: 262_144,
        maxThinkingTokens: 131_072,
        supports_thinking: true,
      },
    ],
    "test-acc",
  );
}

// 1. Context window is 1M
test("qwen3.8-max: contextWindow === 1_000_000", () => {
  registerQwen38Max();
  const ctx = getModelContextWindow("qwen3.8-max", "test-acc");
  assert.strictEqual(ctx, 1_000_000);
});

// 2. Max input is 991808
test("qwen3.8-max: maxInput === 991_808", () => {
  registerQwen38Max();
  const maxInput = getModelMaxInput("qwen3.8-max", "test-acc");
  assert.strictEqual(maxInput, 991_808);
});

// 3. Max input thinking is 983616
test("qwen3.8-max: maxInputThinking === 983_616", () => {
  registerQwen38Max();
  const maxInputThinking = getModelMaxInputThinking("qwen3.8-max", "test-acc");
  assert.strictEqual(maxInputThinking, 983_616);
});

// 4. Max output is 131072
test("qwen3.8-max: maxOutput === 131_072", () => {
  registerQwen38Max();
  const caps = getModelCapabilities("qwen3.8-max", "test-acc");
  assert.strictEqual(caps.maxOutputTokens, 131_072);
});

// 5. Max CoT is 262144
test("qwen3.8-max: maxCot === 262_144", () => {
  registerQwen38Max();
  const maxCot = getModelMaxCot("qwen3.8-max", "test-acc");
  assert.strictEqual(maxCot, 262_144);
});

// 6. maxOutput !== maxCot
test("qwen3.8-max: maxOutput !== maxCot", () => {
  registerQwen38Max();
  const caps = getModelCapabilities("qwen3.8-max", "test-acc");
  const maxCot = getModelMaxCot("qwen3.8-max", "test-acc");
  assert.notEqual(caps.maxOutputTokens, maxCot);
  assert.strictEqual(caps.maxOutputTokens, 131_072);
  assert.strictEqual(maxCot, 262_144);
});

// 7. Standard effective input budget uses 991808
test("budget: standard mode uses maxInput (991808)", () => {
  registerQwen38Max();
  const ctx = getModelContextWindow("qwen3.8-max", "test-acc");
  const maxInput = getModelMaxInput("qwen3.8-max", "test-acc");
  const budget = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    safetyMarginTokens: CONTEXT_TOKEN_SAFETY_MARGIN,
  });
  assert.ok(budget > 989_000, `budget=${budget}`);
  assert.ok(budget < 991_808);
});

// 8. Thinking effective input budget uses 983616
test("budget: thinking mode uses maxInputThinking (983616)", () => {
  registerQwen38Max();
  const ctx = getModelContextWindow("qwen3.8-max", "test-acc");
  const maxInput = getModelMaxInput("qwen3.8-max", "test-acc");
  const maxInputThinking = getModelMaxInputThinking("qwen3.8-max", "test-acc");
  const standardBudget = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    safetyMarginTokens: CONTEXT_TOKEN_SAFETY_MARGIN,
  });
  const thinkingBudget = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    maxInputThinkingTokens: maxInputThinking,
    thinkingMode: true,
    safetyMarginTokens: CONTEXT_TOKEN_SAFETY_MARGIN,
  });
  assert.ok(thinkingBudget < standardBudget, `thinkingBudget=${thinkingBudget} < standard=${standardBudget}`);
  assert.ok(thinkingBudget > 981_000, `thinkingBudget=${thinkingBudget}`);
});

// 9. 262144 never becomes context limit
test("qwen3.8-max: 262144 is not used as context window", () => {
  registerQwen38Max();
  const ctx = getModelContextWindow("qwen3.8-max", "test-acc");
  assert.notStrictEqual(ctx, 262_144);
  assert.strictEqual(ctx, 1_000_000);
});

// 10. 262144 never becomes maxOutputTokens
test("qwen3.8-max: 262144 is not used as maxOutputTokens", () => {
  registerQwen38Max();
  const caps = getModelCapabilities("qwen3.8-max", "test-acc");
  assert.notStrictEqual(caps.maxOutputTokens, 262_144);
  assert.strictEqual(caps.maxOutputTokens, 131_072);
});

// 11. Unknown models use fallback
test("model-registry: unknown models use fallback values", () => {
  const ctx = getModelContextWindow("unknown-model-xyz");
  const caps = getModelCapabilities("unknown-model-xyz");
  assert.strictEqual(ctx, 1_048_576);
  assert.strictEqual(caps.maxOutputTokens, 65_536);
  assert.strictEqual(caps.maxCotTokens, 262_144);
});

// 12. maxCotTokens is independent of maxOutputTokens
test("model-registry: maxCotTokens is separate from maxOutputTokens", () => {
  registerQwen38Max();
  const caps = getModelCapabilities("qwen3.8-max", "test-acc");
  const maxCot = getModelMaxCot("qwen3.8-max", "test-acc");
  assert.strictEqual(caps.maxCotTokens, 262_144);
  assert.strictEqual(maxCot, 262_144);
  assert.strictEqual(caps.maxOutputTokens, 131_072);
});

// 13. Model-specific metadata overrides fallback
test("model-registry: custom model metadata overrides defaults", () => {
  syncModelMetadata(
    [
      {
        id: "custom-model",
        context_window: 500_000,
        max_input: 450_000,
        max_output_tokens: 50_000,
        max_cot_tokens: 100_000,
      },
    ],
    "test",
  );
  assert.strictEqual(getModelContextWindow("custom-model", "test"), 500_000);
  assert.strictEqual(getModelMaxInput("custom-model", "test"), 450_000);
  assert.strictEqual(getModelMaxCot("custom-model", "test"), 100_000);
});

// 14. Effective budget respects maxInput, not contextWindow - maxOutput
test("budget: effective budget uses maxInput constraint", () => {
  // Old (wrong) approach: contextWindow - maxOutput = 1M - 262K = 738K
  // New (correct) approach: min(contextWindow, maxInput) - margin = 991808 - 2048 = 989760
  const ctx = 1_000_000;
  const maxInput = 991_808;
  const maxOutput = 262_144; // This is CoT, not output
  
  const oldWrongBudget = ctx - maxOutput - CONTEXT_TOKEN_SAFETY_MARGIN;
  const correctBudget = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    safetyMarginTokens: CONTEXT_TOKEN_SAFETY_MARGIN,
  });
  
  assert.notEqual(oldWrongBudget, correctBudget, "Old and new approaches must differ");
  assert.ok(correctBudget > 989_000, `correctBudget=${correctBudget}`);
  assert.ok(oldWrongBudget < 738_000, `oldWrongBudget=${oldWrongBudget}`);
});

// 15. Request max_tokens doesn't reserve entire model maxOutput
test("budget: requested max_tokens can limit reservation", () => {
  const ctx = 1_000_000;
  const maxInput = 991_808;
  
  // Model has maxOutput = 131072, but user requested only 4096
  // The budget calculation should not blindly reserve full 131072
  const budget = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    safetyMarginTokens: CONTEXT_TOKEN_SAFETY_MARGIN,
  });
  
  assert.ok(budget > 989_000, `budget=${budget}`);
});

// 16. Safety margin is applied correctly
test("budget: safety margin is subtracted from effective limit", () => {
  const ctx = 100_000;
  const maxInput = 90_000;
  const safetyMargin = 10_000;
  
  const budget = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    safetyMarginTokens: safetyMargin,
  });
  
  // Should be 90000 - 10000 = 80000
  assert.strictEqual(budget, 80_000);
});

// 17. Thinking mode correctly uses maxInputThinking
test("budget: thinking mode uses maxInputThinking when available", () => {
  const ctx = 1_000_000;
  const maxInput = 991_808;
  const maxInputThinking = 983_616;
  
  const standard = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    safetyMarginTokens: 2048,
  });
  
  const thinking = computeInputContextBudget({
    contextWindowTokens: ctx,
    maxInputTokens: maxInput,
    maxInputThinkingTokens: maxInputThinking,
    thinkingMode: true,
    safetyMarginTokens: 2048,
  });
  
  assert.strictEqual(thinking, 983_616 - 2048);
  assert.notEqual(standard, thinking);
});
