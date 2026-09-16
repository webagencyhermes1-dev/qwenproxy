/**
 * Reusable Appendix-G stress driver. Exercises the NEW runtime components
 * (AccountResourceManager / StreamManager / RetryCoordinator /
 * MaintenanceScheduler / ReadinessController) through their public APIs only.
 *
 * A scenario creates a pool of N fake READY accounts, submits concurrent
 * "generations" that each acquire a lease, stream bytes through a
 * StreamManager backed by a fake sink, and release — with injectable failure
 * hooks (account failure, browser stall, client disconnect, DB failure).
 *
 * Hermetic: no DB files, no network, no real browser, no .env. Deterministic:
 * a seeded PRNG drives every random choice; a fake clock drives every stream
 * deadline. No arbitrary real sleeps: the only awaits are on real completion
 * signals (lease release, stream terminal, job completion) or on bounded
 * event-loop flushes.
 */
import { newGenerationId, newOperationId } from "../../domain/ids.ts";
import type { AccountLease, GenerationState } from "../../domain/types.ts";
import { TypedRuntimeError } from "../../domain/errors.ts";
import {
  type Generation,
  type GenerationAttempt,
  nextAttempt,
} from "../../domain/generation.ts";
import type {
  AcquireLeaseResult,
  OwnershipFence,
  ReleaseOutcome,
} from "../../runtime/contracts.ts";
import { AccountResourceManager } from "../../runtime/account/resource-manager.ts";
import {
  StreamManagerError,
  createStream,
  createStreamRegistry,
} from "../../runtime/stream/stream-manager.ts";
import type {
  ManagedStream,
  StreamRegistry,
  StreamSink,
  TimeSource,
} from "../../runtime/stream/stream-manager.ts";
import { RetryCoordinator } from "../../runtime/retry/retry-coordinator.ts";
import type {
  InvariantCounts,
  InvariantName,
} from "./summary.ts";
import { zeroInvariantCounts } from "./summary.ts";

// ─── Deterministic randomness ─────────────────────────────────────────────

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: seeded, reproducible. Never Math.random(). */
export class SeededPrng {
  private state: number;
  constructor(seed: string) {
    this.state = hashSeed(seed) || 1;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  bool(probability: number): boolean {
    return this.next() < probability;
  }
}

// ─── Fake clock ───────────────────────────────────────────────────────────

interface ScheduledTimer {
  fireAt: number;
  callback: () => void;
  cancelled: boolean;
}

/** Virtual clock injected as StreamManager TimeSource / scheduler now(). */
export class FakeTime implements TimeSource {
  private nowMs: number;
  private readonly timers: ScheduledTimer[] = [];
  constructor(start: number = 1_000_000) {
    this.nowMs = start;
  }
  now(): number {
    return this.nowMs;
  }
  schedule(callback: () => void, delayMs: number): () => void {
    const entry: ScheduledTimer = {
      fireAt: this.nowMs + Math.max(0, Math.trunc(delayMs)),
      callback,
      cancelled: false,
    };
    this.timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }
  advance(deltaMs: number): void {
    this.nowMs += Math.max(0, Math.trunc(deltaMs));
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 10_000) break;
      const due = this.timers.filter((t) => !t.cancelled && t.fireAt <= this.nowMs);
      if (due.length === 0) break;
      due.sort((a, b) => a.fireAt - b.fireAt);
      for (const t of due) {
        const index = this.timers.indexOf(t);
        if (index >= 0) this.timers.splice(index, 1);
      }
      for (const t of due) t.callback();
    }
  }
  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

// ─── Primitives ───────────────────────────────────────────────────────────

export class Barrier {
  private released = false;
  private resolvers: Array<() => void> = [];
  wait(): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    const pending = this.resolvers;
    this.resolvers = [];
    for (const resolve of pending) resolve();
  }
  get waiters(): number {
    return this.resolvers.length;
  }
}

