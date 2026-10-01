import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  getAccountOwnership,
  initAccountOwnership,
  resetAccountOwnershipForTests,
} from "../runtime/account/instance.ts";
import { acquireGenerationAccount } from "../runtime/gateway.ts";
import { clearAllHeadersReadyAccounts } from "../core/account-manager.ts";
import type { OwnershipFence } from "../runtime/contracts.ts";
import type { AccountLease } from "../domain/types.ts";

const ACCOUNTS = ["acc-a", "acc-b", "acc-c"];
const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };

function bindReadyPool(): void {
  const ownership = initAccountOwnership(
    ACCOUNTS.map((accountId) => ({
      accountId,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    })),
  );
  for (const id of ACCOUNTS) {
    ownership.transition(id, "WARMING", SYSTEM_FENCE, "test-warm");
    ownership.transition(id, "READY", SYSTEM_FENCE, "test-ready");
  }
}

function releaseLease(lease: AccountLease): void {
  getAccountOwnership().release({
    leaseId: lease.leaseId,
    ownerToken: lease.ownerToken,
    outcome: "completed",
  });
}

test("concurrent sessions: simultaneous gateway claims land on different accounts", async () => {
  bindReadyPool();
  try {
    // Two brand-new sessions fire their FIRST turns at the same moment. The
    // gateway claim is atomic (no await between eligibility and mutation), so
    // the loser can never double-book the winner's account.
    const [claimA, claimB] = await Promise.all([
      (async () =>
        acquireGenerationAccount({
          generationId: "sess-A",
          deadline: Date.now() + 60_000,
        }))(),
      (async () =>
        acquireGenerationAccount({
          generationId: "sess-B",
          deadline: Date.now() + 60_000,
        }))(),
    ]);

    assert.equal(claimA.ok, true);
    assert.equal(claimB.ok, true);
    if (!claimA.ok || !claimB.ok) return;
    assert.notEqual(
      claimA.accountId,
      claimB.accountId,
      `sessions A and B collided on ${claimA.accountId} during concurrent claims`,
    );

    // A third session that already tried both lands on the remaining account.
    const claimC = acquireGenerationAccount({
      generationId: "sess-C",
      triedAccountIds: new Set([claimA.accountId, claimB.accountId]),
      deadline: Date.now() + 60_000,
    });
    assert.equal(claimC.ok, true);
    if (claimC.ok) {
      const remaining = ACCOUNTS.filter(
        (id) => id !== claimA.accountId && id !== claimB.accountId,
      );
      assert.deepEqual([claimC.accountId], remaining);
      releaseLease(claimC.lease);
    }

    releaseLease(claimA.lease);
    releaseLease(claimB.lease);
  } finally {
    resetAccountOwnershipForTests();
    clearAllHeadersReadyAccounts();
  }
});
