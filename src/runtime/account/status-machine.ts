import type { AccountStatus } from "../../domain/types.ts";

/**
 * The authoritative AccountStatus transition table (Appendix A).
 * Exactly one state machine for accounts; every transition in the runtime must
 * pass through `assertAccountTransition` so no component invents its own.
 */
const TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  DISABLED: ["STANDBY"],
  STANDBY: ["WARMING", "DISABLED"],
  WARMING: ["READY", "FAILED", "COOLDOWN", "DISABLED"],
  READY: ["RESERVED", "RECOVERING", "DRAINING", "COOLDOWN", "FAILED", "DISABLED"],
  RESERVED: ["GENERATING", "READY", "RECOVERING", "DRAINING", "FAILED", "DISABLED"],
  GENERATING: ["DRAINING", "RECOVERING", "READY", "FAILED", "DISABLED"],
  DRAINING: ["READY", "RECOVERING", "DISABLED"],
  RECOVERING: ["READY", "COOLDOWN", "FAILED", "DISABLED"],
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
