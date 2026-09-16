/**
 * Immutable context contract for a single generation.
 *
 * A ContextSnapshot is the input view handed to assembly: durable message ids
 * in order, config identity, and the token budget derived from model limits.
 * Once published it is identified by snapshotId and never mutated; consumers
 * read readonly views and rebuild a new snapshot on change.
 */

import type { CompactionStrategy } from "./types.ts";
import { newBranchId, newSnapshotId } from "./ids.ts";

/** Token quantity. Plain number alias by design: the interfaces below are the
 *  authority for cross-module boundaries; callers pass token counts, never
 *  character counts. */
export type Tokens = number;

export const PROTOCOL_SAFETY_TOKENS: Tokens = 512;
const DEFAULT_SAFETY_MARGIN_PCT = 0.02;

/** Monotonic progress rule: each compaction pass must reduce retained units
 *  (or the target) by at least CONTEXT_COMPACTION_TARGET_REDUCTION_PCT, or the
 *  assembler escalates to the next strategy in CONTEXT_COMPACTION_STRATEGY_ORDER.
 *  HARD_FAILURE is terminal: no further strategy can make progress. */
export const CONTEXT_COMPACTION_MAX_PASSES = 4;
export const CONTEXT_COMPACTION_TARGET_REDUCTION_PCT = 15;

export const CONTEXT_COMPACTION_STRATEGY_ORDER: readonly CompactionStrategy[] = [
  "NONE",
  "DROP_LOW_SCORE_GROUPS",
  "SUMMARY_PLUS_RECENT",
  "HARD_FAILURE",
];

export interface ContextBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  reservedThinkingTokens: number;
  protocolSafetyTokens: number;
  toolReservationTokens: number;
  usableInputTokens: number;
}

export interface PreparedContext {
  snapshotId: string;
  renderedPrompt: string;
  payloadBytes: number;
  estimatedTokens: number;
  compressed: boolean;
  compactionPasses: number;
  validated: true;
}

export interface ConfigIdentity {
  systemPromptHash: string;
  personalizationHash: string;
  toolSetHash: string;
  modelId: string;
}

export interface ContextSnapshot {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly branchId: string;
  readonly configIdentity: Readonly<ConfigIdentity>;
  readonly budget: Readonly<ContextBudget>;
  /** Durable message ids, order preserved. */
  readonly messageRefs: readonly string[];
  readonly excludedUnitIds: readonly string[];
  readonly summaryRef: string | null;
  /** epoch ms */
  readonly createdAt: number;
}

export type MeasurementSource = "provider" | "estimate" | "heuristic";

export interface ContextMeasurement {
  promptChars: number;
  payloadBytes: number;
  estimatedTokens: number;
  actualPromptTokens: number | null;
  measurementSource: MeasurementSource;
}

export interface BuildContextBudgetOptions {
  contextWindowTokens: Tokens;
  maxOutputTokens: Tokens;
  maxThinkingTokens: Tokens;
  toolSchemaTokens: Tokens;
  thinkingEnabled: boolean;
  toolsPresent: boolean;
  safetyMarginPct?: number;
}

export interface CreateContextSnapshotInput {
  sessionId: string;
  sessionVersion: number;
  /** Minted when absent (first snapshot of a branch). */
  branchId?: string;
  configIdentity: ConfigIdentity;
  budget: ContextBudget;
  messageRefs: readonly string[];
  excludedUnitIds?: readonly string[];
  summaryRef?: string | null;
  /** epoch ms; defaults to now. */
  createdAt?: number;
}

/** Local measurements are never reported as provider measurements. */
export function localMeasurementFromPrepared(
  prepared: PreparedContext,
): ContextMeasurement {
  return {
    promptChars: prepared.renderedPrompt.length,
    payloadBytes: prepared.payloadBytes,
    estimatedTokens: prepared.estimatedTokens,
    actualPromptTokens: null,
    measurementSource: "estimate",
  };
}

/**
 * Pure: derives the usable input budget from model limits. Every reservation
 * is clamped non-negative before subtraction so a misconfigured limit can
 * never inflate usableInputTokens; the result is floored at 0 (fail-closed).
 * protocolSafetyTokens is the greater of the fixed protocol floor and the
 * proportional safety margin of the context window.
 */
export function buildContextBudget(
  opts: BuildContextBudgetOptions,
): ContextBudget {
  const contextWindowTokens = clampTokens(opts.contextWindowTokens);
  const reservedOutputTokens = clampTokens(opts.maxOutputTokens);
  const reservedThinkingTokens = opts.thinkingEnabled
    ? clampTokens(opts.maxThinkingTokens)
    : 0;
  const toolReservationTokens = opts.toolsPresent
    ? clampTokens(opts.toolSchemaTokens)
    : 0;
  const safetyMarginPct = opts.safetyMarginPct ?? DEFAULT_SAFETY_MARGIN_PCT;
  const protocolSafetyTokens = Math.max(
    PROTOCOL_SAFETY_TOKENS,
    Math.trunc(contextWindowTokens * safetyMarginPct),
  );
  const usableInputTokens = Math.max(
    0,
    contextWindowTokens -
      reservedOutputTokens -
      reservedThinkingTokens -
      toolReservationTokens -
      protocolSafetyTokens,
  );
  return {
    contextWindowTokens,
    reservedOutputTokens,
    reservedThinkingTokens,
    protocolSafetyTokens,
    toolReservationTokens,
    usableInputTokens,
  };
}

/** Fail-closed: a budget that somehow went negative is a bug, not a hint. */
export function assertBudgetNonNegative(b: ContextBudget): void {
  if (b.usableInputTokens < 0) {
    throw new Error(
      `ContextBudget usableInputTokens is negative (${b.usableInputTokens}); refusing to assemble context`,
    );
  }
}

/**
 * Mints a fresh immutable snapshot. Shallow-frozen so downstream consumers
 * cannot reorder or extend the retained message ids; budget is asserted
 * non-negative before publication.
 */
export function createContextSnapshot(
  input: CreateContextSnapshotInput,
): ContextSnapshot {
  assertBudgetNonNegative(input.budget);
  return {
    snapshotId: newSnapshotId(),
    sessionId: input.sessionId,
    sessionVersion: input.sessionVersion,
    branchId: input.branchId ?? newBranchId(),
    configIdentity: Object.freeze({ ...input.configIdentity }),
    budget: Object.freeze({ ...input.budget }),
    messageRefs: Object.freeze([...input.messageRefs]),
    excludedUnitIds: Object.freeze([...(input.excludedUnitIds ?? [])]),
    summaryRef: input.summaryRef ?? null,
    createdAt: input.createdAt ?? Date.now(),
  };
}

function clampTokens(value: number): Tokens {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}
