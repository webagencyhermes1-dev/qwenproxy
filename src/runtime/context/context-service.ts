/**
 * ContextService — monotonic, group-atomic context assembly.
 *
 * Replaces the char-tiered assembler (services/context/tiered.ts) whose
 * budget loops could recompute the same candidate forever: dropping a tool
 * pair here and re-adding it there left the total unchanged, so a 412k-char
 * session against a 200k ceiling never converged. Pipeline, in order:
 *
 *   load snapshot -> calculate budget -> select semantic units ->
 *   compact if needed -> render -> build payload -> measure -> validate ->
 *   freeze -> send
 *
 * No stage after validation may append context: the returned PreparedContext
 * is deep-frozen and its measurement is taken from the FINAL serialized
 * payload, so what is validated is exactly what would be sent.
 */

import type { Message } from "../../domain/session.ts";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolRound,
} from "../../domain/tools.ts";
import { isToolRoundComplete } from "../../domain/tools.ts";
import type { CompactionStrategy } from "../../domain/types.ts";
import type { ErrorCode } from "../../domain/errors.ts";
import {
  buildContextBudget,
  CONTEXT_COMPACTION_MAX_PASSES,
  CONTEXT_COMPACTION_STRATEGY_ORDER,
} from "../../domain/context.ts";
import type {
  ContextBudget,
  ContextMeasurement,
  PreparedContext,
} from "../../domain/context.ts";
import { newSnapshotId } from "../../domain/ids.ts";
// Reused verbatim: the repo's CJK/JSON-aware per-character weighted estimator
// (src/utils/context-truncation.ts). Never chars/4.
import { estimateTokenCount } from "../../utils/context-truncation.ts";
import { wrapToolCallPayload } from "../../tools/toolcall-tags.ts";

/** Model limits come from the caller so no Qwen specifics live here. */
export interface ModelCapabilitySource {
  getContextWindowTokens(modelId: string): number;
  getMaxOutputTokens(modelId: string): number;
}

/**
 * Atomic selection unit. T0 = system (+tool schemas, reserved via the budget);
 * T1 = the current user turn; T2 = older exchanges, droppable only as a whole;
 * T3 = the rolling summary built by SUMMARY_PLUS_RECENT.
 */
export interface SemanticGroup {
  readonly groupId: string;
  readonly tier: 0 | 1 | 2 | 3;
  readonly messages: readonly Message[];
  readonly tokenEstimate: number;
  /** Higher is more valuable; lowest score is dropped first. */
  readonly score?: number;
}

export interface CompactionPassRecord {
  pass: number;
  strategy: CompactionStrategy;
  retainedGroups: number;
  estimatedTokens: number;
  targetTokens: number;
}

export interface PrepareContextInput {
  readonly snapshotId?: string;
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly toolDefinitions?: readonly ToolDefinition[];
  readonly modelId: string;
  readonly capabilities: ModelCapabilitySource;
  readonly thinkingEnabled?: boolean;
  readonly maxThinkingTokens?: number;
  readonly rollingSummary?: string;
  /** Legacy char ceiling (TIERED_DEFAULT_BUDGET compat); validated exactly. */
  readonly legacyCharBudget?: number;
  readonly safetyMarginPct?: number;
}

export type PrepareContextResult =
  | { ok: true; prepared: PreparedContext; measurement: ContextMeasurement }
  | {
      ok: false;
      errorCode: ErrorCode;
      reason: string;
      attempts: CompactionPassRecord[];
    };

export interface CompactionContext {
  readonly systemPrompt: string;
  readonly budget: ContextBudget;
  readonly initialSummary: string;
  readonly legacyCharBudget?: number;
}

export interface Selection {
  readonly retained: readonly SemanticGroup[];
  readonly summary: string;
  readonly droppedCount: number;
}

export type CompactionResult =
  | {
      ok: true;
      selection: Selection;
      passes: readonly CompactionPassRecord[];
      compressed: boolean;
    }
  | { ok: false; passes: readonly CompactionPassRecord[] };

