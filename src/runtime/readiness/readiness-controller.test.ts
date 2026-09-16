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
