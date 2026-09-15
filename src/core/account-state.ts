/**
 * Account Pool 2.0 — explicit lifecycle states with centralized transitions.
 *
 * States are DERIVED from existing truth (disabled flag, cooldown map,
 * headers-ready set, concurrency slots, health init-fail counter) plus two
 * small transient flag sets (auth error, session expired). There is no
 * parallel state store to drift out of sync.
 *
 * Display priority (first match wins):
 *   DISABLED > BROKEN > AUTH_ERROR > SESSION_EXPIRED > COOLDOWN > BUSY >
 *   WARMING > READY
 */

import { isAccountBrokenByHealth } from "./account-health.ts";

export type AccountState =
  | "READY"
  | "WARMING"
  | "BUSY"
  | "COOLDOWN"
  | "AUTH_ERROR"
  | "SESSION_EXPIRED"
  | "BROKEN"
  | "DISABLED";

export interface AccountStateFlags {
  disabled: boolean;
  onCooldown: boolean;
  headersReady: boolean;
  initialized: boolean;
  busy: boolean;
  authError: boolean;
  sessionExpired: boolean;
  broken: boolean;
}

/** Transient per-account flags (cleared on successful recovery). */
const authErrorAccounts = new Set<string>();
const sessionExpiredAccounts = new Set<string>();
const brokenAccounts = new Set<string>();

/** Pure derivation — no I/O, safe to call per request for 200 accounts. */
export function deriveAccountState(flags: AccountStateFlags): AccountState {
  if (flags.disabled) return "DISABLED";
  if (flags.broken) return "BROKEN";
  if (flags.authError) return "AUTH_ERROR";
  if (flags.sessionExpired) return "SESSION_EXPIRED";
  if (flags.onCooldown) return "COOLDOWN";
  if (flags.busy) return "BUSY";
  if (!flags.headersReady || !flags.initialized) return "WARMING";
  return "READY";
}

export function isAccountFlaggedAuthError(accountId: string): boolean {
  return authErrorAccounts.has(accountId);
}

export function isAccountFlaggedSessionExpired(accountId: string): boolean {
  return sessionExpiredAccounts.has(accountId);
}

export function isAccountFlaggedBroken(accountId: string): boolean {
  return brokenAccounts.has(accountId);
}

/** Account authentication failed (bad credentials / permanent block). */
export function markAccountAuthError(accountId: string): void {
  if (!accountId || accountId === "global") return;
  authErrorAccounts.add(accountId);
}

/** Successful auth/init clears the AUTH_ERROR flag. */
export function clearAccountAuthError(accountId: string): void {
  if (!accountId) return;
  authErrorAccounts.delete(accountId);
}

/** Upstream reports the session expired — recover via refresh before switching. */
export function markAccountSessionExpired(accountId: string): void {
  if (!accountId || accountId === "global") return;
  sessionExpiredAccounts.add(accountId);
}

export function clearAccountSessionExpired(accountId: string): void {
  if (!accountId) return;
  sessionExpiredAccounts.delete(accountId);
}

/** Repeated init failures escalate to BROKEN (manual or auto recovery). */
export function markAccountBroken(accountId: string): void {
  if (!accountId || accountId === "global") return;
  brokenAccounts.add(accountId);
}

export function clearAccountBroken(accountId: string): void {
  if (!accountId) return;
  brokenAccounts.delete(accountId);
}

/** Effective broken = explicit flag OR health init-fail threshold. */
export function isAccountEffectivelyBroken(accountId: string): boolean {
  if (brokenAccounts.has(accountId)) return true;
  try {
    return isAccountBrokenByHealth(accountId);
  } catch {
    return false;
  }
}

/**
 * Successful activity recovers transient flags gradually:
 * SESSION_EXPIRED always clears; AUTH_ERROR/BROKEN clear so the account can
 * re-prove itself (health score still gates priority).
 */
export function noteAccountRecovered(accountId: string): void {
  if (!accountId) return;
  sessionExpiredAccounts.delete(accountId);
  authErrorAccounts.delete(accountId);
  brokenAccounts.delete(accountId);
}

/** Test isolation. */
export function resetAccountStateForTests(): void {
  authErrorAccounts.clear();
  sessionExpiredAccounts.clear();
  brokenAccounts.clear();
}
