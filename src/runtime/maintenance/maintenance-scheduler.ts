/**
 * Bounded scheduler for all background maintenance work (session-keeper cycles,
 * warm-pool refills, header refreshes, recovery). Every job flows through one
 * bounded pool and one dedupe table, so maintenance can never spawn an
 * unbounded number of promises (J.18) and can never starve user traffic (J.17).
 */
import { newJobId } from "../../domain/ids.ts";

export type MaintenanceJobKind =
  | "WARM_ACCOUNT"
  | "VERIFY_AUTH"
  | "REFRESH_HEADERS"
  | "REFRESH_METADATA"
  | "CLEAN_SESSION"
  | "CLEAN_THREAD"
  | "FLUSH_STATE"
  | "RECOVER_ACCOUNT";

export interface MaintenanceJob {
  jobId: string;
  kind: MaintenanceJobKind;
  dedupeKey: string;
  /** higher = more urgent; user-adjacent work outranks prewarming */
  priority: number;
  accountId?: string;
  sessionId?: string;
  /** epoch ms, absolute */
  deadline: number;
  attempt: number;
  maxAttempts: number;
  /** epoch ms; backoff scheduling */
  nextRunAt: number;
  status: "queued" | "running" | "done" | "failed" | "dead";
  /** when true, this job class is allowed multiple outstanding members */
  coexist?: boolean;
}

/** Subset submitted by callers; the scheduler fills in identity and defaults. */
export interface MaintenanceJobInput {
  kind: MaintenanceJobKind;
  dedupeKey?: string;
  priority?: number;
  accountId?: string;
  sessionId?: string;
  /** epoch ms, absolute */
  deadline?: number;
  attempt?: number;
  maxAttempts?: number;
  /** epoch ms; defaults to now */
  nextRunAt?: number;
  jobId?: string;
  coexist?: boolean;
}

export interface SubmitResult {
  accepted: boolean;
  /** the pre-existing outstanding job when the submit was coalesced/rejected */
  existing?: MaintenanceJob;
}

export interface MaintenanceStats {
  queueDepth: number;
  running: number;
  done: number;
  failed: number;
  dead: number;
  dedupeRejections: number;
}

export interface MaintenanceSchedulerOptions {
  workerConcurrency: number;
  maxQueueDepth: number;
  pollIntervalMs: number;
  jitter?: () => number;
  /** injectable clock for hermetic tests */
  now?: () => number;
  /** injectable executor; resolves => done, rejects => backoff/dead */
  execute?: (job: MaintenanceJob) => Promise<void>;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** bounded wait for running jobs during stop() */
  drainDeadlineMs?: number;
}

/** Priority at or above which a job still runs while a generation is active. */
export const HIGH_PRIORITY = 100;

export const DEFAULT_PRIORITY: Record<MaintenanceJobKind, number> = {
  WARM_ACCOUNT: 10,
  VERIFY_AUTH: 60,
  REFRESH_HEADERS: 50,
  REFRESH_METADATA: 40,
  CLEAN_SESSION: 30,
  CLEAN_THREAD: 30,
  FLUSH_STATE: HIGH_PRIORITY,
  RECOVER_ACCOUNT: 80,
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DEADLINE_MS = 5 * 60_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_DRAIN_DEADLINE_MS = 5_000;

function defaultDedupeKey(input: MaintenanceJobInput): string {
  const scope = input.accountId ?? input.sessionId ?? "global";
  return `${input.kind}:${scope}`;
}

/**
 * Binary heap ordered by (priority desc, nextRunAt asc). Bounded by
 * maxQueueDepth at the call site, so operations are always over a finite set.
 */
class JobHeap {
  private readonly items: MaintenanceJob[] = [];

  get size(): number {
    return this.items.length;
  }

  toArray(): readonly MaintenanceJob[] {
    return this.items;
  }

  get(index: number): MaintenanceJob {
    return this.items[index];
  }

  push(job: MaintenanceJob): void {
    this.items.push(job);
    this.siftUp(this.items.length - 1);
  }

  remove(job: MaintenanceJob): boolean {
    const index = this.items.indexOf(job);
    if (index < 0) return false;
    this.removeAt(index);
    return true;
  }

  removeAt(index: number): void {
    const last = this.items.pop();
    if (index < this.items.length && last !== undefined) {
      this.items[index] = last;
      if (!this.siftDown(index)) this.siftUp(index);
    }
  }

  private isBetter(a: MaintenanceJob, b: MaintenanceJob): boolean {
    return a.priority > b.priority ||
      (a.priority === b.priority && a.nextRunAt < b.nextRunAt);
  }

  private swap(i: number, j: number): void {
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
  }

  private siftUp(index: number): boolean {
    let i = index;
    let moved = false;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.isBetter(this.items[i], this.items[parent])) {
        this.swap(i, parent);
        i = parent;
        moved = true;
      } else {
        break;
      }
    }
    return moved;
  }

  private siftDown(index: number): boolean {
    let i = index;
    let moved = false;
    for (;;) {
      let best = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (
        left < this.items.length &&
        this.isBetter(this.items[left], this.items[best])
      ) {
        best = left;
      }
      if (
        right < this.items.length &&
        this.isBetter(this.items[right], this.items[best])
      ) {
        best = right;
      }
      if (best === i) break;
      this.swap(i, best);
      i = best;
      moved = true;
    }
    return moved;
  }
}

