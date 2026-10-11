import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllHeadersReadyAccounts,
  getHeadersReadyAccountIds,
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  initAccountOwnership,
  resetAccountOwnershipForTests,
} from "../runtime/account/instance.ts";
import type { OwnershipFence } from "../runtime/contracts.ts";

const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };

function bind(ids: string[]): ReturnType<typeof initAccountOwnership> {
  const ownership = initAccountOwnership(
    ids.map((accountId) => ({
      accountId,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    })),
  );
  return ownership;
}

test.afterEach(() => {
  resetAccountOwnershipForTests();
  clearAllHeadersReadyAccounts();
});

test("unified readiness: unbound ownership falls back to the in-memory set", () => {
  assert.equal(isAccountHeadersReady("u-acc"), false);
  markAccountHeadersReady("u-acc");
  assert.equal(isAccountHeadersReady("u-acc"), true);
  assert.deepEqual(getHeadersReadyAccountIds(), ["u-acc"]);
  unmarkAccountHeadersReady("u-acc");
  assert.equal(isAccountHeadersReady("u-acc"), false);
});

test("unified readiness: STANDBY cannot be marked READY without warmup", () => {
  const ownership = bind(["b-acc"]);
  assert.equal(ownership.getAccountStatus("b-acc"), "STANDBY");
  markAccountHeadersReady("b-acc");
  assert.equal(isAccountHeadersReady("b-acc"), false);
  assert.deepEqual(getHeadersReadyAccountIds(), []);
});

test("unified readiness: WARMING marks READY through the state machine", () => {
  const ownership = bind(["b-warm"]);
  assert.equal(
    ownership.transition("b-warm", "WARMING", SYSTEM_FENCE, "t").transitioned,
    true,
  );
  markAccountHeadersReady("b-warm");
  assert.equal(ownership.getAccountStatus("b-warm"), "READY");
  assert.equal(isAccountHeadersReady("b-warm"), true);
  assert.deepEqual(getHeadersReadyAccountIds(), ["b-warm"]);
});

test("unified readiness: context death moves READY to RECOVERING, never strands", () => {
  const ownership = bind(["b-dead"]);
  ownership.transition("b-dead", "WARMING", SYSTEM_FENCE, "t");
  markAccountHeadersReady("b-dead");
  assert.equal(isAccountHeadersReady("b-dead"), true);
  unmarkAccountHeadersReady("b-dead");
  assert.equal(ownership.getAccountStatus("b-dead"), "RECOVERING");
  assert.equal(isAccountHeadersReady("b-dead"), false);
  assert.deepEqual(getHeadersReadyAccountIds(), []);
  // Recovery requeues through STANDBY and can be marked READY again.
  assert.equal(
    ownership.transition("b-dead", "STANDBY", SYSTEM_FENCE, "recovery-requeue")
      .transitioned,
    true,
  );
  ownership.transition("b-dead", "WARMING", SYSTEM_FENCE, "t2");
  markAccountHeadersReady("b-dead");
  assert.equal(isAccountHeadersReady("b-dead"), true);
});

test("unified readiness: READY records with a dead context are hidden from the ready list", async () => {
  const { registerPlaywrightAccountForTests, unregisterPlaywrightAccountForTests } =
    await import("../services/playwright.ts");
  const ownership = bind(["b-deadpage"]);
  ownership.transition("b-deadpage", "WARMING", SYSTEM_FENCE, "t");
  registerPlaywrightAccountForTests(
    "b-deadpage",
    { isClosed: () => true } as any,
    Date.now(),
  );
  try {
    markAccountHeadersReady("b-deadpage");
    assert.equal(ownership.getAccountStatus("b-deadpage"), "READY");
    assert.equal(
      isAccountHeadersReady("b-deadpage"),
      false,
      "the request-path gate rejects a READY record whose context died",
    );
    assert.deepEqual(
      getHeadersReadyAccountIds(),
      [],
      "the ready list must agree with the gate, or callers resolve an account that can only answer 'is not warmed'",
    );
  } finally {
    unregisterPlaywrightAccountForTests("b-deadpage");
  }
});

test("unified readiness: leased accounts stay hot and unmark is a no-op", () => {
  const ownership = bind(["b-leased"]);
  ownership.transition("b-leased", "WARMING", SYSTEM_FENCE, "t");
  markAccountHeadersReady("b-leased");
  const acquired = ownership.acquire({
    generationId: "gen-1",
    candidates: ["b-leased"],
    deadline: Date.now() + 60_000,
    requirements: { purpose: "generation", generationId: "gen-1" },
  });
  assert.equal(acquired.ok, true);
  assert.equal(isAccountHeadersReady("b-leased"), true);
  // Unmarking a leased account must not disturb the live generation.
  unmarkAccountHeadersReady("b-leased");
  assert.equal(isAccountHeadersReady("b-leased"), true);
  if (acquired.ok) {
    ownership.release({
      leaseId: acquired.lease.leaseId,
      ownerToken: acquired.lease.ownerToken,
      outcome: "completed",
    });
  }
  assert.equal(ownership.getAccountStatus("b-leased"), "READY");
});
