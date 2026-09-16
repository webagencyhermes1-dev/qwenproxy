import test from "node:test";
import assert from "node:assert/strict";

import { AccountResourceManager } from "./resource-manager.ts";
import type { AcquireLeaseRequest, AcquireLeaseResult } from "../contracts.ts";
import type { AccountLease } from "../../domain/types.ts";

function mk(
  candidates: string[],
  generationId: string,
  deadline = Date.now() + 60_000,
): AcquireLeaseRequest {
  return {
    generationId,
    candidates,
    deadline,
    requirements: { purpose: "generation", generationId },
  };
}

/** A fresh account is STANDBY; generation claims require a READY account. */
function registerReady(mgr: AccountResourceManager, id: string): void {
  mgr.registerAccount(id, {
    accountId: id,
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
  });
  mgr.transition(id, "WARMING", { leaseId: "system", ownerToken: "system" });
  mgr.transition(id, "READY", { leaseId: "system", ownerToken: "system" });
}

function leaseOf(r: AcquireLeaseResult): AccountLease {
  assert.ok(r.ok, "acquire must succeed");
  return (r as { ok: true; lease: AccountLease }).lease;
}

test("two concurrent acquires with overlapping candidates: exactly one wins", async () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  registerReady(mgr, "a2");

  // Both requests see the same candidate list and must not both claim a1.
  let resolveA!: (v: unknown) => void;
  let resolveB!: (v: unknown) => void;
  const gateA = new Promise((r) => {
    resolveA = r;
  });
  const gateB = new Promise((r) => {
    resolveB = r;
  });

  const acquired: string[] = [];
  const run = async (gen: string, gate: Promise<unknown>) => {
    await gate;
    const res = mgr.acquire(mk(["a1", "a2"], gen));
    if (res.ok) acquired.push(res.accountId);
  };
  const pA = run("genA", gateA);
  const pB = run("genB", gateB);
  resolveA(undefined);
  resolveB(undefined);
  await Promise.all([pA, pB]);

  assert.equal(acquired.length, 2, "both should find an account, never the same one");
  assert.equal(acquired.filter((a) => a === "a1").length, 1, "a1 claimed exactly once");
  assert.deepEqual([...new Set(acquired)].sort(), ["a1", "a2"]);
});

test("stale release is rejected and the current owner is untouched", () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");

  const leaseA = leaseOf(mgr.acquire(mk(["a1"], "genA")));

  // A releases cleanly, then B acquires.
  const rel = mgr.release({
    leaseId: leaseA.leaseId,
    ownerToken: leaseA.ownerToken,
    outcome: "completed",
  });
  assert.equal(rel.released, true);

  const leaseB = leaseOf(mgr.acquire(mk(["a1"], "genB")));

  // A's old token must be rejected; B remains the owner.
  const stale = mgr.release({
    leaseId: leaseA.leaseId,
    ownerToken: leaseA.ownerToken,
    outcome: "completed",
  });
  assert.equal(stale.released, false);
  assert.equal(stale.stale, true);

  const own = mgr.getOwnership("a1");
  assert.equal(own.lease?.leaseId, leaseB.leaseId);
  assert.equal(own.lease?.ownerToken, leaseB.ownerToken);
  assert.equal(own.fencingEpoch > 1, true);
});

test("double release with the same token is a no-op, not an error", () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  const lease = leaseOf(mgr.acquire(mk(["a1"], "genA")));

  const first = mgr.release({
    leaseId: lease.leaseId,
    ownerToken: lease.ownerToken,
    outcome: "completed",
  });
  const second = mgr.release({
    leaseId: lease.leaseId,
    ownerToken: lease.ownerToken,
    outcome: "completed",
  });
  assert.equal(first.released, true);
  assert.equal(second.released, false);
  assert.equal(second.stale, true);
  assert.equal(mgr.getOwnership("a1").lease, null);
});

test("a busy account is never usable regardless of health inputs", () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  leaseOf(mgr.acquire(mk(["a1"], "genA")));

  const d = mgr.isLegallyUsable("a1", {
    purpose: "generation",
    generationId: "genB",
  });
  assert.equal(d.usable, false);
  assert.equal(d.errorCode, "ACCOUNT_UNAVAILABLE");

  // The SAME generation re-entrantly can still use its own account.
  const same = mgr.isLegallyUsable("a1", {
    purpose: "generation",
    generationId: "genA",
  });
  assert.equal(same.usable, true);
});

test("an unwarmed STANDBY account is not usable for generation", () => {
  const mgr = new AccountResourceManager();
  mgr.registerAccount("a1", {
    accountId: "a1",
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
  });
  const d = mgr.isLegallyUsable("a1", { purpose: "generation" });
  assert.equal(d.usable, false);
  assert.equal(d.errorCode, "ACCOUNT_INITIALIZATION_FAILED");

  // But maintenance (warmup) may claim it to initialize it.
  const maint = mgr.isLegallyUsable("a1", { purpose: "maintenance" });
  assert.equal(maint.usable, true);
});

test("expired cooldown is not persisted as active on register", () => {
  const mgr = new AccountResourceManager();
  const past = Date.now() - 1_000;
  mgr.registerAccount("a1", {
    accountId: "a1",
    disabled: false,
    cooldownUntil: past,
    cooldownReason: "rate-limit",
  });
  // A past cooldown is already expired: the account registers as STANDBY
  // (uninitialized) and never blocks as ACCOUNT_COOLDOWN.
  assert.equal(mgr.getAccountStatus("a1"), "STANDBY");
  const d = mgr.isLegallyUsable("a1", { purpose: "generation" });
  assert.equal(d.usable, false);
  assert.notEqual(d.errorCode, "ACCOUNT_COOLDOWN");
});

