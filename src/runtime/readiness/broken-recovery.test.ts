import test from "node:test";
import assert from "node:assert/strict";

import { getDatabase } from "../../core/database.ts";
import {
  BROKEN_INIT_FAIL_THRESHOLD,
  getAccountHealth,
  getBrokenRecoveryAgeMs,
  getSystemicInitFailureCount,
  isAccountBrokenByHealth,
  noteAccountInitFailure,
  noteAccountInitSuccess,
  recordAccountFailure,
  resetAccountHealthForTests,
} from "../../core/account-health.ts";
import {
  clearAccountBroken,
  isAccountFlaggedBroken,
  markAccountBroken,
} from "../../core/account-state.ts";
import { AccountResourceManager } from "../account/resource-manager.ts";
import {
  resetAccountOwnershipForTests,
  setAccountOwnership,
} from "../account/instance.ts";
import { reconcileBrokenAccounts } from "./broken-recovery.ts";
import { ReadinessController } from "./readiness-controller.ts";

function cleanHealth(ids: string[]): void {
  const db = getDatabase();
  try {
    db.prepare(
      `DELETE FROM account_health WHERE account_id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  } catch {
    // Table may not exist on very old setups — migration creates it.
  }
  resetAccountHealthForTests();
}

function breakAccount(id: string, failures = BROKEN_INIT_FAIL_THRESHOLD): void {
  for (let i = 0; i < failures; i++) noteAccountInitFailure(id);
}

test("broken-recovery: isolated init failures still escalate to BROKEN", () => {
  const id = "broken-recovery-t1";
  cleanHealth([id]);
  try {
    breakAccount(id);
    assert.equal(isAccountBrokenByHealth(id), true);
    noteAccountInitSuccess(id);
    assert.equal(isAccountBrokenByHealth(id), false);
    assert.equal(getAccountHealth(id).initFailCount, 0);
  } finally {
    cleanHealth([id]);
  }
});

test("broken-recovery: a multi-account init storm is systemic and never escalates", () => {
  const ids = ["broken-recovery-a", "broken-recovery-b", "broken-recovery-c", "broken-recovery-d"];
  cleanHealth(ids);
  try {
    const systemicBefore = getSystemicInitFailureCount();
    // Two distinct accounts still count (isolated failures).
    noteAccountInitFailure(ids[0]);
    noteAccountInitFailure(ids[1]);
    assert.equal(getAccountHealth(ids[0]).initFailCount, 1);
    assert.equal(getAccountHealth(ids[1]).initFailCount, 1);
    // The third distinct account inside the window makes the cause systemic:
    // its failures are recorded but never escalate.
    noteAccountInitFailure(ids[2]);
    noteAccountInitFailure(ids[2]);
    assert.equal(getAccountHealth(ids[2]).initFailCount, 0);
    assert.equal(getSystemicInitFailureCount(), systemicBefore + 2);
    assert.equal(isAccountBrokenByHealth(ids[2]), false);
    // Permanent-auth evidence still escalates mid-storm (account-specific).
    recordAccountFailure(ids[3], "auth");
    noteAccountInitFailure(ids[3]);
    assert.equal(getAccountHealth(ids[3]).initFailCount, 1);
    // Nothing in the storm reached BROKEN.
    for (const id of ids) assert.equal(isAccountBrokenByHealth(id), false);
  } finally {
    cleanHealth(ids);
  }
});

test("broken-recovery: escalate -> idle age -> reconcile re-arms counter and flag", () => {
  const id = "broken-recovery-t3";
  cleanHealth([id]);
  try {
    breakAccount(id, BROKEN_INIT_FAIL_THRESHOLD + 1);
    markAccountBroken(id);
    assert.equal(isAccountBrokenByHealth(id), true);
    assert.equal(isAccountFlaggedBroken(id), true);

    // Still failing recently: the cause may be live — nothing is re-armed.
    const active = reconcileBrokenAccounts({ accounts: [{ id }] });
    assert.deepEqual(active.recovered, []);
    assert.deepEqual(active.skippedActive, [id]);
    assert.equal(getAccountHealth(id).initFailCount, BROKEN_INIT_FAIL_THRESHOLD + 1);

    // Quiet for longer than POOL_BROKEN_RECOVERY_AGE_MS: re-armed with a
    // fresh, bounded attempt budget.
    const ageMs = getBrokenRecoveryAgeMs();
    const recovered = reconcileBrokenAccounts({
      accounts: [{ id }],
      now: Date.now() + ageMs + 60_000,
    });
    assert.deepEqual(recovered.recovered, [id]);
    assert.equal(getAccountHealth(id).initFailCount, 0);
    assert.equal(isAccountFlaggedBroken(id), false);
    assert.equal(isAccountBrokenByHealth(id), false);

    // The fresh budget is bounded again: threshold failures re-break it.
    breakAccount(id);
    assert.equal(isAccountBrokenByHealth(id), true);
  } finally {
    clearAccountBroken(id);
    cleanHealth([id]);
  }
});

test("broken-recovery: permanent-auth accounts are never auto-recovered", () => {
  const id = "broken-recovery-t4";
  cleanHealth([id]);
  try {
    // Permanent evidence: the auth ledger recorded a hard auth rejection.
    recordAccountFailure(id, "auth");
    breakAccount(id);
    markAccountBroken(id);
    assert.equal(isAccountBrokenByHealth(id), true);

    const report = reconcileBrokenAccounts({
      accounts: [{ id }],
      now: Date.now() + 24 * 60 * 60_000,
    });
    assert.deepEqual(report.recovered, []);
    assert.deepEqual(report.skippedPermanent, [id]);
    assert.equal(getAccountHealth(id).initFailCount, BROKEN_INIT_FAIL_THRESHOLD);
    assert.equal(isAccountFlaggedBroken(id), true);
    assert.equal(isAccountBrokenByHealth(id), true);

    // Only a genuine successful init clears it.
    noteAccountInitSuccess(id);
    clearAccountBroken(id);
    assert.equal(isAccountBrokenByHealth(id), false);
  } finally {
    clearAccountBroken(id);
    cleanHealth([id]);
  }
});

test("broken-recovery: a FAILED-parked account is requeued to STANDBY", async () => {
  const id = "broken-recovery-t5";
  const other = "broken-recovery-t5-other";
  cleanHealth([id, other]);
  const ownership = new AccountResourceManager();
  setAccountOwnership(ownership);
  try {
    ownership.registerAccount(id, { accountId: id, disabled: false });
    ownership.registerAccount(other, { accountId: other, disabled: false });
    ownership.transition(
      id,
      "FAILED",
      { leaseId: "system", ownerToken: "system" },
      "warmup-exhausted",
    );
    assert.equal(ownership.getAccountStatus(id), "FAILED");

    breakAccount(id);
    const ageMs = getBrokenRecoveryAgeMs();
    const report = reconcileBrokenAccounts({
      accounts: [{ id }, { id: other }],
      now: Date.now() + ageMs + 60_000,
    });
    assert.deepEqual(report.recovered, [id]);
    assert.equal(ownership.getAccountStatus(id), "STANDBY");
    assert.equal(ownership.getAccountStatus(other), "STANDBY");
  } finally {
    resetAccountOwnershipForTests();
    cleanHealth([id, other]);
  }
});

test("broken-recovery: a warmup-exhausted account warms again once its failure record is cleared", async () => {
  const id = "broken-recovery-t6";
  cleanHealth([id]);
  const ownership = new AccountResourceManager({ targetReady: 1 });
  setAccountOwnership(ownership);
  const controller = new ReadinessController(
    ownership,
    {
      targetReady: 1,
      warmupConcurrency: 1,
      warmupTimeoutMs: 0,
      maxWarmupFailures: 1,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
    },
    { warmWarmup: async () => "failed" },
  );
  try {
    ownership.registerAccount(id, { accountId: id, disabled: false });

    const first = await controller.tick();
    assert.deepEqual(first.launched, [id]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Mirrors `recoverAccount(id, "warmup-exhausted")` parking the account.
    ownership.transition(
      id,
      "FAILED",
      { leaseId: "system", ownerToken: "system" },
      "warmup-exhausted",
    );
    breakAccount(id);

    const ageMs = getBrokenRecoveryAgeMs();
    const report = reconcileBrokenAccounts({
      accounts: [{ id }],
      now: Date.now() + ageMs + 60_000,
    });
    assert.deepEqual(report.recovered, [id]);
    assert.equal(ownership.getAccountStatus(id), "STANDBY");

    // Without clearing the controller record the requeued account is still
    // `exhausted` and every pass skips it: BROKEN is gone but nothing warms.
    const stillSkipped = await controller.tick();
    assert.deepEqual(stillSkipped.launched, []);

    // construct.ts clears the record for every recovered account.
    controller.clearWarmupFailureState(id);
    const relaunched = await controller.tick();
    assert.deepEqual(relaunched.launched, [id]);
  } finally {
    controller.stop();
    resetAccountOwnershipForTests();
    cleanHealth([id]);
  }
});
