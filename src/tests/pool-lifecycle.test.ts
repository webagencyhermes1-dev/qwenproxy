import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AccountResourceManager } from "../runtime/account/resource-manager.ts";

const SYSTEM_FENCE = { leaseId: "system", ownerToken: "system" };

function fresh(): AccountResourceManager {
  return new AccountResourceManager();
}

function register(mgr: AccountResourceManager, id: string): void {
  mgr.registerAccount(id, { accountId: id, disabled: false, cooldownUntil: 0, cooldownReason: null });
}

describe("AccountResourceManager pool lifecycle", () => {
  it("Account transitions STANDBY -> WARMING -> READY on successful warmup", () => {
    const mgr = fresh();
    register(mgr, "a1");
    assert.equal(mgr.getAccountStatus("a1"), "STANDBY");

    const t1 = mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");
    assert.equal(t1.transitioned, true);
    assert.equal(mgr.getAccountStatus("a1"), "WARMING");

    const t2 = mgr.transition("a1", "READY", SYSTEM_FENCE, "warmup-done");
    assert.equal(t2.transitioned, true);
    assert.equal(mgr.getAccountStatus("a1"), "READY");
  });

  it("Account in COOLDOWN is not eligible for generation", () => {
    const mgr = fresh();
    mgr.registerAccount("a1", { accountId: "a1", disabled: false, cooldownUntil: Date.now() + 600_000, cooldownReason: "rate-limit" });
    assert.equal(mgr.getAccountStatus("a1"), "COOLDOWN");

    const decision = mgr.isLegallyUsable("a1", { purpose: "generation" });
    assert.equal(decision.usable, false);
    assert.equal(decision.errorCode, "ACCOUNT_COOLDOWN");
  });

  it("Account in WARMING is not eligible for generation purpose", () => {
    const mgr = fresh();
    register(mgr, "a1");
    mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");

    const decision = mgr.isLegallyUsable("a1", { purpose: "generation" });
    assert.equal(decision.usable, false);
    assert.equal(decision.reason, "warming");
  });

  it("Account in STANDBY is not eligible for generation purpose", () => {
    const mgr = fresh();
    register(mgr, "a1");

    const decision = mgr.isLegallyUsable("a1", { purpose: "generation" });
    assert.equal(decision.usable, false);
    assert.equal(decision.reason, "standby:not-warmed");
  });

  it("READY account can be acquired for generation", () => {
    const mgr = fresh();
    register(mgr, "a1");
    mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a1", "READY", SYSTEM_FENCE, "warmup-done");

    const result = mgr.acquire({
      generationId: "gen_1",
      candidates: ["a1"],
      deadline: Date.now() + 30_000,
      requirements: { purpose: "generation", generationId: "gen_1" },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accountId, "a1");
      assert.equal(mgr.getAccountStatus("a1"), "RESERVED");
    }
  });

  it("acquire returns DEADLINE_EXPIRED when deadline is in the past", () => {
    const mgr = fresh();
    register(mgr, "a1");
    mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a1", "READY", SYSTEM_FENCE, "warmup-done");

    const result = mgr.acquire({
      generationId: "gen_1",
      candidates: ["a1"],
      deadline: Date.now() - 1000,
      requirements: { purpose: "generation", generationId: "gen_1" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failureCode, "DEADLINE_EXPIRED");
    }
  });

  it("release with wrong ownerToken returns stale", () => {
    const mgr = fresh();
    register(mgr, "a1");
    mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a1", "READY", SYSTEM_FENCE, "warmup-done");

    const acquired = mgr.acquire({
      generationId: "gen_1",
      candidates: ["a1"],
      deadline: Date.now() + 30_000,
      requirements: { purpose: "generation", generationId: "gen_1" },
    });
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;

    const result = mgr.release({
      leaseId: acquired.lease.leaseId,
      ownerToken: "wrong-token",
      outcome: "completed",
    });
    assert.equal(result.released, false);
    assert.equal(result.stale, true);
  });

  it("transition with active lease is rejected for system fence", () => {
    const mgr = fresh();
    register(mgr, "a1");
    mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a1", "READY", SYSTEM_FENCE, "warmup-done");

    const acquired = mgr.acquire({
      generationId: "gen_1",
      candidates: ["a1"],
      deadline: Date.now() + 30_000,
      requirements: { purpose: "generation", generationId: "gen_1" },
    });
    assert.equal(acquired.ok, true);

    const result = mgr.transition("a1", "COOLDOWN", SYSTEM_FENCE, "force-cooldown");
    assert.equal(result.transitioned, false);
    assert.equal(result.stale, true);
  });

  it("Pool snapshot reports correct counts by status", () => {
    const mgr = fresh();
    register(mgr, "a1");
    register(mgr, "a2");
    register(mgr, "a3");
    mgr.transition("a2", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a3", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a3", "READY", SYSTEM_FENCE, "warmup-done");

    const snap = mgr.getPoolSnapshot();
    assert.equal(snap.byStatus.STANDBY, 1);
    assert.equal(snap.byStatus.WARMING, 1);
    assert.equal(snap.byStatus.READY, 1);
    assert.equal(snap.ready, 1);
    assert.equal(snap.warming, 1);
  });

  it("recoverAccount transitions to RECOVERING", async () => {
    const mgr = fresh();
    register(mgr, "a1");
    mgr.transition("a1", "WARMING", SYSTEM_FENCE, "warmup-start");
    mgr.transition("a1", "READY", SYSTEM_FENCE, "warmup-done");

    await mgr.recoverAccount("a1", "test-recovery");
    assert.equal(mgr.getAccountStatus("a1"), "RECOVERING");
  });

  it("Cooldown expiry auto-clears to STANDBY", () => {
    const mgr = fresh();
    mgr.registerAccount("a1", { accountId: "a1", disabled: false, cooldownUntil: Date.now() + 600_000, cooldownReason: "rate-limit" });
    assert.equal(mgr.getAccountStatus("a1"), "COOLDOWN");

    mgr.registerAccount("a1", { accountId: "a1", disabled: false, cooldownUntil: 1, cooldownReason: null });
    assert.equal(mgr.getAccountStatus("a1"), "COOLDOWN");

    const decision = mgr.isLegallyUsable("a1", { purpose: "warmup" });
    assert.equal(decision.usable, true);
    assert.equal(mgr.getAccountStatus("a1"), "STANDBY");
  });
});
