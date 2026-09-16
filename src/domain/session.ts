import type { ToolCall } from "./tools.ts";

/**
 * Durable conversation aggregate.
 *
 * The session is the canonical application-state boundary: it owns the
 * semantic message tree (branches, parentage, sequence numbers) and is the
 * unit of fairness/quota under a {@link Tenant}. Upstream chat handles are
 * recorded as execution detail only ({@link SessionUpstreamMapping}) and can
 * be discarded and rebuilt at any time without losing conversation state.
 */

// ─── Tenant ───────────────────────────────────────────────────────────────────

export interface TenantLimits {
  maxConcurrentGenerations: number;
  maxQueueDepth: number;
  maxRequestBytes: number;
  maxSessionBytes: number;
}

/**
 * Fairness and quota boundary. API keys are NEVER reused as upstream
 * credentials; a tenant scopes the limits above.
 */
export interface Tenant {
  tenantId: string;
  limits: TenantLimits;
}

// ─── Message tree ─────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Durable semantic history entry. {@link sequenceNumber} is stable and
 * monotonic within a session, and {@link parentMessageId} + {@link branchId}
 * place the message in the tree regardless of upstream ordering.
 */
export interface Message {
  messageId: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  sequenceNumber: number;
  parentMessageId: string | null;
  branchId: string;
  createdAt: number;
  toolCalls?: readonly ToolCall[];
  /** For role "tool": the call being answered. */
  toolCallId?: string;
}

export interface Branch {
  branchId: string;
  parentId: string | null;
  createdAt: number;
  active: boolean;
}

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * Upstream execution handle ONLY — never canonical application state. These
 * fields can disappear and be recreated; a fresh mapping is always creatable.
 */
export interface SessionUpstreamMapping {
  accountId: string | null;
  upstreamChatId: string | null;
  upstreamParentId: string | null;
  /** Bumped whenever the mapping is (re)created. */
  mappingVersion: number;
}

/**
 * The logical conversation; source of truth independent of upstream handles.
 * {@link version} is monotonic and advanced on each semantic commit.
 */
export interface Session {
  sessionId: string;
  tenantId: string;
  version: number;
  currentBranchId: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  upstreamMapping?: SessionUpstreamMapping;
}

// ─── Turn ─────────────────────────────────────────────────────────────────────

export type TurnStatus = "open" | "complete" | "failed";

/**
 * Groups one user request with the physical executions needed to reach a
 * final outcome. A logical turn may contain MULTIPLE physical generations
 * (model response -> tool calls -> next model generation -> final response).
 */
export interface Turn {
  turnId: string;
  sessionId: string;
  sessionVersionAtStart: number;
  userMessageId: string;
  generationIds: readonly string[];
  status: TurnStatus;
  startedAt: number;
  completedAt: number | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Optimistic concurrency: a generation commits only against the version it
 * started from, so {@link to} must be exactly {@link from} + 1.
 */
export function assertMonotonicVersion(from: number, to: number): void {
  if (to !== from + 1) {
    throw new Error(
      `Session version must advance by exactly 1: from=${from} to=${to}`,
    );
  }
}

/** True when an observed version no longer matches the session's version. */
export function isStaleSessionVersion(session: Session, observedVersion: number): boolean {
  return observedVersion !== session.version;
}

/**
 * Default policy: at most one active generation may mutate a session at a
 * time.
 */
export function canMutateSession(
  session: Session,
  activeGenerationCount: number,
): boolean {
  return activeGenerationCount < 1;
}

/**
 * True when the upstream chat/parent ids are absent, meaning a fresh upstream
 * mapping must be created rather than appended to.
 */
export function sessionUpstreamHandleIsStale(
  mapping: SessionUpstreamMapping | undefined,
): boolean {
  if (!mapping) return true;
  return mapping.upstreamChatId === null || mapping.upstreamParentId === null;
}
