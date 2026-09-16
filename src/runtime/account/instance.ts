/**
 * Process singleton for the account ownership authority.
 *
 * FEATURE FLAG — QWEN_RUNTIME_LEASE_AUTHORITY (env var, default OFF):
 *   "true"  → lease acquire/release is delegated to the single
 *             AccountResourceManager: runtime/gateway.ts performs the atomic
 *             select+claim for the request path and core/account-concurrency.ts
 *             becomes a thin pass-through that still returns the legacy
 *             AccountLease shape, so no caller changes.
 *   unset   → the legacy slot-based authority in core/account-concurrency.ts
 *             remains the sole authority and behavior is byte-for-byte
 *             unchanged.
 *
 * The knob is read from process.env here (not added to core/config.ts, which
 * this phase does not own) using the repo's existing string-flag convention
 * (see CONTEXT_COMPRESSION_ENABLED in core/config.ts).
 */
import type { AccountLease } from "../../domain/types.ts";
import type { PersistedAccountState } from "../contracts.ts";
import { AccountResourceManager } from "./resource-manager.ts";

let instance: AccountResourceManager | null = null;

/** True only when the runtime lease authority is explicitly enabled. */
export function isLeaseAuthorityEnabled(): boolean {
  return process.env.QWEN_RUNTIME_LEASE_AUTHORITY === "true";
}

/** Lazy, memoized accessor for the process-wide ownership authority. */
export function getAccountOwnership(): AccountResourceManager {
  if (instance === null) {
    instance = new AccountResourceManager();
  }
  return instance;
}

/**
 * Register each account's presence and durable persisted state on boot.
 * Translates persisted state into the authority's own records; warming
 * (STANDBY -> WARMING -> READY) is handled elsewhere.
 */
export function initAccountOwnership(
  accounts: Iterable<{
    accountId: string;
    disabled: boolean;
    cooldownUntil: number;
    cooldownReason: string | null;
  }>,
): void {
  const manager = getAccountOwnership();
  for (const account of accounts) {
    const persisted: PersistedAccountState = {
      accountId: account.accountId,
      disabled: account.disabled,
      cooldownUntil: account.cooldownUntil,
      cooldownReason: account.cooldownReason,
    };
    manager.registerAccount(account.accountId, persisted);
  }
}

/**
 * Adapt the authoritative domain lease to the legacy AccountLease shape
 * (accountId / leaseId / release()). Structural typing keeps this free of the
 * legacy module — no import cycle — while still satisfying AccountLease.
 * release() is idempotent and fenced: a stale token is rejected and never
 * disturbs the current owner.
 */
export function toLegacyAccountLease(lease: AccountLease): {
  accountId: string;
  leaseId: string;
  release(): void;
} {
  return {
    accountId: lease.accountId,
    leaseId: lease.leaseId,
    release(): void {
      getAccountOwnership().release({
        leaseId: lease.leaseId,
        ownerToken: lease.ownerToken,
        outcome: "completed",
      });
    },
  };
}

/** Tests only: drop the singleton so the next access builds a fresh pool. */
export function resetAccountOwnershipForTests(): void {
  instance = null;
}
