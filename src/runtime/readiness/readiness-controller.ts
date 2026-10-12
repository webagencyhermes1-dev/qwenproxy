import type { IAccountOwnership } from "../contracts.ts";

export type WarmupOutcome = "ready" | "failed";

export interface TickReport {
  launched: string[];
  skipped: string[];
  deficit: number;
  ready: number;
  warming: number;
  target: number;
}

export interface ReadinessOptions {
  targetReady?: number;
  warmupConcurrency?: number;
  warmupTimeoutMs?: number;
  maxWarmupFailures?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface ReadinessDeps {
  warmWarmup: (accountId: string) => Promise<WarmupOutcome>;
  terminateWarmup?: (accountId: string) => Promise<void> | void;
  /** Observability sink for settled warmups (metrics, audit). Never throws into the controller. */
  onOutcome?: (accountId: string, outcome: WarmupOutcome, timedOut: boolean) => void;
  /**
   * Called once per settle, AFTER the account state (backoff/exhaustion) and
   * in-flight bookkeeping are updated. Wired to requestReadinessTick in
   * construct.ts so a freed warmup slot refills immediately instead of waiting
   * for the next reconciliation interval tick.
   */
  onSettled?: (accountId: string, outcome: WarmupOutcome) => void;
  jitter?: () => number;
  now?: () => number;
}

interface WarmupRecord {
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface AccountWarmState {
  failures: number;
  backoffUntil: number;
  exhausted: boolean;
}

export class ReadinessController {
  private readonly ownership: IAccountOwnership;
  private readonly warmupConcurrency: number;
  private readonly warmupTimeoutMs: number;
  private readonly maxWarmupFailures: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly deps: ReadinessDeps;

  private targetReady: number | undefined;
  private readonly inFlight = new Map<string, WarmupRecord>();
  private readonly states = new Map<string, AccountWarmState>();
  private passChain: Promise<TickReport> | null = null;
  private stopped = false;

  constructor(
    ownership: IAccountOwnership,
    options: ReadinessOptions,
    deps: ReadinessDeps,
  ) {
    this.ownership = ownership;
    this.targetReady = options.targetReady;
    this.warmupConcurrency = Math.max(1, options.warmupConcurrency ?? 1);
    this.warmupTimeoutMs = Math.max(0, options.warmupTimeoutMs ?? 0);
    this.maxWarmupFailures = Math.max(1, options.maxWarmupFailures ?? 3);
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.deps = deps;
  }

  tick(): Promise<TickReport> {
    if (this.stopped) return Promise.resolve(this.emptyReport());
    const prev = this.passChain;
    const current = prev
      ? prev.then(() => this.safePass())
      : Promise.resolve(this.safePass());
    this.passChain = current;
    void current.then(() => {
      if (this.passChain === current) this.passChain = null;
    });
    return current;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const record of this.inFlight.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    this.inFlight.clear();
  }

  setTargetReady(target: number): void {
    this.targetReady = target;
  }

