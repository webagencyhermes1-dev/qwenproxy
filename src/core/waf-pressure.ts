/**
 * WAF challenge-pressure state — deliberately a LEAF module with no imports.
 *
 * The scheduler (`core/account-scheduler.ts`) needs per-account challenge
 * pressure to prefer clean lanes, but `core/waf-isolation.ts` imports
 * `core/account-manager.ts`, which imports the scheduler. Importing the
 * isolation module from the scheduler would therefore close the cycle
 *
 *   account-manager -> account-scheduler -> waf-isolation -> account-manager
 *
 * which — exactly like the cycle that motivated extracting
 * `services/playwright-page-state.ts` — can evaluate a module-scope binding
 * while its module is still initialising and throw a TDZ `ReferenceError`
 * depending on entry order. Keeping the numbers here breaks the cycle: the
 * scheduler reads, `waf-isolation` writes, neither imports the other.
 *
 * Semantics: a decayed EWMA of recent challenge pressure. Pressure RISES when
 * an account is challenged and decays on its own, so a lane that went quiet
 * becomes attractive again without any explicit reset.
 */

/** Half-life of a challenge event's contribution to pressure. */
const DECAY_MS = 120_000;
const MAX_ACCOUNT_PRESSURE = 3;
const MAX_POOL_PRESSURE = 8;
/** Quarantine multiplier at maximum pool pressure (1.0x when quiet). */
const PRESSURE_COOLDOWN_MULTIPLIER = 3;

interface AccountPressure {
  /** Decayed challenge count for this account (0 = never challenged). */
  pressure: number;
  lastEventAt: number;
}

const accounts = new Map<string, AccountPressure>();
let poolPressure = 0;
let poolUpdatedAt = 0;

function now(): number {
  return Date.now();
}

function decayPool(at: number): void {
  if (poolUpdatedAt === 0) {
    poolUpdatedAt = at;
    return;
  }
  const elapsed = at - poolUpdatedAt;
  if (elapsed < DECAY_MS / 4) return;
  poolUpdatedAt = at;
  poolPressure *= Math.pow(0.5, elapsed / DECAY_MS);
  if (poolPressure < 0.01) poolPressure = 0;
}

/** Record a challenge against one account (also raises pool-wide pressure). */
export function recordChallenge(accountId: string, at: number = now()): void {
  const entry = accounts.get(accountId) ?? { pressure: 0, lastEventAt: at };
  // Decay this account toward its stored value before incrementing.
  if (entry.pressure > 0) {
    entry.pressure *= Math.pow(0.5, Math.max(0, at - entry.lastEventAt) / DECAY_MS);
  }
  entry.pressure = Math.min(MAX_ACCOUNT_PRESSURE, entry.pressure + 1);
  entry.lastEventAt = at;
  accounts.set(accountId, entry);

  decayPool(at);
  poolPressure = Math.min(MAX_POOL_PRESSURE, poolPressure + 1);
}

/** Clear an account's pressure after a successful generation. */
export function clearChallengePressure(accountId: string): void {
  const entry = accounts.get(accountId);
  if (entry) entry.pressure = 0;
}

/** Pool-wide decayed challenge pressure (0..MAX_POOL_PRESSURE). */
export function getPoolPressure(at: number = now()): number {
  decayPool(at);
  return poolPressure;
}

/**
 * Per-account pressure normalized to 0..1, for routing preference.
 * Decays on read so no explicit reset is needed.
 */
export function getAccountPressure(accountId: string, at: number = now()): number {
  const entry = accounts.get(accountId);
  if (!entry || entry.pressure <= 0) return 0;
  const decayed = entry.pressure * Math.pow(0.5, Math.max(0, at - entry.lastEventAt) / DECAY_MS);
  if (decayed < 0.01) {
    entry.pressure = 0;
    return 0;
  }
  entry.pressure = decayed;
  return Math.min(1, decayed / MAX_ACCOUNT_PRESSURE);
}

/**
 * Multiplier for challenge cooldowns: 1.0 when quiet, up to
 * PRESSURE_COOLDOWN_MULTIPLIER under maximum sustained pressure. Backing off
 * harder is the correct response to a rising challenge rate — rotating faster
 * raises the request rate on an already-flagged egress and provokes more.
 */
export function getCooldownPressureMultiplier(at: number = now()): number {
  const p = getPoolPressure(at);
  if (p <= 0) return 1;
  return (
    1 +
    Math.min(1, p / MAX_POOL_PRESSURE) * (PRESSURE_COOLDOWN_MULTIPLIER - 1)
  );
}

/** Snapshot of the hottest lanes, for /health. */
export function getHotLanes(at: number = now(), limit = 10): Array<{
  accountId: string;
  pressure: number;
}> {
  return [...accounts.keys()]
    .map((accountId) => ({ accountId, pressure: getAccountPressure(accountId, at) }))
    .filter((e) => e.pressure > 0)
    .sort((a, b) => b.pressure - a.pressure)
    .slice(0, limit);
}

/** Test/admin helper. */
export function resetPressure(): void {
  accounts.clear();
  poolPressure = 0;
  poolUpdatedAt = 0;
}