const SEGMENT_SEPARATOR = "\n\n";
const SUMMARY_HEADER = "[Earlier conversation summary]";
const SUMMARY_FRACTION = 0.1;
const SUMMARY_MIN_TOKENS = 128;
const SUMMARY_MAX_TOKENS_CAP = 4_096;
const SUMMARY_LINE_CHARS = 200;
const DISTINCTIVE_TERM_MIN_LEN = 4;
const DISTINCTIVE_TERM_MAX = 64;
const OVERLAP_CAP = 63;

/** Conservative token estimate (reuses the repo weighted estimator). */
export function estimateTokens(text: string): number {
  return estimateTokenCount(text);
}

function summaryTokenCap(budget: ContextBudget): number {
  return Math.min(
    SUMMARY_MAX_TOKENS_CAP,
    Math.max(
      SUMMARY_MIN_TOKENS,
      Math.trunc(budget.usableInputTokens * SUMMARY_FRACTION),
    ),
  );
}

function getUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown> as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
    Object.freeze(value);
  }
  return value;
}

function buildToolNameMap(
  messages: readonly Message[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) map.set(c.callId, c.name);
    }
  }
  return map;
}

function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function messageSegment(
  m: Message,
  toolNames: ReadonlyMap<string, string>,
): string {
  switch (m.role) {
    case "system":
      return "";
    case "user":
      return `User: ${m.content}\n\n`;
    case "assistant": {
      const parts: string[] = [];
      const text = m.content.trim();
      if (text.length > 0) parts.push(text);
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          const payload = JSON.stringify({
            name: tc.name,
            arguments: parseToolArgs(tc.arguments),
          });
          parts.push(wrapToolCallPayload(payload));
        }
      }
      if (parts.length === 0) return "";
      return `Assistant: ${parts.join("\n").trim()}\n\n`;
    }
    case "tool": {
      const name = m.toolCallId
        ? (toolNames.get(m.toolCallId) ?? "tool")
        : "tool";
      return `Tool Response (${name}): ${m.content}\n\n`;
    }
    default:
      return "";
  }
}

function distinctiveTerms(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= DISTINCTIVE_TERM_MIN_LEN && out.size < DISTINCTIVE_TERM_MAX) {
      out.add(raw);
    }
  }
  return out;
}

function termOverlap(text: string, terms: ReadonlySet<string>): number {
  let n = 0;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (terms.has(raw)) n++;
  }
  return n;
}

const groupCharsCache = new WeakMap<SemanticGroup, number>();

function renderedCharsOf(g: SemanticGroup): number {
  const cached = groupCharsCache.get(g);
  if (cached !== undefined) return cached;
  const names = buildToolNameMap(g.messages);
  let total = 0;
  for (const m of g.messages) total += messageSegment(m, names).length;
  return total;
}

/**
 * Groups messages into user-anchored semantic units. A tool result attaches to
 * the exchange of the assistant that issued the call (by callId), so a
 * tool-call/result pair can NEVER be split across groups — that was the
 * per-message pop that broke tiered.ts.
 */
