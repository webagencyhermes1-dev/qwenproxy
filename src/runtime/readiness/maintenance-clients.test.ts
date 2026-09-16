/**
 * Hermetic tests for the Phase 12-wire maintenance CLIENTS (spec §14): the
 * ReadinessGuard and SessionKeeper must never independently decide an account
 * is safe to mutate — they query the ownership authority and submit bounded
 * jobs. No real browser, no DB.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { IAccountOwnership } from "../contracts.ts";
import type { AccountStatus } from "../../domain/types.ts";
import {
  MaintenanceScheduler,
  type MaintenanceJob,
} from "../maintenance/maintenance-scheduler.ts";
import { ReadinessController } from "../readiness/readiness-controller.ts";
import {
  READINESS_CONTROLLER_FLAG,
  ensurePoolReadiness,
  registerReadinessControllerClients,
  resetReadinessControllerClientsForTests,
  resetReadinessCountersForTests,
  triggerReadinessCheck,
  warmupDedupeKey,
} from "../../core/readiness-guard.ts";
import {
  keepAliveDedupeKey,
  registerSessionKeeperClients,
  resetSessionKeeperClientsForTests,
  runSessionKeeperOnceForTesting,
} from "../../services/session-keeper.ts";
import {
  resetRuntimeServicesForTests,
  startRuntimeServices,
  stopRuntimeServices,
  WarmupJobAdapter,
  type RuntimeServices,
} from "../bootstrap.ts";
import {
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
} from "../../services/playwright.ts";
import type { Page } from "patchright";
import { resetAccountConcurrencyForTests } from "../../core/account-concurrency.ts";

function flagOn(): void {
  process.env[READINESS_CONTROLLER_FLAG] = "true";
}
function flagOff(): void {
  delete process.env[READINESS_CONTROLLER_FLAG];
}

interface FakeAccount {
  status: AccountStatus;
}

class FakeOwnership implements IAccountOwnership {
  accounts = new Map<string, FakeAccount>();
  recoverCalls: string[] = [];

  register(id: string, status: AccountStatus = "STANDBY"): void {
    this.accounts.set(id, { status });
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
      target: 3,
    };
  }

  registerAccount(): void {}
  setDraining(): void {}

  async recoverAccount(id: string): Promise<void> {
    this.recoverCalls.push(id);
  }
}

function makePool(n: number): FakeOwnership {
  const own = new FakeOwnership();
  for (let i = 1; i <= n; i++) own.register(`acct${i}`);
  return own;
}

function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A warmup that never resolves, so in-flight jobs stay in-flight. */
function neverResolves(): Promise<boolean> {
  return new Promise<boolean>(() => {});
}

test("guard with the flag OFF keeps its legacy standalone behavior", async () => {
  flagOff();
  const own = makePool(2);
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 60_000,
    execute: async () => {},
  });
  const ctrl = new ReadinessController(
    own,
    { targetReady: 3 },
    { warmWarmup: async () => "ready" },
  );
  registerReadinessControllerClients({
    ownership: own,
    scheduler: sched,
    controller: ctrl,
  });
  try {
    let delegatedTicks = 0;
    ctrl.tick = async () => {
      delegatedTicks++;
      return {
        launched: [],
        skipped: [],
        deficit: 0,
        ready: 0,
        warming: 0,
        target: 3,
      };
    };
    // No guard deps registered: the legacy path bails out, and — crucially —
    // the flag gate means the controller is never consulted either.
    await ensurePoolReadiness();
    assert.equal(delegatedTicks, 0, "no delegation when the flag is off");
  } finally {
    resetReadinessControllerClientsForTests();
  }
});

test("a GENERATING account is never selected for warmup by the controller", async () => {
  flagOn();
  const own = makePool(4);
  own.accounts.get("acct1")!.status = "GENERATING";
  const warmed: string[] = [];
  const services = startRuntimeServices({
    ownership: own,
    drainDeadlineMs: 25,
    executors: {
      warmup: async (id) => {
        warmed.push(id);
        return true;
      },
    },
  });
  try {
    const report = await services.readiness.tick();
    assert.deepEqual(report.launched, ["acct2"]);
    await services.maintenance.runOnce();
    await settle();
    assert.deepEqual(warmed, ["acct2"]);
    assert.ok(
      !warmed.includes("acct1"),
      "a generating account must never be warmed",
    );
  } finally {
    await stopRuntimeServices(services);
    resetRuntimeServicesForTests();
    flagOff();
  }
});

test("two ticks while warmups are slow produce at most one warmup job per account", async () => {
  flagOn();
  const own = makePool(6);
  own.accounts.get("acct1")!.status = "READY";
  own.accounts.get("acct2")!.status = "READY";
  const services = startRuntimeServices({
    ownership: own,
    drainDeadlineMs: 25,
    executors: { warmup: neverResolves },
  });
  const sched = services.maintenance;
  try {
    const first = await services.readiness.tick();
    assert.equal(first.launched.length, 1, "deficit of 1 launches one");
    const key = warmupDedupeKey(first.launched[0]!);
    assert.equal(
      sched.getInflight().filter((j) => j.dedupeKey === key).length,
      1,
      "exactly one job under warmup:<id>",
    );

    // The job is still outstanding, so a second tick must not add another.
    const second = await services.readiness.tick();
    assert.equal(second.launched.length, 0, "no second initializer");
    assert.equal(
      sched.getInflight().filter((j) => j.dedupeKey === key).length,
      1,
      "dedupe key warmup:<id> still holds exactly one job",
    );
  } finally {
    await stopRuntimeServices(services);
    resetRuntimeServicesForTests();
    flagOff();
  }
});

