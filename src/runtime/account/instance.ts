import type { AccountLease } from "../../domain/types.ts";
import type { PersistedAccountState } from "../contracts.ts";
import { bindGateway } from "../gateway.ts";
import { AccountResourceManager } from "./resource-manager.ts";

let manager: AccountResourceManager | null = null;

export function isLeaseAuthorityEnabled(): boolean {
  return process.env["QWEN_RUNTIME_LEASE_AUTHORITY"] === "true";
}

export function initAccountOwnership(
  accounts: readonly PersistedAccountState[],
): AccountResourceManager {
  const next = new AccountResourceManager();
  for (const account of accounts) {
    if (account.accountId) {
      next.registerAccount(account.accountId, account);
    }
  }
  manager = next;
  bindGateway(next);
  return next;
}

export function getAccountOwnership(): AccountResourceManager {
  if (!manager) {
    throw new Error("Account ownership has not been initialized");
  }
  return manager;
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
