/**
 * StreamManager owns the client-side state of one logical SSE stream: a BOUNDED
 * output buffer with real backpressure, an absolute deadline cascade, terminal
 * detection with exactly-once close, and cancellation.
 *
 * The writer it replaces (src/routes/chat/streaming.ts) appended to an unbounded
 * string buffer and called `streamWriter.write(data)` WITHOUT awaiting it, so a
 * slow or stalled client let memory grow with the generation length; the only
 * bound was the 180s idle timeout. Here every push is awaitable, the buffer is
 * capped at maxBufferBytes, and a client that stays blocked past its deadline
 * is failed as CLIENT_STALLED instead of accumulating output.
 */

/** Injected clock so every deadline is deterministic in tests. */
export interface TimeSource {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export type CloseReason = "completed" | "cancelled" | "failed";

export type StreamErrorCode =
  | "CLIENT_STALLED"
  | "UPSTREAM_TIMEOUT"
  | "CLIENT_ABORTED"
  | "SINK_FAILURE"
  | "STREAM_CLOSED"
  | "STREAM_SUPERSEDED"
  | "STREAM_EVICTED";

/** Every terminal condition carries a typed code for the route to map. */
export class StreamManagerError extends Error {
  public readonly code: StreamErrorCode;

  constructor(message: string, code: StreamErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamManagerError";
    this.code = code;
  }
}

/** The client side of the stream. Exactly one write is in flight at a time. */
export interface StreamSink {
  write(chunk: string): Promise<void> | void;
  close(error?: Error): Promise<void> | void;
}

export interface CreateStreamInput {
  streamId: string;
  generationId?: string;
  accountId?: string;
  /** External lifecycle signal (e.g. the request signal). Aborting it cancels. */
  abortSignal?: AbortSignal;
  /** Absolute epoch-ms hard budget. Progress timestamps never extend it. */
  totalDeadline: number;
  /** Relative ms: the first pushed byte must arrive within this window. */
  firstTokenDeadlineMs: number;
  /** Relative ms: max silence between two pushed bytes. */
  idleTimeoutMs: number;
  /** Hard cap on the queued output buffer, in bytes. */
  maxBufferBytes: number;
  sink: StreamSink;
  /** Fired exactly once with the winning terminal outcome. */
  onTerminal?: (reason: CloseReason, error?: Error) => void;
  time?: TimeSource;
  registry?: StreamRegistry;
  /** Relative ms: separate cap for the queue phase. Default: total only. */
  queueDeadlineMs?: number;
}

/** Absolute epoch-ms deadlines derived from the single totalDeadline (J.3). */
export interface DeadlineCascade {
  queue: number;
  firstToken: number;
  idle: number;
  total: number;
}

interface DrainWaiter {
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Public handle. Callers MUST await push(): the returned promise stays pending
 * while the sink is blocked and the buffer is at its cap (backpressure).
 */
export interface ManagedStream {
  readonly streamId: string;
  readonly generationId: string | null;
  readonly accountId: string | null;
  /** Aborts on terminal, so upstream readers/locks do not linger. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  readonly closedAt: number | null;
  readonly terminalReason: CloseReason | null;
  /** Resolves when terminal work is done; null before the first close. */
  readonly terminal: Promise<void> | null;
  readonly bufferedBytes: number;
  readonly highWaterBytes: number;
  readonly pushedBytes: number;
  readonly pushCount: number;
  /** True once at least one byte was queued for the client. */
  readonly hasEmitted: boolean;
  push(chunk: string): Promise<void>;
  close(reason?: CloseReason, error?: Error): Promise<void>;
  cancel(error?: Error): Promise<void>;
  remainingMs(): number;
  deadlines(): DeadlineCascade;
  startHeartbeat(intervalMs: number, sendFn: () => void | Promise<void>): void;
  stopHeartbeat(): void;
}

export interface StreamRegistry {
  register(streamId: string, handle: ManagedStream): void;
  get(streamId: string): ManagedStream | undefined;
  remove(streamId: string): void;
  /** True for a live stream that has not yet sent the client any byte. */
  hasUnemitted(streamId: string): boolean;
  size(): number;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new StreamManagerError(String(value), "SINK_FAILURE");
}

export const realTime: TimeSource = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(() => {
      callback();
    }, Math.max(0, delayMs));
    return () => {
      clearTimeout(timer);
    };
  },
};

