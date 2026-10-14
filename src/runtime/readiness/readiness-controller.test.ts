import test from "node:test";
import assert from "node:assert/strict";

import { ReadinessController } from "./readiness-controller.ts";
import type { IAccountOwnership } from "../contracts.ts";
import type { AccountStatus } from "../../domain/types.ts";

interface FakeAccount {
  status: AccountStatus;
  disabled: boolean;
  cooldownUntil: number;
}

class FakeOwnership implements IAccountOwnership {
  accounts = new Map<string, FakeAccount>();
  recoverCalls: string[] = [];
  private readiness: ReadinessController | null = null;

  attach(c: ReadinessController): void {
    this.readiness = c;
  }

  register(id: string, status: AccountStatus = "STANDBY"): void {
    this.accounts.set(id, {
      status,
      disabled: false,
      cooldownUntil: 0,
    });
  }

  acquire(): never {
    throw new Error("not used");
  }
  release(): never {
    throw new Error("not used");
  }
  transition(): never {
    throw new Error("not used");
  }
  async markStaleAndFence(): Promise<never> {
    throw new Error("not used");
  }
  isLegallyUsable(): never {
    throw new Error("not used");
  }
  getOwnership(): never {
    throw new Error("not used");
  }

  getAccountStatus(id: string): AccountStatus {
    return this.accounts.get(id)?.status ?? "STANDBY";
  }

  listAccountsByStatus(status: AccountStatus): string[] {
    return [...this.accounts.entries()]
      .filter(([, a]) => a.status === status)
      .map(([id]) => id);
  }

  getPoolSnapshot() {
    const byStatus: Partial<Record<AccountStatus, number>> = {};
    for (const a of this.accounts.values()) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    }
    return {
      byStatus,
      ready: byStatus.READY ?? 0,
      warming: byStatus.WARMING ?? 0,
      reserved: byStatus.RESERVED ?? 0,
      generating: byStatus.GENERATING ?? 0,
      cooldown: byStatus.COOLDOWN ?? 0,
      failed: byStatus.FAILED ?? 0,
      target: 4,
    };
  }

  registerAccount(): void {}
  setDraining(): void {}
  setCooldownUntil(): void {}
  isCoolingDown(): boolean {
    return false;
  }
  reapExpiredCooldowns(): number {
    return 0;
  }

  async recoverAccount(id: string, reason: string): Promise<void> {
    this.recoverCalls.push(id);
    const a = this.accounts.get(id);
    if (a && reason === "warmup-exhausted") a.status = "FAILED";
  }
}

function makePool(n: number): FakeOwnership {
  const own = new FakeOwnership();
  for (let i = 1; i <= n; i++) own.register(`acct${i}`);
  return own;
}

/** Let pending microtasks/timers flush so background warmups settle. */
function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("deficit convergence: ready=2, warming=0, target=4, concurrency=2 launches 2", async () => {
  const own = makePool(10);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "READY";
  let warmups = 0;
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 2, warmupTimeoutMs: 1000 },
    {
      warmWarmup: async (id) => {
        warmups += 1;
        own.accounts.get(id)!.status = "READY";
        return "ready";
      },
      jitter: () => 0,
    },
  );

  const report = await ctrl.tick();
  assert.equal(report.launched.length, 2);
  await settle();
  assert.equal(warmups, 2);
  assert.equal(own.getPoolSnapshot().ready, 4, "two warmups land the pool at target");
});

test("ready=2, warming=2 launches 0 (no work when target satisfied)", async () => {
  const own = makePool(10);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "READY";
  let warmups = 0;
  // Warmups that stay in-flight (gated), so the pool really has warming=2.
  const gates = new Map<string, () => void>();
  const pending = new Map<string, Promise<"ready">>();
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 2, warmupTimeoutMs: 10_000 },
    {
      warmWarmup: (id) => {
        warmups += 1;
        const p = new Promise<"ready">((resolve) => {
          gates.set(id, () => {
            own.accounts.get(id)!.status = "READY";
            resolve("ready");
          });
        });
        pending.set(id, p);
        return p;
      },
      jitter: () => 0,
    },
  );
  // Pre-seed two in-flight warmups.
  const first = await ctrl.tick();
  assert.equal(first.launched.length, 2);
  for (const id of first.launched) {
    assert.ok(pending.has(id), `${id} must still be in-flight`);
  }

  const report = await ctrl.tick();
  assert.equal(report.launched.length, 0, "target satisfied by in-flight jobs");
  assert.equal(warmups, 2, "no new warmups while two are already warming");

  for (const g of gates.values()) g();
  await settle();
});