/** Bounded event-loop flush: yields macrotasks without sleeping. */
export async function flushEvents(rounds: number = 4): Promise<void> {
  for (let i = 0; i < Math.max(1, rounds); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Client side of a stream; can stall (backpressure) or reject writes. */
export class FakeSink implements StreamSink {
  readonly chunks: string[] = [];
  bytes: number = 0;
  closed: boolean = false;
  closeError: Error | undefined;
  stall: boolean = false;
  rejectNext: boolean = false;
  write(chunk: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("sink closed"));
    if (this.stall) return new Promise<void>(() => {});
    if (this.rejectNext) {
      this.rejectNext = false;
      return Promise.reject(new Error("sink write failed"));
    }
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, "utf8");
    return Promise.resolve();
  }
  close(error?: Error): Promise<void> {
    this.closed = true;
    this.closeError = error;
    return Promise.resolve();
  }
}

export interface BrowserOperation {
  readonly opId: string;
  readonly accountId: string;
  readonly generationId: string;
  readonly leaseId: string;
  readonly streamId: string;
  readonly startedAt: number;
  finishedAt: number | null;
  cancelled: boolean;
}

/**
 * Tracks live "browser" work so the harness can detect a detached browser
 * generation: an operation still running after its lease/generation is gone.
 */
export class OperationRegistry {
  private readonly ops = new Map<string, BrowserOperation>();
  register(input: {
    accountId: string;
    generationId: string;
    leaseId: string;
    streamId: string;
    startedAt: number;
  }): BrowserOperation {
    const op: BrowserOperation = {
      opId: newOperationId(),
      ...input,
      finishedAt: null,
      cancelled: false,
    };
    this.ops.set(op.opId, op);
    return op;
  }
  finish(opId: string): boolean {
    const op = this.ops.get(opId);
    if (op === undefined || op.finishedAt !== null) return false;
    op.finishedAt = Date.now();
    return true;
  }
  cancel(opId: string): boolean {
    const op = this.ops.get(opId);
    if (op === undefined || op.finishedAt !== null) return false;
    op.cancelled = true;
    op.finishedAt = Date.now();
    return true;
  }
  values(): IterableIterator<BrowserOperation> {
    return this.ops.values();
  }
  get size(): number {
    return this.ops.size;
  }
  liveCount(): number {
    let n = 0;
    for (const op of this.ops.values()) if (op.finishedAt === null) n += 1;
    return n;
  }
  detachedCount(
    activeGenerationIds: ReadonlySet<string>,
    leaseOf: (accountId: string) => AccountLease | null,
  ): number {
    let n = 0;
    for (const op of this.ops.values()) {
      if (op.finishedAt !== null) continue;
      if (!activeGenerationIds.has(op.generationId)) {
        n += 1;
        continue;
      }
      if (leaseOf(op.accountId)?.leaseId !== op.leaseId) n += 1;
    }
    return n;
  }
}

/** The eight Appendix-G counters plus free-form metrics. */
export class StressCounters {
  readonly counts: InvariantCounts = zeroInvariantCounts();
  readonly metrics: Record<string, number> = {};
  inc(name: InvariantName, amount: number = 1): void {
    this.counts[name] += amount;
  }
  metric(name: string, amount: number = 1): void {
    this.metrics[name] = (this.metrics[name] ?? 0) + amount;
  }
  setMetric(name: string, value: number): void {
    this.metrics[name] = value;
  }
}

// ─── Generation specs / outcomes ──────────────────────────────────────────

export type FailMode = "none" | "account" | "stall" | "disconnect" | "db";

export interface GenerationSpec {
  sessionId: string;
  chunks: number;
  chunkChars: number;
  ttlMs?: number;
  failMode?: FailMode;
  /** acquire retries while every candidate is busy (bounded queue pressure) */
  busyRetries?: number;
}

export type GenerationOutcome =
  | { kind: "completed"; generationId: string; accountId: string; bytes: number }
  | { kind: "failed"; generationId: string; reason: string }
  | { kind: "cancelled"; generationId: string; reason: string }
  | { kind: "acquire-failed"; generationId: string; failureCode: string }
  | { kind: "db-failure"; generationId: string; accountId: string; reason: string }
  | { kind: "abandoned"; generationId: string; reason: string };

