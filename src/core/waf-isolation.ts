/**
 * WAF hard-block contingency (aligned with upstream account-isolation.ts).
 *
 * When a Baxia/TMD challenge could NOT be solved, quarantining the account is
 * not enough: the fingerprint seed is derived from the accountId, so the
 * account returns from cooldown on the SAME device identity the WAF already
 * flagged, and the challenge re-propagates immediately. The contingency here:
 *  - escalates the quarantine window per consecutive hard block (×2, capped),
 *  - rotates the account's fingerprint seed (fresh device identity),
 *  - closes the account's Playwright context so the next use re-initializes
 *    with the rotated profile (cookies/storage persist in the profile dir).
 *
 * Strictly per-account: a block on one account never touches another's state.
 */
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { markAccountRateLimited } from "./account-manager.ts";
import { recordAccountFailure } from "./account-health.ts";
import { rotateFingerprintSeed } from "../services/fingerprint.ts";

const ESCALATION_FACTOR = 2;
const MAX_CONSECUTIVE_FOR_ESCALATION = 4;

interface WafBlockState {
  consecutiveHardBlocks: number;
  lastBlockAt: number;
  /** Decayed challenge pressure for this account (0 = never challenged). */
  pressure: number;
  /** Last time this account successfully served a request. */
  lastSuccessAt: number;
}

const states = new Map<string, WafBlockState>();

export interface WafBlockResult {
  cooldownMs: number;
  fingerprintRotated: true;
  escalated: boolean;
  /**
   * Pool-wide challenge pressure at the time of the block (informational —
   * surfaced on /health). It steers routing, not the cooldown window.
   */
  pressureMultiplier: number;
}

type ContextResetListener = (accountId: string) => void | Promise<void>;
let contextResetListener: ContextResetListener | null = null;

const CHALLENGE_DECAY_MS = 120_000;

/**
 * Challenge-pressure bookkeeping lives in the leaf module `waf-pressure.ts` so
 * the scheduler can read per-account pressure without importing this file and
 * closing the account-manager <-> scheduler cycle. This module only writes.
 */
import {
  clearChallengePressure,
  getAccountPressure,
  getCooldownPressureMultiplier,
  getHotLanes,
  getPoolPressure,
  recordChallenge,
  resetPressure,
} from "./waf-pressure.ts";

export { getAccountPressure as getAccountChallengePressure };

/**
 * Register the hook that physically resets an account's browser context after
 * a fingerprint rotation. Injected by the Playwright layer so this module
 * stays decoupled from it (and unit-testable without a browser).
 */
export function setWafContextResetListener(fn: ContextResetListener | null): void {
  contextResetListener = fn;
}

function getState(accountId: string): WafBlockState {
  let state = states.get(accountId);
  if (!state) {
    state = {
      consecutiveHardBlocks: 0,
      lastBlockAt: 0,
      pressure: 0,
      lastSuccessAt: 0,
    };
    states.set(accountId, state);
  }
  return state;
}

export function getWafHardBlockCount(accountId: string): number {
  return states.get(accountId)?.consecutiveHardBlocks ?? 0;
}

/**
 * Record an unsolvable WAF challenge on `accountId`: quarantine (escalating),
 * rotate the device fingerprint, and reset the browser context.
 */
export function recordWafHardBlock(accountId: string): WafBlockResult {
  const now = Date.now();
  const state = getState(accountId);
  state.consecutiveHardBlocks += 1;
  state.lastBlockAt = now;
  recordChallenge(accountId, now);

  const base = config.captcha.accountCooldownMs;
  const cap = config.captcha.hardBlockMaxCooldownMs;
  const exponent = Math.min(
    state.consecutiveHardBlocks - 1,
    MAX_CONSECUTIVE_FOR_ESCALATION,
  );
  // Cooldown stays DETERMINISTIC (base * 2^streak, capped). Challenge pressure
  // deliberately does NOT inflate it: lengthening quarantines under pressure
  // shrinks the very capacity you need when accounts are being challenged, and
  // it would make a lane's return time depend on unrelated pool state. Pressure
  // is used to steer ROUTING away from flagged lanes instead, which cannot
  // starve the pool.
  const pressureMultiplier = getCooldownPressureMultiplier(now);
  const cooldownMs = Math.min(
    cap,
    base * Math.pow(ESCALATION_FACTOR, exponent),
  );

  if (cooldownMs > 0) {
    // markAccountRateLimited requests a controller tick itself.
    markAccountRateLimited(accountId, cooldownMs, "WafChallenge");
  }
  try {
    recordAccountFailure(accountId, "waf");
  } catch {
    // Best-effort.
  }

  rotateFingerprintSeed(accountId);
  logger.warn(
    `[WafIsolation] Hard WAF block on ${accountId}: fingerprint rotated (streak ${state.consecutiveHardBlocks}), quarantined ${Math.round(cooldownMs / 1000)}s`,
  );

  if (contextResetListener) {
    // Best-effort: the next use re-initializes the context with the rotated
    // profile; a failed close must not abort the quarantine.
    void Promise.resolve(contextResetListener(accountId)).catch((error: unknown) => {
      logger.warn(
        `[WafIsolation] Context reset listener failed for ${accountId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  return {
    cooldownMs,
    fingerprintRotated: true,
    escalated: state.consecutiveHardBlocks > 1,
    pressureMultiplier,
  };
}

/** A successful stream on the account clears the escalation streak. */
export function noteWafRecovery(accountId: string): void {
  const state = states.get(accountId);
  if (state && state.consecutiveHardBlocks > 0) {
    state.consecutiveHardBlocks = 0;
  }
}

/**
 * A completed generation: the lane is demonstrably healthy, so clear BOTH the
 * escalation streak and the routing penalty immediately instead of waiting for
 * decay. A successful stream is the strongest available evidence that the
 * account's identity is no longer flagged, so it is the correct single signal
 * to reset on (the request path calls it right after `noteWafRecovery`).
 */
export function noteWafSuccess(accountId: string): void {
  const state = states.get(accountId);
  if (state) {
    state.consecutiveHardBlocks = 0;
    state.pressure = 0;
    state.lastSuccessAt = Date.now();
  }
  clearChallengePressure(accountId);
}

/** Test/admin helper: drop all isolation state for an account. */
export function clearWafIsolation(accountId: string): void {
  states.delete(accountId);
}

/** Test/admin helper: reset the process-wide challenge-pressure signal. */
export function resetChallengePressure(): void {
  resetPressure();
}

/** Snapshot for /health: pool-wide challenge pressure and the hottest lanes. */
export function getWafIsolationStats(now: number = Date.now()): {
  pressure: number;
  pressureMultiplier: number;
  pressuredAccounts: Array<{ accountId: string; pressure: number }>;
} {
  return {
    pressure: getPoolPressure(now),
    pressureMultiplier: getCooldownPressureMultiplier(now),
    pressuredAccounts: getHotLanes(now),
  };
}
