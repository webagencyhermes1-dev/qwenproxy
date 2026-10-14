import { config } from "../core/config.ts";
import { metrics as coreMetrics } from "../core/metrics.ts";
import type { QwenAccount } from "../core/accounts.ts";
import { AccountResourceManager } from "./account/resource-manager.ts";
import { GenerationCoordinator } from "./generation/generation-coordinator.ts";
import { EventRecorder } from "./observability/event-recorder.ts";
import { MetricsEmitter } from "./observability/metrics-emitter.ts";
import { bootPersistence } from "./persistence/bootstrap.ts";
import { GenerationRepository } from "./persistence/generation-repository.ts";
import { MaintenanceScheduler } from "./maintenance/maintenance-scheduler.ts";
import {
  ReadinessController,
  type WarmupOutcome,
} from "./readiness/readiness-controller.ts";
import { reconcileBrokenAccounts } from "./readiness/broken-recovery.ts";
import {
  initModelCapsFromDb,
  sweepExpiredModelCaps,
} from "../services/model-daily-limit.ts";
import { RetryCoordinator } from "./retry/retry-coordinator.ts";
import {
  createStream,
  defaultStreamRegistry,
  getStream,
} from "./stream/stream-manager.ts";
import { setAccountOwnership } from "./account/instance.ts";
import type { QwenRuntime } from "./runtime.ts";
import type { RuntimeServices } from "./bootstrap.ts";

export interface ConstructRuntimeDeps {
  warmupExecutor?: (accountId: string) => Promise<boolean>;
  keepAliveExecutor?: (accountId: string) => Promise<void>;
  terminateWarmup?: (accountId: string) => Promise<void> | void;
}

const SYSTEM_FENCE = { leaseId: "system", ownerToken: "system" };
const MAINTENANCE_POLL_INTERVAL_MS = 15_000;
const MAINTENANCE_MAX_QUEUE_DEPTH = 256;

/**
 * The live readiness controller (set by constructRuntime / startRuntimeServices).
 * Lets any layer request an out-of-band reconcile pass (capacity miss,
 * context death, quarantine) without depending on server startup state.
 * Unset (tests, pre-startup) → requests are safe no-ops.
 */
let activeReadiness: ReadinessController | null = null;

export function requestReadinessTick(reason?: string): void {
  const controller = activeReadiness;
  if (!controller) return;
  if (reason) {
    console.log(`🔥 [Readiness] Tick requested | reason=${reason}`);
  }
  void controller.tick();
}

/** Point the process-wide tick target at `controller` (startup/test setup). */
export function setActiveReadiness(controller: ReadinessController | null): void {
  activeReadiness = controller;
}

/** Test hook: detach the active controller. */
export function clearActiveReadinessForTests(): void {
  activeReadiness = null;
}

function recoverNonterminalGenerations(
  repository: GenerationRepository,
): void {
  const terminalAt = Date.now();
  for (const generation of repository.listNonterminal()) {
    repository.updateState(
      {
        generationId: generation.generationId,
        to: "ABANDONED",
        terminalAt,
        failureReason: "crash-recovery:nonterminal-at-startup",
      },
      { expectedState: generation.state },
    );
  }
}

async function warmAccount(
  ownership: AccountResourceManager,
  accountId: string,
  warmupExecutor: ((accountId: string) => Promise<boolean>) | undefined,
): Promise<WarmupOutcome> {
  if (!warmupExecutor) return "failed";
  // A RECOVERING account re-enters the pool via STANDBY first (the state
  // machine has no direct RECOVERING → WARMING edge).
  if (ownership.getAccountStatus(accountId) === "RECOVERING") {
    const requeued = ownership.transition(
      accountId,
      "STANDBY",
      SYSTEM_FENCE,
      "recovery-requeue",
    );
    if (!requeued.transitioned) return "failed";
  }
  const claimed = ownership.transition(
    accountId,
    "WARMING",
    SYSTEM_FENCE,
    "warmup-start",
  );
  if (!claimed.transitioned) return "failed";
  let succeeded = false;
  try {
    succeeded = await warmupExecutor(accountId);
  } catch {
    succeeded = false;
  }
  if (succeeded) {
    ownership.transition(accountId, "READY", SYSTEM_FENCE, "warmup-complete");
    return "ready";
  }
  ownership.transition(accountId, "FAILED", SYSTEM_FENCE, "warmup-failed");
  ownership.transition(
    accountId,
    "STANDBY",
    SYSTEM_FENCE,
    "warmup-failed:retryable",
  );
  return "failed";
}