const MAX_REGISTRY_ENTRIES = 8192;

/**
 * Bounded registry: the map never grows past maxEntries (a leak in the old
 * registry held memory and hid the stream from the stop endpoint). Overflow
 * evicts the oldest entry and cancels its handle.
 */
export function createStreamRegistry(
  maxEntries: number = MAX_REGISTRY_ENTRIES,
): StreamRegistry {
  const entries = new Map<string, ManagedStream>();

  const register = (streamId: string, handle: ManagedStream): void => {
    const existing = entries.get(streamId);
    if (existing !== undefined && existing !== handle) {
      void existing.cancel(
        new StreamManagerError(`stream ${streamId} superseded`, "STREAM_SUPERSEDED"),
      );
    }
    if (entries.size >= maxEntries && !entries.has(streamId)) {
      let oldestKey: string | undefined;
      for (const key of entries.keys()) {
        oldestKey = key;
        break;
      }
      if (oldestKey !== undefined) {
        const oldest = entries.get(oldestKey);
        entries.delete(oldestKey);
        if (oldest !== undefined) {
          void oldest.cancel(
            new StreamManagerError(
              `stream ${oldestKey} evicted (registry full)`,
              "STREAM_EVICTED",
            ),
          );
        }
      }
    }
    entries.set(streamId, handle);
  };

  return {
    register,
    get: (streamId) => entries.get(streamId),
    remove: (streamId) => {
      entries.delete(streamId);
    },
    hasUnemitted: (streamId) => {
      const handle = entries.get(streamId);
      return handle !== undefined && !handle.hasEmitted;
    },
    size: () => entries.size,
  };
}

export const defaultStreamRegistry: StreamRegistry = createStreamRegistry();

export function register(streamId: string, handle: ManagedStream): void {
  defaultStreamRegistry.register(streamId, handle);
}

export function getStream(streamId: string): ManagedStream | undefined {
  return defaultStreamRegistry.get(streamId);
}

export function removeStream(streamId: string): void {
  defaultStreamRegistry.remove(streamId);
}

export function hasUnemittedStream(streamId: string): boolean {
  return defaultStreamRegistry.hasUnemitted(streamId);
}

export function createStream(input: CreateStreamInput): ManagedStream {
  return new StreamManager(input);
}

export class StreamManager implements ManagedStream {
  public readonly streamId: string;
  public readonly generationId: string | null;
  public readonly accountId: string | null;

  private readonly abortSignal: AbortSignal | undefined;
  private readonly totalDeadline: number;
  private readonly firstTokenDeadlineMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly lowWaterBytes: number;
  private readonly queueDeadlineMs: number;
  private readonly startAt: number;
  private lastActivityAt: number;
  private readonly sink: StreamSink;
  private readonly onTerminal:
    | ((reason: CloseReason, error?: Error) => void)
    | undefined;
  private readonly time: TimeSource;
  private readonly registry: StreamRegistry;

  private buffer = "";
  private bufferBytes = 0;
  private peakBufferBytes = 0;
  private pushedByteTotal = 0;
  private pushCounter = 0;
  private hasEmittedFlag = false;

  private flushing = false;
  private writeInFlight = false;
  private readonly drainWaiters: DrainWaiter[] = [];

  private closedFlag = false;
  private closedEpoch = 0;
  private terminalReasonValue: CloseReason | null = null;
  private terminalError: Error | null = null;
  private terminalWork: Promise<void> | null = null;

  private heartbeatCancel: (() => void) | null = null;
  private firstTokenCancel: (() => void) | null = null;
  private idleCancel: (() => void) | null = null;
  private totalCancel: (() => void) | null = null;
  private readonly abortListener: () => void;
  private readonly upstreamAbort = new AbortController();

