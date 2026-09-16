/**
 * Composition root for the bounded runtime (spec §14).
 *
 * SessionKeeper and ReadinessGuard are maintenance CLIENTS here, not competing
 * account authorities: exactly one ReadinessController computes the warmup
 * deficit, and every maintenance job (warmup, keep-alive) flows through one
 * MaintenanceScheduler with one bounded worker pool and one dedupe table. The
 * guard and keeper only query the ownership authority and submit jobs.
 *
 * Enabled by QWEN_READINESS_CONTROLLER=true (default off → legacy behavior).
 */
import { config } from "../core/config.ts";
import {
  performAccountWarmup,
  registerReadinessControllerClients,
  resetReadinessControllerClientsForTests,
  warmupDedupeKey,
  WARMUP_DEDUPE_PREFIX,
} from "../core/readiness-guard.ts";
import {
  KEEP_ALIVE_DEDUPE_PREFIX,
  performKeepAlive,
  registerSessionKeeperClients,
  resetSessionKeeperClientsForTests,
} from "../services/session-keeper.ts";
import type { IAccountOwnership } from "./contracts.ts";
import {
  ReadinessController,
  type ReadinessConfig,
} from "./readiness/readiness-controller.ts";
import {
  DEFAULT_PRIORITY,
  MaintenanceScheduler,
  type MaintenanceJob,
} from "./maintenance/maintenance-scheduler.ts";
import { EventRecorder } from "./observability/event-recorder.ts";

/** Controller-side mirror of the controller's own WarmupOutcome union. */
type WarmupOutcome = "ready" | "failed" | "timeout";

/**
 * Map the existing operational knobs onto ReadinessConfig.
 *
 * - minReady (2): the legacy MIN_READY floor from core/readiness-guard.ts.
 * - targetReady: PLAYWRIGHT_MAX_ACTIVE_CONTEXTS + 1 — one warm context per
 *   active slot plus one account in warming; with defaults (2) this reproduces
 *   the legacy invariant MIN_READY(2) + MIN_WARMING(1) = 3.
 * - warmupConcurrency: min(PLAYWRIGHT_MAX_PARALLEL_INIT, PLAYWRIGHT_INIT_BATCH_SIZE)
 *   — the parallel-init ceiling is the Chromium boot budget (the legacy guard
 *   hardcoded MAX_CONCURRENT_WARMING = 1; initBatchSize defaults to 1 too).
 * - warmupTimeoutMs: HEADERS_TIMEOUT — the header-capture deadline the guard
 *   had to time out.
 * - tickIntervalMs: the legacy 60s sweep cadence (no env knob exists for it).
 * - backoff*: RETRY_BASE_DELAY_MS / RETRY_MAX_DELAY_MS.
 * - maxWarmupFailures: RETRY_MAX_ATTEMPTS — after it, the controller asks the
 *   ownership authority to recover the account.
 */
export function readinessConfigFromEnv(): ReadinessConfig {
  const minReady = 2;
  return {
    minReady,
    targetReady: Math.max(config.playwright.maxActiveContexts, minReady) + 1,
    warmupConcurrency: Math.max(
      1,
      Math.min(
        config.playwright.maxParallelInit,
        config.playwright.initBatchSize,
      ),
    ),
    warmupTimeoutMs: config.timeouts.headers,
    tickIntervalMs: 60_000,
    backoffBaseMs: config.retry.baseDelayMs,
    backoffMaxMs: config.retry.maxDelayMs,
    maxWarmupFailures: config.retry.maxAttempts,
  };
}

export interface RuntimeServices {
  readonly readiness: ReadinessController;
  readonly maintenance: MaintenanceScheduler;
  /** Stop the intervals (fire-and-forget drain). Prefer stopRuntimeServices. */
  stop(): void;
}

export interface RuntimeExecutors {
  /** Hermetic override for the WARM_ACCOUNT job body (default: the guard). */
  warmup?: (accountId: string) => Promise<boolean>;
  /** Hermetic override for the keep-alive job body (default: the keeper). */
  keepAlive?: (accountId: string) => Promise<void>;
}

export interface StartRuntimeServicesOptions {
  /** Sole account ownership authority (runtime/account/instance.ts in prod). */
  ownership: IAccountOwnership;
  /** Test-only overrides; production leaves these at default. */
  executors?: RuntimeExecutors;
  /** Test-only deterministic clock for the scheduler's drain/backoff. */
  now?: () => number;
  /** Test-only bound for the shutdown drain (default 5s). */
  drainDeadlineMs?: number;
}

/**
 * Bridges the controller's warmWarmup() onto a bounded scheduler job. The
 * controller never talks to the browser directly: it launches through here, so
 * the scheduler's dedupe table is the single warmup funnel (dedupe key
 * `warmup:<accountId>`) and a duplicate launch chains onto the outstanding job
 * instead of queueing a second one.
 */
export class WarmupJobAdapter {
  private scheduler: MaintenanceScheduler | null = null;
  private readonly outcomes = new Map<string, Promise<WarmupOutcome>>();
  private readonly resolvers = new Map<string, (o: WarmupOutcome) => void>();

  bind(scheduler: MaintenanceScheduler): void {
    this.scheduler = scheduler;
  }

