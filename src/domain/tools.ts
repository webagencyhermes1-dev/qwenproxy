import { createHash } from "node:crypto";

import type { JsonSchema } from "../tools/types.ts";

/**
 * Normalized internal tool definition, independent of the wire format
 * (OpenAI function calling, Anthropic tools, etc.).
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: JsonSchema;
  strict?: boolean;
}

/** Lifecycle state of a single tool call within a turn. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * A tool invocation issued by the model. `callId` is the stable identity:
 * it survives compaction, failover, resume, serialization, and restart.
 * `arguments` is the raw JSON string, canonicalized for stable hashing.
 */
export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
  status: ToolCallStatus;
}

/**
 * The outcome of a tool call. Results may arrive in ARBITRARY completion
 * order for parallel calls; correlation is by `callId` only.
 */
export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
  /** Epoch milliseconds. */
  completedAt: number;
}

/**
 * The atomic semantic group that compaction must never split: one assistant
 * message, every tool call it issued, and every result for those calls.
 */
export interface ToolRound {
  assistantMessageId: string;
  calls: readonly ToolCall[];
  results: readonly ToolResult[];
  isComplete: boolean;
}

/**
 * Attributable side-effect record: ties a tool call to the specific physical
 * generation/attempt/session that produced it, for replay safety.
 */
export interface ToolCallEvent {
  callId: string;
  generationId: string;
  attemptId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Recursively reorders object keys so equivalent values serialize identically. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Re-serializes tool arguments with stable key ordering so equivalent
 * arguments produce identical hashes. Total: on parse failure, returns the
 * trimmed original string (never throws — used in hash computation).
 */
export function canonicalizeToolArguments(args: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(args)));
  } catch {
    return args.trim();
  }
}

/**
 * Deterministic sha256 fingerprint of a tool set. Definitions are sorted by
 * name and serialized with stable key order, so equivalent unordered sets
 * hash identically. Returns the first 16 hex chars of the digest.
 */
export function toolSetHash(definitions: readonly ToolDefinition[]): string {
  const canonical = sortKeys(
    definitions
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Deterministic identity of a single tool call, for dedupe/idempotency of
 * result delivery. Derived from name + canonicalized arguments.
 */
export function toolCallFingerprint(call: ToolCall): string {
  const canonical = sortKeys({
    name: call.name,
    arguments: canonicalizeToolArguments(call.arguments),
  });
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** True only when every call in the round has a matching result by callId. */
export function isToolRoundComplete(round: ToolRound): boolean {
  if (round.calls.length === 0) return false;
  const resolved = new Set(round.results.map((r) => r.callId));
  return round.calls.every((c) => resolved.has(c.callId));
}

/**
 * Structural invariant of a tool round. Throws when a result references an
 * unknown callId, or when a round marked complete is missing a required
 * result — a missing result must stay pending, never summarized as resolved.
 */
export function assertToolRoundStructurallyValid(round: ToolRound): void {
  const known = new Set(round.calls.map((c) => c.callId));

  for (const result of round.results) {
    if (!known.has(result.callId)) {
      throw new Error(
        `Tool result references unknown callId: ${result.callId}`,
      );
    }
  }

  if (round.isComplete) {
    const resolved = new Set(round.results.map((r) => r.callId));
    for (const call of round.calls) {
      if (!resolved.has(call.callId)) {
        throw new Error(
          `Completed tool round is missing result for callId: ${call.callId}`,
        );
      }
    }
  }
}