test("after one succeeds (ready=3, warming=1) exactly one more is launched", async () => {
  const own = makePool(10);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "READY";
  own.accounts.get("acct3")!.status = "READY";
  let warmups = 0;
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 2 },
    {
      warmWarmup: async (id) => {
        warmups += 1;
        own.accounts.get(id)!.status = "READY";
        return "ready";
      },
      jitter: () => 0,
    },
  );
  const report = await ctrl.tick();
  assert.equal(report.launched.length, 1);
  await settle();
  assert.equal(own.getPoolSnapshot().ready, 4);
});

test("once ready >= target, zero launches", async () => {
  const own = makePool(10);
  for (const id of ["acct1", "acct2", "acct3", "acct4", "acct5"]) {
    own.accounts.get(id)!.status = "READY";
  }
  let warmups = 0;
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 2 },
    {
      warmWarmup: async () => {
        warmups += 1;
        return "ready";
      },
      jitter: () => 0,
    },
  );
  const report = await ctrl.tick();
  assert.equal(report.launched.length, 0);
  assert.equal(warmups, 0);
});

test("44-account pool, target 4, concurrency 2: at most 2 jobs globally and 1 per account", async () => {
  const own = makePool(44);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "READY";
  let maxConcurrent = 0;
  let live = 0;
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 2 },
    {
      warmWarmup: async (id) => {
        live += 1;
        maxConcurrent = Math.max(maxConcurrent, live);
        await new Promise((r) => setTimeout(r, 20));
        own.accounts.get(id)!.status = "READY";
        live -= 1;
        return "ready";
      },
      jitter: () => 0,
    },
  );
  const first = await ctrl.tick();
  assert.equal(first.launched.length, 2);
  // A second tick while those are still warming must not add more.
  const second = await ctrl.tick();
  assert.equal(second.launched.length, 0, "no duplicate warmups while in flight");
  assert.ok(maxConcurrent <= 2, `maxConcurrent ${maxConcurrent} must be <= 2`);
});

test("RECOVERING accounts are warmup candidates (no stranding after context death)", async () => {
  const own = makePool(4);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "RECOVERING";
  own.accounts.get("acct3")!.status = "RECOVERING";
  const launched: string[] = [];
  const ctrl = new ReadinessController(
    own,
    {
      targetReady: 5,
      warmupConcurrency: 2,
      warmupTimeoutMs: 1000,
      maxWarmupFailures: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    },
    {
      warmWarmup: async (id) => {
        launched.push(id);
        return "failed";
      },
      jitter: () => 0,
    },
  );
  // ready=1, recovering=2 (counted as warming), deficit=2: one STANDBY plus
  // one RECOVERING launch. RECOVERING accounts must be launchable, not stranded.
  const report = await ctrl.tick();
  assert.ok(
    report.launched.includes("acct2") || report.launched.includes("acct3"),
    `expected a RECOVERING launch, got ${JSON.stringify(report.launched)}`,
  );
  await settle(50);
  assert.ok(launched.length >= 1, "RECOVERING warmup must actually run");
});

test("warmup timeout force-terminates and counts a failure", async () => {
  const own = makePool(4);
  let terminated = 0;
  const ctrl = new ReadinessController(
    own,
    {
      targetReady: 4,
      warmupConcurrency: 1,
      warmupTimeoutMs: 10,
      maxWarmupFailures: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
    },
    {
      warmWarmup: async () => new Promise<"ready">(() => {}),
      terminateWarmup: async () => {
        terminated += 1;
      },
      jitter: () => 0,
    },
  );
  const report = await ctrl.tick();
  assert.equal(report.launched.length, 1);
  await settle(100);
  assert.ok(terminated >= 1, "timed-out warmup must be force-terminated");
  assert.equal(own.recoverCalls.length, 0, "first failure should not exhaust");
});