export function groupSemanticUnits(
  messages: readonly Message[],
): readonly SemanticGroup[] {
  const toolNames = buildToolNameMap(messages);

  const callOwner = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) callOwner.set(c.callId, i);
    }
  });

  const exchangeOf = new Array<number>(messages.length).fill(0);
  let nextExchange = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      exchangeOf[i] = -1;
    } else if (m.role === "user") {
      nextExchange += 1;
      exchangeOf[i] = nextExchange;
    } else if (m.role === "tool" && m.toolCallId && callOwner.has(m.toolCallId)) {
      exchangeOf[i] = exchangeOf[callOwner.get(m.toolCallId) as number];
    } else {
      exchangeOf[i] = nextExchange;
    }
  }

  const order: number[] = [];
  const byExchange = new Map<number, Message[]>();
  for (let i = 0; i < messages.length; i++) {
    const ex = exchangeOf[i];
    let bucket = byExchange.get(ex);
    if (!bucket) {
      bucket = [];
      byExchange.set(ex, bucket);
      order.push(ex);
    }
    bucket.push(messages[i]);
  }

  const lastExchange = order.filter((ex) => ex >= 0).pop();
  const currentTerms = distinctiveTerms(
    messages.reduce((s, m) => (m.role === "user" ? m.content : s), ""),
  );

  const groups: SemanticGroup[] = [];
  for (const ex of order) {
    const bucket = byExchange.get(ex) as Message[];
    const tier: 0 | 1 | 2 = ex === -1 ? 0 : ex === lastExchange ? 1 : 2;
    const parts = bucket.map((m) => messageSegment(m, toolNames));
    let chars = 0;
    for (const p of parts) chars += p.length;
    const overlap = Math.min(
      OVERLAP_CAP,
      termOverlap(bucket.map((m) => m.content).join(" "), currentTerms),
    );
    const group: SemanticGroup = {
      groupId: `grp_${groups.length + 1}`,
      tier,
      messages: bucket,
      tokenEstimate: estimateTokenCount(...parts),
      score: ex * 64 + overlap,
    };
    groupCharsCache.set(group, chars);
    groups.push(group);
  }
  return groups;
}

function groupToolRound(g: SemanticGroup): ToolRound {
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  let assistantMessageId: string | undefined;
  for (const m of g.messages) {
    if (m.role === "assistant") {
      if (!assistantMessageId) assistantMessageId = m.messageId;
      if (m.toolCalls) calls.push(...m.toolCalls);
    } else if (m.role === "tool" && m.toolCallId) {
      results.push({
        callId: m.toolCallId,
        content: m.content,
        isError: false,
        completedAt: m.createdAt,
      });
    }
  }
  return {
    assistantMessageId: assistantMessageId ?? g.groupId,
    calls,
    results,
    isComplete: false,
  };
}

/** A group with tool calls whose round is fully resolved inside it. */
function roundIsComplete(g: SemanticGroup): boolean {
  const round = groupToolRound(g);
  return round.calls.length === 0 || isToolRoundComplete(round);
}

/**
 * J.10: a tier-2 group is droppable only as a WHOLE, and only when it holds no
 * assistant tool call, or every call is answered by a result in the SAME group,
 * or the round is explicitly pending. Otherwise dropping it would orphan a
 * required tool result elsewhere in the history.
 */
export function isGroupDroppable(g: SemanticGroup): boolean {
  if (g.tier !== 2) return false;
  const round = groupToolRound(g);
  if (round.calls.length === 0) return true;
  if (isToolRoundComplete(round)) return true;
  return round.calls.some(
    (c) => c.status === "pending" || c.status === "in_progress",
  );
}

function renderSelection(
  systemPrompt: string,
  summary: string,
  retained: readonly SemanticGroup[],
  toolNames: ReadonlyMap<string, string>,
): string {
  const segments: string[] = [];
  for (const g of retained) {
    for (const m of g.messages) {
      const s = messageSegment(m, toolNames);
      if (s.length > 0) segments.push(s);
    }
  }
  const parts: string[] = [];
  if (systemPrompt.length > 0) parts.push(systemPrompt);
  if (summary.length > 0) parts.push(`${SUMMARY_HEADER}\n${summary}`);
  const body = segments.join("");
  if (body.length > 0) parts.push(body);
  return parts.join(SEGMENT_SEPARATOR);
}

function selectionChars(
  systemPrompt: string,
  retained: readonly SemanticGroup[],
  summary: string,
): number {
  const partLengths: number[] = [];
  if (systemPrompt.length > 0) partLengths.push(systemPrompt.length);
  if (summary.length > 0) {
    partLengths.push(SUMMARY_HEADER.length + 1 + summary.length);
  }
  let body = 0;
  for (const g of retained) body += renderedCharsOf(g);
  if (body > 0) partLengths.push(body);
  let total = 0;
  for (const n of partLengths) total += n;
  return total + SEGMENT_SEPARATOR.length * Math.max(0, partLengths.length - 1);
}