interface ActiveGeneration {
  generationId: string;
  sessionId: string;
  accountId: string | null;
  lease: AccountLease | null;
  generation: Generation;
  attempt: GenerationAttempt;
  stream: ManagedStream | null;
  sink: FakeSink | null;
  abort: AbortController;
  op: BrowserOperation | null;
  state: GenerationState;
  failMode: FailMode;
  emitted: boolean;
  terminalReason: string | null;
  crashed: boolean;
}

const STREAM_BUDGET_MS = 10_000;
export const SYSTEM_FENCE: OwnershipFence = {
  leaseId: "system",
  ownerToken: "system",
};

function makeBaseGeneration(
  generationId: string,
  sessionId: string,
  deadline: number,
): Generation {
  return {
    generationId,
    tenantId: "stress",
    sessionId,
    turnId: `turn_${generationId}`,
    sessionVersionAtStart: 1,
    state: "QUEUED",
    attemptIds: [],
    attemptedAccountIds: [],
    snapshotId: null,
    leaseId: null,
    deadline,
    createdAt: Date.now(),
    terminalAt: null,
    sideEffects: {
      outputEmittedToClient: false,
      toolCallsExecuted: [],
      lastUpdatedAt: Date.now(),
    },
    idempotencyKey: null,
  };
}

function asFence(lease: AccountLease): OwnershipFence {
  return { leaseId: lease.leaseId, ownerToken: lease.ownerToken };
}

export interface DriverSnapshot {
  activeGenerations: number;
  liveLeases: number;
  liveStreams: number;
  liveOps: number;
  pendingTimers: number;
}

export interface SweepReport {
  swept: number;
  cleanExits: number;
  fenced: number;
  forceCancelledOps: number;
}

export interface StressDriverOptions {
  accountCount: number;
  seed: string;
  targetReady?: number;
  maxBufferBytes?: number;
  /** shared counters across several pools in one scenario */
  counters?: StressCounters;
}

/**
 * Owns one hermetic universe: an AccountResourceManager pool, a fake clock, a
 * stream registry, a browser operation registry and the eight invariant
 * counters. Scenarios drive it through submitGeneration / crashGeneration /
 * sweepOrphans and read counters at the end.
 */
export class StressDriver {
  readonly ownership: AccountResourceManager;
  readonly accountIds: string[];
  readonly time: FakeTime = new FakeTime();
  readonly streams: StreamRegistry = createStreamRegistry(4096);
  readonly ops: OperationRegistry = new OperationRegistry();
  readonly prng: SeededPrng;
  readonly counters: StressCounters;
  private readonly active = new Map<string, ActiveGeneration>();
  private readonly tombstone = new Map<string, ActiveGeneration>();
  private readonly liveLeases = new Map<string, string>();
  private readonly retry: RetryCoordinator;
  private readonly maxBufferBytes: number;
  private readonly leaseTtlMs: number = 5_000;

  constructor(options: StressDriverOptions) {
    this.ownership = new AccountResourceManager({
      targetReady: options.targetReady ?? 2,
    });
    this.counters = options.counters ?? new StressCounters();
    this.accountIds = [];
    for (let i = 0; i < options.accountCount; i++) {
      const accountId = `acct-${String(i + 1).padStart(3, "0")}`;
      this.accountIds.push(accountId);
      this.ownership.registerAccount(accountId, {
        accountId,
        disabled: false,
        cooldownUntil: 0,
        cooldownReason: null,
      });
    }
    this.prng = new SeededPrng(`${options.seed}|pool${options.accountCount}`);
    this.maxBufferBytes = options.maxBufferBytes ?? 65_536;
    this.retry = new RetryCoordinator({
      maxAttempts: 4,
      maxAccountSwitches: 2,
      baseDelayMs: 1,
      maxDelayMs: 8,
      chatInProgressMaxSameChat: 2,
      jitter: () => this.prng.next(),
    });
  }

