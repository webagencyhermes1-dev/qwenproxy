import {
  type AttemptState,
  type GenerationState,
  isTerminalGenerationState,
} from "./types.ts";

/**
 * Maximum number of physical upstream attempts a single logical generation may
 * spend. Beyond this the operation fails permanently rather than hammering the
 * upstream pool.
 */
export const MAX_GENERATION_ATTEMPTS = 4;

// ─── Logical generation ───────────────────────────────────────────────────────

/**
 * One LOGICAL inference operation: a single client-visible answer that may span
 * several PHYSICAL upstream attempts ({@link GenerationAttempt}) as accounts
 * fail over. Identity follows the logical operation, not the wire request.
 */
export interface Generation {
  generationId: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  /** Session version captured at creation; optimistic-concurrency guard. */
  sessionVersionAtStart: number;
  state: GenerationState;
  /** Physical attempts, appended in order. The last entry is the live one. */
  attemptIds: readonly string[];
  /** Failover guard: accounts already burned by this generation. */
  attemptedAccountIds: readonly string[];
  /** Immutable ContextSnapshot shared by every attempt. */
  snapshotId: string | null;
  /** Current fenced lease, if one is held. */
  leaseId: string | null;
  /** ONE absolute root deadline (epoch ms); children inherit the remainder. */
  deadline: number;
  createdAt: number;
  terminalAt: number | null;
  /** The retry policy consults this; never infer "safe to retry" from a label. */
  sideEffects: SideEffectRecord;
  idempotencyKey: string | null;
}

/**
 * User-visible consequences of a generation. Replay after any of these would
 * duplicate content the client already received or re-execute real work.
 */
export interface SideEffectRecord {
  outputEmittedToClient: boolean;
  /** Tool call ids that were actually dispatched upstream. */
  toolCallsExecuted: readonly string[];
  lastUpdatedAt: number;
}

/** True when replaying the generation would duplicate user-visible effects. */
export function hasIrreversibleSideEffects(s: SideEffectRecord): boolean {
  return s.outputEmittedToClient || s.toolCallsExecuted.length > 0;
}

// ─── Physical attempt ────────────────────────────────────────────────────────

/**
 * One PHYSICAL upstream attempt. Belongs to exactly one {@link Generation};
 * failover replaces an attempt, never the generation.
 */
