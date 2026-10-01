import type {
  AccountLease,
  AccountStatus,
} from "../../domain/types.ts";
import { newLeaseId, newOwnerToken } from "../../domain/ids.ts";
import type { ErrorCode } from "../../domain/errors.ts";
import type {
  AcquireFailureCode,
  AcquireLeaseRequest,
  AcquireLeaseResult,
  EligibilityDecision,
  IAccountCapabilityResolver,
  IAccountOwnership,
  OwnershipFence,
  OwnershipSnapshot,
  PersistedAccountState,
  PoolSnapshot,
  ReleaseRequest,
  ReleaseResult,
  StaleFenceOptions,
  StaleFenceResult,
  TransitionResult,
  UsageRequirements,
} from "../contracts.ts";
import {
  assertAccountTransition,
  canTransitionAccount,
} from "./status-machine.ts";

interface InternalAccountRecord {
  accountId: string;
  status: AccountStatus;
  lease: AccountLease | null;
  fencingEpoch: number;
  cooldownUntil: number;
  cooldownReason: string | null;
  lastTransitionReason: string | null;
  draining: boolean;
}

const SYSTEM_FENCE: OwnershipFence = {
  leaseId: "system",
  ownerToken: "system",
};

function now(): number {
  return Date.now();
}

export interface AccountTransitionEvent {
  accountId: string;
  from: AccountStatus;
  to: AccountStatus;
  reason: string;
  at: number;
}

const transitionListeners = new Set<
  (e: AccountTransitionEvent) => void
>();

/**
 * OPTIONAL module-level transition listener hook (Phase 3.1 observability).
 * Returns an unsubscribe function. Listener errors are swallowed so they
 * never break transitions.
 */
export function onTransition(
  listener: (e: AccountTransitionEvent) => void,
): () => void {
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}

/**
 * SOLE authority for account acquisition, lease ownership, release, state
 * transitions and recovery coordination. Other components may query or REQUEST
 * transitions but must not invent competing account ownership models.
 *
 * Invariant 1 (atomic acquire): `acquire()` contains NO await between the
 * eligibility check and the ownership mutation, so two concurrent requests can
 * never both claim the same account.
 *
 * Invariant 2 (one fenced owner): at most one valid lease exists per account at
 * any time; every ownership change bumps a monotonic fencingEpoch so a stale
 * owner's late release is rejected rather than mutating the current owner.
 */
export class AccountResourceManager implements IAccountOwnership {
  private readonly accounts = new Map<string, InternalAccountRecord>();
  private readonly capabilityResolver: IAccountCapabilityResolver | null;
  private readonly targetReady: number;

  constructor(options?: {
    capabilityResolver?: IAccountCapabilityResolver;
    targetReady?: number;
  }) {
    this.capabilityResolver = options?.capabilityResolver ?? null;
    this.targetReady = options?.targetReady ?? 2;
  }

  registerAccount(accountId: string, persisted: PersistedAccountState): void {
    const existing = this.accounts.get(accountId);
    const status: AccountStatus = persisted.disabled
      ? "DISABLED"
      : persisted.cooldownUntil > 0 && persisted.cooldownUntil > now()
        ? "COOLDOWN"
        : existing?.status ?? "STANDBY";
    const record: InternalAccountRecord = {
      accountId,
      status,
      lease: null,
      fencingEpoch: existing?.fencingEpoch ?? 0,
      cooldownUntil: persisted.cooldownUntil,
      cooldownReason: persisted.cooldownReason,
      lastTransitionReason: existing?.lastTransitionReason ?? "registered",
      draining: false,
    };
    this.accounts.set(accountId, record);
  }

  setDraining(accountId: string, draining: boolean): void {
    const record = this.accounts.get(accountId);
    if (!record) return;
    record.draining = draining;
    if (draining && record.status === "READY") {
      this.applyTransition(record, "DRAINING", "operator-drain");
    }
  }