/** Conservative (>= exact) token estimate of a candidate selection. */
function selectionTokenEstimate(
  systemPrompt: string,
  retained: readonly SemanticGroup[],
  summary: string,
): number {
  let total = 0;
  if (systemPrompt.length > 0) {
    total += estimateTokens(systemPrompt);
    total += 1;
  }
  if (summary.length > 0) {
    total += estimateTokens(`${SUMMARY_HEADER}\n${summary}`);
    total += 1;
  }
  for (const g of retained) total += g.tokenEstimate;
  return total;
}

function measurementFits(
  m: { estimatedTokens: number; promptChars: number },
  budget: ContextBudget,
  legacyCharBudget: number | undefined,
): boolean {
  if (m.estimatedTokens > budget.usableInputTokens) return false;
  if (legacyCharBudget !== undefined && m.promptChars > legacyCharBudget) {
    return false;
  }
  return true;
}

function selectionFits(
  selection: Selection,
  systemPrompt: string,
  budget: ContextBudget,
  legacyCharBudget: number | undefined,
): boolean {
  return measurementFits(
    {
      estimatedTokens: selectionTokenEstimate(
        systemPrompt,
        selection.retained,
        selection.summary,
      ),
      promptChars: selectionChars(
        systemPrompt,
        selection.retained,
        selection.summary,
      ),
    },
    budget,
    legacyCharBudget,
  );
}

function finalizeSelection(
  groups: readonly SemanticGroup[],
  keptIds: ReadonlySet<string>,
  summary: string,
): Selection {
  const retained = groups.filter((g) => keptIds.has(g.groupId));
  return {
    retained,
    summary,
    droppedCount: groups.length - retained.length,
  };
}

function applyStrategy(
  groups: readonly SemanticGroup[],
  initialSummary: string,
  strategyIndex: number,
  budget: ContextBudget,
  legacyCharBudget: number | undefined,
  systemPrompt: string,
): Selection {
  const strategy = CONTEXT_COMPACTION_STRATEGY_ORDER[strategyIndex];
  // J.9: T0 (system) and the current user turn are invariant — every strategy
  // retains them, only tier-2 groups are ever dropped.
  const invariantIds = new Set(
    groups.filter((g) => g.tier === 0 || g.tier === 1).map((g) => g.groupId),
  );
  const t2 = groups.filter((g) => g.tier === 2);
  const nonDroppableIds = new Set(
    t2.filter((g) => !isGroupDroppable(g)).map((g) => g.groupId),
  );
  // Highest score first: the lowest-scoring group sits at the end and is
  // popped first. Dropping is whole-group only (J.10).
  const droppable = t2
    .filter((g) => isGroupDroppable(g))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (strategy === "NONE") {
    return { retained: [...groups], summary: initialSummary, droppedCount: 0 };
  }

  if (strategy === "HARD_FAILURE") {
    return finalizeSelection(
      groups,
      new Set<string>([...invariantIds, ...nonDroppableIds]),
      "",
    );
  }

  if (strategy === "DROP_LOW_SCORE_GROUPS") {
    const keptIds = new Set<string>([
      ...invariantIds,
      ...nonDroppableIds,
      ...droppable.map((g) => g.groupId),
    ]);
    const work = [...droppable];
    while (
      work.length > 0 &&
      !selectionFits(
        finalizeSelection(groups, keptIds, initialSummary),
        systemPrompt,
        budget,
        legacyCharBudget,
      )
    ) {
      keptIds.delete((work.pop() as SemanticGroup).groupId);
    }
    return finalizeSelection(groups, keptIds, initialSummary);
  }

  // SUMMARY_PLUS_RECENT: fold completed older exchanges into one extractive
  // summary; pending and non-droppable rounds stay verbatim so an unresolved
  // round is never summarized as resolved.
  const summarized = droppable.filter((g) => roundIsComplete(g));
  const verbatim = droppable.filter((g) => !roundIsComplete(g));
  const summary = buildExtractiveSummary(summarized, summaryTokenCap(budget));
  const keptIds = new Set<string>([
    ...invariantIds,
    ...nonDroppableIds,
    ...verbatim.map((g) => g.groupId),
  ]);
  return finalizeSelection(groups, keptIds, summary || initialSummary);
}