export interface GenerationAttempt {
  attemptId: string;
  generationId: string;
  /** 1-based ordinal within the parent generation. */
  attemptNumber: number;
  accountId: string;
  state: AttemptState;
  startedAt: number | null;
  upstreamStartedAt: number | null;
  firstTokenAt: number | null;
  completedAt: number | null;
  /** ErrorCode value, set when the attempt failed. */
  failureCode: string | null;
  failureReason: string | null;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export interface GenerationTimeline {
  created: number;
  reserved: number | null;
  preparing: number | null;
  upstreamStarted: number | null;
  firstToken: number | null;
  toolCalls: number[];
  failovers: number[];
  terminal: number | null;
}

export type TimelineEvent =
  | "created"
  | "reserved"
  | "preparing"
  | "upstreamStarted"
  | "firstToken"
  | "toolCall"
  | "failover"
  | "terminal";

/**
 * Pure: returns a NEW timeline with `event` recorded at `at`. The input timeline
 * is never mutated — failovers and tool calls append to fresh arrays.
 */
export function recordTimelineTransition(
  timeline: GenerationTimeline,
  event: TimelineEvent,
  at: number,
): GenerationTimeline {
  switch (event) {
    case "created":
      return { ...timeline, created: at };
    case "reserved":
      return { ...timeline, reserved: at };
    case "preparing":
      return { ...timeline, preparing: at };
    case "upstreamStarted":
      return { ...timeline, upstreamStarted: at };
    case "firstToken":
      return { ...timeline, firstToken: at };
    case "toolCall":
      return { ...timeline, toolCalls: [...timeline.toolCalls, at] };
    case "failover":
      return { ...timeline, failovers: [...timeline.failovers, at] };
    case "terminal":
      return { ...timeline, terminal: at };
  }
}

// ─── State machine ───────────────────────────────────────────────────────────

/**
 * Targets reachable from every nonterminal state: cancel, hard fail, or
 * abandonment of an orphaned process. Terminal states lead nowhere — exactly
 * one terminal transition may win.
 */
const TERMINAL_TARGETS: readonly GenerationState[] = [
  "CANCELLED",
  "FAILED",
  "ABANDONED",
];

/**
 * Legal generation transitions.
 *
 * Forward spine:
 *   QUEUED → RESERVING → PREPARING → STARTING → STREAMING
 *     → (WAITING_FOR_TOOL_RESULTS → STARTING)*   (tool loop)
 *     → SETTLING → COMPLETED
 *
 * A recoverable attempt failure returns to RESERVING so the retry coordinator
 * can re-reserve a fresh account; an unrecoverable one goes straight to FAILED.
 * STARTING may short-circuit to WAITING_FOR_TOOL_RESULTS (tool-only turn) or to
 * SETTLING (empty completion) without emitting a token.
 */
const TRANSITIONS: Readonly<Record<GenerationState, readonly GenerationState[]>> = {
  QUEUED: ["RESERVING", ...TERMINAL_TARGETS],
  RESERVING: ["PREPARING", "RESERVING", ...TERMINAL_TARGETS],
  PREPARING: ["STARTING", "RESERVING", ...TERMINAL_TARGETS],
  STARTING: [
    "STREAMING",
    "WAITING_FOR_TOOL_RESULTS",
    "SETTLING",
    "RESERVING",
    ...TERMINAL_TARGETS,
  ],
  STREAMING: ["WAITING_FOR_TOOL_RESULTS", "SETTLING", "RESERVING", ...TERMINAL_TARGETS],
  WAITING_FOR_TOOL_RESULTS: ["STARTING", "RESERVING", ...TERMINAL_TARGETS],
  SETTLING: ["COMPLETED", ...TERMINAL_TARGETS],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  ABANDONED: [],
};

/** True when `from → to` is a legal generation state transition. */
export function canTransition(from: GenerationState, to: GenerationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** True when the generation has reached a state that cannot change. */
export function isTerminal(g: Generation): boolean {
  return isTerminalGenerationState(g.state);
}

/**
 * Late-callback guard. A result is acceptable only when it names the CURRENT
 * attempt and was issued against the state the generation actually holds.
 * Anything else is a stray from a superseded attempt and is hostile to
 * correctness: dropping it is always safer than applying it.
 */
export function canAcceptResult(
  g: Generation,
  attemptId: string,
  expectedState: GenerationState,
): boolean {
  if (isTerminal(g)) return false;
  const current = g.attemptIds[g.attemptIds.length - 1];
  if (current !== attemptId) return false;
  return g.state === expectedState;
}

/**
 * Failover guard: true when `accountId` already failed this generation and must
 * not be handed the retry. Callers select a candidate account, then verify it
 * here before committing an attempt to it.
 */
export function isAttemptedAccount(g: Generation, accountId: string): boolean {
  return g.attemptedAccountIds.includes(accountId);
}

/**
 * Open a new physical attempt on the logical generation, appending it as the
 * live attempt. Returns null when the retry budget is exhausted
 * (`attemptIds.length >= MAX_GENERATION_ATTEMPTS`) or when recorded side effects
 * make a replay unsafe — the caller must not retry on top of emitted output.
 *
 * `accountId` is the account the retry coordinator chose (an account not in
 * {@link Generation.attemptedAccountIds}); the pure domain layer keeps the
 * guard data but does not pick from an account pool.
 */
export function nextAttempt(
  g: Generation,
  accountId: string = "",
): { generation: Generation; attempt: GenerationAttempt } | null {
  if (g.attemptIds.length >= MAX_GENERATION_ATTEMPTS) return null;
  if (hasIrreversibleSideEffects(g.sideEffects)) return null;

  const attemptNumber = g.attemptIds.length + 1;
  const attemptId = `${g.generationId}_attempt_${attemptNumber}`;
  const attemptedAccountIds =
    accountId && !g.attemptedAccountIds.includes(accountId)
      ? [...g.attemptedAccountIds, accountId]
      : g.attemptedAccountIds;

  const generation: Generation = {
    ...g,
    attemptIds: [...g.attemptIds, attemptId],
    attemptedAccountIds,
  };
  const attempt: GenerationAttempt = {
    attemptId,
    generationId: g.generationId,
    attemptNumber,
    accountId,
    state: "STARTING",
    startedAt: null,
    upstreamStartedAt: null,
    firstTokenAt: null,
    completedAt: null,
    failureCode: null,
    failureReason: null,
  };
  return { generation, attempt };
}

/**
 * Time left before the root deadline expires. Child operations receive this
 * REMAINDER, never a fresh relative timeout: one absolute deadline governs the
 * whole generation, so a retry cannot outlive the budget its predecessors spent.
 * A terminal generation has no remaining time.
 */
export function remainingDeadline(g: Generation, now: number): number {
  if (isTerminal(g)) return 0;
  return Math.max(0, g.deadline - now);
}