export async function constructRuntime(
  accounts: readonly QwenAccount[],
  deps?: ConstructRuntimeDeps,
): Promise<{ runtime: QwenRuntime; runtimeServices: RuntimeServices }> {
  bootPersistence();

  const ownership = new AccountResourceManager({
    targetReady: config.pool.targetReady,
  });
  for (const account of accounts) {
    ownership.registerAccount(account.id, {
      accountId: account.id,
      disabled: (account.disabled ?? 0) > 0,
      cooldownUntil: account.cooldown_until ?? 0,
      cooldownReason: account.cooldown_reason ?? null,
    });
  }

  const repository = new GenerationRepository();
  recoverNonterminalGenerations(repository);

  const metrics = new MetricsEmitter();
  const events = new EventRecorder();
  const retry = new RetryCoordinator(RetryCoordinator.defaultConfig());
  const generations = new GenerationCoordinator({
    ownership,
    retry,
    generations: repository,
    events,
    streams: { createStream, getStream },
  });

  // Single authority handoff: the instance manager and the gateway lease
  // path observe the same AccountResourceManager (see instance.ts). Without
  // this, readiness/lease queries would silently fall back to legacy stores.
  setAccountOwnership(ownership);

  const runtime: QwenRuntime = {
    ownership,
    retry,
    generations,
    repository,
    streams: defaultStreamRegistry,
    metrics,
    events,
  };

  const readiness = new ReadinessController(
    ownership,
    {
      targetReady: config.pool.targetReady,
      warmupConcurrency: config.pool.warmupConcurrency,
      warmupTimeoutMs: config.pool.warmupTimeoutMs,
      maxWarmupFailures: config.pool.maxWarmupFailures,
      backoffBaseMs: config.pool.backoffBaseMs,
      backoffMaxMs: config.pool.backoffMaxMs,
      maxFailedWarmupEras: config.pool.maxFailedWarmupEras,
      failedEraSkipBaseMs: config.pool.failedEraSkipBaseMs,
      failedEraSkipMaxMs: config.pool.failedEraSkipMaxMs,
    },
    {
      warmWarmup: (accountId) =>
        warmAccount(ownership, accountId, deps?.warmupExecutor),
      terminateWarmup: deps?.terminateWarmup,
      onOutcome: (accountId, outcome, timedOut) => {
        if (outcome === "failed") {
          coreMetrics.increment("warmup.failures", 1, {
            account: accountId,
            reason: timedOut ? "timeout" : "failed",
          });
        }
      },
      // A settled warmup frees a concurrency slot — refill it immediately
      // instead of idling until the next reconciliation interval tick.
      // settleWarmup invokes this after backoff/exhaustion state is written,
      // so the follow-up pass makes decisions on final state.
      onSettled: () => requestReadinessTick("warmup-settled"),
    },
  );
  // Register the controller as the process-wide tick target BEFORE the first
  // pass so out-of-band ticks (context death, cooldown-set, warmup-settled)
  // work from startup, not only after the first interval fires.
  setActiveReadiness(readiness);
  // Bounded BROKEN recovery (startup + every reconciliation tick): accounts
  // escalated to BROKEN by init failures while a systemic cause was in effect
  // are re-armed once they stop failing, so the persisted escalation can never
  // strand them after the cause is fixed. Permanent-auth accounts and accounts
  // still failing recently are skipped by the pass. Runs BEFORE the tick so a
  // recovered (previously FAILED-parked) account is a warmup candidate now.
  const runBrokenRecovery = (): void => {
    try {
      const report = reconcileBrokenAccounts({ accounts });
      // A re-armed account is usually the one the controller parked as
      // `exhausted` (`warmup-exhausted` -> FAILED): without dropping that
      // record the state machine requeues it to STANDBY but `runPass` still
      // skips it forever. Clear it so the fresh attempt budget is real.
      for (const accountId of report.recovered) {
        readiness.clearWarmupFailureState(accountId);
      }
    } catch {
      // Recovery must never break the reconciliation loop.
    }
  };
  // Restore persisted daily model caps BEFORE the first warmup tick: without
  // this a restart forgets every cap, re-probes already-exhausted accounts, and
  // re-drains the warm pool for the capped model within the first few requests
  // (the post-restart "no hot accounts for qwen3.8-max" churn).
  await initModelCapsFromDb();
  runBrokenRecovery();
  void readiness.tick();

  const maintenance = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: MAINTENANCE_MAX_QUEUE_DEPTH,
    pollIntervalMs: MAINTENANCE_POLL_INTERVAL_MS,
  });
  maintenance.start();

  const tickTimer = setInterval(() => {
    runBrokenRecovery();
    void sweepExpiredModelCaps().catch(() => {});
    void readiness.tick();
  }, config.pool.reconciliationIntervalMs);
  tickTimer.unref?.();

  const runtimeServices: RuntimeServices = {
    readiness,
    maintenance,
    timers: [tickTimer],
  };

  return { runtime, runtimeServices };
}
