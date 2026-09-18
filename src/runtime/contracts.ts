import type { AccountLease, AccountStatus } from "../domain/types.ts";
import type { ErrorCode } from "../domain/errors.ts";

export type ReleaseOutcome = "completed" | "failed" | "cancelled";

export type AcquireFailureCode =
  | "DEADLINE_EXPIRED"
  | "NO_CANDIDATES"
  | "ALL_INELIGIBLE"
  | "ALL_BUSY"
  | "ALL_COOLDOWN";

export interface UsageRequirements {
  purpose: "generation" | "warmup" | "maintenance";
  modelId?: string;
  generationId?: string;
}

export interface AcquireRejection {
  accountId: string;
  reason: string;
  errorCode?: ErrorCode;
}

export interface AcquireLeaseRequest {
  generationId: string;
  candidates: readonly string[];
  deadline: number;
  requirements: UsageRequirements;
}

export type AcquireLeaseResult =
  | {
      ok: true;
      lease: AccountLease;
      accountId: string;
      rejections: readonly AcquireRejection[];
    }
  | {
      ok: false;
      failureCode: AcquireFailureCode;
      errorCode: ErrorCode;
      rejections: readonly AcquireRejection[];
    };

export interface ReleaseRequest {
  leaseId: string;
  ownerToken: string;
  outcome: ReleaseOutcome;
  reason?: string;
}

export interface ReleaseResult {
  released: boolean;
  stale: boolean;
}

export interface EligibilityDecision {
  usable: boolean;
  reason?: string;
  errorCode?: ErrorCode;
}

export interface OwnershipFence {
  leaseId: string;
  ownerToken: string;
}

export interface TransitionResult {
  transitioned: boolean;
  from: AccountStatus;
  to: AccountStatus;
  stale: boolean;
  illegal: boolean;
}

export interface OwnershipSnapshot {
  accountId: string;
  status: AccountStatus;
  lease: AccountLease | null;
  fencingEpoch: number;
  cooldownUntil: number | null;
  lastTransitionReason: string | null;
}

export interface PersistedAccountState {
  accountId?: string;
  disabled: boolean;
  cooldownUntil: number;
  cooldownReason: string | null;
}

export interface PoolSnapshot {
  byStatus: Partial<Record<AccountStatus, number>>;
  ready: number;
  warming: number;
  reserved: number;
  generating: number;
  cooldown: number;
  failed: number;
  target: number;
}

export interface StaleFenceOptions {
  requestCancellation: (lease: AccountLease) => Promise<void>;
  graceMs: number;
  deadline: number;
}

export interface StaleFenceResult {
  accountId: string;
  fenced: boolean;
  invalidatedOwnerToken: string | null;
  cleanExit: boolean;
}

export interface IAccountCapabilityResolver {
  canServe(accountId: string, modelId: string): boolean;
}

export interface IAccountOwnership {
  acquire(request: AcquireLeaseRequest): AcquireLeaseResult;
  release(request: ReleaseRequest): ReleaseResult;
  transition(
    accountId: string,
    to: AccountStatus,
    fence: OwnershipFence,
    reason?: string,
  ): TransitionResult;
  markStaleAndFence(
    accountId: string,
    options: StaleFenceOptions,
  ): Promise<StaleFenceResult>;
  isLegallyUsable(
    accountId: string,
    requirements: UsageRequirements,
  ): EligibilityDecision;
  getOwnership(accountId: string): OwnershipSnapshot;
  getAccountStatus(accountId: string): AccountStatus;
  listAccountsByStatus(status: AccountStatus): readonly string[];
  getPoolSnapshot(): PoolSnapshot;
  recoverAccount(accountId: string, reason: string): Promise<void>;
  registerAccount(accountId: string, persisted: PersistedAccountState): void;
  setDraining(accountId: string, draining: boolean): void;
}