test("after maxWarmupFailures an account is FAILED and never re-warmed", async () => {
  const own = makePool(2);
  const callsByAccount = new Map<string, number>();
  const ctrl = new ReadinessController(
    own,
    {
      targetReady: 2,
      warmupConcurrency: 1,
      warmupTimeoutMs: 1000,
      maxWarmupFailures: 2,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    },
    {
      warmWarmup: async (id) => {
        callsByAccount.set(id, (callsByAccount.get(id) ?? 0) + 1);
        return "failed";
      },
      jitter: () => 0,
    },
  );
  for (let i = 0; i < 6; i++) {
    await ctrl.tick();
    await settle();
  }
  // maxWarmupFailures is PER ACCOUNT: each of the 2 accounts may be tried at
  // most twice before being marked FAILED. Total <= 2 * maxWarmupFailures.
  const total = [...callsByAccount.values()].reduce((a, b) => a + b, 0);
  assert.ok(
    total <= 2 * 2,
    `permanently broken accounts must not loop: total=${total}`,
  );
  for (const [id, n] of callsByAccount) {
    assert.ok(n <= 2, `${id} exceeded its failure budget: ${n}`);
  }
  assert.deepEqual(own.recoverCalls.sort(), ["acct1", "acct2"]);
  assert.equal(own.getAccountStatus("acct1"), "FAILED");
  assert.equal(own.getAccountStatus("acct2"), "FAILED");
});

test("a temporarily failing account can re-enter readiness after backoff", async () => {
  const own = makePool(2);
  let attempt = 0;
  const ctrl = new ReadinessController(
    own,
    {
      targetReady: 2,
      warmupConcurrency: 1,
      warmupTimeoutMs: 1000,
      maxWarmupFailures: 5,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
    },
    {
      warmWarmup: async (id) => {
        attempt += 1;
        if (attempt === 1) return "failed";
        own.accounts.get(id)!.status = "READY";
        return "ready";
      },
      jitter: () => 0,
    },
  );
  const r1 = await ctrl.tick();
  assert.equal(r1.launched.length, 1);
  await settle();
  assert.equal(own.getAccountStatus("acct1"), "STANDBY");
  const r2 = await ctrl.tick();
  await settle();
  assert.equal(r2.launched.length, 1, "backoff expired -> re-warmed");
  assert.equal(own.getAccountStatus(r2.launched[0] ?? ""), "READY");
});

test("recovery in progress counts as warming: no second initializer", async () => {
  const own = makePool(4);
  own.accounts.get("acct1")!.status = "RECOVERING";
  const warmed = new Set<string>();
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 2 },
    {
      warmWarmup: async (id) => {
        warmed.add(id);
        return "ready";
      },
      jitter: () => 0,
    },
  );
  await ctrl.tick();
  assert.ok(
    !warmed.has("acct1"),
    "a recovering account must never be selected for warmup",
  );
});

test("warmup circuit breaker parks an account that never succeeds, and a success clears it", async () => {
  const own = makePool(1);
  const ctrl = new ReadinessController(
    own,
    {
      targetReady: 1,
      warmupConcurrency: 1,
      warmupTimeoutMs: 0,
      maxWarmupFailures: 1,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      maxFailedWarmupEras: 2,
      failedEraSkipBaseMs: 60_000,
      failedEraSkipMaxMs: 600_000,
    },
    {
      warmWarmup: async () => "failed",
      jitter: () => 0,
    },
  );

  // Era 1: the single attempt fails, exhausts, and BROKEN recovery re-arms the
  // account with a fresh budget — exactly what construct.ts does every tick.
  await ctrl.tick();
  await settle();
  own.accounts.get("acct1")!.status = "STANDBY";
  ctrl.clearWarmupFailureState("acct1");

  // Era 2 crosses the threshold and parks the account.
  await ctrl.tick();
  await settle();
  own.accounts.get("acct1")!.status = "STANDBY";
  ctrl.clearWarmupFailureState("acct1");

  const breakers = ctrl.getWarmupCircuitBreakers();
  assert.equal(breakers[0]?.accountId, "acct1");
  assert.equal(breakers[0]?.eras, 2);
  assert.equal(breakers[0]?.parked, true, "two failed eras must park the account");

  // Re-armed and record-cleared, it is still never launched: a WAF-blocked or
  // dead-credential account stops spending a ~450MB Chromium context per cycle.
  const parked = await ctrl.tick();
  assert.deepEqual(parked.launched, [], "a parked account must not launch a browser");
  assert.ok(parked.skipped.includes("acct1"));

  // Operator escape hatch un-parks it.
  ctrl.clearWarmupCircuitBreaker("acct1");
  const resumed = await ctrl.tick();
  assert.deepEqual(resumed.launched, ["acct1"]);
});

