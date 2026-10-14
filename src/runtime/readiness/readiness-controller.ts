import type { IAccountOwnership } from "../contracts.ts";

export type WarmupOutcome = "ready" | "failed";

/** Fence used for transitions the controller drives itself (no request lease). */
const SYSTEM_FENCE = { leaseId: "system", ownerToken: "system" };

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
  /**
   * Consecutive EXHAUSTED warmup eras (each era = `maxWarmupFailures` failed
   * attempts) after which an account is parked by the circuit breaker and no
   * longer has a browser launched for it. 0 disables the breaker entirely.
   */
  maxFailedWarmupEras?: number;
  /** Base park window for the breaker (doubles per extra era). */
  failedEraSkipBaseMs?: number;
  /** Ceiling for the breaker park window. */
  failedEraSkipMaxMs?: number;
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

/**
 * Warmup circuit breaker state, tracked SEPARATELY from `states` on purpose.
 *
 * `states` is cleared by the BROKEN recovery pass (it grants a fresh attempt
 * budget), so an account that can never warm — WAF-blocked, dead credentials,
 * never-activated — cycles forever: exhaust → FAILED → re-arm → exhaust,
 * launching a full browser context (~450MB) every cycle for nothing. The era
 * counter survives those recoveries and is cleared only by a REAL successful
 * warmup, so the breaker parks an account that has burned many whole eras
 * without ever once succeeding.
 */
interface WarmupEraState {
  eras: number;
  skipUntil: number;
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
  /** Round-robin position into the warmup candidate list (see rotateCandidates). */
  private candidateCursor = 0;
  /** Warmup circuit breaker: accounts parked after N failed eras. */
  private readonly failedEras = new Map<string, WarmupEraState>();
  private readonly maxFailedWarmupEras: number;
  private readonly failedEraSkipBaseMs: number;
  private readonly failedEraSkipMaxMs: number;
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
    this.maxFailedWarmupEras = Math.max(0, Math.floor(options.maxFailedWarmupEras ?? 3));
    this.failedEraSkipBaseMs = Math.max(1_000, options.failedEraSkipBaseMs ?? 7_200_000);
    this.failedEraSkipMaxMs = Math.max(
      this.failedEraSkipBaseMs,
      options.failedEraSkipMaxMs ?? 86_400_000,
    );
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

  /**
   * True while the account is parked by the warmup circuit breaker. Parking is
   * a WINDOW, never a terminal state: when `skipUntil` passes the account
   * becomes a normal candidate again, and a single successful warmup resets
   * the counter entirely.
   */
  private isWarmupParked(accountId: string, nowMs: number): boolean {
    if (this.maxFailedWarmupEras <= 0) return false;
    const state = this.failedEras.get(accountId);
    if (!state || state.skipUntil <= 0) return false;
    if (state.skipUntil <= nowMs) return false;
    return true;
  }

  /**
   * Count one exhausted warmup era and park the account once it has burned
   * `maxFailedWarmupEras` of them. The window doubles per extra era up to
   * `failedEraSkipMaxMs`, so an account that never recovers stops consuming
   * warmup slots progressively faster while still getting a bounded,
   * self-healing retry path.
   */
  private recordFailedEra(accountId: string): void {
    if (this.maxFailedWarmupEras <= 0) return;
    const state = this.failedEras.get(accountId) ?? { eras: 0, skipUntil: 0 };
    state.eras += 1;
    if (state.eras >= this.maxFailedWarmupEras) {
      const over = state.eras - this.maxFailedWarmupEras;
      const window = Math.min(
        this.failedEraSkipMaxMs,
        this.failedEraSkipBaseMs * Math.pow(2, over),
      );
      state.skipUntil = Date.now() + window;
      console.warn(
        `⛔ [Readiness] Warmup circuit breaker | account=${accountId} | failed ${state.eras} era(s) without ever warming | parked ${Math.round(window / 1000)}s`,
      );
    }
    this.failedEras.set(accountId, state);
  }

