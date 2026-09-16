/**
 * Appendix G scenario 4 — warmup stress.
 *
 * 44 accounts, target 4, warmup concurrency 2. Repeated readiness ticks with
 * slow / hanging (force-terminated) / failing / recovering warmups while a
 * bounded maintenance scheduler drives account recovery and the pool churns
 * (ready accounts fail upstream, reopening the readiness deficit).
 *
 * Asserts duplicate warmup = 0, at most 2 global warmup jobs, convergence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  Barrier,
  SeededPrng,
  StressCounters,
  SYSTEM_FENCE,
  flushEvents,
} from "./driver.ts";
import {
  type ScenarioResult,
  newScenarioRecorder,
  printStressSummary,
  registerScenarioResult,
} from "./summary.ts";
import { AccountResourceManager } from "../../runtime/account/resource-manager.ts";
import { ReadinessController } from "../../runtime/readiness/readiness-controller.ts";
import { MaintenanceScheduler } from "../../runtime/maintenance/maintenance-scheduler.ts";
import type { MaintenanceJob } from "../../runtime/maintenance/maintenance-scheduler.ts";

export const SCENARIO_NAME = "warmup-stress";
export let STRESS_RESULT: ScenarioResult;

const counters = new StressCounters();
const recorder = newScenarioRecorder(SCENARIO_NAME, counters);
const prng = new SeededPrng("warmup-stress|v1");

const ACCOUNTS = 44;
const TARGET_READY = 4;
const WARMUP_CONCURRENCY = 2;
const TICKS = 40;
const CHURN_END = 30;

const SLOW_ACCOUNTS = new Set(["warm-acct-01", "warm-acct-02", "warm-acct-07"]);
const HANGING_ACCOUNTS = new Set(["warm-acct-03", "warm-acct-04"]);
const slowBarrier = new Barrier();
const hangLatches = new Map<string, () => void>();

const ownership = new AccountResourceManager({ targetReady: TARGET_READY });
const accountIds: string[] = [];
for (let i = 1; i <= ACCOUNTS; i++) {
  const accountId = `warm-acct-${String(i).padStart(2, "0")}`;
  accountIds.push(accountId);
  ownership.registerAccount(accountId, {
    accountId,
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
  });
}

const inFlightWarmups = new Set<Promise<string>>();
const warmupCalls = new Map<string, number>();
let liveWarmups = 0;
let maxConcurrentWarmups = 0;
let globalTick = 0;

/** Deterministic intermittent warmup failure (every 7th tick per account). */
function warmupCanSucceed(accountId: string): boolean {
  const index = accountIds.indexOf(accountId);
  if (globalTick >= CHURN_END) return true;
  return (globalTick + index) % 7 !== 0;
}

async function warmWarmup(accountId: string): Promise<"ready" | "failed" | "timeout"> {
  // Duplicate detection: two concurrent warmups of one account is a violation.
  const current = warmupCalls.get(accountId) ?? 0;
  if (current > 0) counters.inc("duplicateWarmup");
  warmupCalls.set(accountId, current + 1);
  liveWarmups += 1;
  maxConcurrentWarmups = Math.max(maxConcurrentWarmups, liveWarmups);
  try {
    // The WARMING transition precedes any await, so a concurrent tick can
    // never select the same account (status guard + in-flight guard).
    const warming = ownership.transition(accountId, "WARMING", SYSTEM_FENCE, "warmup:start");
    if (!warming.transitioned) return "failed";

    if (HANGING_ACCOUNTS.has(accountId)) {
      // Never resolves on its own: the per-job deadline must force-terminate it.
      await new Promise<void>((resolve) => {
        hangLatches.set(accountId, resolve);
      });
      return "timeout";
    }
    if (SLOW_ACCOUNTS.has(accountId)) {
      // Slow warmup gated on a barrier the scenario releases early.
      await slowBarrier.wait();
    }
    if (!warmupCanSucceed(accountId)) {
      // Warmup failure: WARMING -> COOLDOWN (a rate-limit style failure). The
      // account never serves a generation from this state; maintenance owns
      // its return to STANDBY.
      ownership.transition(accountId, "COOLDOWN", SYSTEM_FENCE, "warmup:rate-limit");
      counters.metric("warmup-failures");
      return "failed";
    }
    const ready = ownership.transition(accountId, "READY", SYSTEM_FENCE, "warmup:ready");
    return ready.transitioned ? "ready" : "failed";
  } finally {
    liveWarmups -= 1;
    warmupCalls.set(accountId, Math.max(0, (warmupCalls.get(accountId) ?? 1) - 1));
  }
}

async function terminateWarmup(accountId: string): Promise<void> {
  // Force-terminate: WARMING -> COOLDOWN (a timed-out warmup is a rate-limit
  // style failure, not a generation-affecting one). Recovery owns its return.
  ownership.transition(accountId, "COOLDOWN", SYSTEM_FENCE, "warmup:timeout");
  hangLatches.get(accountId)?.();
  hangLatches.delete(accountId);
  counters.metric("warmup-timeouts");
}

const controller = new ReadinessController(
  ownership,
  {
    targetReady: TARGET_READY,
    warmupConcurrency: WARMUP_CONCURRENCY,
    warmupTimeoutMs: 20,
    tickIntervalMs: 1_000,
    backoffBaseMs: 1,
    backoffMaxMs: 4,
    maxWarmupFailures: 5,
  },
  {
    warmWarmup: (accountId) => {
      const promise = warmWarmup(accountId).then((outcome) => {
        inFlightWarmups.delete(promise);
        return outcome;
      });
      inFlightWarmups.add(promise);
      return promise;
    },
    terminateWarmup,
    jitter: () => prng.next(),
  },
);

