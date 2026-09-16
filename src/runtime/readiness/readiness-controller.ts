import type { IAccountOwnership, PoolSnapshot } from "../contracts.ts";
import type { AccountStatus } from "../../domain/types.ts";

export interface ReadinessConfig {
  minReady: number;
  targetReady: number;
  warmupConcurrency: number;
  warmupTimeoutMs: number;
  tickIntervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxWarmupFailures: number;
}

export interface TickReport {
  launched: string[];
  skipped: Array<{ accountId: string; reason: string }>;
  deficit: number;
  ready: number;
  warming: number;
  target: number;
}

type WarmupOutcome = "ready" | "failed" | "timeout";

interface WarmingJob {
  accountId: string;
  startedAt: number;
  deadline: number;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A maintenance CLIENT, not an account owner (spec §14). It queries
 * IAccountOwnership and drives warmup jobs; it never independently decides that
 * an account is safe to mutate.
 *
 * Bounded deficit algorithm: deficit = max(0, targetReady - ready - warming).
 * Launches no more than `deficit` and no more than `warmupConcurrency` jobs per
 * tick, and never more than available standby accounts. Converges: once
 * ready + warming >= target, no work is scheduled.
 */
export class ReadinessController {
  private readonly ownership: IAccountOwnership;
  private readonly config: ReadinessConfig;
  private readonly warmWarmup: (accountId: string) => Promise<WarmupOutcome>;
  private readonly terminateWarmup: (accountId: string) => Promise<void>;
  private readonly jitter: () => number;
  private readonly failures = new Map<string, number>();
  private readonly nextWarmupAt = new Map<string, number>();
  private readonly inFlight = new Map<string, WarmingJob>();
  private tickInFlight = false;
  private pendingRecheck = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    ownership: IAccountOwnership,
    config: Partial<ReadinessConfig> = {},
    deps?: {
      warmWarmup?: (accountId: string) => Promise<WarmupOutcome>;
      terminateWarmup?: (accountId: string) => Promise<void>;
      jitter?: () => number;
    },
  ) {
    this.ownership = ownership;
    this.config = {
      minReady: config.minReady ?? 2,
      targetReady: config.targetReady ?? 4,
      warmupConcurrency: config.warmupConcurrency ?? 2,
      warmupTimeoutMs: config.warmupTimeoutMs ?? 90_000,
      tickIntervalMs: config.tickIntervalMs ?? 60_000,
      backoffBaseMs: config.backoffBaseMs ?? 1_000,
      backoffMaxMs: config.backoffMaxMs ?? 60_000,
      maxWarmupFailures: config.maxWarmupFailures ?? 3,
    };
    this.warmWarmup =
      deps?.warmWarmup ?? (() => Promise.resolve<WarmupOutcome>("ready"));
    this.terminateWarmup = deps?.terminateWarmup ?? (() => Promise.resolve());
    this.jitter = deps?.jitter ?? (() => Math.random());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.config.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One readiness pass. Coalesces overlapping ticks: a concurrent tick is a
   * no-op that schedules a single trailing re-check.
   */
  async tick(): Promise<TickReport> {
    if (this.tickInFlight) {
      this.pendingRecheck = true;
      return this.emptyReport("tick-in-flight");
    }
    this.tickInFlight = true;
    try {
      return await this.runTick();
    } finally {
      this.tickInFlight = false;
      if (this.pendingRecheck) {
        this.pendingRecheck = false;
        void this.tick().catch(() => {});
      }
    }
  }

  private async runTick(): Promise<TickReport> {
    const snapshot = this.ownership.getPoolSnapshot();
    this.reapTimedOutWarmups();
    const warming = this.countWarming();
    const ready = snapshot.ready;
    const deficit = Math.max(0, this.config.targetReady - ready - warming);
    const skipped: Array<{ accountId: string; reason: string }> = [];

    if (deficit <= 0) {
      return {
        launched: [],
        skipped,
        deficit,
        ready,
        warming,
        target: this.config.targetReady,
      };
    }

    const standby = this.ownership
      .listAccountsByStatus("STANDBY")
      .filter((id) => this.isWarmable(id, skipped));
    const slots = Math.min(
      deficit,
      this.config.warmupConcurrency - this.globalRunning(),
      standby.length,
    );

    const launched: string[] = [];
    for (const accountId of standby.slice(0, Math.max(0, slots))) {
      this.launchWarmup(accountId);
      launched.push(accountId);
    }
    for (const id of standby.slice(Math.max(0, slots))) {
      skipped.push({ accountId: id, reason: "concurrency-cap" });
    }

    // A tick launches background warmup jobs and reports; it does NOT await
    // their completion (warmups are background work and may take many seconds;
    // awaiting would serialize readiness and block the trailing re-check).
    return {
      launched,
      skipped,
      deficit,
      ready,
      warming: this.countWarming(),
      target: this.config.targetReady,
    };
  }

  private isWarmable(
    accountId: string,
    skipped: Array<{ accountId: string; reason: string }>,
  ): boolean {
    const status = this.ownership.getAccountStatus(accountId);
    if (status !== "STANDBY") {
      skipped.push({ accountId, reason: `not-standby:${status}` });
      return false;
    }
    if (this.inFlight.has(accountId)) {
      skipped.push({ accountId, reason: "already-warming" });
      return false;
    }
    const backoffUntil = this.nextWarmupAt.get(accountId) ?? 0;
    if (backoffUntil > Date.now()) {
      skipped.push({ accountId, reason: "backoff" });
      return false;
    }
    const failures = this.failures.get(accountId) ?? 0;
    if (failures >= this.config.maxWarmupFailures) {
      skipped.push({ accountId, reason: "permanently-failed" });
      return false;
    }
    return true;
  }

  private launchWarmup(accountId: string): void {
    const startedAt = Date.now();
    const job: WarmingJob = {
      accountId,
      startedAt,
      deadline: startedAt + this.config.warmupTimeoutMs,
      done: false,
      timer: null,
    };
    // Per-job deadline: a warmup must be force-terminated when its deadline
    // passes, even if no readiness tick fires for a while (spec §10).
    job.timer = setTimeout(() => {
      void this.terminateWarmup(accountId).then(
        () => this.finishWarmup(accountId, "timeout"),
        () => this.finishWarmup(accountId, "timeout"),
      );
    }, this.config.warmupTimeoutMs);
    job.timer.unref?.();
    this.inFlight.set(accountId, job);
    void this.warmWarmup(accountId).then(
      (outcome) => this.finishWarmup(accountId, outcome),
      () => this.finishWarmup(accountId, "failed"),
    );
  }

  private finishWarmup(accountId: string, outcome: WarmupOutcome): void {
    const job = this.inFlight.get(accountId);
    if (!job || job.done) return;
    job.done = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    this.inFlight.delete(accountId);
    if (outcome === "ready") {
      this.failures.delete(accountId);
      this.nextWarmupAt.delete(accountId);
      return;
    }
    const failures = (this.failures.get(accountId) ?? 0) + 1;
    this.failures.set(accountId, failures);
    const delay = Math.min(
      this.config.backoffBaseMs * 2 ** Math.min(failures, 8),
      this.config.backoffMaxMs,
    );
    const jittered = delay * (0.5 + this.jitter() * 0.5);
    this.nextWarmupAt.set(accountId, Date.now() + jittered);
    if (failures >= this.config.maxWarmupFailures) {
      void this.ownership.recoverAccount(accountId, "warmup-exhausted").catch(
        () => {},
      );
    }
  }

  private reapTimedOutWarmups(): void {
    for (const [accountId, job] of this.inFlight) {
      if (job.deadline <= Date.now()) {
        // Force-terminate the job rather than letting it linger.
        void this.terminateWarmup(accountId).then(
          () => this.finishWarmup(accountId, "timeout"),
          () => this.finishWarmup(accountId, "timeout"),
        );
      }
    }
  }

  private countWarming(): number {
    let n = this.inFlight.size;
    for (const id of this.inFlight.keys()) {
      if (this.ownership.getAccountStatus(id) === "RECOVERING") n += 0;
    }
    return n;
  }

  private globalRunning(): number {
    return this.inFlight.size;
  }

  private emptyReport(reason: string): TickReport {
    const snapshot = this.ownership.getPoolSnapshot();
    return {
      launched: [],
      skipped: [{ accountId: "-", reason }],
      deficit: 0,
      ready: snapshot.ready,
      warming: this.countWarming(),
      target: this.config.targetReady,
    };
  }
}

export type { PoolSnapshot, AccountStatus };
