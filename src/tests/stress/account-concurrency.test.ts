/**
 * Appendix G scenario 1 — account concurrency stress.
 *
 * REQUIRED mixes: 1 account/2 sessions; 5/10; 10/25; 50/100. Sessions exceed
 * accounts so contention is guaranteed; every generation acquires a lease,
 * streams bytes through a StreamManager with a fake sink and releases. A
 * simulated crash plus markStaleAndFence sweep runs at the end of every mix.
 *
 * Asserts: duplicate account generation = 0, duplicate lease owner = 0,
 * orphan lease = 0.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { StressCounters, StressDriver, flushEvents } from "./driver.ts";
import type { FailMode, GenerationSpec } from "./driver.ts";
import {
  type ScenarioResult,
  newScenarioRecorder,
  printStressSummary,
  registerScenarioResult,
} from "./summary.ts";

export const SCENARIO_NAME = "account-concurrency-stress";
export let STRESS_RESULT: ScenarioResult;

const counters = new StressCounters();
const recorder = newScenarioRecorder(SCENARIO_NAME, counters);

interface Mix {
  name: string;
  accounts: number;
  sessions: number;
  crashed: number;
}

const MIXES: readonly Mix[] = [
  { name: "1x2", accounts: 1, sessions: 2, crashed: 1 },
  { name: "5x10", accounts: 5, sessions: 10, crashed: 3 },
  { name: "10x25", accounts: 10, sessions: 25, crashed: 5 },
  { name: "50x100", accounts: 50, sessions: 100, crashed: 10 },
];

const FAIL_MODES: readonly FailMode[] = [
  "db",
  "stall",
  "disconnect",
  "none",
  "none",
  "none",
  "db",
  "stall",
];

function buildSpecs(mix: Mix, seed: string): GenerationSpec[] {
  const specs: GenerationSpec[] = [];
  for (let i = 0; i < mix.sessions; i++) {
    const mode = FAIL_MODES[i % FAIL_MODES.length];
    specs.push({
      sessionId: `sess-${mix.name}-${i}`,
      chunks: mode === "stall" ? 8 : 4,
      chunkChars: mode === "stall" ? 16_384 : 256,
      failMode: mode,
      busyRetries: 4,
      ttlMs: 60_000,
    });
  }
  void seed;
  return specs;
}

async function runMix(mix: Mix): Promise<void> {
  const driver = new StressDriver({
    accountCount: mix.accounts,
    seed: `acct|${mix.name}`,
    counters,
  });
  driver.warmAccounts(mix.accounts);

  const specs = buildSpecs(mix, `acct|${mix.name}`);
  const pending = specs.map((spec) => driver.submitGeneration(spec));
  // Let acquisitions and pushes interleave; stalled generations block here.
  await flushEvents(12);

  // Simulated crash: sessions whose release was lost (db failure) hold live
  // leases; stalled sessions are still mid-stream. Crash a bounded subset so
  // the stale-lease sweep has real orphans to recover.
  const inFlight = driver.activeGenerationIds();
  const crashedCount = Math.min(mix.crashed, inFlight.length);
  for (let i = 0; i < crashedCount; i++) {
    driver.crashGeneration(inFlight[i] as string);
  }

  // Advance the virtual clock past every stream deadline: stalled clients are
  // breached as CLIENT_STALLED instead of accumulating output forever.
  driver.time.advance(30_000);
  await flushEvents(12);

  const outcomes = await Promise.all(pending);
  for (const outcome of outcomes) {
    counters.metric(`outcome:${outcome.kind}`);
  }

  // Crash the sessions whose release was lost (db failure): the process died
  // before the release was persisted, so their leases are live orphans.
  for (const outcome of outcomes) {
    if (outcome.kind === "db-failure") driver.crashGeneration(outcome.generationId);
  }

  const sweep = await driver.sweepOrphans();
  await flushEvents(8);

  driver.assertClean();
  counters.setMetric(`mix:${mix.name}:swept`, sweep.swept);
  counters.setMetric(`mix:${mix.name}:fenced`, sweep.fenced);
  counters.setMetric(`mix:${mix.name}:clean-exits`, sweep.cleanExits);
  counters.setMetric(`mix:${mix.name}:force-cancelled-ops`, sweep.forceCancelledOps);

  const snap = driver.snapshot();
  assert.equal(
    snap.activeGenerations,
    0,
    `${mix.name}: no unexplained active generations`,
  );
  assert.equal(snap.liveLeases, 0, `${mix.name}: zero live leases`);
  assert.equal(snap.liveStreams, 0, `${mix.name}: zero live streams`);
  assert.equal(snap.liveOps, 0, `${mix.name}: zero live browser ops`);
  assert.equal(counters.counts.duplicateAccountGeneration, 0, "duplicate account generation");
  assert.equal(counters.counts.duplicateLeaseOwner, 0, "duplicate lease owner");
  assert.equal(counters.counts.orphanLease, 0, "orphan lease");
}

test(
  "account-concurrency: 1 account / 2 sessions",
  recorder.track("mix 1x2", () => runMix(MIXES[0] as Mix)),
);
test(
  "account-concurrency: 5 accounts / 10 sessions",
  recorder.track("mix 5x10", () => runMix(MIXES[1] as Mix)),
);
test(
  "account-concurrency: 10 accounts / 25 sessions",
  recorder.track("mix 10x25", () => runMix(MIXES[2] as Mix)),
);
test(
  "account-concurrency: 50 accounts / 100 sessions",
  recorder.track("mix 50x100", () => runMix(MIXES[3] as Mix)),
);

test.after(() => {
  STRESS_RESULT = recorder.finalize();
  registerScenarioResult(STRESS_RESULT);
  printStressSummary();
});
