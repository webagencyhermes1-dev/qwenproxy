import { newEventId } from "./ids.ts";

/**
 * Canonical runtime event names. Emitted across the session, generation,
 * account, context, browser and warmup lifecycles.
 */
export type RuntimeEventName =
  | "SESSION_CREATED"
  | "SESSION_VERSION_ADVANCED"
  | "SESSION_BRANCH_CREATED"
  | "GENERATION_CREATED"
  | "GENERATION_RESERVED"
  | "GENERATION_STARTED"
  | "GENERATION_FIRST_TOKEN"
  | "GENERATION_TOOL_CALL"
  | "GENERATION_TOOL_RESULT"
  | "GENERATION_WAITING_FOR_TOOL"
  | "GENERATION_FAILOVER"
  | "GENERATION_COMPLETED"
  | "GENERATION_FAILED"
  | "GENERATION_CANCELLED"
  | "GENERATION_ABANDONED"
  | "ACCOUNT_RESERVED"
  | "ACCOUNT_RELEASED"
  | "ACCOUNT_STATE_CHANGED"
  | "ACCOUNT_RECOVERY_STARTED"
  | "ACCOUNT_RECOVERY_COMPLETED"
  | "ACCOUNT_COOLDOWN"
  | "WARMUP_STARTED"
  | "WARMUP_COMPLETED"
  | "WARMUP_FAILED"
  | "CONTEXT_SNAPSHOT_CREATED"
  | "CONTEXT_COMPACTED"
  | "CONTEXT_COMPACTED_FAILED"
  | "CONTEXT_VALIDATED"
  | "BROWSER_OPERATION_STARTED"
  | "BROWSER_OPERATION_COMPLETED"
  | "BROWSER_OPERATION_ABORTED"
  | "BROWSER_OPERATION_TIMEOUT";

export interface RuntimeEvent {
  eventId: string;
  name: RuntimeEventName;
  at: number; // epoch ms
  // Identity spines — present when available; never assume all are set.
  requestId?: string;
  tenantId?: string;
  sessionId?: string;
  generationId?: string;
  attemptId?: string;
  accountId?: string;
  leaseId?: string;
  // Sized/hashed diagnostics ONLY. Never raw prompts, cookies, auth headers,
  // or tool secrets.
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Partial identity spine; callers supply whichever ids they have. */
export type RuntimeEventIdentity = Partial<
  Pick<
    RuntimeEvent,
    | "requestId"
    | "tenantId"
    | "sessionId"
    | "generationId"
    | "attemptId"
    | "accountId"
    | "leaseId"
  >
>;

// ─── Sensitive attribute guard ───────────────────────────────────────────────
// Defense in depth: keys that must never be placed in `attributes`, since that
// field is meant for sized/hashed diagnostics only.

export const SENSITIVE_ATTRIBUTE_KEYS = [
  "prompt",
  "password",
  "cookie",
  "authorization",
  "token",
  "systemPrompt",
  "toolArguments",
  "personalization",
] as const;

/** Case-insensitive membership check against {@link SENSITIVE_ATTRIBUTE_KEYS}. */
export function isSensitiveAttributeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (SENSITIVE_ATTRIBUTE_KEYS as readonly string[]).some(
    (forbidden) => forbidden === normalized,
  );
}

// ─── Event names by entity ────────────────────────────────────────────────────

export const EVENT_NAMES_BY_ENTITY: Record<
  "session" | "generation" | "account" | "context" | "browser" | "warmup",
  readonly RuntimeEventName[]
> = {
  session: [
    "SESSION_CREATED",
    "SESSION_VERSION_ADVANCED",
    "SESSION_BRANCH_CREATED",
  ],
  generation: [
    "GENERATION_CREATED",
    "GENERATION_RESERVED",
    "GENERATION_STARTED",
    "GENERATION_FIRST_TOKEN",
    "GENERATION_TOOL_CALL",
    "GENERATION_TOOL_RESULT",
    "GENERATION_WAITING_FOR_TOOL",
    "GENERATION_FAILOVER",
    "GENERATION_COMPLETED",
    "GENERATION_FAILED",
    "GENERATION_CANCELLED",
    "GENERATION_ABANDONED",
  ],
  account: [
    "ACCOUNT_RESERVED",
    "ACCOUNT_RELEASED",
    "ACCOUNT_STATE_CHANGED",
    "ACCOUNT_RECOVERY_STARTED",
    "ACCOUNT_RECOVERY_COMPLETED",
    "ACCOUNT_COOLDOWN",
  ],
  context: [
    "CONTEXT_SNAPSHOT_CREATED",
    "CONTEXT_COMPACTED",
    "CONTEXT_COMPACTED_FAILED",
    "CONTEXT_VALIDATED",
  ],
  browser: [
    "BROWSER_OPERATION_STARTED",
    "BROWSER_OPERATION_COMPLETED",
    "BROWSER_OPERATION_ABORTED",
    "BROWSER_OPERATION_TIMEOUT",
  ],
  warmup: ["WARMUP_STARTED", "WARMUP_COMPLETED", "WARMUP_FAILED"],
};

// ─── Pure constructor ─────────────────────────────────────────────────────────

/**
 * Build a {@link RuntimeEvent} with a fresh event id. Side-effect free: no
 * logging, no I/O, no metric emission.
 */
export function runtimeEvent(
  name: RuntimeEventName,
  identity: RuntimeEventIdentity,
  attributes?: Record<string, string | number | boolean | null>,
): RuntimeEvent {
  const event: RuntimeEvent = {
    eventId: newEventId(),
    name,
    at: Date.now(),
    ...identity,
  };
  if (attributes) {
    event.attributes = attributes;
  }
  return event;
}