function buildExtractiveSummary(
  groups: readonly SemanticGroup[],
  maxTokens: number,
): string {
  const lines: string[] = [];
  for (const g of groups) {
    for (const m of g.messages) {
      if (m.role === "system") continue;
      const text = m.content.trim();
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        lines.push(`assistant called ${m.toolCalls.map((c) => c.name).join(", ")}`);
        if (text.length === 0) continue;
      }
      if (text.length === 0) continue;
      if (m.role === "tool") {
        lines.push(`tool result: ${text.slice(0, 120)}`);
        continue;
      }
      const firstLine =
        text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
      lines.push(`${m.role}: ${firstLine.slice(0, SUMMARY_LINE_CHARS)}`);
    }
  }
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = estimateTokens(line);
    if (used + t > maxTokens) break;
    kept.push(line);
    used += t;
  }
  return kept.join("\n");
}

/**
 * THE BUG FIX: a bounded compaction loop. At most
 * CONTEXT_COMPACTION_MAX_PASSES passes; each pass either fits the budget or
 * strictly changes (retained units, estimate, or strategy index), and a pass
 * that repeats its predecessor escalates the strategy immediately. When the
 * strategy ladder is exhausted the loop fails closed with
 * CONTEXT_COMPACTION_NON_CONVERGENT — it never retries the same input+budget
 * and never falls back to sending the oversized original.
 */
export function compactWithBudget(
  groups: readonly SemanticGroup[],
  ctx: CompactionContext,
): CompactionResult {
  const { systemPrompt, budget, initialSummary, legacyCharBudget } = ctx;
  const passes: CompactionPassRecord[] = [];
  let strategyIndex = 0;

  for (let pass = 1; pass <= CONTEXT_COMPACTION_MAX_PASSES; pass++) {
    const selection = applyStrategy(
      groups,
      initialSummary,
      strategyIndex,
      budget,
      legacyCharBudget,
      systemPrompt,
    );
    const record: CompactionPassRecord = {
      pass,
      strategy: CONTEXT_COMPACTION_STRATEGY_ORDER[strategyIndex],
      retainedGroups: selection.retained.length,
      estimatedTokens: selectionTokenEstimate(
        systemPrompt,
        selection.retained,
        selection.summary,
      ),
      targetTokens: budget.usableInputTokens,
    };
    passes.push(record);

    if (selectionFits(selection, systemPrompt, budget, legacyCharBudget)) {
      return {
        ok: true,
        selection,
        passes,
        compressed:
          selection.droppedCount > 0 || selection.summary.length > 0,
      };
    }

    // HARD_FAILURE is terminal: no further strategy can make progress.
    if (strategyIndex >= CONTEXT_COMPACTION_STRATEGY_ORDER.length - 1) {
      return { ok: false, passes };
    }

    const previous = passes[passes.length - 2];
    const madeNoProgress =
      previous !== undefined &&
      previous.retainedGroups === record.retainedGroups &&
      previous.estimatedTokens === record.estimatedTokens;
    if (madeNoProgress || record.strategy === "NONE") {
      strategyIndex += 1;
    }
  }

  return { ok: false, passes };
}

/**
 * Full pipeline. Loads the snapshot view, derives the token budget from the
 * effective model's capabilities, selects and (only if needed) compacts
 * semantic units, renders, re-measures the final payload, validates, and
 * returns a deep-frozen PreparedContext.
 */