  acquire(request: AcquireLeaseRequest): AcquireLeaseResult {
    const rejections: Array<{
      accountId: string;
      reason: string;
      errorCode?: ErrorCode;
    }> = [];

    if (request.deadline <= now()) {
      return {
        ok: false,
        failureCode: "DEADLINE_EXPIRED",
        errorCode: "QUEUE_TIMEOUT",
        rejections,
      };
    }

    for (const accountId of request.candidates) {
      const decision = this.isLegallyUsable(
        accountId,
        request.requirements,
      );
      if (!decision.usable) {
        rejections.push({
          accountId,
          reason: decision.reason ?? "ineligible",
          errorCode: decision.errorCode,
        });
        continue;
      }
      // CRITICAL SECTION: no await between the eligibility decision above and
      // the ownership claim below. Single-threaded JS makes this uninterruptible.
      const record = this.accounts.get(accountId)!;
      const lease: AccountLease = {
        leaseId: newLeaseId(),
        ownerToken: newOwnerToken(),
        accountId,
        generationId: request.requirements.generationId ?? "",
        acquiredAt: now(),
        deadline: Math.max(request.deadline, 0),
      };
      record.lease = lease;
      record.fencingEpoch += 1;
      this.applyTransition(record, "RESERVED", "acquire");
      return {
        ok: true,
        lease,
        accountId,
        rejections,
      };
    }

    const failureCode: AcquireFailureCode = rejections.length
      ? this.dominantFailure(rejections)
      : "NO_CANDIDATES";
    return {
      ok: false,
      failureCode,
      errorCode: this.failureErrorCode(failureCode),
      rejections,
    };
  }

  release(request: ReleaseRequest): ReleaseResult {
    const record = this.accounts.get(this.accountIdForLease(request));
    if (!record) {
      return { released: false, stale: true };
    }
    const current = record.lease;
    if (!current || current.ownerToken !== request.ownerToken) {
      // Stale or fenced token: the current owner must not be disturbed.
      return { released: false, stale: true };
    }
    if (current.leaseId !== request.leaseId) {
      return { released: false, stale: true };
    }
    record.lease = null;
    record.fencingEpoch += 1;
    if (record.status === "RESERVED" || record.status === "GENERATING") {
      const to: AccountStatus = record.draining ? "DRAINING" : "READY";
      this.applyTransition(
        record,
        to,
        `release:${request.outcome}${request.reason ? `:${request.reason}` : ""}`,
      );
      // A cooldown that landed mid-generation re-holds the account now that
      // it is lease-free, instead of leaking a cooled account as READY.
      if (
        to === "READY" &&
        record.cooldownUntil > now() &&
        canTransitionAccount("READY", "COOLDOWN")
      ) {
        this.applyTransition(
          record,
          "COOLDOWN",
          `cooldown:${record.cooldownReason ?? "rate-limit"}`,
        );
      }
    }
    return { released: true, stale: false };
  }

  transition(
    accountId: string,
    to: AccountStatus,
    fence: OwnershipFence,
    reason?: string,
  ): TransitionResult {
    const record = this.accounts.get(accountId);
    if (!record) {
      return {
        transitioned: false,
        from: "STANDBY",
        to,
        stale: true,
        illegal: false,
      };
    }
    const from = record.status;
    const isSystem = fence.leaseId === SYSTEM_FENCE.leaseId;
    if (!isSystem) {
      const current = record.lease;
      if (
        !current ||
        current.ownerToken !== fence.ownerToken ||
        current.leaseId !== fence.leaseId
      ) {
        return { transitioned: false, from, to, stale: true, illegal: false };
      }
    } else if (record.lease !== null) {
      // A live generation owns this account; system transitions are rejected.
      return { transitioned: false, from, to, stale: true, illegal: false };
    }
    if (!canTransitionAccount(from, to)) {
      return { transitioned: false, from, to, stale: false, illegal: true };
    }
    this.applyTransition(record, to, reason ?? "transition");
    return { transitioned: true, from, to, stale: false, illegal: false };
  }

  async markStaleAndFence(
    accountId: string,
    options: StaleFenceOptions,
  ): Promise<StaleFenceResult> {
    const record = this.accounts.get(accountId);
    if (!record) {
      return { accountId, fenced: false, invalidatedOwnerToken: null, cleanExit: false };
    }
    const lease = record.lease;
    if (!lease) {
      return { accountId, fenced: false, invalidatedOwnerToken: null, cleanExit: true };
    }
    // Do NOT simply declare the account free while the old operation may still
    // be alive. Request cancellation first and give cleanup a bounded grace.
    try {
      await options.requestCancellation(lease);
    } catch {
      // Cancellation failure is not permission to keep the lease.
    }
    const graceDeadline = Math.min(
      now() + options.graceMs,
      options.deadline > 0 ? options.deadline : Number.POSITIVE_INFINITY,
    );
    await this.waitForGrace(graceDeadline);

    const stillOwned = record.lease?.leaseId === lease.leaseId;
    if (!stillOwned) {
      return {
        accountId,
        fenced: false,
        invalidatedOwnerToken: null,
        cleanExit: true,
      };
    }
    // The old owner did not finish: mark abandoned and fence the old token so a
    // late cleanup cannot affect a future owner.
    record.lease = null;
    record.fencingEpoch += 1;
    if (canTransitionAccount(record.status, "RECOVERING")) {
      this.applyTransition(record, "RECOVERING", "stale-fence:abandoned");
    }
    return {
      accountId,
      fenced: true,
      invalidatedOwnerToken: lease.ownerToken,
      cleanExit: false,
    };
  }