test("breaker disabled by maxFailedWarmupEras=0 keeps the old re-arm behaviour", async () => {
  const own = makePool(1);
  const ctrl = new ReadinessController(
    own,
    {
      targetReady: 1,
      warmupConcurrency: 1,
      warmupTimeoutMs: 0,
      maxWarmupFailures: 1,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      maxFailedWarmupEras: 0,
    },
    {
      warmWarmup: async () => "failed",
      jitter: () => 0,
    },
  );
  for (let era = 0; era < 4; era++) {
    await ctrl.tick();
    await settle();
    own.accounts.get("acct1")!.status = "STANDBY";
    ctrl.clearWarmupFailureState("acct1");
  }
  assert.equal(ctrl.getWarmupCircuitBreakers().length, 0);
  const stillLaunched = await ctrl.tick();
  assert.deepEqual(stillLaunched.launched, ["acct1"], "breaker off = old behaviour");
});

test("overlapping ticks are coalesced into one pass plus a trailing re-check", async () => {
  const own = makePool(4);
  let passes = 0;
  const ctrl = new ReadinessController(
    own,
    { targetReady: 4, warmupConcurrency: 1 },
    {
      warmWarmup: async (id) => {
        passes += 1;
        await new Promise((r) => setTimeout(r, 20));
        own.accounts.get(id)!.status = "READY";
        return "ready";
      },
      jitter: () => 0,
    },
  );
  const [a, b] = await Promise.all([ctrl.tick(), ctrl.tick()]);
  assert.equal(passes, 1, "the second concurrent tick must not run a new pass");
  assert.equal(a.launched.length, 1);
  assert.equal(b.launched.length, 0);
});

// Regression for the warmup double-count ("stops midway" freeze). The other
// fakes never move an account to WARMING status, so they cannot catch a bug in
// the deficit term — they only exercise the concurrency clamp. This one mimics
// production `warmAccount`: a launched account holds WARMING status while
// in-flight, so `snapshot.warming` already includes it. With 2 in-flight and 2
// free concurrency slots the controller MUST launch 2 more, not 0.
test("in-flight WARMING-status accounts must not shrink the launch budget", async () => {
  const own = makePool(12);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "READY";
  const gates: Array<() => void> = [];
  const ctrl = new ReadinessController(
    own,
    { targetReady: 8, warmupConcurrency: 4, warmupTimeoutMs: 10_000 },
    {
      warmWarmup: (id) => {
        own.accounts.get(id)!.status = "WARMING";
        return new Promise<"ready">((resolve) => {
          gates.push(() => {
            own.accounts.get(id)!.status = "READY";
            resolve("ready");
          });
        });
      },
      jitter: () => 0,
    },
  );
  // Tick 1: ready=2, warming=0 → deficit 6, slots min(6,4)=4 → launch 4.
  const t1 = await ctrl.tick();
  assert.equal(t1.launched.length, 4);
  // Settle 2 of the 4: ready=4, 2 still WARMING + in-flight, 2 free slots.
  gates.splice(0, 2).forEach((g) => g());
  await settle();
  // Tick 2: correct warming=2 → deficit 8-4-2=2 → launch 2 (fills free slots).
  // The double-count bug would compute warming=4 → deficit 0 → launch 0, leaving
  // the pool frozen at 4 ready with 2 concurrency slots idle forever.
  const t2 = await ctrl.tick();
  assert.equal(t2.launched.length, 2, "must fill every free concurrency slot");
  gates.forEach((g) => g());
  await settle();
  assert.equal(own.getPoolSnapshot().ready, 8, "pool converges to target");
});
