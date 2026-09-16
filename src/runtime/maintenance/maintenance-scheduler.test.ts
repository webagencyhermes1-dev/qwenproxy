import test from "node:test";
import assert from "node:assert";

import {
  DEFAULT_PRIORITY,
  HIGH_PRIORITY,
  MaintenanceScheduler,
} from "./maintenance-scheduler.ts";

/** Test-controlled barrier: jobs only resolve when the gate fires. */
class Gate {
  private isOpen = false;
  private waiters: Array<() => void> = [];

  wait(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.isOpen = true;
    for (const resolve of this.waiters) resolve();
    this.waiters.length = 0;
  }
}

test("MaintenanceScheduler: duplicate dedupeKey coalesces to exactly one job", () => {
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 16,
    pollIntervalMs: 1000,
  });

  const first = sched.submit({ kind: "WARM_ACCOUNT", accountId: "acct1" });
  assert.strictEqual(first.accepted, true);

  const second = sched.submit({ kind: "WARM_ACCOUNT", accountId: "acct1" });
  assert.strictEqual(second.accepted, false);
  assert.ok(second.existing);
  assert.strictEqual(second.existing!.kind, "WARM_ACCOUNT");

  const third = sched.submit({
    kind: "WARM_ACCOUNT",
    accountId: "acct1",
  });
  assert.strictEqual(third.accepted, false);

  assert.strictEqual(sched.getInflight().length, 1);
  assert.strictEqual(sched.getStats().dedupeRejections, 2);
});

test("MaintenanceScheduler: submitOrCoalesce merges into the outstanding job", () => {
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 16,
    pollIntervalMs: 1000,
  });

  sched.submit({ kind: "RECOVER_ACCOUNT", accountId: "acct2" });
  const merged = sched.submitOrCoalesce({
    kind: "RECOVER_ACCOUNT",
    accountId: "acct2",
    priority: 95,
  });
  assert.strictEqual(merged.accepted, true);
  assert.ok(merged.existing);
  assert.strictEqual(merged.existing!.priority, 95);
  assert.strictEqual(sched.getInflight().length, 1);
  assert.strictEqual(sched.getStats().dedupeRejections, 0);
});

test("MaintenanceScheduler: coexist jobs may share a dedupeKey class", () => {
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 16,
    pollIntervalMs: 1000,
  });

  for (let i = 0; i < 5; i++) {
    const r = sched.submit({
      kind: "CLEAN_SESSION",
      accountId: "acct1",
      sessionId: `sess${i}`,
      coexist: true,
    });
    assert.strictEqual(r.accepted, true);
  }
  assert.strictEqual(sched.getInflight().length, 5);
});

test("MaintenanceScheduler: pool bound is never exceeded", async () => {
  const gate = new Gate();
  let active = 0;
  let peak = 0;
  const sched = new MaintenanceScheduler({
    workerConcurrency: 4,
    maxQueueDepth: 100,
    pollIntervalMs: 1000,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.wait();
      active -= 1;
    },
  });

  for (let i = 0; i < 50; i++) {
    sched.submit({
      kind: "CLEAN_SESSION",
      accountId: "acct1",
      sessionId: `sess${i}`,
      coexist: true,
    });
  }

  const pending = sched.runOnce();
  assert.strictEqual(peak, 4);
  assert.strictEqual(sched.getStats().running, 4);

  gate.release();
  await pending;
  assert.strictEqual(sched.getStats().running, 0);
  assert.ok(peak <= 4);
});

test("MaintenanceScheduler: 100 rapid submits never launch unbounded promises", async () => {
  const gate = new Gate();
  let active = 0;
  let peak = 0;
  let executed = 0;
  const sched = new MaintenanceScheduler({
    workerConcurrency: 4,
    maxQueueDepth: 200,
    pollIntervalMs: 1000,
    execute: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.wait();
      active -= 1;
      executed += 1;
    },
  });

  for (let i = 0; i < 100; i++) {
    sched.submit({ kind: "WARM_ACCOUNT", accountId: `acct${i}` });
  }
  assert.strictEqual(sched.getStats().queueDepth, 100);
  assert.strictEqual(sched.getStats().running, 0);

  const pending = sched.runOnce();
  assert.strictEqual(sched.getStats().running, 4);
  assert.ok(peak <= 4);

  gate.release();
  await pending;

  let guard = 0;
  while (sched.getStats().queueDepth > 0 && guard++ < 100) {
    await sched.runOnce();
  }
  assert.strictEqual(executed, 100);
  assert.ok(peak <= 4);
  assert.strictEqual(sched.getStats().queueDepth, 0);
});

test("MaintenanceScheduler: submit at capacity is rejected visibly", () => {
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 5,
    pollIntervalMs: 1000,
  });

  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 10; i++) {
    if (sched.submit({ kind: "WARM_ACCOUNT", accountId: `acct${i}` }).accepted) {
      accepted += 1;
    } else {
      rejected += 1;
    }
  }
  assert.strictEqual(accepted, 5);
  assert.strictEqual(rejected, 5);
  assert.strictEqual(sched.getStats().queueDepth, 5);
});

