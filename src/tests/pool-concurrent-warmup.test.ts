import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  ReadinessController,
  type WarmupOutcome,
} from "../runtime/readiness/readiness-controller.ts";
import type { IAccountOwnership, PoolSnapshot } from "../runtime/contracts.ts";
import type { AccountStatus } from "../domain/types.ts";

let clock = 0;

class FakeOwnership implements IAccountOwnership {
  accounts = new Map<string, AccountStatus>();

  register(id: string, status: AccountStatus = "STANDBY"): void {
    this.accounts.set(id, status);
  }

  mark(id: string, status: AccountStatus): void {
    this.accounts.set(id, status);
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
    return this.accounts.get(id) ?? "STANDBY";
  }

  listAccountsByStatus(status: AccountStatus): readonly string[] {
    return [...this.accounts.entries()]
      .filter(([, s]) => s === status)
      .map(([id]) => id);
  }

  getPoolSnapshot(): PoolSnapshot {
    const byStatus: Partial<Record<AccountStatus, number>> = {};
    for (const s of this.accounts.values()) {
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return {
      byStatus,
      ready: byStatus.READY ?? 0,
      warming: byStatus.WARMING ?? 0,
      reserved: byStatus.RESERVED ?? 0,
      generating: byStatus.GENERATING ?? 0,
      cooldown: byStatus.COOLDOWN ?? 0,
      failed: byStatus.FAILED ?? 0,
      target: 0,
    };
  }

  registerAccount(): void {}
  setDraining(): void {}

  async recoverAccount(accountId: string, reason: string): Promise<void> {}
}

function makePool(n: number): FakeOwnership {
  const own = new FakeOwnership();
  for (let i = 1; i <= n; i++) own.register(`acct${i}`);
  return own;
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pool concurrent warmup", () => {
  beforeEach(() => {
    clock = 0;
  });

  it("ReadinessController warms up to N accounts concurrently", async () => {
    const own = makePool(20);
    let launched = 0;
    const ctrl = new ReadinessController(
      own,
      { targetReady: 20, warmupConcurrency: 20, warmupTimeoutMs: 10_000 },
      {
        warmWarmup: () => {
          launched += 1;
          return new Promise<"ready">(() => {});
        },
        jitter: () => 0,
        now: () => clock,
      },
    );
    const report = await ctrl.tick();
    assert.equal(report.launched.length, 20);
    assert.equal(launched, 20, "all warmups must start in a single pass");
    assert.equal(ctrl.getInFlight().length, 20);
    ctrl.stop();
  });

  it("Single warmup failure does not block other warmups", async () => {
    const own = makePool(5);
    const failId = "acct3";
    const warmed = new Set<string>();
    const ctrl = new ReadinessController(
      own,
      {
        targetReady: 5,
        warmupConcurrency: 5,
        warmupTimeoutMs: 10_000,
        backoffBaseMs: 1,
        backoffMaxMs: 1,
      },
      {
        warmWarmup: async (id) => {
          if (id === failId) throw new Error("warmup failed");
          warmed.add(id);
          own.mark(id, "READY");
          return "ready";
        },
        jitter: () => 0,
        now: () => clock,
      },
    );
    const report = await ctrl.tick();
    assert.equal(report.launched.length, 5);
    await settle();
    assert.equal(warmed.size, 4);
    assert.ok(!warmed.has(failId));
    assert.equal(own.getPoolSnapshot().ready, 4);
    assert.equal(own.getAccountStatus(failId), "STANDBY");
    assert.equal(ctrl.getInFlight().length, 0);
    ctrl.stop();
  });

  it("Warmup concurrency is bounded by configured limit", async () => {
    const own = makePool(10);
    let live = 0;
    let maxLive = 0;
    const gates = new Map<string, () => void>();
    const ctrl = new ReadinessController(
      own,
      { targetReady: 10, warmupConcurrency: 3, warmupTimeoutMs: 10_000 },
      {
        warmWarmup: (id) => {
          live += 1;
          maxLive = Math.max(maxLive, live);
          return new Promise<"ready">((resolve) => {
            gates.set(id, () => {
              live -= 1;
              own.mark(id, "READY");
              resolve("ready");
            });
          });
        },
        jitter: () => 0,
        now: () => clock,
      },
    );
    const first = await ctrl.tick();
    assert.equal(first.launched.length, 3);
    assert.equal(live, 3);
    assert.equal(ctrl.getInFlight().length, 3);
    const second = await ctrl.tick();
    assert.equal(second.launched.length, 0, "no slots while the limit is in flight");
    assert.equal(live, 3);
    const gate = gates.get(first.launched[0]);
    assert.ok(gate);
    gate();
    await settle();
    assert.equal(live, 2);
    const third = await ctrl.tick();
    assert.equal(third.launched.length, 1, "one slot frees when a warmup settles");
    assert.equal(live, 3);
    assert.ok(maxLive <= 3, `maxLive ${maxLive} must never exceed the limit`);
    ctrl.stop();
  });

  it("Timed-out warmup cannot publish stale state", async () => {
    const own = makePool(1);
    const id = "acct1";
    const terminated = new Set<string>();
    let published = 0;
    const ctrl = new ReadinessController(
      own,
      {
        targetReady: 1,
        warmupConcurrency: 1,
        warmupTimeoutMs: 50,
        maxWarmupFailures: 3,
        backoffBaseMs: 1000,
        backoffMaxMs: 1000,
      },
      {
        warmWarmup: (accountId) =>
          new Promise<"ready">((resolve) => {
            const timer = setTimeout(() => {
              if (terminated.has(accountId)) return;
              published += 1;
              own.mark(accountId, "READY");
              resolve("ready");
            }, 200);
            timer.unref?.();
          }),
        terminateWarmup: (accountId) => {
          terminated.add(accountId);
        },
        jitter: () => 0,
        now: () => clock,
      },
    );
    const report = await ctrl.tick();
    assert.equal(report.launched.length, 1);
    await settle(120);
    assert.equal(ctrl.getInFlight().length, 0, "timed-out warmup must settle");
    assert.ok(terminated.has(id), "timed-out warmup must be terminated");
    await settle(250);
    assert.equal(published, 0, "terminated warmup must not publish late state");
    assert.equal(own.getAccountStatus(id), "STANDBY");
    assert.equal(own.getPoolSnapshot().ready, 0);
    const blocked = await ctrl.tick();
    assert.equal(blocked.launched.length, 0, "timeout counts as a failure with backoff");
    clock = 2000;
    const retry = await ctrl.tick();
    assert.equal(retry.launched.length, 1, "account is retryable after backoff expires");
    ctrl.stop();
  });

  it("Late completion after timeout is suppressed", async () => {
    const own = makePool(1);
    const id = "acct1";
    let resolveWarmup: ((outcome: WarmupOutcome) => void) | undefined;
    const ctrl = new ReadinessController(
      own,
      {
        targetReady: 1,
        warmupConcurrency: 1,
        warmupTimeoutMs: 50,
        maxWarmupFailures: 3,
        backoffBaseMs: 1000,
        backoffMaxMs: 1000,
      },
      {
        warmWarmup: () =>
          new Promise<WarmupOutcome>((resolve) => {
            resolveWarmup = resolve;
          }),
        jitter: () => 0,
        now: () => clock,
      },
    );
    const report = await ctrl.tick();
    assert.equal(report.launched.length, 1);
    await settle(120);
    assert.equal(ctrl.getInFlight().length, 0, "timeout must settle the warmup");
    assert.ok(resolveWarmup);
    resolveWarmup("ready");
    await settle();
    assert.equal(own.getAccountStatus(id), "STANDBY");
    assert.equal(own.getPoolSnapshot().ready, 0);
    const blocked = await ctrl.tick();
    assert.equal(blocked.launched.length, 0, "late success must not clear failure state");
    assert.ok(blocked.skipped.includes(id));
    clock = 2000;
    const retry = await ctrl.tick();
    assert.equal(retry.launched.length, 1, "account stays on the failure/backoff path");
    ctrl.stop();
  });
});
