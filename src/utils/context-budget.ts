/**
 * Model-aware context budget calculation.
 *
 * Derives the input context budget from model limits, using the model's actual
 * max-input constraint. The result is clamped to a sensible positive minimum
 * to avoid negative budgets from misconfigured limits.
 */
export interface ComputeInputContextBudgetOptions {
  contextWindowTokens: number;
  maxInputTokens: number;
  maxInputThinkingTokens?: number;
  thinkingMode?: boolean;
  safetyMarginTokens?: number;
  requestedMaxTokens?: number;
}

export const CONTEXT_TOKEN_SAFETY_MARGIN = 2048;

export function computeInputContextBudget(
  opts: ComputeInputContextBudgetOptions,
): number {
  const contextWindowTokens = Math.max(0, Math.floor(opts.contextWindowTokens));
  const safetyMargin = Math.max(
    CONTEXT_TOKEN_SAFETY_MARGIN,
    Math.floor(opts.safetyMarginTokens ?? 0),
  );

  // Use maxInput for standard mode, maxInputThinking for thinking mode
  const maxInputTokens = opts.thinkingMode && opts.maxInputThinkingTokens !== undefined
    ? Math.max(0, Math.floor(opts.maxInputThinkingTokens))
    : Math.max(0, Math.floor(opts.maxInputTokens));

  // Effective input limit is min(contextWindow, maxInput/maxInputThinking)
  const effectiveInputLimit = Math.min(contextWindowTokens, maxInputTokens);

  // Subtract safety margin
  const inputBudget = effectiveInputLimit - safetyMargin;

  return Math.max(1024, Math.floor(inputBudget));
}