export function prepareContext(input: PrepareContextInput): PrepareContextResult {
  const tools = input.toolDefinitions ?? [];
  // Tool schemas ride their own reserved channel (budget.toolReservationTokens),
  // so they are measured out of the payload, never inside it.
  const toolSchemaTokens =
    tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0;

  const budget = buildContextBudget({
    contextWindowTokens: input.capabilities.getContextWindowTokens(input.modelId),
    maxOutputTokens: input.capabilities.getMaxOutputTokens(input.modelId),
    maxThinkingTokens: input.maxThinkingTokens ?? 0,
    toolSchemaTokens,
    thinkingEnabled: input.thinkingEnabled === true,
    toolsPresent: tools.length > 0,
    safetyMarginPct: input.safetyMarginPct,
  });

  const groups = groupSemanticUnits(input.messages);
  const toolNames = buildToolNameMap(input.messages);

  // J.9: T0 (system) and the current user turn are invariant. If they alone
  // cannot fit, no strategy can help — fail closed with CONTEXT_TOO_LARGE
  // rather than truncating protected content.
  const invariant = groups.filter((g) => g.tier === 0 || g.tier === 1);
  const floorRendered = renderSelection(
    input.systemPrompt,
    "",
    invariant,
    toolNames,
  );
  const floorMeasurement = {
    promptChars: floorRendered.length,
    estimatedTokens: estimateTokens(floorRendered),
  };
  if (!measurementFits(floorMeasurement, budget, input.legacyCharBudget)) {
    return {
      ok: false,
      errorCode: "CONTEXT_TOO_LARGE",
      reason:
        `Invariant context (system prompt + current turn) exceeds the usable budget: ${floorMeasurement.estimatedTokens} estimated tokens > ${budget.usableInputTokens} usable`,
      attempts: [],
    };
  }

  const compaction = compactWithBudget(groups, {
    systemPrompt: input.systemPrompt,
    budget,
    initialSummary: input.rollingSummary ?? "",
    legacyCharBudget: input.legacyCharBudget,
  });
  if (!compaction.ok) {
    const last = compaction.passes[compaction.passes.length - 1];
    return {
      ok: false,
      errorCode: "CONTEXT_COMPACTION_NON_CONVERGENT",
      reason:
        `Compaction exhausted ${compaction.passes.length} pass(es) without converging (last estimate ${last?.estimatedTokens} tokens / ${last?.retainedGroups} groups vs ${budget.usableInputTokens} usable); refusing to send oversized context`,
      attempts: [...compaction.passes],
    };
  }

  // Measure then validate then freeze: the measurement below is taken on the
  // exact serialized payload that would be sent.
  const rendered = renderSelection(
    input.systemPrompt,
    compaction.selection.summary,
    compaction.selection.retained,
    toolNames,
  );
  const measurement: ContextMeasurement = {
    promptChars: rendered.length,
    payloadBytes: getUtf8ByteLength(rendered),
    estimatedTokens: estimateTokens(rendered),
    actualPromptTokens: null,
    measurementSource: "estimate",
  };
  if (!measurementFits(measurement, budget, input.legacyCharBudget)) {
    return {
      ok: false,
      errorCode: "CONTEXT_TOO_LARGE",
      reason:
        `Rendered payload exceeds the budget after compaction: ${measurement.estimatedTokens} estimated tokens / ${measurement.promptChars} chars`,
      attempts: [...compaction.passes],
    };
  }

  const prepared: PreparedContext = deepFreeze({
    snapshotId: input.snapshotId ?? newSnapshotId(),
    renderedPrompt: rendered,
    payloadBytes: measurement.payloadBytes,
    estimatedTokens: measurement.estimatedTokens,
    compressed: compaction.compressed,
    compactionPasses: compaction.passes.filter((p) => p.strategy !== "NONE")
      .length,
    validated: true,
  });

  return { ok: true, prepared, measurement };
}
