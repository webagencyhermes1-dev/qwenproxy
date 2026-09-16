/**
 * Request-path gateway into the account ownership authority.
 *
 * acquireGenerationAccount() is where the atomic select+claim happens: it
 * builds the ranked candidate list from existing truth via the pure
 * rankSchedulerCandidates/pickSchedulerCandidate helpers, then calls
 * getAccountOwnership().acquire() — which contains NO await between the
 * eligibility check and the ownership mutation — so two concurrent requests
 * can never both win the same account.
 *
 * WARMING SEAM: accounts register as STANDBY and a generation claim requires
 * a READY account. The warming service (core/readiness-guard.ts owner) must
 * transition accounts to READY before this path can serve traffic. The flag
 * is OFF by default, so the legacy path stays authoritative until then.
 */
import type { AccountLease } from "../domain/types.ts";
import type { ErrorCode } from "../domain/errors.ts";
import type { AcquireFailureCode } from "./contracts.ts";
import {
  getAccountOwnership,
  initAccountOwnership,
} from "./account/instance.ts";
import {
  buildSchedulerCandidates,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";
import { loadAccounts } from "../core/accounts.ts";
import {
  pickSchedulerCandidate,
  rankSchedulerCandidates,
} from "../core/account-scheduler.ts";

export interface AcquireGenerationAccountInput {
  generationId: string;
  /**
   * Best-first account ids to consider. When omitted the gateway builds and
   * ranks the full configured pool itself.
   */
  candidates?: readonly string[];
  /** Pin (sticky thread owner or explicit preferred account). */
  preferredAccountId?: string;
  /** Accounts already tried for this request; excluded when ranking the pool. */
  triedAccountIds?: ReadonlySet<string>;
  /** Absolute generation deadline; the lease expires no later than this. */
  deadline: number;
  /** Optional capability filter applied by the ownership authority. */
  modelId?: string;
}

export interface AcquireGenerationAccountSuccess {
  ok: true;
  lease: AccountLease;
  accountId: string;
  rejections: ReadonlyArray<{ accountId: string; reason: string; errorCode?: ErrorCode }>;
}

export interface AcquireGenerationAccountFailure {
  ok: false;
  failureCode: AcquireFailureCode;
  errorCode: ErrorCode;
  rejections: ReadonlyArray<{ accountId: string; reason: string; errorCode?: ErrorCode }>;
}

export type AcquireGenerationAccountResult =
  | AcquireGenerationAccountSuccess
  | AcquireGenerationAccountFailure;

let poolBootstrapped = false;
let gatewayCursor = 0;

/**
 * Atomic select+claim for the request path. Synchronous end-to-end: the
 * ranking, the eligibility check and the ownership claim all run without an
 * await, so the claim is uninterruptible on the single-threaded event loop.
 */
export function acquireGenerationAccount(
  input: AcquireGenerationAccountInput,
): AcquireGenerationAccountResult {
  ensureOwnershipInitialized();

  const ordered = input.candidates && input.candidates.length > 0
    ? [...input.candidates]
    : rankPoolCandidateIds({
        preferredAccountId: input.preferredAccountId,
        triedAccountIds: input.triedAccountIds,
      });

  const result = getAccountOwnership().acquire({
    generationId: input.generationId,
    candidates: ordered,
    deadline: input.deadline,
    requirements: {
      purpose: "generation",
      generationId: input.generationId,
      modelId: input.modelId,
    },
  });

  if (result.ok) {
    return {
      ok: true,
      lease: result.lease,
      accountId: result.accountId,
      rejections: result.rejections,
    };
  }
  return {
    ok: false,
    failureCode: result.failureCode,
    errorCode: typedErrorCode(result.failureCode),
    rejections: result.rejections,
  };
}

/** Map the authority's failure codes onto typed codes the retry path classifies. */
function typedErrorCode(code: AcquireFailureCode): ErrorCode {
  switch (code) {
    case "ALL_BUSY":
      return "SESSION_BUSY";
    case "ALL_COOLDOWN":
      return "ACCOUNT_COOLDOWN";
    case "DEADLINE_EXPIRED":
      return "QUEUE_TIMEOUT";
    case "NO_CANDIDATES":
    case "ALL_INELIGIBLE":
    default:
      return "ACCOUNT_UNAVAILABLE";
  }
}

/**
 * Rank the configured pool: eligibility first, then preference/load/health,
 * with a rotating cursor among fully-tied leaders so consecutive picks cycle.
 */
function rankPoolCandidateIds(options: {
  preferredAccountId?: string;
  triedAccountIds?: ReadonlySet<string>;
}): string[] {
  const candidates = buildSchedulerCandidates(loadAccounts());
  const ranked = rankSchedulerCandidates(candidates, {
    triedAccountIds: options.triedAccountIds
      ? new Set(options.triedAccountIds)
      : undefined,
    preferredAccountId: options.preferredAccountId,
    allowSaturatedFallback: true,
  });
  if (ranked.length === 0) return [];

  const picked = pickSchedulerCandidate(
    ranked,
    gatewayCursor,
    candidates.length,
    options.preferredAccountId,
  );
  if (picked) {
    gatewayCursor = (picked.priorityIndex + 1) % Math.max(1, candidates.length);
    const rest = ranked.filter((candidate) => candidate !== picked);
    return [picked.account.id, ...rest.map((candidate) => candidate.account.id)];
  }
  return ranked.map((candidate) => candidate.account.id);
}

/**
 * Register the durable pool into the authority exactly once. When the pool is
 * already populated (explicit init by tests or by the boot wiring of a later
 * phase) this is a no-op, so hermetic callers never touch the account store.
 */
function ensureOwnershipInitialized(): void {
  if (poolBootstrapped) return;
  poolBootstrapped = true;

  const snapshot = getAccountOwnership().getPoolSnapshot();
  const registered = Object.values(snapshot.byStatus).reduce<number>(
    (total, count) => total + (count ?? 0),
    0,
  );
  if (registered > 0) return;

  initAccountOwnership(
    buildSchedulerCandidates(loadAccounts()).map((candidate) => {
      const cooldown = getAccountCooldownInfo(candidate.account.id);
      return {
        accountId: candidate.account.id,
        disabled: candidate.disabled,
        cooldownUntil: cooldown ? Date.now() + cooldown.remainingMs : 0,
        cooldownReason: cooldown ? cooldown.reason : null,
      };
    }),
  );
}

/** Tests only: reset the bootstrap/cursor state. */
export function resetGatewayForTests(): void {
  poolBootstrapped = false;
  gatewayCursor = 0;
}