export class MaintenanceScheduler {
  private readonly workerConcurrency: number;
  private readonly maxQueueDepth: number;
  private readonly pollIntervalMs: number;
  private readonly jitter: () => number;
  private readonly now: () => number;
  private readonly execute: (job: MaintenanceJob) => Promise<void>;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly drainDeadlineMs: number;

  private readonly heap = new JobHeap();
  private readonly dedupe = new Map<string, MaintenanceJob>();
  private readonly runningJobs = new Set<MaintenanceJob>();
  private readonly activeGenerations = new Map<string, boolean>();

  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private doneCount = 0;
  private failedCount = 0;
  private deadCount = 0;
  private dedupeRejections = 0;

  constructor(options: MaintenanceSchedulerOptions) {
    this.workerConcurrency = Math.max(1, options.workerConcurrency);
    this.maxQueueDepth = Math.max(1, options.maxQueueDepth);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs);
    this.jitter = options.jitter ?? (() => 0);
    this.now = options.now ?? (() => Date.now());
    this.execute = options.execute ?? (async () => {});
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.drainDeadlineMs = options.drainDeadlineMs ??
      DEFAULT_DRAIN_DEADLINE_MS;
  }

  /**
   * Enqueue a job. A second submit with the same dedupeKey while one is
   * outstanding is rejected (exactly one job per dedupeKey class per account)
   * unless the class opts into coexistence. Overload at maxQueueDepth is
   * rejected too — backpressure stays visible to the caller (J.18).
   */
  submit(input: MaintenanceJobInput): SubmitResult {
    const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);
    const coexist = input.coexist ?? false;
    if (!coexist) {
      const existing = this.dedupe.get(dedupeKey);
      if (existing !== undefined) {
        this.dedupeRejections += 1;
        return { accepted: false, existing };
      }
    }
    if (this.heap.size + this.runningJobs.size >= this.maxQueueDepth) {
      return { accepted: false };
    }
    const job = this.normalize(input, dedupeKey, coexist);
    this.heap.push(job);
    this.dedupe.set(this.dedupeKeyOf(job), job);
    return { accepted: true };
  }

  /**
   * Like submit(), but a duplicate merges into the outstanding job (most
   * urgent priority / earliest deadline wins) and reports it via `existing`.
   */
  submitOrCoalesce(input: MaintenanceJobInput): SubmitResult {
    const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);
    const existing = this.dedupe.get(dedupeKey);
    if (existing === undefined) return this.submit(input);
    if (input.priority !== undefined && input.priority > existing.priority) {
      this.heap.remove(existing);
      existing.priority = input.priority;
      this.heap.push(existing);
    }
    if (input.deadline !== undefined && input.deadline < existing.deadline) {
      existing.deadline = input.deadline;
    }
    return { accepted: true, existing };
  }

  /** Remove an outstanding queued job; running jobs are left to finish. */
  cancel(dedupeKey: string): MaintenanceJob | null {
    const job = this.dedupe.get(dedupeKey);
    if (job === undefined || this.runningJobs.has(job)) return null;
    this.heap.remove(job);
    job.status = "dead";
    this.dedupe.delete(this.dedupeKeyOf(job));
    return job;
  }

  /** Record that user traffic is (in)active on an account (J.17). */
  setGenerationActive(accountId: string, active: boolean): void {
    if (active) this.activeGenerations.set(accountId, true);
    else this.activeGenerations.delete(accountId);
  }

  getInflight(): readonly MaintenanceJob[] {
    return [...this.heap.toArray(), ...this.runningJobs];
  }

  getStats(): MaintenanceStats {
    return {
      queueDepth: this.heap.size,
      running: this.runningJobs.size,
      done: this.doneCount,
      failed: this.failedCount,
      dead: this.deadCount,
      dedupeRejections: this.dedupeRejections,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.pump(), this.pollIntervalMs);
    this.timer.unref?.();
    this.pump();
  }

  /**
   * Stop the poller, then wait at most drainDeadlineMs for running jobs before
   * force-marking anything still in flight as dead.
   */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const deadline = this.now() + this.drainDeadlineMs;
    while (this.runningJobs.size > 0 && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stranded = [...this.runningJobs];
    for (const job of stranded) this.terminate(job, "dead");
    this.runningJobs.clear();
  }

  /**
   * One bounded pass: claim ready jobs into free pool slots and await them.
   * `launched` is bounded by workerConcurrency by construction — never an
   * unbounded Promise.all.
   */
  async runOnce(): Promise<void> {
    const launched: Array<Promise<void>> = [];
    while (this.runningJobs.size < this.workerConcurrency) {
      const job = this.claimNextReady();
      if (job === null) break;
      launched.push(this.executeJob(job));
    }
    if (launched.length > 0) await Promise.all(launched);
  }

  /** Pump until no job is claimable right now (backoff/deferral stop it). */
  async drainOnce(): Promise<void> {
    const limit = this.maxQueueDepth + this.workerConcurrency + 16;
    for (let i = 0; i < limit && this.hasReadyJob(); i++) {
      await this.runOnce();
    }
  }

  private dedupeKeyOf(job: MaintenanceJob): string {
    return job.coexist ? `${job.dedupeKey}::${job.jobId}` : job.dedupeKey;
  }

  private normalize(
    input: MaintenanceJobInput,
    dedupeKey: string,
    coexist: boolean,
  ): MaintenanceJob {
    const now = this.now();
    return {
      jobId: input.jobId ?? newJobId(),
      kind: input.kind,
      dedupeKey,
      priority: input.priority ?? DEFAULT_PRIORITY[input.kind],
      accountId: input.accountId,
      sessionId: input.sessionId,
      deadline: input.deadline ?? now + DEFAULT_DEADLINE_MS,
      attempt: input.attempt ?? 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      nextRunAt: input.nextRunAt ?? now,
      status: "queued",
      coexist,
    };
  }

  private isDeferred(job: MaintenanceJob): boolean {
    return job.accountId !== undefined &&
      this.activeGenerations.get(job.accountId) === true &&
      job.priority < HIGH_PRIORITY;
  }

  private computeBackoff(job: MaintenanceJob): number {
    const delay = Math.min(
      this.backoffBaseMs * 2 ** job.attempt,
      this.backoffMaxMs,
    );
    return this.now() + delay + this.jitter();
  }

  private hasReadyJob(): boolean {
    return this.findReadyIndex() >= 0;
  }

  private claimNextReady(): MaintenanceJob | null {
    const index = this.findReadyIndex();
    if (index < 0) return null;
    const job = this.heap.get(index);
    this.heap.removeAt(index);
    return job;
  }

  /**
   * Index of the best executable job: drop deadline-expired work as failed
   * (bounded staleness), skip deferred/backed-off jobs, then pick by
   * (priority desc, nextRunAt asc).
   */
  private findReadyIndex(): number {
    const now = this.now();
    for (let i = this.heap.size - 1; i >= 0; i--) {
      const stale = this.heap.get(i);
      if (stale.deadline < now) {
        this.heap.removeAt(i);
        this.terminate(stale, "failed");
      }
    }
    let best = -1;
    for (let i = 0; i < this.heap.size; i++) {
      const job = this.heap.get(i);
      if (job.nextRunAt > now) continue;
      if (this.isDeferred(job)) continue;
      if (best < 0 || this.isBetter(job, this.heap.get(best))) best = i;
    }
    return best;
  }

  private isBetter(a: MaintenanceJob, b: MaintenanceJob): boolean {
    return a.priority > b.priority ||
      (a.priority === b.priority && a.nextRunAt < b.nextRunAt);
  }

  private async executeJob(job: MaintenanceJob): Promise<void> {
    job.status = "running";
    this.runningJobs.add(job);
    try {
      await this.execute(job);
      if (job.status === "running") this.terminate(job, "done");
    } catch {
      if (job.status !== "running") return;
      job.attempt += 1;
      if (job.attempt >= job.maxAttempts) {
        this.terminate(job, "dead");
      } else {
        job.status = "queued";
        job.nextRunAt = this.computeBackoff(job);
        this.heap.push(job);
      }
    } finally {
      this.runningJobs.delete(job);
    }
  }

  private terminate(
    job: MaintenanceJob,
    status: "done" | "failed" | "dead",
  ): void {
    if (job.status === status) return;
    job.status = status;
    this.dedupe.delete(this.dedupeKeyOf(job));
    if (status === "done") this.doneCount += 1;
    else if (status === "failed") this.failedCount += 1;
    else this.deadCount += 1;
  }

  /** Claim ready jobs into free slots; fire-and-forget but fully accounted. */
  private pump(): void {
    if (!this.started) return;
    while (this.runningJobs.size < this.workerConcurrency) {
      const job = this.claimNextReady();
      if (job === null) break;
      void this.executeJob(job);
    }
  }
}
