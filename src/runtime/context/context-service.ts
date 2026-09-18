import { newSnapshotId } from "../../domain/ids.ts";
import type { CompactionStrategy } from "../../domain/types.ts";
import type { Message } from "../../domain/session.ts";
import type { ToolDefinition } from "../../domain/tools.ts";
import type { ErrorCode } from "../../domain/errors.ts";
import {
  buildContextBudget,
  localMeasurementFromPrepared,
  CONTEXT_COMPACTION_MAX_PASSES,
} from "../../domain/context.ts";
import type { ContextMeasurement, PreparedContext } from "../../domain/context.ts";
import { computeInputContextBudget } from "../../utils/context-budget.ts";
import { estimateTokenCount } from "../../utils/context-truncation.ts";
import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from "../../tools/toolcall-tags.ts";

export interface ModelCapabilitySource {
  getContextWindowTokens(modelId?: string): number;
  getMaxOutputTokens(modelId?: string): number;
  getMaxInputTokens(modelId?: string): number;
}

export interface SemanticGroup {
  readonly tier: number;
  readonly messages: readonly Message[];
}

export interface CompactionPassRecord {
  readonly pass: number;
  readonly strategy: CompactionStrategy;
  readonly retainedGroups: number;
  readonly estimatedTokens: number;
}

export interface PrepareContextInput {
  messages: readonly Message[];
  systemPrompt: string;
  modelId: string;
  capabilities: ModelCapabilitySource;
  legacyCharBudget?: number;
  toolDefinitions?: readonly ToolDefinition[];
  rollingSummary?: string;
  usePersonalization?: boolean;
}

export type PrepareContextResult =
  | { ok: true; prepared: PreparedContext; measurement: ContextMeasurement }
  | { ok: false; errorCode: ErrorCode; reason: string; attempts: CompactionPassRecord[] };

const CJK_RANGES: readonly [number, number][] = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
  [0x3000, 0x303f],
  [0x3040, 0x309f],
  [0x30a0, 0x30ff],
  [0xac00, 0xd7af],
  [0xff00, 0xffef],
];

const STRUCTURAL_CHARS = new Set(
  "{}[]\":,=<>+-*/\\|&!@#$%^~`?;()",
);

function isCjkCode(code: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) i++;
    if (isCjkCode(code)) {
      tokens += 1;
    } else if (STRUCTURAL_CHARS.has(text[i])) {
      tokens += 0.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

function findLastUserMessageIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

export function groupSemanticUnits(messages: readonly Message[]): SemanticGroup[] {
  const toolCallToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        toolCallToAssistantIdx.set(tc.callId, i);
      }
    }
  }

  const lastUserIdx = findLastUserMessageIndex(messages);
  const groups: SemanticGroup[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (assigned.has(i)) continue;
    const msg = messages[i];

    if (msg.role === "system") {
      groups.push({ tier: 1, messages: [msg] });
      assigned.add(i);
    } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const groupMsgs: Message[] = [msg];
      assigned.add(i);
      const callIds = new Set(msg.toolCalls.map((tc) => tc.callId));
      for (let j = i + 1; j < messages.length; j++) {
        if (assigned.has(j)) continue;
        const candidate = messages[j];
        if (candidate.role === "tool" && candidate.toolCallId && callIds.has(candidate.toolCallId)) {
          groupMsgs.push(candidate);
          assigned.add(j);
        }
      }
      const inCurrentTurn = lastUserIdx >= 0 && i >= lastUserIdx;
      const hasPending = msg.toolCalls.some(
        (tc) => tc.status === "pending" || tc.status === "in_progress",
      );
      const tier = inCurrentTurn || hasPending ? 1 : 2;
      groups.push({ tier, messages: groupMsgs });
    } else if (msg.role === "tool" && msg.toolCallId && toolCallToAssistantIdx.has(msg.toolCallId)) {
      continue;
    } else {
      const tier = msg.role === "user" && i === lastUserIdx ? 1 : lastUserIdx >= 0 && i >= lastUserIdx ? 1 : 2;
      groups.push({ tier, messages: [msg] });
      assigned.add(i);
    }
  }

  return groups;
}