  constructor(input: CreateStreamInput) {
    if (!Number.isFinite(input.totalDeadline)) {
      throw new TypeError("totalDeadline must be a finite epoch-ms value");
    }
    if (
      !Number.isFinite(input.firstTokenDeadlineMs) ||
      input.firstTokenDeadlineMs < 0
    ) {
      throw new TypeError("firstTokenDeadlineMs must be a non-negative number");
    }
    if (!Number.isFinite(input.idleTimeoutMs) || input.idleTimeoutMs < 0) {
      throw new TypeError("idleTimeoutMs must be a non-negative number");
    }
    if (!Number.isInteger(input.maxBufferBytes) || input.maxBufferBytes <= 0) {
      throw new TypeError("maxBufferBytes must be a positive integer");
    }

    this.streamId = input.streamId;
    this.generationId = input.generationId ?? null;
    this.accountId = input.accountId ?? null;
    this.abortSignal = input.abortSignal;
    this.totalDeadline = input.totalDeadline;
    this.firstTokenDeadlineMs = input.firstTokenDeadlineMs;
    this.idleTimeoutMs = input.idleTimeoutMs;
    this.maxBufferBytes = input.maxBufferBytes;
    this.lowWaterBytes = Math.max(1, Math.floor(input.maxBufferBytes / 2));
    this.queueDeadlineMs = input.queueDeadlineMs ?? Number.POSITIVE_INFINITY;
    this.sink = input.sink;
    this.onTerminal = input.onTerminal;
    this.time = input.time ?? realTime;
    this.registry = input.registry ?? defaultStreamRegistry;
    this.startAt = this.time.now();
    this.lastActivityAt = this.startAt;

    this.registry.register(this.streamId, this);

    this.abortListener = (): void => {
      void this.onExternalAbort();
    };
    if (this.abortSignal !== undefined) {
      if (this.abortSignal.aborted) {
        this.abortListener();
      } else {
        this.abortSignal.addEventListener("abort", this.abortListener);
      }
    }

    // One outstanding timer per phase; rescheduling cancels its predecessor, so
    // progress never starts fresh nested timeouts and never extends the total.
    if (this.firstTokenDeadlineMs > 0) {
      this.firstTokenCancel = this.schedule(
        () => this.onFirstTokenFire(),
        this.firstTokenDeadline(),
      );
    }
    this.totalCancel = this.schedule(() => this.onTotalFire(), this.totalDeadline);
  }

  public get signal(): AbortSignal {
    return this.upstreamAbort.signal;
  }

  public get closed(): boolean {
    return this.closedFlag;
  }

  public get closedAt(): number | null {
    return this.closedFlag ? this.closedEpoch : null;
  }

  public get terminalReason(): CloseReason | null {
    return this.terminalReasonValue;
  }

  public get terminal(): Promise<void> | null {
    return this.terminalWork;
  }

  public get bufferedBytes(): number {
    return this.bufferBytes;
  }

  public get highWaterBytes(): number {
    return this.peakBufferBytes;
  }

  public get pushedBytes(): number {
    return this.pushedByteTotal;
  }

  public get pushCount(): number {
    return this.pushCounter;
  }

  public get hasEmitted(): boolean {
    return this.hasEmittedFlag;
  }

  /**
   * Queue `chunk` for the client. Callers MUST await this promise: while the
   * buffer is at maxBufferBytes it stays pending until the sink drains below the
   * low-water mark. Memory is bounded by max(maxBufferBytes, largest single
   * chunk) - never by generation length. Rejects with a StreamManagerError once
   * the stream has terminated.
   */
  public async push(chunk: string): Promise<void> {
    if (this.closedFlag) {
      throw this.closedError();
    }
    const bytes = byteLength(chunk);
    if (bytes <= 0) {
      this.markActivity();
      return;
    }
    while (!this.closedFlag) {
      if (bytes > this.maxBufferBytes) {
        // A single chunk larger than the whole cap cannot be split; it goes
        // through only when nothing else is queued.
        if (this.bufferBytes === 0) {
          break;
        }
      } else if (this.bufferBytes + bytes <= this.maxBufferBytes) {
        break;
      }
      await this.awaitDrainSlot(bytes);
    }
    if (this.closedFlag) {
      throw this.closedError();
    }

    this.buffer += chunk;
    this.bufferBytes += bytes;
    if (this.bufferBytes > this.peakBufferBytes) {
      this.peakBufferBytes = this.bufferBytes;
    }
    this.pushedByteTotal += bytes;
    this.pushCounter += 1;
    this.hasEmittedFlag = true;

    this.markActivity();
    this.scheduleFlush();
  }

