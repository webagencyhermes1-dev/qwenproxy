import test from "node:test";
import assert from "node:assert/strict";
import {
  StreamManagerError,
  createStream,
  createStreamRegistry,
  type CloseReason,
  type CreateStreamInput,
  type ManagedStream,
  type StreamRegistry,
  type StreamSink,
  type TimeSource,
} from "./stream-manager.ts";

interface ScheduledTimer {
  fire: number;
  callback: () => void;
  cancelled: boolean;
}

interface FakeTime extends TimeSource {
  advance(ms: number): void;
  pending(): number;
  reset(): void;
}

function createFakeTime(): FakeTime {
  let current = 0;
  const timers: ScheduledTimer[] = [];
  return {
    now: () => current,
    schedule: (callback, delayMs) => {
      const timer: ScheduledTimer = {
        fire: current + Math.max(0, delayMs),
        callback,
        cancelled: false,
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance: (ms) => {
      const target = current + ms;
      for (;;) {
        let next: ScheduledTimer | null = null;
        for (const timer of timers) {
          if (!timer.cancelled && timer.fire <= target) {
            if (next === null || timer.fire < next.fire) {
              next = timer;
            }
          }
        }
        if (next === null) {
          break;
        }
        next.cancelled = true;
        current = next.fire;
        next.callback();
      }
      current = target;
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
    reset: () => {
      timers.length = 0;
      current = 0;
    },
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function createDeferred(): Deferred {
  let resolveFn!: () => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

interface FakeSink {
  sink: StreamSink;
  writes: string[];
  closed: number;
  closeError: Error | undefined;
  block(): void;
  unblock(): void;
}

function createFakeSink(): FakeSink {
  const writes: string[] = [];
  let closed = 0;
  let closeError: Error | undefined;
  let gate: Deferred | null = null;
  const sink: StreamSink = {
    async write(chunk: string): Promise<void> {
      writes.push(chunk);
      while (gate !== null) {
        const held = gate;
        await held.promise;
      }
    },
    async close(error?: Error): Promise<void> {
      closed += 1;
      closeError = error;
    },
  };
  return {
    sink,
    writes,
    get closed() {
      return closed;
    },
    get closeError() {
      return closeError;
    },
    block() {
      gate = createDeferred();
    },
    unblock() {
      const held = gate;
      gate = null;
      held?.resolve();
    },
  };
}

async function pump(ticks: number = 25): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

interface TerminalRecord {
  reason: CloseReason;
  error?: Error;
}

interface Harness {
  mgr: ManagedStream;
  sink: FakeSink;
  time: FakeTime;
  terminals: TerminalRecord[];
  removed: string[];
}

const MAX_BUFFER = 8192;
const CHUNK = 1000;

function makeHarness(overrides: Partial<CreateStreamInput> = {}): Harness {
  const time = createFakeTime();
  const sink = createFakeSink();
  const terminals: TerminalRecord[] = [];
  const registry = createStreamRegistry(64);
  const removed: string[] = [];
  const wrapped: StreamRegistry = {
    register: (id, handle) => registry.register(id, handle),
    get: (id) => registry.get(id),
    remove: (id) => {
      removed.push(id);
      registry.remove(id);
    },
    hasUnemitted: (id) => registry.hasUnemitted(id),
    size: () => registry.size(),
  };
  const mgr = createStream({
    streamId: "stream-1",
    totalDeadline: 1000,
    firstTokenDeadlineMs: 50,
    idleTimeoutMs: 100,
    maxBufferBytes: MAX_BUFFER,
    sink: sink.sink,
    time,
    registry: wrapped,
    onTerminal: (reason, error) => {
      terminals.push({ reason, error });
    },
    ...overrides,
  });
  return { mgr, sink, time, terminals, removed };
}

test("backpressure: a blocked sink makes push await and keeps the buffer capped", async () => {
  const { mgr, sink } = makeHarness();
  sink.block();

  for (let i = 0; i < 9; i += 1) {
    await mgr.push("a".repeat(CHUNK));
  }
  assert.ok(mgr.bufferedBytes <= MAX_BUFFER, "buffer must stay under the cap");
  assert.equal(sink.writes.length, 1, "exactly one write should be in flight");

  let released = false;
  const blocked = mgr.push("a".repeat(CHUNK)).then(() => {
    released = true;
  });
  await pump();
  assert.equal(released, false, "push must not resolve while the sink is blocked");
  assert.ok(mgr.bufferedBytes <= MAX_BUFFER, "capped while blocked");
  assert.equal(mgr.highWaterBytes, 8 * CHUNK);

  sink.unblock();
  await blocked;
  await pump(50);
  assert.equal(released, true, "push resolves once the sink drains");
  const total = sink.writes.reduce((sum, write) => sum + write.length, 0);
  assert.equal(total, 10 * CHUNK, "every buffered byte is delivered in order");
  assert.equal(mgr.bufferedBytes, 0);
});

test("client stall: a sink blocked past the deadline fails CLIENT_STALLED, never grows memory", async () => {
  const { mgr, sink, time, terminals } = makeHarness({ totalDeadline: 500 });
  sink.block();

  for (let i = 0; i < 9; i += 1) {
    await mgr.push("a".repeat(CHUNK));
  }
  let pushError: Error | null = null;
  const blocked = mgr.push("a".repeat(CHUNK)).catch((err: Error) => {
    pushError = err;
  });
  await pump();
  assert.ok(!pushError);
  assert.ok(mgr.bufferedBytes <= MAX_BUFFER);
  const peakBefore = mgr.highWaterBytes;

  time.advance(500);
  await blocked;
  await pump();

  assert.ok(pushError !== null, "the blocked push must reject");
  assert.equal((pushError as StreamManagerError).code, "CLIENT_STALLED");
  assert.equal(mgr.terminalReason, "failed");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].reason, "failed");
  assert.equal(
    (terminals[0].error as StreamManagerError).code,
    "CLIENT_STALLED",
  );
  assert.ok(mgr.highWaterBytes <= MAX_BUFFER, "memory never grew past the cap");
  assert.equal(mgr.highWaterBytes, peakBefore);
  assert.equal(mgr.bufferedBytes, 0, "buffer dropped on terminal");
  assert.equal(sink.closed, 1);
  assert.equal(time.pending(), 0, "no timer outlives the stream");
});

test("racing close callers produce exactly one terminal outcome", async () => {
  const { mgr, sink, time, terminals } = makeHarness();
  const first = mgr.close("completed");
  const second = mgr.close("failed", new Error("boom"));
  await Promise.all([first, second]);

  assert.equal(terminals.length, 1, "onTerminal fires exactly once");
  assert.equal(terminals[0].reason, "completed");
  assert.equal(terminals[0].error, undefined);
  assert.equal(mgr.terminalReason, "completed");
  assert.ok(mgr.closedAt !== null);
  assert.equal(sink.closed, 1);
  assert.equal(time.pending(), 0);
  assert.equal(mgr.signal.aborted, true, "the upstream is released on terminal");
});

test("double cancel is a no-op", async () => {
  const { mgr, sink, time, terminals, removed } = makeHarness();
  await mgr.cancel();
  await mgr.cancel(new Error("again"));

  assert.equal(terminals.length, 1);
  assert.equal(mgr.terminalReason, "cancelled");
  assert.equal(sink.closed, 1);
  assert.deepEqual(removed, ["stream-1"]);
  assert.equal(time.pending(), 0);
});

test("an aborted request signal cancels the stream", async () => {
  const controller = new AbortController();
  const { mgr, terminals } = makeHarness({ abortSignal: controller.signal });
  await pump();
  assert.equal(mgr.closed, false);
  controller.abort();
  await pump(10);

  assert.equal(mgr.terminalReason, "cancelled");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].reason, "cancelled");
  assert.equal(mgr.signal.aborted, true);
});

test("push after close rejects with a typed error", async () => {
  const { mgr } = makeHarness();
  await mgr.close("completed");
  await assert.rejects(() => mgr.push("late"), StreamManagerError);
});

test("a sink write failure closes the stream as failed", async () => {
  const broken: StreamSink = {
    write: async () => {
      throw new Error("socket gone");
    },
    close: async () => {},
  };
  const { mgr, terminals } = makeHarness({ sink: broken });
  await mgr.push("hello");
  await pump();

  assert.equal(mgr.terminalReason, "failed");
  assert.equal(terminals.length, 1);
  assert.match(terminals[0].error?.message ?? "", /socket gone/);
});

test("first-token timeout fires when nothing is pushed in time", async () => {
  const { mgr, time, terminals } = makeHarness();
  time.advance(49);
  await pump();
  assert.equal(terminals.length, 0, "one ms short of the deadline is silent");

  time.advance(1);
  await pump();
  assert.equal(terminals.length, 1);
  assert.equal(mgr.terminalReason, "failed");
  assert.equal(
    (terminals[0].error as StreamManagerError).code,
    "UPSTREAM_TIMEOUT",
  );
  assert.equal(mgr.hasEmitted, false);
});

test("first-token timeout does not fire once data has arrived", async () => {
  const { mgr, time, terminals } = makeHarness();
  time.advance(10);
  await mgr.push("hello");
  time.advance(50);
  await pump();
  assert.equal(terminals.length, 0, "the retired watch must not fire");
  assert.equal(mgr.closed, false);
  await mgr.close("completed");
});

test("idle timeout resets on every push", async () => {
  const { mgr, time, terminals } = makeHarness();
  time.advance(10);
  await mgr.push("a");
  time.advance(90);
  await mgr.push("b");
  time.advance(95);
  await pump();
  assert.equal(terminals.length, 0, "still within the reset idle window");

  time.advance(10);
  await pump();
  assert.equal(terminals.length, 1);
  assert.equal(
    (terminals[0].error as StreamManagerError).code,
    "UPSTREAM_TIMEOUT",
  );
  assert.equal(mgr.terminalReason, "failed");
});

test("a total deadline tighter than the idle window still terminates once", async () => {
  const { mgr, time, terminals } = makeHarness({
    totalDeadline: 40,
    idleTimeoutMs: 1000,
    firstTokenDeadlineMs: 2000,
  });
  time.advance(10);
  await mgr.push("data");
  time.advance(30);
  await pump();

  assert.equal(terminals.length, 1, "exactly one terminal, no re-arm loop");
  assert.equal(mgr.terminalReason, "failed");
  assert.equal(mgr.remainingMs(), 0);
  assert.equal(time.pending(), 0);
});

test("remainingMs never goes negative and decreases monotonically", async () => {
  const { mgr, time } = makeHarness({ totalDeadline: 1000 });
  assert.equal(mgr.remainingMs(), 1000);
  assert.equal(mgr.deadlines().total, 1000);
  assert.ok(mgr.deadlines().firstToken < mgr.deadlines().total);
  assert.ok(mgr.deadlines().queue <= mgr.deadlines().total);

  time.advance(400);
  assert.equal(mgr.remainingMs(), 600);
  time.advance(400);
  assert.equal(mgr.remainingMs(), 200);
  time.advance(1000);
  assert.equal(mgr.remainingMs(), 0, "clamped at zero");
  await pump();
  assert.equal(mgr.terminalReason, "failed");
});

test("registry entry is removed exactly once even under double close", async () => {
  const { mgr, removed, sink } = makeHarness({ streamId: "s-reg" });
  assert.equal(mgr.streamId, "s-reg");
  assert.equal(mgr.hasEmitted, false);
  assert.equal(mgr.bufferedBytes, 0);

  await mgr.push("first");
  assert.equal(mgr.hasEmitted, true);

  await mgr.close("completed");
  await mgr.cancel();
  await mgr.close("failed", new Error("late"));
  await pump();

  assert.deepEqual(removed, ["s-reg"], "removed exactly once");
  assert.equal(sink.closed, 1);
});

test("hasUnemitted mirrors the old emittedChunk supersede guard", async () => {
  const { mgr } = makeHarness({ streamId: "s-supersede" });
  assert.equal(mgr.hasEmitted, false);
  await mgr.push("chunk");
  assert.equal(mgr.hasEmitted, true);
  await mgr.close("completed");
});

test("heartbeat is cleared on close and never leaks a timer", async () => {
  const { mgr, time, sink } = makeHarness({
    firstTokenDeadlineMs: 10000,
    idleTimeoutMs: 20000,
    totalDeadline: 60000,
  });
  let beats = 0;
  mgr.startHeartbeat(25, () => {
    beats += 1;
  });
  time.advance(100);
  assert.ok(beats >= 3, "heartbeats fire on the interval");
  assert.ok(time.pending() > 0);

  await mgr.close("completed");
  assert.equal(time.pending(), 0, "the heartbeat timer died with the stream");

  const before = beats;
  time.advance(1000);
  assert.equal(beats, before, "no heartbeat after close");
  assert.equal(sink.closed, 1);
});

test("registry is bounded and evicts the oldest entry", async () => {
  const registry = createStreamRegistry(2);
  const sink = createFakeSink();
  const time = createFakeTime();
  const made: ManagedStream[] = [];
  const mk = (id: string): ManagedStream =>
    createStream({
      streamId: id,
      totalDeadline: 1000,
      firstTokenDeadlineMs: 50,
      idleTimeoutMs: 100,
      maxBufferBytes: MAX_BUFFER,
      sink: sink.sink,
      time,
      registry,
    });
  made.push(mk("a"), mk("b"), mk("c"));
  await pump();

  assert.equal(registry.size(), 2);
  assert.equal(registry.get("a"), undefined, "oldest evicted");
  assert.notEqual(registry.get("c"), undefined);
  assert.equal(made[0].terminalReason, "cancelled", "evicted handle cancelled");
  for (const handle of made) {
    await handle.close("completed");
  }
});