  /** Maintenance warmup: STANDBY -> WARMING -> READY via the system fence. */
  warmAccounts(count: number): void {
    let warmed = 0;
    for (const accountId of this.accountIds) {
      if (warmed >= count) break;
      if (
        this.ownership.transition(accountId, "WARMING", SYSTEM_FENCE, "stress:warm")
          .transitioned &&
        this.ownership.transition(accountId, "READY", SYSTEM_FENCE, "stress:ready")
          .transitioned
      ) {
        warmed += 1;
      }
    }
  }

  /** Deterministic candidate order per session (seeded, not Math.random). */
  candidatesFor(sessionId: string): string[] {
    const order = [...this.accountIds];
    const local = new SeededPrng(`${this.prng.next()}|${sessionId}`);
    for (let i = order.length - 1; i > 0; i--) {
      const j = local.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  private makeChunk(chars: number, index: number): string {
    const alphabet = "ABCDEFGHij klmnop";
    const base = alphabet[(index + 7) % alphabet.length];
    return `${base}${String(index).padStart(3, "0")}-`.repeat(
      Math.max(1, Math.ceil(chars / 5)),
    ).slice(0, chars);
  }

  private claimAccount(
    generationId: string,
    candidates: readonly string[],
    ttl: number,
  ): AcquireLeaseResult {
    return this.ownership.acquire({
      generationId,
      candidates,
      deadline: Date.now() + ttl,
      requirements: { purpose: "generation", generationId },
    });
  }

  private recordLease(rec: ActiveGeneration, lease: AccountLease): void {
    const existing = this.liveLeases.get(lease.accountId);
    if (existing !== undefined && existing !== rec.generationId) {
      this.counters.inc("duplicateAccountGeneration");
    }
    this.liveLeases.set(lease.accountId, rec.generationId);
    rec.lease = lease;
  }

  private releaseLease(rec: ActiveGeneration, outcome: ReleaseOutcome): void {
    if (rec.lease === null || rec.accountId === null) return;
    const result = this.ownership.release({
      ...asFence(rec.lease),
      outcome,
      reason: "stress",
    });
    if (result.released) this.counters.metric("releases");
    if (this.liveLeases.get(rec.accountId) === rec.generationId) {
      this.liveLeases.delete(rec.accountId);
    }
    rec.lease = null;
  }

  private finishOp(rec: ActiveGeneration, cancelled: boolean): void {
    if (rec.op === null) return;
    if (cancelled) this.ops.cancel(rec.op.opId);
    else this.ops.finish(rec.op.opId);
  }

  /**
   * One logical generation: acquire -> GENERATING -> stream chunks -> release.
   * Failure modes are injected at deterministic points (no timing races).
   */
  async submitGeneration(spec: GenerationSpec): Promise<GenerationOutcome> {
    const generationId = newGenerationId();
    const ttl = spec.ttlMs ?? this.leaseTtlMs;
    const failMode = spec.failMode ?? "none";
    const rec: ActiveGeneration = {
      generationId,
      sessionId: spec.sessionId,
      accountId: null,
      lease: null,
      generation: makeBaseGeneration(generationId, spec.sessionId, Date.now() + ttl),
      attempt: {
        attemptId: "",
        generationId,
        attemptNumber: 0,
        accountId: "",
        state: "STARTING",
        startedAt: null,
        upstreamStartedAt: null,
        firstTokenAt: null,
        completedAt: null,
        failureCode: null,
        failureReason: null,
      },
      stream: null,
      sink: null,
      abort: new AbortController(),
      op: null,
      state: "QUEUED",
      failMode,
      emitted: false,
      terminalReason: null,
      crashed: false,
    };
    this.active.set(generationId, rec);
    this.counters.metric("generations");

    const candidates = this.candidatesFor(spec.sessionId);
    let acquired = this.claimAccount(generationId, candidates, ttl);
    let retries = 0;
    while (
      !acquired.ok &&
      (acquired.failureCode === "ALL_BUSY" || acquired.failureCode === "ALL_COOLDOWN") &&
      retries < (spec.busyRetries ?? 0)
    ) {
      retries += 1;
      this.counters.metric("busy-retries");
      await flushEvents(1);
      acquired = this.claimAccount(generationId, candidates, ttl);
    }
    if (!acquired.ok) {
      this.active.delete(generationId);
      rec.state = "FAILED";
      return { kind: "acquire-failed", generationId, failureCode: acquired.failureCode };
    }

    this.recordLease(rec, acquired.lease);
    rec.accountId = acquired.accountId;
    const opened = nextAttempt(rec.generation, acquired.accountId);
    if (opened === null) {
      this.releaseLease(rec, "failed");
      this.active.delete(generationId);
      return { kind: "failed", generationId, reason: "attempt-budget" };
    }
    rec.generation = opened.generation;
    rec.attempt = opened.attempt;
    this.counters.metric("leases");

    const startTransition = this.ownership.transition(
      acquired.accountId,
      "GENERATING",
      asFence(acquired.lease),
      "stress:generating",
    );
    if (!startTransition.transitioned) {
      this.releaseLease(rec, "failed");
      this.active.delete(generationId);
      return { kind: "failed", generationId, reason: "illegal-generating" };
    }
    rec.state = "STREAMING";
    rec.generation = { ...rec.generation, state: "STARTING", leaseId: acquired.lease.leaseId };

    if (failMode === "account") {
      const outcome = this.injectAccountFailure(rec, ttl);
      if (outcome !== null) return outcome;
    }
    const sink = new FakeSink();
    if (failMode === "stall") sink.stall = true;
    const stream = createStream({
      streamId: `stream_${generationId}`,
      generationId,
      accountId: rec.accountId ?? undefined,
      abortSignal: rec.abort.signal,
      totalDeadline: this.time.now() + STREAM_BUDGET_MS,
      firstTokenDeadlineMs: Math.trunc(STREAM_BUDGET_MS / 2),
      idleTimeoutMs: Math.trunc(STREAM_BUDGET_MS / 2),
      maxBufferBytes: this.maxBufferBytes,
      sink,
      time: this.time,
      registry: this.streams,
      onTerminal: (reason) => {
        rec.terminalReason = reason;
      },
    });
    rec.stream = stream;
    rec.sink = sink;
    rec.op = this.ops.register({
      accountId: rec.accountId ?? "",
      generationId,
      leaseId: acquired.lease.leaseId,
      streamId: stream.streamId,
      startedAt: this.time.now(),
    });

    for (let i = 0; i < spec.chunks; i++) {
      if (failMode === "disconnect" && i === 1) {
        rec.abort.abort();
      }
      try {
        await stream.push(this.makeChunk(spec.chunkChars, i));
        rec.emitted = true;
      } catch {
        break;
      }
    }

    if (!stream.closed) {
      if (failMode === "db") {
        await stream.close("completed");
        await stream.terminal;
        this.finishOp(rec, false);
        this.counters.metric("db-failures");
        // The lease is deliberately left live: the process crashed before the
        // release was persisted. Stays tracked until the scenario crashes it.
        return {
          kind: "db-failure",
          generationId,
          accountId: rec.accountId ?? "",
          reason: "release persistence lost",
        };
      }
      await stream.close("completed");
    }
    await stream.terminal;

    if (rec.crashed) {
      // The process died mid-flight: no late cleanup, no release, no op finish.
      // The stale-lease sweep owns the lease and the detached browser op.
      this.active.delete(generationId);
      rec.state = "ABANDONED";
      return { kind: "abandoned", generationId, reason: "process-crash" };
    }

    const cancelled = stream.terminalReason === "cancelled";
    this.finishOp(rec, cancelled);
    if (cancelled) {
      this.releaseLease(rec, "cancelled");
      rec.state = "CANCELLED";
      this.active.delete(generationId);
      return {
        kind: "cancelled",
        generationId,
        reason: rec.terminalReason ?? "client-aborted",
      };
    }
    if (stream.terminalReason === "failed") {
      this.releaseLease(rec, "failed");
      rec.state = "FAILED";
      this.active.delete(generationId);
      return {
        kind: "failed",
        generationId,
        reason: rec.terminalReason ?? "stream-failed",
      };
    }

    this.releaseLease(rec, "completed");
    rec.state = "COMPLETED";
    this.active.delete(generationId);
    this.counters.metric("bytes-streamed", sink.bytes);
    return {
      kind: "completed",
      generationId,
      accountId: rec.accountId ?? "",
      bytes: sink.bytes,
    };
  }

  /**
   * Account-level failure right after the account went GENERATING and before
   * any byte was emitted. The retry coordinator decides: replay on an untried
   * account, or fail terminal (never replay after irreversible side effects).
   */
  private injectAccountFailure(
    rec: ActiveGeneration,
    ttl: number,
  ): GenerationOutcome | null {
    if (rec.accountId === null || rec.lease === null) return null;
    const failed = this.ownership.transition(
      rec.accountId,
      "FAILED",
      asFence(rec.lease),
      "stress:account-failure",
    );
    if (!failed.transitioned) return null;
    this.counters.metric("account-failures");

    const error = TypedRuntimeError.fromCode(
      "ACCOUNT_UNAVAILABLE",
      "stress:account-failure",
    );
    const decision = this.retry.decide({
      error,
      generation: rec.generation,
      attempt: rec.attempt,
      chatCorrupted: false,
      accountLevelFailure: true,
    });
    if (decision.action !== "RETRY") {
      this.releaseLease(rec, "failed");
      this.active.delete(rec.generationId);
      rec.state = "FAILED";
      return {
        kind: "failed",
        generationId: rec.generationId,
        reason: `decision:${decision.action}:${decision.reason}`,
      };
    }
    this.counters.metric("failover-decisions");

    const tried = new Set(rec.generation.attemptedAccountIds);
    const remaining = this.candidatesFor(rec.sessionId).filter((id) => !tried.has(id));
    const next = this.claimAccount(rec.generationId, remaining, ttl);
    if (!next.ok) {
      this.releaseLease(rec, "failed");
      this.active.delete(rec.generationId);
      rec.state = "FAILED";
      return { kind: "acquire-failed", generationId: rec.generationId, failureCode: next.failureCode };
    }
    const oldAccountId = rec.accountId;
    this.releaseLease(rec, "failed");
    this.recordLease(rec, next.lease);
    rec.accountId = next.accountId;
    const reopened = nextAttempt(rec.generation, next.accountId);
    if (reopened === null) {
      this.releaseLease(rec, "failed");
      this.active.delete(rec.generationId);
      return { kind: "failed", generationId: rec.generationId, reason: "attempt-budget" };
    }
    rec.generation = reopened.generation;
    rec.attempt = reopened.attempt;
    const transitioned = this.ownership.transition(
      next.accountId,
      "GENERATING",
      asFence(next.lease),
      "stress:failover",
    );
    if (!transitioned.transitioned) {
      this.releaseLease(rec, "failed");
      this.active.delete(rec.generationId);
      return { kind: "failed", generationId: rec.generationId, reason: "illegal-failover" };
    }
    this.counters.metric("failovers");
    this.counters.metric(`failover-from:${oldAccountId}`);
    return null;
  }

  /** Simulate a crashed process: drop bookkeeping, keep the lease live. */
  crashGeneration(generationId: string): boolean {
    const rec = this.active.get(generationId);
    if (rec === undefined) return false;
    this.active.delete(generationId);
    rec.crashed = true;
    if (rec.lease !== null) this.tombstone.set(rec.lease.leaseId, rec);
    this.counters.metric("crashes");
    return true;
  }

  /** Generations still in flight (resolved generations are shed). */
  activeGenerationIds(): string[] {
    return [...this.active.keys()];
  }

  liveLeasedAccounts(): string[] {
    return this.accountIds.filter((id) => this.ownership.getOwnership(id).lease !== null);
  }

  /** Recovery sweep: for every account still carrying a lease, run the
   * stale-lease protocol. Cooperating orphans release inside the grace window;
   * unresponsive ones are fenced, then their detached browser op is force
   * cancelled. */
  async sweepOrphans(): Promise<SweepReport> {
    const report: SweepReport = {
      swept: 0,
      cleanExits: 0,
      fenced: 0,
      forceCancelledOps: 0,
    };
    const leased = this.liveLeasedAccounts();
    for (const accountId of leased) {
      const lease = this.ownership.getOwnership(accountId).lease;
      if (lease === null) continue;
      report.swept += 1;
      const cooperate = this.prng.bool(0.5);
      const result = await this.ownership.markStaleAndFence(accountId, {
        graceMs: 2,
        deadline: Date.now() + 500,
        requestCancellation: async (staleLease) => {
          const rec = this.tombstone.get(staleLease.leaseId);
          if (rec === undefined) return;
          if (!cooperate) {
            // An unresponsive browser: cancellation fails, fencing must handle it.
            throw new StreamManagerError("browser unresponsive", "SINK_FAILURE");
          }
          this.releaseLease(rec, "abandoned");
          this.finishOp(rec, true);
          if (rec.stream !== null && !rec.stream.closed) {
            void rec.stream.cancel(
              new StreamManagerError("orphan cancelled", "CLIENT_ABORTED"),
            );
          }
        },
      });
      if (result.fenced) {
        report.fenced += 1;
        // The fence cleared the authoritative lease; drop the driver's stale
        // bookkeeping so a future owner is not misread as a second owner.
        this.liveLeases.delete(accountId);
        const rec = this.tombstone.get(lease.leaseId);
        if (rec !== undefined) {
          if (rec.op !== null && rec.op.finishedAt === null) {
            this.ops.cancel(rec.op.opId);
            report.forceCancelledOps += 1;
          }
          if (rec.stream !== null && !rec.stream.closed) {
            void rec.stream.cancel(
              new StreamManagerError("orphan fenced", "CLIENT_ABORTED"),
            );
          }
        }
      } else if (result.cleanExit) {
        report.cleanExits += 1;
      }
    }
    this.counters.metric("sweeps", report.swept);
    this.counters.metric("fenced", report.fenced);
    return report;
  }

  /** Cross-check the authoritative pool against driver bookkeeping. */
  scanPool(): void {
    const seenLeaseIds = new Set<string>();
    for (const accountId of this.accountIds) {
      const lease = this.ownership.getOwnership(accountId).lease;
      if (lease === null) continue;
      if (seenLeaseIds.has(lease.leaseId)) this.counters.inc("duplicateLeaseOwner");
      seenLeaseIds.add(lease.leaseId);
      const driverOwner = this.liveLeases.get(accountId);
      if (driverOwner !== undefined && driverOwner !== lease.generationId) {
        this.counters.inc("duplicateAccountGeneration");
      }
    }
  }

  /** Terminal invariant measurement (call after crash + sweep). */
  assertClean(): void {
    this.scanPool();
    for (const accountId of this.accountIds) {
      if (this.ownership.getOwnership(accountId).lease !== null) {
        this.counters.inc("orphanLease");
      }
    }
    const detached = this.ops.detachedCount(
      new Set(this.active.keys()),
      (accountId) => this.ownership.getOwnership(accountId).lease,
    );
    this.counters.inc("detachedBrowserGeneration", detached);
    this.setResourceSnapshot();
  }

  setResourceSnapshot(): void {
    this.counters.setMetric("active-generations", this.active.size);
    this.counters.setMetric("live-leases", this.liveLeasedAccounts().length);
    this.counters.setMetric("live-streams", this.streams.size());
    this.counters.setMetric("live-ops", this.ops.liveCount());
    this.counters.setMetric("pending-timers", this.time.pending());
  }

  snapshot(): DriverSnapshot {
    return {
      activeGenerations: this.active.size,
      liveLeases: this.liveLeasedAccounts().length,
      liveStreams: this.streams.size(),
      liveOps: this.ops.liveCount(),
      pendingTimers: this.time.pending(),
    };
  }
}
