/**
 * Shared runtime contracts. Exactly ONE authoritative implementation of each
 * authority exists; every consumer programs against these interfaces so a fake
 * can be substituted in tests and a future distributed backend can replace the
 * in-memory one without touching call sites.
 */
import type { AccountLease, AccountStatus } from "../domain/types.ts";
import type { ErrorCode } from "../domain/errors.ts";

/** Why an operation wants an account. Maintenance must never evict a generation. */
export type AcquisitionPurpose = "generation" | "maintenance";

export interface UsageRequirements {
  purpose: AcquisitionPurpose;
  /** When set, capability compatibility is enforced against account model metadata. */
  modelId?: string;
  /**
   * When set, the account is considered eligible even if it currently carries a
   * lease owned by THIS generation (re-entrant settle / retry on the same
   * logical operation). A lease owned by any OTHER generation is always a hard
   * exclusion.
   */
  generationId?: string;
}

export interface EligibilityDecision {
  usable: boolean;
  /** Human-readable reason for observability; never credentials. */
  reason?: string;
  errorCode?: ErrorCode;
}

/**
 * The authoritative ownership record. Answers WHO owns the account, WHY, since
 * when, and until what deadline — never a bare boolean flag (J.5).
 */
export interface OwnershipSnapshot {
  accountId: string;
  status: AccountStatus;
  lease: AccountLease | null;
  /** Monotonic per-account counter; incremented on every ownership change. */
  fencingEpoch: number;
  /** epoch ms, or null when not cooling down */
  cooldownUntil: number | null;
  /** last status transition reason */
  lastTransitionReason: string | null;
}

export interface PoolSnapshot {
  byStatus: Partial<Record<AccountStatus, number>>;
  ready: number;
  warming: number;
  reserved: number;
  generating: number;
  cooldown: number;
  failed: number;
  /** configured readiness target */
  target: number;
}

/** Pre-ranked candidate list; the manager claims the first LEGALLY USABLE one. */
export interface AcquireLeaseRequest {
  generationId: string;
  candidates: readonly string[];
  /** Absolute root generation deadline; the lease expires no later than this. */
  deadline: number;
  requirements: UsageRequirements;
}

export type AcquireFailureCode =
  | "NO_CANDIDATES"
  | "ALL_INELIGIBLE"
  | "ALL_BUSY"
  | "ALL_COOLDOWN"
  | "DEADLINE_EXPIRED";

export interface AcquireLeaseSuccess {
  ok: true;
  lease: AccountLease;
  accountId: string;
  /** Per-candidate rejection record so the scheduler/traces can explain the pick. */
  rejections: ReadonlyArray<{ accountId: string; reason: string; errorCode?: ErrorCode }>;
}

export interface AcquireLeaseFailure {
  ok: false;
  failureCode: AcquireFailureCode;
  errorCode: ErrorCode;
  rejections: ReadonlyArray<{ accountId: string; reason: string; errorCode?: ErrorCode }>;
}

export type AcquireLeaseResult = AcquireLeaseSuccess | AcquireLeaseFailure;

/** Proof that the caller is the CURRENT fenced owner. */
export interface OwnershipFence {
  leaseId: string;
  ownerToken: string;
}

export type ReleaseOutcome = "completed" | "failed" | "cancelled" | "abandoned";

export interface ReleaseRequest extends OwnershipFence {
  outcome: ReleaseOutcome;
  reason?: string;
}

export interface ReleaseResult {
  released: boolean;
  /** true when the token no longer matched the current owner (late/stale callback). */
  stale: boolean;
}

export interface TransitionResult {
  transitioned: boolean;
  from: AccountStatus;
  to: AccountStatus;
  /** false when the fence was stale or the transition is illegal in the state machine */
  stale: boolean;
  illegal: boolean;
}

export interface StaleFenceOptions {
  /** Bounded grace period given to the old owner's cleanup before fencing. */
  graceMs: number;
  /**
   * Requests cancellation of the orphaned operation. Must tolerate duplicate
   * calls from racing callbacks.
   */
  requestCancellation: (lease: AccountLease) => Promise<void>;
  /** Absolute deadline for the whole fence operation. */
  deadline: number;
}

export interface StaleFenceResult {
  accountId: string;
  fenced: boolean;
  /** The token that was invalidated; any later release carrying it is rejected. */
  invalidatedOwnerToken: string | null;
  /** true when the operation completed cleanly inside the grace window */
  cleanExit: boolean;
}

/**
 * SOLE authority for account acquisition, lease ownership, release, state
 * transitions and recovery coordination. Other components may query or REQUEST
 * transitions but must not invent competing account ownership models.
 */
export interface IAccountOwnership {
  /**
   * Atomic claim. This method contains NO await between the eligibility check
   * and the ownership mutation, so two concurrent requests can never both win
   * the same account (single-threaded JS event loop guarantees the critical
   * section is uninterruptible).
   */
  acquire(request: AcquireLeaseRequest): AcquireLeaseResult;

  /**
   * Idempotent, fenced release. A release whose ownerToken is not the current
   * owner's token is rejected as stale rather than mutating the current owner.
   */
  release(request: ReleaseRequest): ReleaseResult;

  /**
   * Fenced status transition. Requires proof of current ownership (maintenance
   * transitions on an unowned account use the zero lease with a system token).
   */
  transition(
    accountId: string,
    to: AccountStatus,
    fence: OwnershipFence,
    reason?: string,
  ): TransitionResult;

  /**
   * Stale-lease protocol: do NOT simply declare the account free while the old
   * operation may still be alive. Request cancellation, allow a bounded grace
   * period, then mark the ownership abandoned and fence the old token so a late
   * cleanup cannot affect a future owner.
   */
  markStaleAndFence(accountId: string, options: StaleFenceOptions): Promise<StaleFenceResult>;

  /** Hard-filter legality first (state, ownership, cooldown, drain, capability);
   *  health/priority are tie-breakers and NEVER make a busy account usable (J.1). */
  isLegallyUsable(accountId: string, requirements: UsageRequirements): EligibilityDecision;

  getOwnership(accountId: string): OwnershipSnapshot;
  getAccountStatus(accountId: string): AccountStatus;
  listAccountsByStatus(status: AccountStatus): readonly string[];
  getPoolSnapshot(): PoolSnapshot;

  /** Register an account's presence and durable persisted state on boot. */
  registerAccount(accountId: string, persisted: PersistedAccountState): void;

  /** Operator control plane: no new generations admitted; existing work completes. */
  setDraining(accountId: string, draining: boolean): void;

  /** Recovery coordination entry point (browser/auth failure -> RECOVERING). */
  recoverAccount(accountId: string, reason: string): Promise<void>;
}

export interface PersistedAccountState {
  accountId: string;
  disabled: boolean;
  /** epoch ms; 0 when none */
  cooldownUntil: number;
  cooldownReason: string | null;
}

/**
 * Capability resolver — injected so the generic runtime never hard-codes
 * provider specifics. Decides whether an account can serve a model/mode.
 */
export interface IAccountCapabilityResolver {
  canServe(accountId: string, modelId: string): boolean;
}
