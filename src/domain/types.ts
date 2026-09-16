export type AccountStatus =
  | "DISABLED"
  | "STANDBY"
  | "WARMING"
  | "READY"
  | "RESERVED"
  | "GENERATING"
  | "DRAINING"
  | "RECOVERING"
  | "COOLDOWN"
  | "FAILED";

export type GenerationState =
  | "QUEUED"
  | "RESERVING"
  | "PREPARING"
  | "STARTING"
  | "STREAMING"
  | "WAITING_FOR_TOOL_RESULTS"
  | "SETTLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "ABANDONED";

export type AttemptState =
  | "STARTING"
  | "STREAMING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type WarmupState =
  | "IDLE"
  | "QUEUED"
  | "WARMING"
  | "READY"
  | "FAILED"
  | "BACKOFF";

export type CompactionStrategy =
  | "NONE"
  | "DROP_LOW_SCORE_GROUPS"
  | "SUMMARY_PLUS_RECENT"
  | "HARD_FAILURE";

export interface AccountLease {
  leaseId: string;
  ownerToken: string;
  accountId: string;
  generationId: string;
  /** epoch ms */
  acquiredAt: number;
  /** epoch ms, absolute */
  deadline: number;
}

export interface LeaseOwnershipSnapshot {
  accountId: string;
  /** null == unowned */
  lease: AccountLease | null;
  accountStatus: AccountStatus;
}

export interface LifecycleTransition {
  entityType: "account" | "generation" | "attempt";
  entityId: string;
  from: string;
  to: string;
  /** epoch ms */
  at: number;
  reason?: string;
}

export const TERMINAL_GENERATION_STATES: ReadonlySet<GenerationState> =
  new Set<GenerationState>([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "ABANDONED",
  ]);

const TERMINAL_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set<
  AttemptState
>(["COMPLETED", "FAILED", "CANCELLED"]);

export function isTerminalGenerationState(s: GenerationState): boolean {
  return TERMINAL_GENERATION_STATES.has(s);
}

export function isTerminalAttemptState(s: AttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.has(s);
}
