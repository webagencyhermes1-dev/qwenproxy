import { newJobId } from "../../domain/ids.ts";

export type MaintenanceJobKind =
  | "WARM_ACCOUNT"
  | "RECOVER_ACCOUNT"
  | "VALIDATE_ACCOUNT"
  | "KEEP_ALIVE"
  | "REFRESH_MODELS"
  | "CLEANUP"
  | "CLEAN_SESSION"
  | "VERIFY_AUTH"
  | "REFRESH_HEADERS"
  | "FLUSH_STATE"
  | (string & {});

export const HIGH_PRIORITY = 80;

export const DEFAULT_PRIORITY: Record<string, number> = {
  FLUSH_STATE: HIGH_PRIORITY,
  RECOVER_ACCOUNT: 70,
  VERIFY_AUTH: 60,
  REFRESH_HEADERS: 50,
  WARM_ACCOUNT: 40,
  VALIDATE_ACCOUNT: 30,
  KEEP_ALIVE: 20,
  CLEAN_SESSION: 20,
  REFRESH_MODELS: 20,
  CLEANUP: 10,
};

export type MaintenanceJobStatus = "queued" | "running" | "completed" | "dead";

export interface MaintenanceJob {
  jobId: string;
  kind: MaintenanceJobKind;
  accountId: string;
  sessionId?: string;
  priority: number;
  deadline?: number;
  dedupeKey: string;
  attempt: number;
  maxAttempts: number;
  status: MaintenanceJobStatus;
  createdAt: number;
  nextRunAt: number;
}

export interface SubmitJobSpec {
  kind: MaintenanceJobKind;
  accountId: string;
  sessionId?: string;
  priority?: number;
  deadline?: number;
  dedupeKey?: string;
  maxAttempts?: number;
  coexist?: boolean;
}

export interface SubmitResult {
  accepted: boolean;
  existing?: MaintenanceJob;
  reason?: "duplicate" | "queue-full" | "stopped";
}

export interface MaintenanceSchedulerOptions {
  workerConcurrency: number;
  maxQueueDepth: number;
  pollIntervalMs: number;
  execute?: (job: MaintenanceJob) => Promise<void> | void;
  now?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  drainDeadlineMs?: number;
}