  getInFlight(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Drop the per-account warmup failure record (attempts, backoff, exhaustion).
   *
   * Used by the BROKEN recovery pass: an account re-armed after an init-failure
   * escalation is usually the same one this controller parked as `exhausted`
   * (`warmup-exhausted` -> FAILED). Requeueing it to STANDBY without clearing
   * the record would leave it permanently `skipped` by `runPass`, so the pool
   * would show a non-BROKEN account that still never warms. Grants a fresh,
   * bounded attempt budget (`maxWarmupFailures`).
   */
  clearWarmupFailureState(accountId: string): void {
    this.states.delete(accountId);
  }

  private emptyReport(): TickReport {
    return {
      launched: [],
      skipped: [],
      deficit: 0,
      ready: 0,
      warming: 0,
      target: this.targetReady ?? 0,
    };
  }

  private safePass(): TickReport {
    try {
      return this.runPass();
    } catch {
      return this.emptyReport();
    }
  }

  private runPass(): TickReport {
    // Heal lapsed cooldowns first so requeued accounts are candidates below.
    this.ownership.reapExpiredCooldowns();
    const snapshot = this.ownership.getPoolSnapshot();
    const target = this.targetReady ?? snapshot.target ?? 0;
    const ready: number = snapshot.ready ?? 0;
    const recovering: number = snapshot.byStatus?.RECOVERING ?? 0;
    const warming = (snapshot.warming ?? 0) + recovering + this.inFlight.size;
    const deficit = Math.max(0, target - ready - warming);
    const launched: string[] = [];
    const skipped: string[] = [];
    const slots = Math.max(
      0,
      Math.min(deficit, this.warmupConcurrency - this.inFlight.size),
    );
    if (slots > 0) {
      const now = this.now();
      // STANDBY (never warmed / requeued) plus RECOVERING (context death,
      // fenced stale owners) — both are warmable, unless cooling down.
      // Exhaustion/backoff below still gates each account individually.
      const candidates: readonly string[] = [
        ...(this.ownership.listAccountsByStatus("STANDBY") ?? []),
        ...(this.ownership.listAccountsByStatus("RECOVERING") ?? []),
      ].filter((id) => !this.ownership.isCoolingDown(id));
      for (const accountId of candidates) {
        if (launched.length >= slots) break;
        if (this.inFlight.has(accountId)) {
          skipped.push(accountId);
          continue;
        }
        const state = this.states.get(accountId);
        if (state?.exhausted) {
          skipped.push(accountId);
          continue;
        }
        if (state && state.backoffUntil > now) {
          skipped.push(accountId);
          continue;
        }
        this.launch(accountId);
        launched.push(accountId);
      }
    }
    return { launched, skipped, deficit, ready, warming, target };
  }

  private launch(accountId: string): void {
    const record: WarmupRecord = { timer: null, settled: false };
    this.inFlight.set(accountId, record);
    if (this.warmupTimeoutMs > 0) {
      record.timer = setTimeout(() => this.onTimeout(accountId), this.warmupTimeoutMs);
      record.timer.unref?.();
    }
    let warmup: Promise<WarmupOutcome>;
    try {
      warmup = this.deps.warmWarmup(accountId);
    } catch {
      this.settleWarmup(accountId, false, false);
      return;
    }
    void warmup.then(
      (outcome) => this.settleWarmup(accountId, outcome === "ready", false),
      () => this.settleWarmup(accountId, false, false),
    );
  }

  private onTimeout(accountId: string): void {
    this.settleWarmup(accountId, false, true);
  }

  private settleWarmup(
    accountId: string,
    success: boolean,
    timedOut: boolean,
  ): void {
    const record = this.inFlight.get(accountId);
    if (!record || record.settled) return;
    record.settled = true;
    if (record.timer) clearTimeout(record.timer);
    this.inFlight.delete(accountId);
    try {
      this.deps.onOutcome?.(accountId, success ? "ready" : "failed", timedOut);
    } catch {
      // Observability must never break the warmup state machine.
    }
    if (timedOut && this.deps.terminateWarmup) {
      void Promise.resolve(this.deps.terminateWarmup(accountId)).catch(
        () => {},
      );
    }
    if (this.stopped) return;
    if (success) {
      this.states.delete(accountId);
    } else {
      const state: AccountWarmState = this.states.get(accountId) ?? {
        failures: 0,
        backoffUntil: 0,
        exhausted: false,
      };
      state.failures += 1;
      if (state.failures >= this.maxWarmupFailures) {
        state.exhausted = true;
        this.states.set(accountId, state);
        // Operator signal: this account is out of warmup attempts and is parked
        // as terminal by recoverAccount("warmup-exhausted"). Silently exhausting
        // left a pool that looked like it was still trying while nothing moved.
        console.warn(
          `❌ [Readiness] Warmup exhausted for ${accountId} after ${state.failures} attempt(s); marking the account terminal (recovery reason "warmup-exhausted")`,
        );
        void Promise.resolve(
          this.ownership.recoverAccount(accountId, "warmup-exhausted"),
        ).catch(() => {});
      } else {
        const delay = Math.min(
          this.backoffBaseMs * 2 ** (state.failures - 1),
          this.backoffMaxMs,
        );
        state.backoffUntil = this.now() + delay + this.jitter();
        this.states.set(accountId, state);
      }
    }
    // Fire after all settle bookkeeping so the follow-up pass sees the final
    // in-flight set, backoff, and exhaustion state (construct.ts ticks the
    // reconciliation loop on this event).
    try {
      this.deps.onSettled?.(accountId, success ? "ready" : "failed");
    } catch {
      // Observability must never break the warmup state machine.
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private jitter(): number {
    return this.deps.jitter ? this.deps.jitter() : 0;
  }
}