  /** Terminal close. Idempotent: the second caller is a no-op. */
  public close(reason: CloseReason = "completed", error?: Error): Promise<void> {
    if (this.closedFlag) {
      return this.terminalWork ?? Promise.resolve();
    }
    // The flag is claimed synchronously, so two callers racing in the same tick
    // (a success callback vs a timeout callback) yield exactly one outcome.
    this.closedFlag = true;
    this.terminalReasonValue = reason;
    this.terminalError = error ?? null;
    this.closedEpoch = this.time.now();
    this.terminalWork = this.runTerminal(reason, error ?? null);
    return this.terminalWork;
  }

  /** Idempotent cancellation; tolerates duplicate calls from racing callbacks. */
  public cancel(error?: Error): Promise<void> {
    return this.close("cancelled", error);
  }

  /** Remaining hard budget; never negative. */
  public remainingMs(): number {
    return Math.max(0, this.totalDeadline - this.time.now());
  }

  public deadlines(): DeadlineCascade {
    return {
      queue: this.queueDeadline(),
      firstToken: this.firstTokenDeadline(),
      idle: this.idleDeadline(),
      total: this.totalDeadline,
    };
  }

  public startHeartbeat(
    intervalMs: number,
    sendFn: () => void | Promise<void>,
  ): void {
    if (this.closedFlag || intervalMs <= 0) {
      return;
    }
    this.stopHeartbeat();
    const tick = (): void => {
      if (this.closedFlag) {
        return;
      }
      const result = sendFn();
      if (
        result !== undefined &&
        typeof (result as Promise<void>).catch === "function"
      ) {
        void (result as Promise<void>).catch(() => {
          /* a heartbeat must never kill the stream */
        });
      }
      if (this.closedFlag) {
        return;
      }
      this.heartbeatCancel = this.time.schedule(tick, intervalMs);
    };
    this.heartbeatCancel = this.time.schedule(tick, intervalMs);
  }

  public stopHeartbeat(): void {
    if (this.heartbeatCancel !== null) {
      this.heartbeatCancel();
      this.heartbeatCancel = null;
    }
  }

  private queueDeadline(): number {
    return Math.min(this.startAt + this.queueDeadlineMs, this.totalDeadline);
  }

  private firstTokenDeadline(): number {
    return Math.min(
      this.startAt + this.firstTokenDeadlineMs,
      this.totalDeadline,
    );
  }

  private idleDeadline(): number {
    return Math.min(this.lastActivityAt + this.idleTimeoutMs, this.totalDeadline);
  }

  private schedule(callback: () => void, at: number): () => void {
    return this.time.schedule(callback, at - this.time.now());
  }

  /**
   * Records upstream progress. Resets the idle deadline and retires the
   * first-token watch; it never moves the total deadline (J.3).
   */
  private markActivity(): void {
    this.lastActivityAt = this.time.now();
    if (this.firstTokenCancel !== null) {
      this.firstTokenCancel();
      this.firstTokenCancel = null;
    }
    if (this.idleTimeoutMs > 0) {
      this.armIdle();
    }
  }

  private armIdle(): void {
    if (this.idleCancel !== null) {
      this.idleCancel();
    }
    this.idleCancel = this.schedule(
      () => this.onIdleFire(),
      this.idleDeadline(),
    );
  }

  private onFirstTokenFire(): void {
    if (this.closedFlag || this.hasEmittedFlag) {
      return;
    }
    this.breach(
      `timed out after ${this.firstTokenDeadlineMs}ms without a first byte`,
    );
  }

  private onIdleFire(): void {
    if (this.closedFlag) {
      return;
    }
    if (this.time.now() < this.idleDeadline()) {
      this.armIdle();
      return;
    }
    const silence = this.time.now() - this.lastActivityAt;
    this.breach(
      `upstream silent for ${silence}ms (idle timeout ${this.idleTimeoutMs}ms)`,
    );
  }

  private onTotalFire(): void {
    if (this.closedFlag) {
      return;
    }
    this.breach("exceeded its total deadline");
  }