export interface MaintenanceSchedulerStats {
  queueDepth: number;
  running: number;
  dedupeRejections: number;
  completed: number;
  failed: number;
  dead: number;
  rejected: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const FALLBACK_PRIORITY = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class MaintenanceScheduler {
  private readonly workerConcurrency: number;
  private readonly maxQueueDepth: number;
  private readonly pollIntervalMs: number;
  private readonly executeFn: (job: MaintenanceJob) => Promise<void> | void;
  private readonly nowFn: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly drainDeadlineMs: number;

  private readonly queue: MaintenanceJob[] = [];
  private readonly running = new Map<MaintenanceJob, Promise<void>>();
  private readonly byDedupe = new Map<string, MaintenanceJob>();
  private readonly generationActive = new Set<string>();
  private readonly counters = {
    dedupeRejections: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    rejected: 0,
  };

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: MaintenanceSchedulerOptions) {
    this.workerConcurrency = Math.max(1, options.workerConcurrency);
    this.maxQueueDepth = Math.max(0, options.maxQueueDepth);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs);
    this.executeFn = options.execute ?? (async () => {});
    this.nowFn = options.now ?? (() => Date.now());
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000;
    this.drainDeadlineMs = options.drainDeadlineMs ?? 5_000;
  }

  submit(spec: SubmitJobSpec): SubmitResult {
    if (this.stopped) return { accepted: false, reason: "stopped" };
    const dedupeKey = spec.dedupeKey ?? this.defaultDedupeKey(spec);
    const existing = this.byDedupe.get(dedupeKey);
    if (existing) {
      this.counters.dedupeRejections += 1;
      return { accepted: false, existing, reason: "duplicate" };
    }
    if (this.queue.length >= this.maxQueueDepth) {
      this.counters.rejected += 1;
      return { accepted: false, reason: "queue-full" };
    }
    const job = this.createJob(spec, dedupeKey);
    this.queue.push(job);
    this.byDedupe.set(dedupeKey, job);
    return { accepted: true };
  }

  submitOrCoalesce(spec: SubmitJobSpec): SubmitResult {
    if (this.stopped) return { accepted: false, reason: "stopped" };
    const dedupeKey = spec.dedupeKey ?? this.defaultDedupeKey(spec);
    const existing = this.byDedupe.get(dedupeKey);
    if (existing) {
      if (spec.priority !== undefined) {
        existing.priority = Math.max(existing.priority, spec.priority);
      }
      if (spec.deadline !== undefined) {
        existing.deadline = Math.max(existing.deadline ?? 0, spec.deadline);
      }
      return { accepted: true, existing };
    }
    if (this.queue.length >= this.maxQueueDepth) {
      this.counters.rejected += 1;
      return { accepted: false, reason: "queue-full" };
    }
    const job = this.createJob(spec, dedupeKey);
    this.queue.push(job);
    this.byDedupe.set(dedupeKey, job);
    return { accepted: true };
  }

  cancel(dedupeKey: string): MaintenanceJob | null {
    const job = this.byDedupe.get(dedupeKey);
    if (!job) return null;
    job.status = "dead";
    this.removeJob(job);
    this.counters.dead += 1;
    return job;
  }

  setGenerationActive(accountId: string, active: boolean): void {
    if (active) this.generationActive.add(accountId);
    else this.generationActive.delete(accountId);
  }

  getInflight(): MaintenanceJob[] {
    return [...this.queue, ...this.running.keys()];
  }

  getStats(): MaintenanceSchedulerStats {
    return {
      queueDepth: this.queue.length,
      running: this.running.size,
      dedupeRejections: this.counters.dedupeRejections,
      completed: this.counters.completed,
      failed: this.counters.failed,
      dead: this.counters.dead,
      rejected: this.counters.rejected,
    };
  }

  runOnce(): Promise<void> {
    const started = this.dispatch();
    return Promise.all(started).then(() => undefined);
  }

  async drainOnce(): Promise<number> {
    let executed = 0;
    for (;;) {
      const started = this.dispatch();
      if (started.length === 0) break;
      await Promise.all(started);
      executed += started.length;
    }
    return executed;
  }

  start(): void {
    if (this.stopped || this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const job of [...this.queue]) {
      job.status = "dead";
      this.removeJob(job);
      this.counters.dead += 1;
    }
    if (this.running.size > 0) {
      const pending = Promise.allSettled([...this.running.values()]);
      await Promise.race([pending, sleep(this.drainDeadlineMs)]);
    }
    for (const job of [...this.running.keys()]) {
      job.status = "dead";
      this.removeJob(job);
      this.counters.dead += 1;
    }
  }

  private defaultDedupeKey(spec: SubmitJobSpec): string {
    if (spec.coexist) {
      return `${spec.kind}:${spec.accountId}:${spec.sessionId ?? newJobId()}`;
    }
    return `${spec.kind}:${spec.accountId}`;
  }

  private createJob(spec: SubmitJobSpec, dedupeKey: string): MaintenanceJob {
    return {
      jobId: newJobId(),
      kind: spec.kind,
      accountId: spec.accountId,
      sessionId: spec.sessionId,
      priority: spec.priority ?? DEFAULT_PRIORITY[spec.kind] ?? FALLBACK_PRIORITY,
      deadline: spec.deadline,
      dedupeKey,
      attempt: 1,
      maxAttempts: spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      status: "queued",
      createdAt: this.nowFn(),
      nextRunAt: 0,
    };
  }

  private dispatch(): Array<Promise<void>> {
    const started: Array<Promise<void>> = [];
    if (this.stopped) return started;
    const now = this.nowFn();
    const ordered = [...this.queue].sort(
      (a, b) =>
        b.priority - a.priority ||
        a.nextRunAt - b.nextRunAt ||
        a.createdAt - b.createdAt,
    );
    for (const job of ordered) {
      if (this.running.size >= this.workerConcurrency) break;
      if (job.deadline !== undefined && now >= job.deadline) {
        job.status = "dead";
        this.removeJob(job);
        this.counters.failed += 1;
        continue;
      }
      if (job.nextRunAt > now) continue;
      if (
        this.generationActive.has(job.accountId) &&
        job.priority < HIGH_PRIORITY
      ) {
        continue;
      }
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      job.status = "running";
      const execution = this.executeJob(job);
      this.running.set(job, execution);
      started.push(execution);
    }
    return started;
  }

  private async executeJob(job: MaintenanceJob): Promise<void> {
    try {
      await this.executeFn(job);
    } catch {
      this.onFailure(job);
      return;
    }
    this.onSuccess(job);
  }

  private onSuccess(job: MaintenanceJob): void {
    if (job.status !== "running") return;
    job.status = "completed";
    this.removeJob(job);
    this.counters.completed += 1;
  }

  private onFailure(job: MaintenanceJob): void {
    if (job.status !== "running") return;
    if (job.attempt >= job.maxAttempts) {
      job.status = "dead";
      this.removeJob(job);
      this.counters.dead += 1;
      return;
    }
    const delay = Math.min(
      this.backoffBaseMs * 2 ** (job.attempt - 1),
      this.backoffMaxMs,
    );
    job.attempt += 1;
    job.nextRunAt = this.nowFn() + delay;
    job.status = "queued";
    this.running.delete(job);
    this.queue.push(job);
  }

  private removeJob(job: MaintenanceJob): void {
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    this.running.delete(job);
    if (this.byDedupe.get(job.dedupeKey) === job) {
      this.byDedupe.delete(job.dedupeKey);
    }
  }
}
