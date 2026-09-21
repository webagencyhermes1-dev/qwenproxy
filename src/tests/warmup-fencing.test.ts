import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReadinessController } from "../runtime/readiness/readiness-controller.ts";
import type { IAccountOwnership } from "../runtime/contracts.ts";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fastBackoff = { backoffBaseMs: 1, backoffMaxMs: 2 };

function makeOwnership(): {
  ownership: IAccountOwnership;
  recoverCalls: Array<{ accountId: string; reason: string }>;
} {
  const recoverCalls: Array<{ accountId: string; reason: string }> = [];
  const ownership = {
    getPoolSnapshot: () => ({
      ready: 0,
      warming: 0,
      byStatus: {},
      target: 5,
      reserved: 0,
      generating: 0,
      cooldown: 0,
      failed: 0,
    }),
    listAccountsByStatus: () => ["acc1"],
    recoverAccount: async (accountId: string, reason: string) => {
      recoverCalls.push({ accountId, reason });
    },
  } as unknown as IAccountOwnership;
  return { ownership, recoverCalls };
}

describe("warmup attempt fencing", () => {
  it("warmup timeout settles the attempt as failed", async () => {
    const { ownership } = makeOwnership();
    const terminated: string[] = [];
    const controller = new ReadinessController(
      ownership,
      { warmupTimeoutMs: 10, ...fastBackoff },
      {
        warmWarmup: () => new Promise(() => {}),
        terminateWarmup: (accountId) => {
          terminated.push(accountId);
        },
        jitter: () => 0,
      },
    );
    try {
      const report = await controller.tick();
      assert.deepEqual(report.launched, ["acc1"]);
      assert.deepEqual(controller.getInFlight(), ["acc1"]);
      await wait(50);
      assert.deepEqual(controller.getInFlight(), []);
      assert.deepEqual(terminated, ["acc1"]);
    } finally {
      controller.stop();
    }
  });

  it("late completion after timeout does not mark account ready", async () => {
    const { ownership, recoverCalls } = makeOwnership();
    const controller = new ReadinessController(
      ownership,
      { warmupTimeoutMs: 10, maxWarmupFailures: 1, ...fastBackoff },
      {
        warmWarmup: async () => {
          await wait(100);
          return "ready";
        },
        jitter: () => 0,
      },
    );
    try {
      await controller.tick();
      await wait(150);
      assert.deepEqual(controller.getInFlight(), []);
      assert.equal(recoverCalls.length, 1);
      assert.equal(recoverCalls[0].accountId, "acc1");
      assert.equal(recoverCalls[0].reason, "warmup-exhausted");
      const report = await controller.tick();
      assert.deepEqual(report.launched, []);
      assert.deepEqual(report.skipped, ["acc1"]);
    } finally {
      controller.stop();
    }
  });

  it("repeated timeout does not leak active warmups", async () => {
    const { ownership } = makeOwnership();
    let launchedTotal = 0;
    const controller = new ReadinessController(
      ownership,
      { warmupTimeoutMs: 10, ...fastBackoff },
      {
        warmWarmup: () => {
          launchedTotal += 1;
          return new Promise(() => {});
        },
        jitter: () => 0,
      },
    );
    try {
      for (let i = 0; i < 3; i++) {
        const report = await controller.tick();
        assert.deepEqual(report.launched, ["acc1"]);
        await wait(40);
        assert.deepEqual(controller.getInFlight(), []);
      }
      assert.equal(launchedTotal, 3);
      assert.deepEqual(controller.getInFlight(), []);
    } finally {
      controller.stop();
    }
  });

  it("successful warmup clears failure state", async () => {
    const { ownership, recoverCalls } = makeOwnership();
    const outcomes = ["failed", "ready", "failed"] as const;
    let calls = 0;
    const controller = new ReadinessController(
      ownership,
      { maxWarmupFailures: 2, ...fastBackoff },
      {
        warmWarmup: async () => outcomes[calls++] ?? "failed",
        jitter: () => 0,
      },
    );
    try {
      await controller.tick();
      await wait(20);
      await controller.tick();
      await wait(20);
      await controller.tick();
      await wait(20);
      assert.equal(calls, 3);
      assert.equal(recoverCalls.length, 0);
      const report = await controller.tick();
      assert.deepEqual(report.launched, ["acc1"]);
    } finally {
      controller.stop();
    }
  });

  it("exhausted account is not retried", async () => {
    const { ownership, recoverCalls } = makeOwnership();
    let calls = 0;
    const controller = new ReadinessController(
      ownership,
      { maxWarmupFailures: 2, ...fastBackoff },
      {
        warmWarmup: async () => {
          calls += 1;
          return "failed";
        },
        jitter: () => 0,
      },
    );
    try {
      await controller.tick();
      await wait(20);
      await controller.tick();
      await wait(20);
      assert.equal(calls, 2);
      assert.equal(recoverCalls.length, 1);
      assert.equal(recoverCalls[0].reason, "warmup-exhausted");
      const report = await controller.tick();
      assert.deepEqual(report.launched, []);
      assert.deepEqual(report.skipped, ["acc1"]);
      await wait(20);
      assert.equal(calls, 2);
    } finally {
      controller.stop();
    }
  });
});
