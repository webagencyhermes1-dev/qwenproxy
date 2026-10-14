/**
 * WAF challenge pressure: adaptive cooldown + routing preference.
 *
 * The behavioural rule under test is the one that matters operationally: when
 * accounts are getting challenged, the pool must BACK OFF (longer quarantine,
 * lanes rested) rather than rotate faster, because raising the request rate on
 * an already-flagged egress provokes more challenges.
 *
 * Pressure state lives in the leaf module `core/waf-pressure.ts` (no imports)
 * specifically so the scheduler can read it without closing the
 * account-manager <-> scheduler import cycle.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  clearChallengePressure,
  getAccountPressure,
  getCooldownPressureMultiplier,
  getHotLanes,
  getPoolPressure,
  recordChallenge,
  resetPressure,
} from "../core/waf-pressure.ts";
import {
  clearWafIsolation,
  getWafHardBlockCount,
  getWafIsolationStats,
  noteWafSuccess,
  recordWafHardBlock,
  resetChallengePressure,
} from "../core/waf-isolation.ts";

test("a quiet pool has zero pressure and no cooldown multiplier", () => {
  resetPressure();
  assert.equal(getPoolPressure(), 0);
  assert.equal(getAccountPressure("nobody"), 0);
  assert.equal(getCooldownPressureMultiplier(), 1);
  assert.deepEqual(getHotLanes(), []);
});

test("challenges raise pool pressure and the cooldown multiplier", () => {
  resetPressure();
  recordChallenge("a1");
  recordChallenge("a2");
  recordChallenge("a3");
  assert.ok(getPoolPressure() > 0, "pool pressure must be positive");
  assert.ok(
    getCooldownPressureMultiplier() > 1,
    "pressure must lengthen the quarantine window",
  );
  assert.ok(getCooldownPressureMultiplier() <= 3, "multiplier stays bounded");
});

test("per-account pressure rises for the challenged lane only", () => {
  resetPressure();
  recordChallenge("hot");
  assert.ok(getAccountPressure("hot") > 0);
  assert.equal(getAccountPressure("cold"), 0, "an untouched lane stays clean");
});

test("a success clears the lane's pressure so it is preferred again", () => {
  resetPressure();
  recordChallenge("recovered");
  assert.ok(getAccountPressure("recovered") > 0);
  clearChallengePressure("recovered");
  assert.equal(getAccountPressure("recovered"), 0);
});

test("pressure decays back to zero without an explicit reset", () => {
  resetPressure();
  recordChallenge("decay-me");
  assert.ok(getAccountPressure("decay-me") > 0);
  // A full half-life later the contribution is halved; query far enough ahead
  // and the lane reads clean again.
  const farFuture = Date.now() + 10 * 120_000;
  assert.equal(getAccountPressure("decay-me", farFuture), 0);
});

test("hot lanes are reported worst-first for /health", () => {
  resetPressure();
  recordChallenge("a");
  recordChallenge("b");
  recordChallenge("b");
  const hot = getHotLanes();
  assert.ok(hot.length >= 2);
  assert.equal(hot[0].accountId, "b", "the more-challenged lane ranks first");
});

test("recordWafHardBlock records pressure but leaves the cooldown deterministic", () => {
  resetPressure();
  resetChallengePressure();
  clearWafIsolation("waf-1");

  // A quiet pool multiplies by 1, and recording a block itself raises pressure.
  assert.equal(getCooldownPressureMultiplier(), 1);
  recordWafHardBlock("waf-1");

  // Push the pool into pressure with OTHER accounts.
  for (let i = 0; i < 6; i++) recordChallenge(`noise-${i}`);
  const second = recordWafHardBlock("waf-1");

  // Cooldown MUST stay a pure function of the streak: inflating quarantines
  // under pressure would starve the pool of exactly the capacity it needs.
  const solo = (() => {
    resetPressure();
    resetChallengePressure();
    clearWafIsolation("waf-1-cooldown");
    recordWafHardBlock("waf-1-cooldown");
    return recordWafHardBlock("waf-1-cooldown").cooldownMs;
  })();
  assert.equal(
    second.cooldownMs,
    solo,
    "the same streak must yield the same cooldown regardless of pool pressure",
  );

  clearWafIsolation("waf-1");
  clearWafIsolation("waf-1-cooldown");
  resetPressure();
  resetChallengePressure();
});

test("a served generation clears both the streak and the routing penalty", () => {
  resetPressure();
  resetChallengePressure();
  clearWafIsolation("waf-2");

  recordWafHardBlock("waf-2");
  assert.equal(getWafHardBlockCount("waf-2"), 1);
  assert.ok(getAccountPressure("waf-2") > 0);

  noteWafSuccess("waf-2");
  assert.equal(getWafHardBlockCount("waf-2"), 0, "streak cleared");
  assert.equal(getAccountPressure("waf-2"), 0, "routing penalty cleared");

  clearWafIsolation("waf-2");
  resetPressure();
  resetChallengePressure();
});

test("isolation stats expose pressure and the hottest lanes", () => {
  resetPressure();
  resetChallengePressure();
  clearWafIsolation("waf-3");
  recordWafHardBlock("waf-3");

  const stats = getWafIsolationStats();
  assert.ok(stats.pressure > 0);
  assert.ok(stats.pressureMultiplier >= 1);
  assert.ok(
    stats.pressuredAccounts.some((e) => e.accountId === "waf-3"),
    "the challenged lane must be visible to operators",
  );

  clearWafIsolation("waf-3");
  resetPressure();
  resetChallengePressure();
});