const scheduler = new MaintenanceScheduler({
  workerConcurrency: 2,
  maxQueueDepth: 64,
  pollIntervalMs: 1_000,
  now: () => Date.now(),
  jitter: () => prng.next(),
  execute: async (job: MaintenanceJob) => {
    if (job.kind === "RECOVER_ACCOUNT" && job.accountId) {
      const accountId = job.accountId;
      const from = ownership.getAccountStatus(accountId);
      // Recovery returns the account to STANDBY via legal state-machine hops so
      // readiness can warm it again. RECOVERING -> COOLDOWN -> STANDBY,
      // COOLDOWN -> STANDBY, FAILED -> COOLDOWN -> STANDBY.
      if (from === "RECOVERING" || from === "FAILED") {
        ownership.transition(accountId, "COOLDOWN", SYSTEM_FENCE, "maintenance:cooldown");
      }
      const standby = ownership.transition(
        accountId,
        "STANDBY",
        SYSTEM_FENCE,
        "maintenance:standby",
      );
      if (standby.transitioned) counters.metric("recovered-accounts");
    }
  },
});

/** Await every outstanding warmup: a hung one settles when its deadline fires. */
async function awaitWarmups(): Promise<void> {
  if (inFlightWarmups.size === 0) return;
  await Promise.allSettled([...inFlightWarmups]);
}

function submitRecoveryWork(): void {
  // Recovery work for every account not serving or warming: the scheduler's
  // dedupe table keeps one outstanding RECOVER_ACCOUNT job per account.
  for (const accountId of ownership.listAccountsByStatus("RECOVERING")) {
    scheduler.submitOrCoalesce({
      kind: "RECOVER_ACCOUNT",
      accountId,
      dedupeKey: `RECOVER_ACCOUNT:${accountId}`,
    });
  }
  for (const accountId of ownership.listAccountsByStatus("COOLDOWN")) {
    scheduler.submitOrCoalesce({
      kind: "RECOVER_ACCOUNT",
      accountId,
      dedupeKey: `RECOVER_ACCOUNT:${accountId}`,
    });
  }
}

test(
  "warmup-stress: 44 accounts, target 4, concurrency 2 — no duplicate warmups, bounded jobs, convergence",
  recorder.track("warmup convergence", async () => {
    let totalLaunched = 0;

    // Tick 0 launches the two slow warmups; an OVERLAPPING tick must launch
    // nothing while they are in-flight (concurrency cap + no duplicate warmup).
    globalTick = 0;
    const first = await controller.tick();
    totalLaunched += first.launched.length;
    assert.equal(first.launched.length, 2, "the first tick launches two warmups");
    const overlap = controller.tick();
    slowBarrier.release();
    const overlapReport = await overlap;
    assert.equal(
      overlapReport.launched.length,
      0,
      "no duplicate warmups while two are already in flight",
    );
    await awaitWarmups();

    for (let tick = 1; tick < TICKS; tick++) {
      globalTick = tick;
      // Pool churn: ready accounts fail upstream and enter recovery, which
      // reopens the readiness deficit and forces fresh warmups.
      if (tick < CHURN_END && tick % 3 === 0) {
        for (const accountId of ownership.listAccountsByStatus("READY").slice(0, 4)) {
          void ownership.recoverAccount(accountId, "upstream-auth-failure");
        }
      }
      submitRecoveryWork();
      const report = await controller.tick();
      totalLaunched += report.launched.length;
      counters.setMetric(`tick:${tick}:launched`, report.launched.length);
      counters.setMetric(`tick:${tick}:ready`, report.ready);
      counters.setMetric(`tick:${tick}:warming`, report.warming);
      // Await every outstanding warmup (a real completion signal, never a
      // sleep: a hung warmup settles when its own deadline force-terminates it).
      await awaitWarmups();
      await scheduler.runOnce();
      await flushEvents(1);
    }

    // Final drain: recover everything, then let readiness settle.
    submitRecoveryWork();
    await scheduler.drainOnce();
    await controller.tick();
    await awaitWarmups();
    await flushEvents(2);
    await scheduler.stop();
    await controller.tick();
    await awaitWarmups();

    const snapshot = ownership.getPoolSnapshot();
    counters.setMetric("total-launched", totalLaunched);
    counters.setMetric("max-concurrent-warmups", maxConcurrentWarmups);
    counters.setMetric("final-ready", snapshot.ready);
    counters.setMetric("final-warming", snapshot.warming);
    counters.setMetric("final-recovering", snapshot.byStatus.RECOVERING ?? 0);
    counters.setMetric("final-standby", snapshot.byStatus.STANDBY ?? 0);

    assert.equal(counters.counts.duplicateWarmup, 0, "duplicate warmup");
    assert.ok(
      maxConcurrentWarmups <= WARMUP_CONCURRENCY,
      `at most ${WARMUP_CONCURRENCY} global warmup jobs (saw ${maxConcurrentWarmups})`,
    );
    assert.ok(totalLaunched >= 8, `warmups must churn: launched ${totalLaunched}`);
    assert.ok(
      snapshot.ready >= TARGET_READY,
      `pool must converge on the readiness target (ready=${snapshot.ready})`,
    );
    assert.equal(
      ownership.listAccountsByStatus("WARMING").length,
      0,
      "no lingering warming jobs",
    );
    assert.equal(scheduler.getInflight().length, 0, "no lingering maintenance jobs");
    const stats = scheduler.getStats();
    counters.setMetric("scheduler-done", stats.done);
    counters.setMetric("scheduler-dead", stats.dead);
    counters.setMetric("scheduler-dedupe-rejections", stats.dedupeRejections);
  }),
);

test.after(() => {
  STRESS_RESULT = recorder.finalize();
  registerScenarioResult(STRESS_RESULT);
  printStressSummary();
});