test("unexpired cooldown blocks generation with ACCOUNT_COOLDOWN", () => {
  const mgr = new AccountResourceManager();
  const future = Date.now() + 10_000;
  mgr.registerAccount("a1", {
    accountId: "a1",
    disabled: false,
    cooldownUntil: future,
    cooldownReason: "rate-limit",
  });
  const d = mgr.isLegallyUsable("a1", { purpose: "generation" });
  assert.equal(d.usable, false);
  assert.equal(d.errorCode, "ACCOUNT_COOLDOWN");
});

test("markStaleAndFence fences a non-finishing owner to RECOVERING", async () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  const lease = leaseOf(mgr.acquire(mk(["a1"], "genA")));

  let cancellationCalls = 0;
  const result = await mgr.markStaleAndFence("a1", {
    graceMs: 5,
    deadline: Date.now() + 5_000,
    requestCancellation: async () => {
      cancellationCalls += 1;
      // Never releases the lease — simulating an orphaned operation.
    },
  });

  assert.equal(cancellationCalls, 1);
  assert.equal(result.fenced, true);
  assert.equal(result.invalidatedOwnerToken, lease.ownerToken);
  assert.equal(result.cleanExit, false);
  assert.equal(mgr.getAccountStatus("a1"), "RECOVERING");
  assert.equal(mgr.getOwnership("a1").lease, null);

  // The old token is now permanently invalid.
  const stale = mgr.release({
    leaseId: lease.leaseId,
    ownerToken: lease.ownerToken,
    outcome: "completed",
  });
  assert.equal(stale.released, false);
  assert.equal(stale.stale, true);
});

test("markStaleAndFence reports a clean exit when the owner releases in grace", async () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  const lease = leaseOf(mgr.acquire(mk(["a1"], "genA")));

  const result = await mgr.markStaleAndFence("a1", {
    graceMs: 50,
    deadline: Date.now() + 5_000,
    requestCancellation: async () => {
      mgr.release({
        leaseId: lease.leaseId,
        ownerToken: lease.ownerToken,
        outcome: "completed",
      });
    },
  });
  assert.equal(result.fenced, false);
  assert.equal(result.cleanExit, true);
  assert.equal(mgr.getAccountStatus("a1"), "READY");
});

test("illegal transition is rejected; DISABLED blocks generation", () => {
  const mgr = new AccountResourceManager();
  mgr.registerAccount("a1", {
    accountId: "a1",
    disabled: true,
    cooldownUntil: 0,
    cooldownReason: null,
  });
  assert.equal(mgr.getAccountStatus("a1"), "DISABLED");

  const d = mgr.isLegallyUsable("a1", { purpose: "generation" });
  assert.equal(d.usable, false);
  assert.equal(d.errorCode, "ACCOUNT_UNAVAILABLE");

  const t = mgr.transition(
    "a1",
    "GENERATING",
    { leaseId: "system", ownerToken: "system" },
  );
  assert.equal(t.transitioned, false);
  assert.equal(t.illegal, true);
});

test("a fenced transition cannot move a state the owner does not hold", () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  const lease = leaseOf(mgr.acquire(mk(["a1"], "genA")));

  // Wrong token cannot transition.
  const bad = mgr.transition(
    "a1",
    "GENERATING",
    { leaseId: lease.leaseId, ownerToken: "wrong" },
  );
  assert.equal(bad.transitioned, false);
  assert.equal(bad.stale, true);

  // Correct owner can transition.
  const good = mgr.transition(
    "a1",
    "GENERATING",
    { leaseId: lease.leaseId, ownerToken: lease.ownerToken },
  );
  assert.equal(good.transitioned, true);
  assert.equal(mgr.getAccountStatus("a1"), "GENERATING");
});

test("pool snapshot counts by status and reports the target", () => {
  const mgr = new AccountResourceManager({ targetReady: 4 });
  for (const id of ["a1", "a2", "a3"]) {
    mgr.registerAccount(id, {
      accountId: id,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    });
  }
  mgr.transition("a2", "WARMING", { leaseId: "system", ownerToken: "system" });
  mgr.transition("a3", "WARMING", { leaseId: "system", ownerToken: "system" });
  mgr.transition("a2", "READY", { leaseId: "system", ownerToken: "system" });

  const snap = mgr.getPoolSnapshot();
  assert.equal(snap.ready, 1);
  assert.equal(snap.warming, 1);
  assert.equal(snap.byStatus.STANDBY ?? 0, 1);
  assert.equal(snap.target, 4);
});

test("listAccountsByStatus and draining behavior", () => {
  const mgr = new AccountResourceManager();
  registerReady(mgr, "a1");
  registerReady(mgr, "a2");

  mgr.setDraining("a2", true);
  assert.equal(mgr.getAccountStatus("a2"), "DRAINING");

  const draining = mgr.listAccountsByStatus("DRAINING");
  assert.deepEqual(draining, ["a2"]);

  // A draining account is not usable for new generations.
  const d = mgr.isLegallyUsable("a2", { purpose: "generation" });
  assert.equal(d.usable, false);
  assert.equal(d.errorCode, "ACCOUNT_UNAVAILABLE");
});