  /**
   * A deadline elapsed. When the client is not consuming output the failure is
   * classified CLIENT_STALLED - the buffer is dropped and the upstream aborted
   * rather than accumulating output. Otherwise it is an UPSTREAM_TIMEOUT.
   */
  private breach(message: string): void {
    const blocked =
      this.drainWaiters.length > 0 || this.writeInFlight || this.bufferBytes > 0;
    const code: StreamErrorCode = blocked ? "CLIENT_STALLED" : "UPSTREAM_TIMEOUT";
    const detail = blocked
      ? `${message} while the client was stalled (${this.bufferBytes}B buffered, ${this.drainWaiters.length} push caller(s) blocked)`
      : message;
    void this.close(
      "failed",
      new StreamManagerError(`stream ${this.streamId} ${detail}`, code),
    );
  }

  private onExternalAbort(): void {
    void this.cancel(
      new StreamManagerError(
        `stream ${this.streamId} aborted by the client`,
        "CLIENT_ABORTED",
      ),
    );
  }

  private awaitDrainSlot(bytes: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.drainWaiters.push({ bytes, resolve, reject });
      // A flush may have stalled behind this very push; make sure one is running.
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushing || this.closedFlag || this.bufferBytes <= 0) {
      return;
    }
    this.flushing = true;
    void this.runFlush().catch((err) => {
      void asError(err);
    });
  }

  /** Single-writer drain loop: ordering is preserved because every byte passes
   * through this one buffer and this one sink call. */
  private async runFlush(): Promise<void> {
    try {
      while (this.bufferBytes > 0 && !this.closedFlag) {
        const data = this.buffer;
        this.buffer = "";
        this.bufferBytes = 0;
        this.writeInFlight = true;
        try {
          await this.sink.write(data);
        } catch (err) {
          await this.close("failed", asError(err));
          return;
        } finally {
          this.writeInFlight = false;
        }
        this.notifyDrain();
      }
    } catch (err) {
      void this.close("failed", asError(err));
    } finally {
      this.flushing = false;
      if (!this.closedFlag && this.bufferBytes > 0) {
        this.scheduleFlush();
      }
    }
  }

  /** Backpressure hysteresis: release blocked callers in FIFO order, only after
   * the buffer has drained below the low-water mark and never past the cap. */
  private notifyDrain(): void {
    if (this.drainWaiters.length === 0) {
      return;
    }
    if (this.bufferBytes > this.lowWaterBytes) {
      return;
    }
    while (this.drainWaiters.length > 0) {
      const front = this.drainWaiters[0];
      if (
        front.bytes <= this.maxBufferBytes &&
        this.bufferBytes + front.bytes > this.maxBufferBytes
      ) {
        break;
      }
      this.drainWaiters.shift();
      front.resolve();
    }
  }

  private closedError(): Error {
    return (
      this.terminalError ??
      new StreamManagerError(
        `stream ${this.streamId} already closed`,
        "STREAM_CLOSED",
      )
    );
  }

  private async runTerminal(
    reason: CloseReason,
    error: Error | null,
  ): Promise<void> {
    // Nothing more is buffered or written past this point.
    this.stopHeartbeat();
    if (this.firstTokenCancel !== null) {
      this.firstTokenCancel();
      this.firstTokenCancel = null;
    }
    if (this.idleCancel !== null) {
      this.idleCancel();
      this.idleCancel = null;
    }
    if (this.totalCancel !== null) {
      this.totalCancel();
      this.totalCancel = null;
    }
    if (this.abortSignal !== undefined) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }
    this.buffer = "";
    this.bufferBytes = 0;

    // Release any push blocked on backpressure; it must not hang forever.
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(
        error ??
          new StreamManagerError(
            `stream ${this.streamId} closed`,
            "STREAM_CLOSED",
          ),
      );
    }

    // Aborting cancels in-flight upstream fetches/reads so the per-account
    // stream lock is released immediately instead of at the idle timeout.
    try {
      this.upstreamAbort.abort(error ?? reason);
    } catch {
      /* already aborted */
    }

    // Removed exactly once: close is gated by the closedFlag claim.
    try {
      this.registry.remove(this.streamId);
    } catch {
      /* registry removal must never break teardown */
    }

    try {
      this.onTerminal?.(reason, error ?? undefined);
    } catch {
      /* an observer must never block teardown */
    }

    try {
      await this.sink.close(error ?? undefined);
    } catch {
      /* the sink is gone either way */
    }
  }
}