export function isGroupDroppable(group: SemanticGroup): boolean {
  if (group.tier <= 1) return false;
  const resultCallIds = new Set(
    group.messages
      .filter((m) => m.role === "tool" && m.toolCallId)
      .map((m) => m.toolCallId!),
  );
  for (const msg of group.messages) {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const hasPending = msg.toolCalls.some(
        (tc) => tc.status === "pending" || tc.status === "in_progress",
      );
      if (hasPending) return false;
      for (const tc of msg.toolCalls) {
        if ((tc.status === "completed" || tc.status === "failed") && !resultCallIds.has(tc.callId)) {
          return false;
        }
      }
    }
  }
  return true;
}

function buildCallIdToToolName(messages: readonly Message[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        map.set(tc.callId, tc.name);
      }
    }
  }
  return map;
}

function renderMessage(msg: Message, callIdToName: Map<string, string>): string {
  if (msg.role === "tool") {
    const name = callIdToName.get(msg.toolCallId ?? "") ?? msg.toolCallId ?? "unknown";
    return `Tool Response (${name})\n${msg.content}`;
  }
  const parts: string[] = [];
  if (msg.content) {
    parts.push(msg.content);
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(tc.arguments);
      } catch {
        parsedArgs = tc.arguments;
      }
      const payload = JSON.stringify({ name: tc.name, arguments: parsedArgs });
      parts.push(`${TOOL_CALL_OPEN}\n${payload}\n${TOOL_CALL_CLOSE}`);
    }
  }
  const roleLabel = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
  return `${roleLabel}: ${parts.join("\n")}`;
}

function renderPromptFromGroups(
  groups: readonly SemanticGroup[],
  systemPrompt: string,
  rollingSummary: string,
  callIdToName: Map<string, string>,
): string {
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`System: ${systemPrompt}`);
  }
  if (rollingSummary) {
    parts.push(`Summary of earlier work: ${rollingSummary}`);
  }
  for (const group of groups) {
    for (const msg of group.messages) {
      if (msg.role === "system") continue;
      parts.push(renderMessage(msg, callIdToName));
    }
  }
  return parts.join("\n\n");
}

function fitsWithinBudget(
  renderedTokens: number,
  renderedChars: number,
  usableInputTokens: number,
  legacyCharBudget?: number,
): boolean {
  if (renderedTokens > usableInputTokens) return false;
  if (legacyCharBudget !== undefined && renderedChars > legacyCharBudget) return false;
  return true;
}

function makePrepared(rendered: string, tokens: number, compressed: boolean, passes: number): PreparedContext {
  return deepFreeze({
    snapshotId: newSnapshotId(),
    renderedPrompt: rendered,
    payloadBytes: Buffer.byteLength(rendered, "utf8"),
    estimatedTokens: tokens,
    compressed,
    compactionPasses: passes,
    validated: true as const,
  });
}

function applyDropLowScoreGroups(groups: readonly SemanticGroup[]): SemanticGroup[] {
  return groups.filter((g) => !isGroupDroppable(g));
}

function applySummaryPlusRecent(groups: readonly SemanticGroup[]): SemanticGroup[] {
  const retained: SemanticGroup[] = [];
  for (const group of groups) {
    if (group.tier <= 1 || !isGroupDroppable(group)) {
      retained.push(group);
    }
  }
  return retained;
}

