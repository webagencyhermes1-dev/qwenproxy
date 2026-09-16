/**
 * Appendix G scenario 5 — prolonged mixed soak.
 *
 * 200 generations across 20 accounts in bounded rounds, with injected account
 * failures, browser stalls, client disconnects and lost releases (DB
 * failures). A bounded maintenance scheduler recovers failed accounts; the
 * stale-lease sweep reclaims orphans at the end.
 *
 * Asserts: zero unexplained active generations, zero orphan leases, zero
 * detached browser operations, stable resource counts within tolerance.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { StressCounters, StressDriver, SYSTEM_FENCE, flushEvents } from "./driver.ts";
import type { FailMode, GenerationSpec } from "./driver.ts";
import {
  type ScenarioResult,
  newScenarioRecorder,
  printStressSummary,
  registerScenarioResult,
} from "./summary.ts";
import { MaintenanceScheduler } from "../../runtime/maintenance/maintenance-scheduler.ts";
import type { MaintenanceJob } from "../../runtime/maintenance/maintenance-scheduler.ts";

export const SCENARIO_NAME = "soak-stress";
export let STRESS_RESULT: ScenarioResult;

const counters = new StressCounters();
const recorder = newScenarioRecorder(SCENARIO_NAME, counters);

const ACCOUNTS = 20;
const GENERATIONS = 200;
const ROUNDS = 10;
const PER_ROUND = GENERATIONS / ROUNDS;

const driver = new StressDriver({
  accountCount: ACCOUNTS,
  seed: "soak|v1",
  counters,
  targetReady: 4,
});
driver.warmAccounts(ACCOUNTS);

const scheduler = new MaintenanceScheduler({
  workerConcurrency: 2,
  maxQueueDepth: 64,
  pollIntervalMs: 1_000,
  now: () => Date.now(),
  jitter: () => driver.prng.next(),
  execute: async (job: MaintenanceJob) => {
    if (job.kind !== "RECOVER_ACCOUNT" || !job.accountId) return;
    const accountId = job.accountId;
    const from = driver.ownership.getAccountStatus(accountId);
    // FAILED -> COOLDOWN -> STANDBY, then the warm-pool refill brings it back.
    if (from === "FAILED") {
      driver.ownership.transition(accountId, "COOLDOWN", SYSTEM_FENCE, "soak:cooldown");
    }
    driver.ownership.transition(accountId, "STANDBY", SYSTEM_FENCE, "soak:standby");
    driver.ownership.transition(accountId, "WARMING", SYSTEM_FENCE, "soak:warm");
    driver.ownership.transition(accountId, "READY", SYSTEM_FENCE, "soak:ready");
    counters.metric("recovered-accounts");
  },
});

function pickFailMode(): FailMode {
  const roll = driver.prng.next();
  if (roll < 0.08) return "account";
  if (roll < 0.17) return "stall";
  if (roll < 0.26) return "disconnect";
  if (roll < 0.34) return "db";
  return "none";
}

function buildSpecs(round: number): GenerationSpec[] {
  const specs: GenerationSpec[] = [];
  for (let i = 0; i < PER_ROUND; i++) {
    const failMode = pickFailMode();
    specs.push({
      sessionId: `soak-sess-${round}-${i}`,
      chunks: failMode === "stall" ? 8 : driver.prng.int(1, 6),
      chunkChars: failMode === "stall" ? 16_384 : 512,
      failMode,
      busyRetries: 3,
      ttlMs: 60_000,
    });
  }
  return specs;
}

async function recoverPool(): Promise<void> {
  for (const accountId of driver.ownership.listAccountsByStatus("FAILED")) {
    scheduler.submitOrCoalesce({
      kind: "RECOVER_ACCOUNT",
      accountId,
      dedupeKey: `RECOVER_ACCOUNT:${accountId}`,
    });
  }
  // Bounded cleanup work coexists with user traffic (dedupe keeps it finite).
  scheduler.submitOrCoalesce({
    kind: "CLEAN_THREAD",
    dedupeKey: "CLEAN_THREAD:soak",
    coexist: false,
  });
  await scheduler.runOnce();
}

test(
  "soak-stress: 200 generations / 20 accounts with injected failures",
  recorder.track("mixed soak", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const specs = buildSpecs(round);
      const pending = specs.map((spec) => driver.submitGeneration(spec));
      await flushEvents(10);
      // Advance the virtual clock so stalled clients are breached instead of
      // accumulating output while their holders keep the lease.
      driver.time.advance(30_000);
      await flushEvents(10);
      const outcomes = await Promise.all(pending);
      for (const outcome of outcomes) {
        counters.metric(`outcome:${outcome.kind}`);
      }
      // Sessions whose release was lost crash the process: their leases are
      // live orphans for the recovery sweep.
      for (const outcome of outcomes) {
        if (outcome.kind === "db-failure") driver.crashGeneration(outcome.generationId);
      }
      await recoverPool();
      await flushEvents(2);
      counters.setMetric(`round:${round}:active`, driver.snapshot().activeGenerations);
    }

    // Final drain: crash anything still tracked, sweep the stale leases.
    for (const generationId of driver.activeGenerationIds()) {
      driver.crashGeneration(generationId);
    }
    await recoverPool();
    const sweep = await driver.sweepOrphans();
    await flushEvents(8);
    await scheduler.stop();
    driver.assertClean();

    counters.setMetric("swept", sweep.swept);
    counters.setMetric("fenced", sweep.fenced);
    counters.setMetric("clean-exits", sweep.cleanExits);
    counters.setMetric("force-cancelled-ops", sweep.forceCancelledOps);

    const before = driver.snapshot();
    await flushEvents(6);
    const after = driver.snapshot();
    counters.setMetric("final-active", after.activeGenerations);
    counters.setMetric("final-live-leases", after.liveLeases);
    counters.setMetric("final-live-streams", after.liveStreams);
    counters.setMetric("final-live-ops", after.liveOps);
    counters.setMetric("final-pending-timers", after.pendingTimers);

    assert.equal(
      driver.activeGenerationIds().length,
      0,
      "zero unexplained active generations",
    );
    assert.equal(before.liveLeases, after.liveLeases, "resource counts are stable");
    assert.equal(after.liveLeases, 0, "zero orphan leases");
    assert.equal(after.liveOps, 0, "zero detached browser operations");
    assert.equal(after.liveStreams, 0, "zero live streams");
    assert.equal(after.pendingTimers, 0, "no leaked stream timers");
    assert.equal(
      driver.ownership.getPoolSnapshot().generating,
      0,
      "no account is left generating",
    );
    assert.equal(counters.counts.duplicateAccountGeneration, 0, "duplicate account generation");
    assert.equal(counters.counts.duplicateLeaseOwner, 0, "duplicate lease owner");
    assert.equal(counters.counts.orphanLease, 0, "orphan lease");
    assert.equal(counters.counts.detachedBrowserGeneration, 0, "detached browser generation");
    assert.equal(counters.counts.duplicateWarmup, 0, "duplicate warmup");
    assert.equal(counters.counts.invalidToolRound, 0, "invalid tool round");
    assert.equal(counters.counts.oversizedPayloadSent, 0, "oversized payload sent");
    assert.equal(counters.counts.unboundedCompactionLoop, 0, "unbounded compaction loop");
  }),
);

test.after(() => {
  STRESS_RESULT = recorder.finalize();
  registerScenarioResult(STRESS_RESULT);
  printStressSummary();
});