  isLegallyUsable(
    accountId: string,
    requirements: UsageRequirements,
  ): EligibilityDecision {
    const record = this.accounts.get(accountId);
    if (!record) {
      return {
        usable: false,
        reason: "unknown-account",
        errorCode: "ACCOUNT_UNAVAILABLE",
      };
    }
    if (record.status === "DISABLED" || record.draining) {
      return {
        usable: false,
        reason: "disabled-or-draining",
        errorCode: "ACCOUNT_UNAVAILABLE",
      };
    }
    if (record.status === "FAILED") {
      return {
        usable: false,
        reason: "failed",
        errorCode: "ACCOUNT_UNAVAILABLE",
      };
    }
    if (this.checkCooldown(record)) {
      return {
        usable: false,
        reason: `cooldown:${record.cooldownReason ?? "rate-limit"}`,
        errorCode: "ACCOUNT_COOLDOWN",
      };
    }
    if (record.status === "WARMING" && requirements.purpose === "generation") {
      return {
        usable: false,
        reason: "warming",
        errorCode: "ACCOUNT_INITIALIZATION_FAILED",
      };
    }
    if (record.status === "RECOVERING" && requirements.purpose === "generation") {
      return {
        usable: false,
        reason: "recovering",
        errorCode: "ACCOUNT_INITIALIZATION_FAILED",
      };
    }
    // A STANDBY account is uninitialized: only a maintenance/warmup purpose may
    // claim it. Generation requests require a READY account.
    if (record.status === "STANDBY" && requirements.purpose === "generation") {
      return {
        usable: false,
        reason: "standby:not-warmed",
        errorCode: "ACCOUNT_INITIALIZATION_FAILED",
      };
    }
    // Ownership check: a lease owned by THIS generation is re-entrant; any other
    // lease is a hard exclusion. Health/priority are NEVER legality inputs (J.1).
    if (record.lease) {
      const sameGeneration =
        requirements.generationId !== undefined &&
        record.lease.generationId === requirements.generationId;
      if (!sameGeneration) {
        return {
          usable: false,
          reason: `busy:owned-by:${record.lease.generationId || "other"}`,
          errorCode: "ACCOUNT_UNAVAILABLE",
        };
      }
    }
    if (
      requirements.modelId &&
      this.capabilityResolver &&
      !this.capabilityResolver.canServe(accountId, requirements.modelId)
    ) {
      return {
        usable: false,
        reason: `model-incompatible:${requirements.modelId}`,
        errorCode: "ACCOUNT_UNAVAILABLE",
      };
    }
    return { usable: true };
  }

  getOwnership(accountId: string): OwnershipSnapshot {
    const record = this.accounts.get(accountId);
    if (!record) {
      return {
        accountId,
        status: "STANDBY",
        lease: null,
        fencingEpoch: 0,
        cooldownUntil: null,
        lastTransitionReason: null,
      };
    }
    return {
      accountId,
      status: record.status,
      lease: record.lease,
      fencingEpoch: record.fencingEpoch,
      cooldownUntil: record.cooldownUntil > 0 ? record.cooldownUntil : null,
      lastTransitionReason: record.lastTransitionReason,
    };
  }

  getAccountStatus(accountId: string): AccountStatus {
    return this.accounts.get(accountId)?.status ?? "STANDBY";
  }

  listAccountsByStatus(status: AccountStatus): readonly string[] {
    const out: string[] = [];
    for (const record of this.accounts.values()) {
      if (record.status === status) out.push(record.accountId);
    }
    return out;
  }