test("duplicate direct submits coalesce to one warmup job (dedupe key warmup:<id>)", async () => {
  flagOn();
  const own = makePool(2);
  const services = startRuntimeServices({
    ownership: own,
    drainDeadlineMs: 25,
    executors: { warmup: neverResolves },
  });
  try {
    const key = warmupDedupeKey("acct1");
    const a = services.maintenance.submit({
      kind: "WARM_ACCOUNT",
      accountId: "acct1",
      dedupeKey: key,
    });
    const b = services.maintenance.submit({
      kind: "WARM_ACCOUNT",
      accountId: "acct1",
      dedupeKey: key,
    });
    assert.equal(a.accepted, true);
    assert.equal(b.accepted, false, "second submit is coalesced");
    assert.equal(
      services.maintenance.getInflight().filter((j) => j.dedupeKey === key)
        .length,
      1,
    );
  } finally {
    await stopRuntimeServices(services);
    resetRuntimeServicesForTests();
    flagOff();
  }
});

test("startRuntimeServices wires the guard/keeper as clients and stopRuntimeServices leaves no orphan jobs", async () => {
  flagOn();
  const own = makePool(4);
  own.accounts.get("acct1")!.status = "GENERATING";
  const services: RuntimeServices = startRuntimeServices({
    ownership: own,
    drainDeadlineMs: 25,
    executors: { warmup: neverResolves },
  });
  try {
    // The guard is a client: ensurePoolReadiness delegates to the controller
    // the composition root registered.
    resetReadinessCountersForTests();
    const report = await ensurePoolReadiness();
    if (!report) {
      assert.fail("client mode must return the controller's tick report");
    }
    assert.equal(report.launched.length, 1);
    assert.notEqual(report.launched[0], "acct1");
    assert.equal(
      services.maintenance.getInflight().filter((j) => j.kind === "WARM_ACCOUNT")
        .length,
      1,
      "the delegated tick launched a scheduler job",
    );

    // Claim the queued job into the bounded worker pool without awaiting it (a
    // slow warmup must stay running), then stop: the drain must not orphan it.
    void services.maintenance.runOnce();
    await settle(5);
    const job = services.maintenance
      .getInflight()
      .find((j) => j.kind === "WARM_ACCOUNT");
    assert.ok(job, "the warmup job is running under the bounded pool");
    assert.equal(services.maintenance.getStats().running, 1);

    await stopRuntimeServices(services);
    assert.equal(job.status, "dead", "the in-flight job was force-completed");
    assert.equal(
      services.maintenance.getStats().running,
      0,
      "no orphaned running job",
    );
    assert.equal(
      services.maintenance.getInflight().length,
      0,
      "no orphaned queued job",
    );
  } finally {
    resetReadinessControllerClientsForTests();
    resetRuntimeServicesForTests();
    flagOff();
  }
});

test("guard with the flag ON delegates to the controller, not its internal sets", async () => {
  flagOn();
  const own = makePool(4);
  own.accounts.get("acct1")!.status = "READY";
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 60_000,
    execute: async () => {},
  });
  const adapter = new WarmupJobAdapter();
  adapter.bind(sched);
  const ctrl = new ReadinessController(
    own,
    { targetReady: 3, warmupConcurrency: 1 },
    { warmWarmup: (id) => adapter.warm(id) },
  );
  registerReadinessControllerClients({ ownership: own, scheduler: sched, controller: ctrl });
  try {
    let delegatedTicks = 0;
    const realTick = ctrl.tick.bind(ctrl);
    ctrl.tick = async () => {
      delegatedTicks++;
      return realTick();
    };

    await ensurePoolReadiness();
    assert.equal(
      delegatedTicks,
      1,
      "ensurePoolReadiness delegates to the controller tick",
    );
    assert.equal(
      sched.getInflight().filter((j) => j.kind === "WARM_ACCOUNT").length,
      1,
      "the tick launched a scheduler job, not the guard's own loop",
    );

    delegatedTicks = 0;
    triggerReadinessCheck();
    await settle();
    assert.ok(delegatedTicks >= 1, "triggerReadinessCheck delegates too");
  } finally {
    resetReadinessControllerClientsForTests();
    flagOff();
  }
});

test("keep-alive skips a GENERATING account and submits a bounded job for an idle one", async () => {
  flagOn();
  resetAccountConcurrencyForTests();
  const own = new FakeOwnership();
  own.register("busy", "GENERATING");
  own.register("idle", "STANDBY");
  const executed: MaintenanceJob[] = [];
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 60_000,
    execute: async (job) => {
      executed.push(job);
    },
  });
  registerSessionKeeperClients({ ownership: own, scheduler: sched });
  const stale = Date.now() - 10 * 60_000;
  registerPlaywrightAccountForTests(
    "busy",
    { isClosed: () => false, url: () => "https://chat.qwen.ai/" } as unknown as Page,
    stale,
  );
  registerPlaywrightAccountForTests(
    "idle",
    { isClosed: () => false, url: () => "https://chat.qwen.ai/" } as unknown as Page,
    stale,
  );
  try {
    await runSessionKeeperOnceForTesting();
    const keys = sched.getInflight().map((j) => j.dedupeKey);
    assert.deepEqual(keys, [keepAliveDedupeKey("idle")]);
    assert.ok(
      !keys.includes(keepAliveDedupeKey("busy")),
      "a generating account must never receive keep-alive maintenance",
    );

    // The submitted job is bounded: running it once drains it.
    await sched.runOnce();
    assert.equal(executed.length, 1);
    assert.equal(sched.getInflight().length, 0);
  } finally {
    unregisterPlaywrightAccountForTests("busy");
    unregisterPlaywrightAccountForTests("idle");
    resetSessionKeeperClientsForTests();
    flagOff();
  }
});
