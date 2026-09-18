import type { IAccountOwnership } from "./contracts.ts";
import {
  MaintenanceScheduler,
  type MaintenanceJob,
} from "./maintenance/maintenance-scheduler.ts";
import {
  ReadinessController,
  type WarmupOutcome,
} from "./readiness/readiness-controller.ts";
import {
  registerReadinessControllerClients,
  resetReadinessControllerClientsForTests,
  warmupDedupeKey,
} from "../core/readiness-guard.ts";

export interface RuntimeServices {
  readiness: ReadinessController;
  maintenance: MaintenanceScheduler;
  timers: ReadonlyArray<ReturnType<typeof setInterval>>;
}

interface WarmupPending {
  resolve: (outcome: WarmupOutcome) => void;
}

export class WarmupJobAdapter {
  private scheduler: MaintenanceScheduler | null = null;
  private readonly pending = new Map<string, WarmupPending>();

  bind(scheduler: MaintenanceScheduler): void {
    this.scheduler = scheduler;
  }

  warm(accountId: string): Promise<WarmupOutcome> {
    const existing = this.pending.get(accountId);
    if (existing) {
      return new Promise<WarmupOutcome>((resolve) => {
        const prev = existing.resolve;
        existing.resolve = (outcome) => {
          prev(outcome);
          resolve(outcome);
        };
      });
    }
    return new Promise<WarmupOutcome>((resolve) => {
      this.pending.set(accountId, { resolve });
      if (this.scheduler) {
        this.scheduler.submit({
          kind: "WARM_ACCOUNT",
          accountId,
          dedupeKey: warmupDedupeKey(accountId),
        });
      }
    });
  }

  settle(accountId: string, outcome: WarmupOutcome): void {
    const entry = this.pending.get(accountId);
    if (entry) {
      this.pending.delete(accountId);
      entry.resolve(outcome);
    }
  }
}

export interface StartRuntimeServicesOptions {
  ownership: IAccountOwnership;
  drainDeadlineMs?: number;
  executors?: {
    warmup?: (accountId: string) => Promise<boolean>;
    keepAlive?: (accountId: string) => Promise<void>;
  };
}

export function startRuntimeServices(
  options: StartRuntimeServicesOptions,
): RuntimeServices {
  const adapter = new WarmupJobAdapter();
  const warmupExecutor = options.executors?.warmup;

  const maintenance = new MaintenanceScheduler({
    workerConcurrency: 2,
    maxQueueDepth: 16,
    pollIntervalMs: 60_000,
    drainDeadlineMs: options.drainDeadlineMs ?? 5_000,
    execute: async (job: MaintenanceJob) => {
      if (job.kind === "WARM_ACCOUNT" && warmupExecutor) {
        const success = await warmupExecutor(job.accountId);
        adapter.settle(job.accountId, success ? "ready" : "failed");
      }
    },
  });
  adapter.bind(maintenance);

  const readiness = new ReadinessController(
    options.ownership,
    { targetReady: 3, warmupConcurrency: 1 },
    { warmWarmup: (id) => adapter.warm(id) },
  );

  registerReadinessControllerClients({
    ownership: options.ownership,
    scheduler: maintenance,
    controller: readiness,
  });

  return { readiness, maintenance, timers: [] };
}

export function resetRuntimeServicesForTests(): void {
  resetReadinessControllerClientsForTests();
}

export async function stopRuntimeServices(
  services: RuntimeServices | null | undefined,
): Promise<void> {
  if (!services) return;
  for (const timer of services.timers) {
    clearInterval(timer);
  }
  services.readiness?.stop();
  await services.maintenance?.stop();
}