  /** Parked accounts + their era counts, for /health and the TUI. */
  getWarmupCircuitBreakers(): Array<{
    accountId: string;
    eras: number;
    skipUntil: number;
    parked: boolean;
  }> {
    const now = Date.now();
    return [...this.failedEras.entries()]
      .filter(([, s]) => s.eras > 0)
      .map(([accountId, s]) => ({
        accountId,
        eras: s.eras,
        skipUntil: s.skipUntil,
        parked: s.skipUntil > now,
      }))
      .sort((a, b) => b.eras - a.eras);
  }

  /** Operator/test escape hatch: un-park an account immediately. */
  clearWarmupCircuitBreaker(accountId: string): void {
    this.failedEras.delete(accountId);
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
    // In-flight warmups are ALREADY counted in `snapshot.warming`: `warmAccount`
    // transitions the account to WARMING synchronously before its first await
    // (construct.ts), so every launched, not-yet-settled account holds WARMING
    // status and is present in the by-status snapshot. Adding `this.inFlight.size`
    // here double-counted each launch and halved effective concurrency: with
    // target 14 / ready 8 / 4 in-flight the controller computed warming 8 →
    // deficit 0 and refused to fill the 2 free slots, freezing the pool below
    // target (the "stops midway" symptom). Concurrency is still enforced exactly
    // once by the `warmupConcurrency - inFlight.size` clamp on `slots` below;
    // this term only needs to express "not-ready but progressing".
    const warming = (snapshot.warming ?? 0) + recovering;
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
      const candidates: readonly string[] = this.rotateCandidates([
        ...(this.ownership.listAccountsByStatus("STANDBY") ?? []),
        ...(this.ownership.listAccountsByStatus("RECOVERING") ?? []),
      ].filter((id) => !this.ownership.isCoolingDown(id)));
      for (const accountId of candidates) {
        if (launched.length >= slots) break;
        if (this.inFlight.has(accountId)) {
          skipped.push(accountId);
          continue;
        }
        // Circuit breaker: an account that burned several whole warmup eras
        // without ever succeeding keeps its browser closed. Checked BEFORE the
        // per-attempt backoff so a re-armed dead account never reaches launch().
        if (this.isWarmupParked(accountId, now)) {
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

  /**
   * Round-robin the candidate list through a persistent cursor before it is
   * consumed.
   *
   * `listAccountsByStatus` returns Map insertion order, which is
   * `ORDER BY created_at ASC`. The `for` loop takes the FIRST eligible
   * entries, so without rotation the same head-of-list accounts are attempted
   * first on every tick and the tail is only ever reached when the head
   * exhausts its retries. With a pool much larger than the readiness target
   * that reads as "the same few accounts warm, nothing else ever does".
   *
   * The cursor advances by however many entries were actually consumed, so
   * successive ticks continue where the previous one stopped. It is
   * process-scoped: which accounts happen to be warm at any moment is not
   * worth persisting, and a restart re-derives it from live status.
   */
  private rotateCandidates(candidates: readonly string[]): string[] {
    if (candidates.length <= 1) return [...candidates];
    const start = this.candidateCursor % candidates.length;
    this.candidateCursor = (start + 1) % candidates.length;
    return [
      ...candidates.slice(start),
      ...candidates.slice(0, start),
    ];
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
    // A warmup that timed out without settling left the account in ownership
    // WARMING — `warmWarmup` never ran its FAILED → STANDBY tail. Nothing else
    // moves it, and `runPass` counts WARMING against the readiness deficit, so a
    // single orphan freezes the whole pool at its current size and no further
    // account is ever warmed. Put it back in the warmable queue. The backoff
    // below still prevents a hot retry loop.
    if (timedOut) {
      try {
        this.ownership.transition(
          accountId,
          "STANDBY",
          SYSTEM_FENCE,
          "warmup-abandoned:timeout",
        );
      } catch {
        // Best-effort: a terminal account rejects the transition by design.
      }
    }
    if (this.stopped) return;
    if (success) {
      this.states.delete(accountId);
      // A real successful warmup is the ONLY thing that clears the breaker:
      // this account proved it can serve, so park history is irrelevant.
      this.failedEras.delete(accountId);
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
        this.recordFailedEra(accountId);
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