  getPoolSnapshot(): PoolSnapshot {
    const byStatus: Partial<Record<AccountStatus, number>> = {};
    for (const record of this.accounts.values()) {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    }
    return {
      byStatus,
      ready: byStatus.READY ?? 0,
      warming: byStatus.WARMING ?? 0,
      reserved: byStatus.RESERVED ?? 0,
      generating: byStatus.GENERATING ?? 0,
      cooldown: byStatus.COOLDOWN ?? 0,
      failed: byStatus.FAILED ?? 0,
      target: this.targetReady,
    };
  }

  async recoverAccount(accountId: string, reason: string): Promise<void> {
    const record = this.accounts.get(accountId);
    if (!record) return;
    if (canTransitionAccount(record.status, "RECOVERING")) {
      this.applyTransition(record, "RECOVERING", `recovery:${reason}`);
    }
  }

  setCooldownUntil(accountId: string, untilMs: number, reason: string | null): void {
    const record = this.accounts.get(accountId);
    if (!record) return;
    if (untilMs > now()) {
      record.cooldownUntil = untilMs;
      record.cooldownReason = reason;
      // A live generation keeps serving; the release path re-holds the
      // account once it returns to READY (see release()).
      if (record.lease === null && canTransitionAccount(record.status, "COOLDOWN")) {
        this.applyTransition(record, "COOLDOWN", `cooldown:${reason ?? "rate-limit"}`);
      }
    } else {
      record.cooldownUntil = 0;
      record.cooldownReason = null;
      if (record.status === "COOLDOWN") {
        this.applyTransition(record, "STANDBY", "cooldown-cleared");
      }
    }
  }

  isCoolingDown(accountId: string): boolean {
    const record = this.accounts.get(accountId);
    if (!record) return false;
    return this.checkCooldown(record);
  }

  reapExpiredCooldowns(nowMs: number = now()): number {
    let reaped = 0;
    for (const record of this.accounts.values()) {
      if (
        record.status === "COOLDOWN" &&
        record.cooldownUntil > 0 &&
        record.cooldownUntil <= nowMs
      ) {
        record.cooldownUntil = 0;
        record.cooldownReason = null;
        this.applyTransition(record, "STANDBY", "cooldown-expired");
        reaped += 1;
      }
    }
    return reaped;
  }

  private checkCooldown(record: InternalAccountRecord): boolean {
    if (record.cooldownUntil <= 0) return false;
    if (record.cooldownUntil > now()) return true;
    // Expired cooldown auto-clears to STANDBY.
    if (canTransitionAccount(record.status, "STANDBY")) {
      this.applyTransition(record, "STANDBY", "cooldown-expired");
    }
    record.cooldownUntil = 0;
    record.cooldownReason = null;
    return false;
  }

  private applyTransition(
    record: InternalAccountRecord,
    to: AccountStatus,
    reason: string,
  ): void {
    const from = record.status;
    assertAccountTransition(from, to);
    record.status = to;
    record.lastTransitionReason = reason;
    if (transitionListeners.size > 0) {
      const event: AccountTransitionEvent = {
        accountId: record.accountId,
        from,
        to,
        reason,
        at: Date.now(),
      };
      for (const listener of [...transitionListeners]) {
        try {
          listener(event);
        } catch {
          // Never break transitions.
        }
      }
    }
  }

  private accountIdForLease(fence: OwnershipFence): string {
    // Release requests carry only lease/token identity; resolve the owning
    // account by scanning the pool (bounded and rarely contended).
    for (const record of this.accounts.values()) {
      if (record.lease?.leaseId === fence.leaseId) return record.accountId;
    }
    return "";
  }

  private dominantFailure(
    rejections: ReadonlyArray<{ errorCode?: ErrorCode }>,
  ): AcquireFailureCode {
    const codes = new Set(rejections.map((r) => r.errorCode));
    if (codes.has("ACCOUNT_COOLDOWN")) return "ALL_COOLDOWN";
    return "ALL_INELIGIBLE";
  }

  private failureErrorCode(code: AcquireFailureCode): ErrorCode {
    switch (code) {
      case "ALL_COOLDOWN":
        return "ACCOUNT_COOLDOWN";
      case "DEADLINE_EXPIRED":
        return "QUEUE_TIMEOUT";
      case "NO_CANDIDATES":
      case "ALL_INELIGIBLE":
      case "ALL_BUSY":
      default:
        return "ACCOUNT_UNAVAILABLE";
    }
  }

  private async waitForGrace(graceDeadline: number): Promise<void> {
    const remaining = graceDeadline - now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), Math.min(remaining, 1_000));
      timer.unref?.();
    });
  }
}
