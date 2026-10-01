import type { AccountLease } from "../../domain/types.ts";
import type { PersistedAccountState } from "../contracts.ts";
import { bindGateway } from "../gateway.ts";
import { AccountResourceManager } from "./resource-manager.ts";

let manager: AccountResourceManager | null = null;

export function initAccountOwnership(
  accounts: readonly PersistedAccountState[],
): AccountResourceManager {
  const next = new AccountResourceManager();
  for (const account of accounts) {
    if (account.accountId) {
      next.registerAccount(account.accountId, account);
    }
  }
  setAccountOwnership(next);
  return next;
}

/**
 * Bind an externally constructed manager (production `constructRuntime`
 * builds its own with pool options, then hands it over here). Binds the
 * gateway atomically with the instance so the two can never disagree about
 * which authority is active.
 */
export function setAccountOwnership(next: AccountResourceManager): void {
  manager = next;
  bindGateway(next);
}

export function getAccountOwnership(): AccountResourceManager {
  if (!manager) {
    throw new Error("Account ownership has not been initialized");
  }
  return manager;
}

/**
 * True once an AccountResourceManager is bound (production server startup via
 * constructRuntime → setAccountOwnership, or tests that bind explicitly).
 * Readiness queries use the ownership state machine when bound and fall back
 * to the legacy in-memory set otherwise (hermetic mock tests never bind).
 */
export function isAccountOwnershipBound(): boolean {
  return manager !== null;
}

export function resetAccountOwnershipForTests(): void {
  manager = null;
  bindGateway(null);
}

export function toLegacyAccountLease(lease: AccountLease): {
  leaseId: string;
  accountId: string;
  release: () => void;
} {
  const ownerToken = lease.ownerToken;
  let released = false;
  return {
    leaseId: lease.leaseId,
    accountId: lease.accountId,
    release: () => {
      if (released) return;
      released = true;
      manager?.release({
        leaseId: lease.leaseId,
        ownerToken,
        outcome: "completed",
      });
    },
  };
}
