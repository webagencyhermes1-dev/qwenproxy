import type { AccountStatus } from "../../domain/types.ts";

/**
 * The authoritative AccountStatus transition table (Appendix A).
 * Exactly one state machine for accounts; every transition in the runtime must
 * pass through `assertAccountTransition` so no component invents its own.
 */
const TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  DISABLED: ["STANDBY"],
  // STANDBY → FAILED ("warmup-exhausted"): a candidate that ran out of warmup
  // attempts WITHOUT ever reaching READY must land in a terminal bucket the
  // pool snapshot already reports (ACCOUNT_TERMINAL_STATES). Without this edge
  // `recoverAccount(id, "warmup-exhausted")` fell back to RECOVERING, which the
  // controller re-launches — the account then cycled warmup → exhaustion →
  // recovery → warmup forever instead of surfacing as failed.
  STANDBY: ["WARMING", "FAILED", "DISABLED"],
  // WARMING → STANDBY ("warmup-abandoned"): a warmup that timed out without
  // settling leaves the account occupying a WARMING slot forever, because the
  // controller's timeout path only drops its in-flight entry and never touches
  // ownership status. One orphan is enough to pin
  // `deficit = target - ready - warming` at 0, which silently stops ALL further
  // warmup — the pool then freezes at whatever count it reached. Requeueing
  // returns the account to the warmable pool instead.
  WARMING: ["READY", "STANDBY", "FAILED", "COOLDOWN", "DISABLED"],
  READY: ["RESERVED", "RECOVERING", "DRAINING", "COOLDOWN", "FAILED", "DISABLED"],
  RESERVED: ["GENERATING", "READY", "RECOVERING", "DRAINING", "FAILED", "DISABLED"],
  GENERATING: ["DRAINING", "RECOVERING", "READY", "FAILED", "DISABLED"],
  DRAINING: ["READY", "RECOVERING", "DISABLED"],
  // RECOVERING → STANDBY ("recovery-requeue"): recovery observation is
  // complete and the account is back in the warmable pool. Without this edge
  // a context-dead account strands in RECOVERING until restart — nothing else
  // moves it (the controller only launches STANDBY/RECOVERING candidates).
  RECOVERING: ["STANDBY", "READY", "COOLDOWN", "FAILED", "DISABLED"],
  COOLDOWN: ["STANDBY", "DISABLED"],
  FAILED: ["COOLDOWN", "STANDBY", "DISABLED"],
};

export const ACCOUNT_TERMINAL_STATES: readonly AccountStatus[] = [
  "DISABLED",
  "FAILED",
];

export function canTransitionAccount(
  from: AccountStatus,
  to: AccountStatus,
): boolean {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return allowed.includes(to);
}

export function assertAccountTransition(
  from: AccountStatus,
  to: AccountStatus,
): void {
  if (!canTransitionAccount(from, to)) {
    throw new Error(
      `Illegal account state transition: ${from} -> ${to}`,
    );
  }
}

export function isAccountTerminal(status: AccountStatus): boolean {
  return ACCOUNT_TERMINAL_STATES.includes(status);
}

function exhaustiveCheck(status: never): never {
  throw new Error(`Unknown account status: ${String(status)}`);
}

export function describeTransition(
  from: AccountStatus,
  to: AccountStatus,
): string {
  if (!canTransitionAccount(from, to)) {
    return `illegal:${from}->${to}`;
  }
  switch (to) {
    case "DISABLED":
      return "disabled";
    case "STANDBY":
      return from === "DISABLED" ? "enabled" : "standby";
    case "WARMING":
      return "warming";
    case "READY":
      return from === "RESERVED" ? "released" : "ready";
    case "RESERVED":
      return "reserved";
    case "GENERATING":
      return "generating";
    case "DRAINING":
      return "draining";
    case "RECOVERING":
      return "recovering";
    case "COOLDOWN":
      return "cooldown";
    case "FAILED":
      return "failed";
    default:
      return exhaustiveCheck(to);
  }
}