test("MaintenanceScheduler: failing job backs off then dies after maxAttempts", async () => {
  let fakeNow = 1_000_000;
  const executed: number[] = [];
  const backoffs: number[] = [];
  const sched = new MaintenanceScheduler({
    workerConcurrency: 1,
    maxQueueDepth: 8,
    pollIntervalMs: 1000,
    now: () => fakeNow,
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
    execute: async (job) => {
      executed.push(job.attempt);
      throw new Error("auth rejected");
    },
  });

  sched.submit({
    kind: "VERIFY_AUTH",
    accountId: "acct1",
    maxAttempts: 3,
  });

  let guard = 0;
  while (guard++ < 40) {
    const job = sched.getInflight()[0];
    if (job === undefined || job.status === "dead") break;
    await sched.drainOnce();
    if (job.status === "queued") {
      assert.ok(job.nextRunAt > fakeNow, "backoff must schedule into future");
      backoffs.push(job.nextRunAt);
      fakeNow = job.nextRunAt;
    }
  }

  assert.strictEqual(sched.getInflight().length, 0);
  assert.strictEqual(executed.length, 3, "one execution per attempt");
  assert.strictEqual(sched.getStats().dead, 1);
  assert.strictEqual(sched.getStats().queueDepth, 0);
  for (let i = 1; i < backoffs.length; i++) {
    assert.ok(backoffs[i] > backoffs[i - 1], "backoff must increase");
  }
});

test("MaintenanceScheduler: expired deadline job is dropped, not executed", async () => {
  let fakeNow = 1_000_000;
  let executed = 0;
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 1000,
    now: () => fakeNow,
    execute: async () => {
      executed += 1;
    },
  });

  sched.submit({
    kind: "REFRESH_HEADERS",
    accountId: "acct1",
    deadline: fakeNow + 500,
  });
  fakeNow += 1_000;

  await sched.runOnce();
  assert.strictEqual(executed, 0);
  assert.strictEqual(sched.getInflight().length, 0);
  assert.strictEqual(sched.getStats().failed, 1);
});

test("MaintenanceScheduler: active generation defers low priority only", async () => {
  let fakeNow = 1_000_000;
  const executed: string[] = [];
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 1000,
    now: () => fakeNow,
    execute: async (job) => {
      executed.push(job.kind);
    },
  });

  sched.setGenerationActive("acct1", true);
  sched.submit({
    kind: "WARM_ACCOUNT",
    accountId: "acct1",
    priority: DEFAULT_PRIORITY.WARM_ACCOUNT,
  });
  sched.submit({
    kind: "FLUSH_STATE",
    accountId: "acct1",
    priority: DEFAULT_PRIORITY.FLUSH_STATE,
  });

  await sched.runOnce();
  assert.deepStrictEqual(executed, ["FLUSH_STATE"]);
  assert.ok(HIGH_PRIORITY >= DEFAULT_PRIORITY.FLUSH_STATE);

  const inflight = sched.getInflight();
  assert.strictEqual(inflight.length, 1);
  assert.strictEqual(inflight[0].kind, "WARM_ACCOUNT");

  sched.setGenerationActive("acct1", false);
  await sched.runOnce();
  assert.deepStrictEqual(executed, ["FLUSH_STATE", "WARM_ACCOUNT"]);
});

test("MaintenanceScheduler: stop force-marks unfinished jobs dead", async () => {
  const gate = new Gate();
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 1000,
    drainDeadlineMs: 30,
    execute: async () => {
      await gate.wait();
      throw new Error("aborted");
    },
  });

  sched.start();
  const submitted = sched.submit({
    kind: "FLUSH_STATE",
    accountId: "acct1",
    maxAttempts: 1,
  });
  assert.strictEqual(submitted.accepted, true);
  const job = sched.getInflight()[0];
  assert.ok(job);
  const pending = sched.runOnce();
  await Promise.resolve();
  assert.strictEqual(sched.getStats().running, 1);

  await sched.stop();
  assert.strictEqual(job!.status, "dead");
  assert.strictEqual(sched.getStats().running, 0);

  gate.release();
  await pending;
  assert.strictEqual(job!.status, "dead");
});

test("MaintenanceScheduler: cancel removes a queued job", () => {
  const sched = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 8,
    pollIntervalMs: 1000,
  });

  sched.submit({ kind: "WARM_ACCOUNT", accountId: "acct1" });
  const cancelled = sched.cancel("WARM_ACCOUNT:acct1");
  assert.ok(cancelled);
  assert.strictEqual(cancelled!.status, "dead");
  assert.strictEqual(sched.getInflight().length, 0);

  const resubmit = sched.submit({ kind: "WARM_ACCOUNT", accountId: "acct1" });
  assert.strictEqual(resubmit.accepted, true);
});