  warm(accountId: string): Promise<WarmupOutcome> {
    const scheduler = this.scheduler;
    if (!scheduler) return Promise.resolve<WarmupOutcome>("failed");
    const key = warmupDedupeKey(accountId);
    const outstanding = this.outcomes.get(key);
    if (outstanding) return outstanding;
    let resolve!: (outcome: WarmupOutcome) => void;
    const promise = new Promise<WarmupOutcome>((r) => {
      resolve = r;
    });
    // Register before submit: the scheduler's pump can execute the job in the
    // next microtask and call settle() before `warm()` returns.
    this.outcomes.set(key, promise);
    this.resolvers.set(key, resolve);
    const submitted = scheduler.submit({
      kind: "WARM_ACCOUNT",
      accountId,
      dedupeKey: key,
      priority: DEFAULT_PRIORITY.WARM_ACCOUNT,
      // The controller owns warmup retry/backoff; the scheduler must not retry.
      maxAttempts: 1,
    });
    if (!submitted.accepted) {
      if (submitted.existing) {
        // A warmup is already outstanding for this account that the controller
        // is not tracking (e.g. queued by the guard's recovered-account sweep).
        // Clear the in-flight slot and let the running job finish.
      } else {
        // Backpressure: the maintenance queue is at capacity. Clear the slot so
        // the next tick retries instead of silently dropping the account.
        console.warn(
          `⚠️  [Runtime] Warmup queue at capacity; deferring ${accountId}`,
        );
      }
      // Either way the account is not at fault: report success without
      // attribution so the controller frees its slot and does not back off.
      this.forget(key);
      resolve("ready");
    }
    void promise.then(() => this.forget(key), () => this.forget(key));
    return promise;
  }

  /** Resolve the controller's launch promise from the job executor. */
  settle(accountId: string, outcome: WarmupOutcome): void {
    this.resolvers.get(warmupDedupeKey(accountId))?.(outcome);
  }

  private forget(key: string): void {
    this.outcomes.delete(key);
    this.resolvers.delete(key);
  }
}

function buildJobExecutor(
  executors: RuntimeExecutors,
  adapter: WarmupJobAdapter,
): (job: MaintenanceJob) => Promise<void> {
  const warmup = executors.warmup ?? performAccountWarmup;
  const keepAlive = executors.keepAlive ?? performKeepAlive;
  return async (job: MaintenanceJob): Promise<void> => {
    const accountId = job.accountId;
    if (accountId === undefined) return;
    if (job.dedupeKey.startsWith(WARMUP_DEDUPE_PREFIX)) {
      const ok = await warmup(accountId);
      adapter.settle(accountId, ok ? "ready" : "failed");
      if (!ok) throw new Error(`warmup failed for ${accountId}`);
      return;
    }
    if (job.dedupeKey.startsWith(KEEP_ALIVE_DEDUPE_PREFIX)) {
      await keepAlive(accountId);
      return;
    }
  };
}

/**
 * Construct the single ReadinessController + MaintenanceScheduler, wire the
 * guard and keeper as their clients, and start the bounded intervals (unref'd,
 * so they never hold the process open).
 *
 * Must be called before startSessionKeeper()/startReadinessGuardSweep() when
 * QWEN_READINESS_CONTROLLER=true — those entry points detect the wiring and
 * delegate to the controller/scheduler registered here.
 */
export function startRuntimeServices(
  options: StartRuntimeServicesOptions,
): RuntimeServices {
  const ownership = options.ownership;
  const adapter = new WarmupJobAdapter();
  const scheduler = new MaintenanceScheduler({
    // One global maintenance pool bounded by the Chromium boot ceiling.
    workerConcurrency: config.playwright.maxParallelInit,
    maxQueueDepth: Math.max(16, config.playwright.maxParallelInit * 4),
    pollIntervalMs: 1_000,
    drainDeadlineMs: options.drainDeadlineMs ?? 5_000,
    now: options.now,
    execute: buildJobExecutor(options.executors ?? {}, adapter),
  });
  adapter.bind(scheduler);

  const events = new EventRecorder();
  const controller = new ReadinessController(
    ownership,
    readinessConfigFromEnv(),
    {
      warmWarmup: (accountId: string) => adapter.warm(accountId),
      terminateWarmup: async () => {
        // The browser context is owned by the WARM_ACCOUNT job above; the
        // scheduler's deadline/backoff bound its lifetime. A no-op here still
        // satisfies the controller's force-terminate contract.
      },
      jitter: () => Math.random(),
    },
  );

  registerReadinessControllerClients({ ownership, scheduler, controller, events });
  registerSessionKeeperClients({ ownership, scheduler });

  scheduler.start();
  controller.start();

  return {
    readiness: controller,
    maintenance: scheduler,
    stop(): void {
      controller.stop();
      void scheduler.stop();
    },
  };
}

/**
 * Graceful shutdown contribution: bounded drain of in-flight maintenance
 * (running jobs finish or are force-marked dead within drainDeadlineMs), then
 * the intervals stop so no job is orphaned mid-flight.
 */
export async function stopRuntimeServices(
  services: RuntimeServices,
): Promise<void> {
  await services.maintenance.stop();
  services.stop();
}

/** Test hook: detach both clients so legacy behavior is restored. */
export function resetRuntimeServicesForTests(): void {
  resetReadinessControllerClientsForTests();
  resetSessionKeeperClientsForTests();
}
