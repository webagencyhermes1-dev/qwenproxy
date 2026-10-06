/**
 * Bounded BROKEN recovery (pool reconciliation pass).
 *
 * `init_fail_count` is persisted, so an account that was escalated to BROKEN
 * while a SYSTEMIC cause was in effect (an occluded composer, a WAF change, an
 * init-deadline storm) stayed BROKEN forever: the escalation state outlived the
 * cause, and nothing ever gave the account another chance. That is the classic
 * "transient systemic failure recorded as a permanent per-account failure".
 *
 * This pass is the automatic, code-level remedy (no operator step):
 *
 *   * an account that is BROKEN purely from init-failure escalation and has
 *     failed NOTHING for `POOL_BROKEN_RECOVERY_AGE_MS` is re-armed: the
 *     escalation counter is zeroed, the in-memory broken flag is cleared, a
 *     terminal FAILED ownership status is requeued to STANDBY, and a log line
 *     records what happened;
 *   * accounts carrying permanent-auth evidence (`auth_failures > 0` or an
 *     `AuthPermanentFailure*` cooldown — the `isPermanentInitFailure` model)
 *     are SKIPPED: bad credentials are legitimately BROKEN and must stay so;
 *   * accounts still failing recently are SKIPPED: while a cause is live the
 *     escalation is still the right answer.
 *
 * Every recovery hands the account a FRESH, bounded budget: it must fail
 * `BROKEN_INIT_FAIL_THRESHOLD` isolated init attempts again (or go permanent)
 * before it is re-parked, and warmup itself stays bounded by the readiness
 * controller's `POOL_MAX_WARMUP_FAILURES` + concurrency.
 *
 * Wired into the existing pool reconciliation interval
 * (`POOL_RECONCILIATION_INTERVAL_MS`) by runtime/construct.ts — at startup and
 * on every tick.
 */

import { loadAccounts } from "../../core/accounts.ts";
import {
  BROKEN_INIT_FAIL_THRESHOLD,
  getBrokenRecoveryAgeMs,
  getAccountHealth,
  hasPermanentInitEvidence,
  resetInitFailureEscalation,
} from "../../core/account-health.ts";
import {
  clearAccountBroken,
  isAccountFlaggedBroken,
} from "../../core/account-state.ts";
import { getAccountOwnership, isAccountOwnershipBound } from "../account/instance.ts";
import { canTransitionAccount } from "../account/status-machine.ts";

const SYSTEM_FENCE = { leaseId: "system", ownerToken: "system" };

export interface BrokenRecoveryReport {
  /** Accounts inspected because they looked BROKEN (flagged or escalated). */
  scanned: number;
  /** Accounts re-armed: escalation counter zeroed / broken flag cleared. */
  recovered: string[];
  /** Skipped: permanent-auth evidence — legitimately BROKEN. */
  skippedPermanent: string[];
  /** Skipped: failed something recently — the cause may still be live. */
  skippedActive: string[];
}

/**
 * Re-arm BROKEN-on-init-failure accounts whose escalation has gone quiet.
 * Never throws; safe to call on every reconciliation tick.
 */
export function reconcileBrokenAccounts(
  options?: {
    now?: number;
    /** Pool to inspect (defaults to `loadAccounts()`). */
    accounts?: readonly { id: string; cooldown_reason?: string | null }[];
  },
): BrokenRecoveryReport {
  const now = options?.now ?? Date.now();
  const ageMs = getBrokenRecoveryAgeMs();
  const report: BrokenRecoveryReport = {
    scanned: 0,
    recovered: [],
    skippedPermanent: [],
    skippedActive: [],
  };
  let accounts: readonly { id: string; cooldown_reason?: string | null }[];
  try {
    accounts = options?.accounts ?? loadAccounts();
  } catch {
    return report;
  }

  for (const account of accounts) {
    const accountId = account.id;
    if (!accountId || accountId === "global") continue;
    const flagged = isAccountFlaggedBroken(accountId);
    const rec = getAccountHealth(accountId);
    const escalated = rec.initFailCount >= BROKEN_INIT_FAIL_THRESHOLD;
    if (!flagged && !escalated) continue;
    report.scanned += 1;

    // The pool rows already carry `cooldown_reason`, so the permanent-auth
    // check needs no per-account query on the reconciliation path.
    if (hasPermanentInitEvidence(accountId, rec, account.cooldown_reason)) {
      report.skippedPermanent.push(accountId);
      continue;
    }
    const idleMs = rec.lastFailureAt == null ? Infinity : now - rec.lastFailureAt;
    if (idleMs < ageMs) {
      report.skippedActive.push(accountId);
      continue;
    }

    const priorInitFailures = rec.initFailCount;
    if (escalated) resetInitFailureEscalation(accountId);
    if (flagged) clearAccountBroken(accountId);
    requeueTerminalAccount(accountId);
    report.recovered.push(accountId);

    const idle =
      rec.lastFailureAt == null
        ? "unknown-idle"
        : `${(idleMs / 3_600_000).toFixed(1)}h`;
    console.log(
      `🔁 [Pool] BROKEN recovery | account=${accountId} | init-failure escalation cleared after ${idle} with no failure | priorInitFailures=${priorInitFailures} | fresh budget=${BROKEN_INIT_FAIL_THRESHOLD} attempt(s)`,
    );
  }

  if (report.recovered.length > 0) {
    console.log(
      `🔁 [Pool] BROKEN recovery pass | recovered=${report.recovered.length} | scanned=${report.scanned} | skippedPermanent=${report.skippedPermanent.length} | skippedActive=${report.skippedActive.length}`,
    );
  }
  return report;
}

/**
 * A recovered account parked terminal by warmup exhaustion (FAILED) is back in
 * the warmable pool: FAILED → STANDBY is a legal transition and the readiness
 * controller only launches STANDBY/RECOVERING candidates.
 */
function requeueTerminalAccount(accountId: string): void {
  if (!isAccountOwnershipBound()) return;
  try {
    const ownership = getAccountOwnership();
    if (
      ownership.getAccountStatus(accountId) === "FAILED" &&
      canTransitionAccount("FAILED", "STANDBY")
    ) {
      ownership.transition(accountId, "STANDBY", SYSTEM_FENCE, "broken-recovery");
    }
  } catch {
    // Best-effort: the health/flag reset already un-blocked the account.
  }
}