export function prepareContext(input: PrepareContextInput): PrepareContextResult {
  const { messages, systemPrompt, modelId, capabilities, legacyCharBudget, toolDefinitions, rollingSummary, usePersonalization } = input;

  const toolSchemaTokens = toolDefinitions && toolDefinitions.length > 0
    ? estimateTokenCount(JSON.stringify(toolDefinitions))
    : 0;

  const contextWindowTokens = capabilities.getContextWindowTokens(modelId);
  const maxInputTokens = capabilities.getMaxOutputTokens(modelId);

  const inputBudget = computeInputContextBudget({
    contextWindowTokens,
    maxInputTokens,
    safetyMarginTokens: 2048,
  });

  const callIdToName = buildCallIdToToolName(messages);
  const summaryText = rollingSummary ?? "";

  const systemTokens = usePersonalization ? 0 : estimateTokenCount(systemPrompt) + estimateTokenCount(summaryText);
  if (systemTokens > inputBudget) {
    return {
      ok: false,
      errorCode: "CONTEXT_TOO_LARGE",
      reason: "system prompt exceeds usable input budget",
      attempts: [],
    };
  }
  if (legacyCharBudget !== undefined && systemPrompt.length + summaryText.length > legacyCharBudget) {
    return {
      ok: false,
      errorCode: "CONTEXT_TOO_LARGE",
      reason: "system prompt exceeds legacy char budget",
      attempts: [],
    };
  }

  const groups = groupSemanticUnits(messages);
  const invariantGroups = groups.filter((g) => g.tier <= 1);

  const invariantRendered = renderPromptFromGroups(invariantGroups, systemPrompt, summaryText, callIdToName);
  const invariantTokens = estimateTokenCount(invariantRendered);
  if (!fitsWithinBudget(invariantTokens, invariantRendered.length, inputBudget, legacyCharBudget)) {
    return {
      ok: false,
      errorCode: "CONTEXT_TOO_LARGE",
      reason: "invariant content exceeds usable input budget",
      attempts: [],
    };
  }

  const fullRendered = renderPromptFromGroups(groups, systemPrompt, summaryText, callIdToName);
  const fullTokens = estimateTokenCount(fullRendered);

  if (fitsWithinBudget(fullTokens, fullRendered.length, inputBudget, legacyCharBudget)) {
    const prepared = makePrepared(fullRendered, fullTokens, false, 0);
    return { ok: true, prepared, measurement: localMeasurementFromPrepared(prepared) };
  }

  const attempts: CompactionPassRecord[] = [];
  let currentGroups: SemanticGroup[] = [...groups];
  let passCount = 0;
  let strategyIdx = 1;

  while (passCount < CONTEXT_COMPACTION_MAX_PASSES && strategyIdx < 4) {
    const strategy = ["NONE", "DROP_LOW_SCORE_GROUPS", "SUMMARY_PLUS_RECENT", "HARD_FAILURE"][strategyIdx] as CompactionStrategy;
    passCount++;

    if (strategy === "HARD_FAILURE") {
      const rendered = renderPromptFromGroups(currentGroups, systemPrompt, summaryText, callIdToName);
      attempts.push({
        pass: passCount,
        strategy,
        retainedGroups: currentGroups.length,
        estimatedTokens: estimateTokenCount(rendered),
      });
      return {
        ok: false,
        errorCode: "CONTEXT_COMPACTION_NON_CONVERGENT",
        reason: "compaction could not converge within maximum passes",
        attempts,
      };
    }

    const nextGroups = strategy === "DROP_LOW_SCORE_GROUPS"
      ? applyDropLowScoreGroups(currentGroups)
      : applySummaryPlusRecent(currentGroups);

    const rendered = renderPromptFromGroups(nextGroups, systemPrompt, summaryText, callIdToName);
    const tokens = estimateTokenCount(rendered);

    attempts.push({
      pass: passCount,
      strategy,
      retainedGroups: nextGroups.length,
      estimatedTokens: tokens,
    });

    if (fitsWithinBudget(tokens, rendered.length, inputBudget, legacyCharBudget)) {
      const prepared = makePrepared(rendered, tokens, true, passCount);
      return { ok: true, prepared, measurement: localMeasurementFromPrepared(prepared) };
    }

    currentGroups = nextGroups;
    strategyIdx++;
  }

  return {
    ok: false,
    errorCode: "CONTEXT_COMPACTION_NON_CONVERGENT",
    reason: "compaction could not converge within maximum passes",
    attempts,
  };
}
