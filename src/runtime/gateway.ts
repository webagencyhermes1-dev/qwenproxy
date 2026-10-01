import type { ErrorCode } from "../domain/errors.ts";
import type { AccountLease } from "../domain/types.ts";
import type { AcquireFailureCode, IAccountOwnership } from "./contracts.ts";

export interface AcquireGenerationAccountRequest {
  generationId: string;
  candidates?: readonly string[];
  preferredAccountId?: string;
  triedAccountIds?: ReadonlySet<string>;
  deadline: number;
  modelId?: string;
}

export type GatewayFailureCode = AcquireFailureCode | "not_authorized";

export type AcquireGenerationAccountResult =
  | {
      ok: true;
      accountId: string;
      lease: AccountLease;
      errorCode: null;
      failureCode: null;
    }
  | {
      ok: false;
      accountId: string;
      lease: AccountLease;
      errorCode: ErrorCode;
      failureCode: GatewayFailureCode;
    };

const EMPTY_LEASE: AccountLease = {
  leaseId: "",
  ownerToken: "",
  accountId: "",
  generationId: "",
  acquiredAt: 0,
  deadline: 0,
};

let ownership: IAccountOwnership | null = null;

export function bindGateway(next: IAccountOwnership | null): void {
  ownership = next;
}

export function resetGatewayForTests(): void {
  ownership = null;
}

function failure(
  errorCode: ErrorCode,
  failureCode: GatewayFailureCode,
): AcquireGenerationAccountResult {
  return {
    ok: false,
    accountId: "",
    lease: EMPTY_LEASE,
    errorCode,
    failureCode,
  };
}

function buildCandidates(
  authority: IAccountOwnership,
  preferredAccountId: string | undefined,
  triedAccountIds: ReadonlySet<string> | undefined,
): string[] {
  const excluded = triedAccountIds ?? new Set<string>();
  const candidates = authority
    .listAccountsByStatus("READY")
    .filter((accountId) => !excluded.has(accountId));
  if (preferredAccountId === undefined || excluded.has(preferredAccountId)) {
    return candidates;
  }
  const preferredIndex = candidates.indexOf(preferredAccountId);
  if (preferredIndex === 0) return candidates;
  if (preferredIndex > 0) candidates.splice(preferredIndex, 1);
  candidates.unshift(preferredAccountId);
  return candidates;
}

/**
 * Stateless READY-only candidate peek (preferred-first, tried excluded).
 * Read-only: the atomic claim still happens in `acquireGenerationAccount`,
 * which re-validates, so the peek→claim window cannot claim a non-READY
 * account. Used for rotation resolution and advisories; never for claiming.
 */
export function peekReadyAccountIds(
  triedAccountIds?: ReadonlySet<string>,
  preferredAccountId?: string,
): string[] {
  if (ownership === null) return [];
  return buildCandidates(ownership, preferredAccountId, triedAccountIds);
}

export function acquireGenerationAccount(
  request: AcquireGenerationAccountRequest,
): AcquireGenerationAccountResult {
  const authority = ownership;
  if (authority === null) {
    return failure("ACCOUNT_UNAVAILABLE", "not_authorized");
  }
  const rawCandidates =
    request.candidates ??
    buildCandidates(
      authority,
      request.preferredAccountId,
      request.triedAccountIds,
    );
  // NORMAL REQUESTS MAY ONLY EXECUTE ON HOT ACCOUNTS. Explicit candidate lists
  // must also be intersected with the READY set: an explicit/sticky candidate
  // that is WARM/COLD is dropped at the selection boundary instead of being
  // claimed and discovered as not-warmed after the lease was acquired.
  const ready = new Set(authority.listAccountsByStatus("READY"));
  const candidates = rawCandidates.filter((id) => ready.has(id));
  if (candidates.length === 0) {
    return failure("ACCOUNT_UNAVAILABLE", "NO_CANDIDATES");
  }
  const result = authority.acquire({
    generationId: request.generationId,
    candidates,
    deadline: request.deadline,
    requirements: {
      purpose: "generation",
      modelId: request.modelId,
      generationId: request.generationId,
    },
  });
  if (result.ok) {
    return {
      ok: true,
      accountId: result.accountId,
      lease: result.lease,
      errorCode: null,
      failureCode: null,
    };
  }
  return failure(result.errorCode, result.failureCode);
}
