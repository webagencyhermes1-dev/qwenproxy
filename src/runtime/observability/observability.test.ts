import test from "node:test";
import assert from "node:assert";

process.env.NODE_ENV = "test";

import { MetricsEmitter } from "./metrics-emitter.ts";
import { EventRecorder } from "./event-recorder.ts";
import type { EventSink } from "./event-recorder.ts";
import type { RuntimeEvent } from "../../domain/events.ts";

interface CapturedMetric {
  name: string;
  value: number;
  dimensions?: Record<string, string>;
}

function capturingMetricSink(): {
  calls: CapturedMetric[];
  sink: (name: string, value: number, dimensions?: Record<string, string>) => void;
} {
  const calls: CapturedMetric[] = [];
  return {
    calls,
    sink: (name, value, dimensions) => calls.push({ name, value, dimensions }),
  };
}

function capturingEventSink(): { events: RuntimeEvent[]; sink: EventSink } {
  const events: RuntimeEvent[] = [];
  return { events, sink: { record: (event) => void events.push(event) } };
}

// ─── MetricsEmitter ──────────────────────────────────────────────────────────

test("counter/gauge/histogram emit through the capturing sink", () => {
  const cap = capturingMetricSink();
  const emitter = new MetricsEmitter({ onMetric: cap.sink, strictDimensions: false });

  emitter.incrementCounter("requests_total", 1, { model: "qwen" });
  emitter.incrementCounter("requests_success_total");
  emitter.setGauge("queue_depth", 5, { model: "qwen" });
  emitter.observeHistogram("queue_wait_ms", 42, { model: "qwen" });
  emitter.recordTimingMs("generation_first_token_ms", 7, { model: "qwen" });

  assert.equal(cap.calls.length, 5);
  assert.deepEqual(cap.calls[0], {
    name: "requests_total",
    value: 1,
    dimensions: { model: "qwen" },
  });
  assert.equal(cap.calls[1].value, 1);
  assert.equal(cap.calls[2].value, 5);
  assert.equal(cap.calls[3].value, 42);
  assert.equal(cap.calls[4].name, "generation_first_token_ms");
});

test("wrong metric kind is rejected", () => {
  const emitter = new MetricsEmitter({ onMetric: () => {}, strictDimensions: false });

  assert.throws(() => emitter.setGauge("requests_total", 1), /counter/);
  assert.throws(() => emitter.incrementCounter("queue_depth", 1), /gauge/);
  assert.throws(() => emitter.observeHistogram("retry_total", 1), /counter/);
});

test("unbounded dimension is rejected", () => {
  const emitter = new MetricsEmitter({ onMetric: () => {}, strictDimensions: false });

  assert.throws(
    () => emitter.incrementCounter("requests_total", 1, { bogus: "x" }),
    /not allowed/,
  );
});

test("high-cardinality dimensions are rejected in strict mode", () => {
  const emitter = new MetricsEmitter({ onMetric: () => {}, strictDimensions: true });

  assert.throws(
    () => emitter.incrementCounter("requests_total", 1, { accountId: "acc_1" }),
    /accountId/,
  );
  assert.throws(
    () => emitter.observeHistogram("queue_wait_ms", 1, { generationId: "gen_1" }),
    /generationId/,
  );
});

test("strictDimensions defaults to true when NODE_ENV=test", () => {
  const emitter = new MetricsEmitter({ onMetric: () => {} });
  assert.throws(
    () => emitter.incrementCounter("requests_total", 1, { requestId: "req_1" }),
    /requestId/,
  );
});

test("high-cardinality dimension is dropped with a warning in non-strict mode", () => {
  const cap = capturingMetricSink();
  const emitter = new MetricsEmitter({ onMetric: cap.sink, strictDimensions: false });

  emitter.incrementCounter("requests_total", 1, {
    model: "qwen",
    accountId: "acc_1",
    generationId: "gen_1",
  });

  assert.equal(cap.calls.length, 1);
  assert.deepEqual(cap.calls[0].dimensions, { model: "qwen" });
});

test("accountStateGauge maps states and skips unmapped ones", () => {
  const cap = capturingMetricSink();
  const emitter = new MetricsEmitter({ onMetric: cap.sink, strictDimensions: false });

  emitter.accountStateGauge("READY", 3);
  emitter.accountStateGauge("COOLDOWN", 1);
  emitter.accountStateGauge("DISABLED", 9);
  emitter.accountStateGauge("STANDBY", 9);

  assert.equal(cap.calls.length, 2);
  assert.equal(cap.calls[0].name, "account_ready");
  assert.equal(cap.calls[0].value, 3);
  assert.equal(cap.calls[1].name, "account_cooldown");
  assert.equal(cap.calls[1].value, 1);
});

// ─── EventRecorder ───────────────────────────────────────────────────────────

test("sensitive attribute keys are stripped, including substring variants", () => {
  const cap = capturingEventSink();
  const recorder = new EventRecorder(cap.sink);

  const event = recorder.record(
    "GENERATION_CREATED",
    { generationId: "gen_1" },
    {
      model: "qwen",
      prompt: "secret prompt",
      rawPrompt: "secret prompt",
      authToken: "secret",
      cookieValue: "yum",
      Authorization: "Bearer x",
      systemPromptHint: "nope",
    },
  );

  assert.equal(event.attributes?.model, "qwen");
  assert.equal("prompt" in (event.attributes ?? {}), false);
  assert.equal("rawPrompt" in (event.attributes ?? {}), false);
  assert.equal("authToken" in (event.attributes ?? {}), false);
  assert.equal("cookieValue" in (event.attributes ?? {}), false);
  assert.equal("Authorization" in (event.attributes ?? {}), false);
  assert.equal("systemPromptHint" in (event.attributes ?? {}), false);
  assert.equal(cap.events.length, 1);
});

test("secret-looking attribute values are replaced with [redacted]", () => {
  const cap = capturingEventSink();
  const recorder = new EventRecorder(cap.sink);

  const event = recorder.record(
    "CONTEXT_SNAPSHOT_CREATED",
    {},
    {
      signature: "sk-live-1234567890abcdef",
      credential: "Bearer abc123",
      payload: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.fakesighere",
      oversized: "x".repeat(200),
      benign: "fine",
      count: 7,
    },
  );

  assert.equal(event.attributes?.signature, "[redacted]");
  assert.equal(event.attributes?.credential, "[redacted]");
  assert.equal(event.attributes?.payload, "[redacted]");
  assert.equal(event.attributes?.oversized, "[redacted]");
  assert.equal(event.attributes?.benign, "fine");
  assert.equal(event.attributes?.count, 7);
});

test("sized diagnostics survive the key guard while credential-ish keys do not", () => {
  const cap = capturingEventSink();
  const recorder = new EventRecorder(cap.sink);

  const event = recorder.record(
    "CONTEXT_SNAPSHOT_CREATED",
    {},
    {
      estimatedTokens: 512,
      sessionToken: "abc",
      authToken: "abc",
    },
  );

  assert.equal(event.attributes?.estimatedTokens, 512);
  assert.equal("sessionToken" in (event.attributes ?? {}), false);
  assert.equal("authToken" in (event.attributes ?? {}), false);
});

test("identity spine carries given ids and leaves absent ids undefined", () => {
  const cap = capturingEventSink();
  const recorder = new EventRecorder(cap.sink);

  const event = recorder.record("GENERATION_STARTED", {
    requestId: "req_1",
    generationId: "gen_1",
  });

  assert.equal(event.requestId, "req_1");
  assert.equal(event.generationId, "gen_1");
  assert.equal(event.sessionId, undefined);
  assert.equal(event.accountId, undefined);
  assert.equal(event.tenantId, undefined);
  assert.equal(event.attemptId, undefined);
  assert.equal(event.leaseId, undefined);
  assert.ok(event.eventId.startsWith("evt_"));
  assert.equal(typeof event.at, "number");
});

test("recordGenerationLifecycle emits sized attributes only", () => {
  const cap = capturingEventSink();
  const recorder = new EventRecorder(cap.sink);

  recorder.recordGenerationLifecycle(
    "created",
    { generationId: "gen_1" },
    { estimatedTokens: 128 },
  );
  recorder.recordGenerationLifecycle(
    "failed",
    { generationId: "gen_1" },
    { errorName: "UpstreamError", durationMs: 42 },
  );

  assert.equal(cap.events[0].name, "GENERATION_CREATED");
  assert.equal(cap.events[0].attributes?.estimatedTokens, 128);
  assert.equal(cap.events[1].name, "GENERATION_FAILED");
  assert.equal(cap.events[1].attributes?.errorName, "UpstreamError");
  assert.equal(cap.events[1].attributes?.durationMs, 42);
});

test("ring buffer is bounded and evicts the oldest events", () => {
  const cap = capturingEventSink();
  const recorder = new EventRecorder(cap.sink);

  for (let i = 0; i < 600; i++) {
    recorder.record("GENERATION_FIRST_TOKEN", { generationId: `gen_${i}` });
  }

  const recent = recorder.recentEvents();
  assert.ok(recent.length <= 500);
  assert.equal(recent.length, 500);
  assert.equal(recent[0].generationId, "gen_100");
  assert.equal(recent[499].generationId, "gen_599");

  const filtered = recorder.recentEvents((e) => e.generationId === "gen_599");
  assert.equal(filtered.length, 1);
});

test("a throwing synchronous sink does not propagate to the caller", async () => {
  const recorder = new EventRecorder({
    record: () => {
      throw new Error("boom");
    },
  });

  const event = recorder.record("GENERATION_COMPLETED", {});
  assert.equal(event.name, "GENERATION_COMPLETED");
  assert.equal(recorder.recentEvents().length, 1);
  await assert.doesNotReject(() => recorder.flush());
});

test("a rejecting asynchronous sink does not propagate to the caller", async () => {
  const recorder = new EventRecorder({
    record: async () => {
      throw new Error("async boom");
    },
  });

  recorder.record("GENERATION_FAILED", {});
  recorder.record("GENERATION_COMPLETED", {});
  await assert.doesNotReject(() => recorder.flush());
  assert.equal(recorder.recentEvents().length, 2);
});

test("flush awaits a slow asynchronous sink", async () => {
  let recorded = false;
  const recorder = new EventRecorder({
    record: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recorded = true;
    },
  });

  recorder.record("GENERATION_COMPLETED", {});
  await recorder.flush();
  assert.equal(recorded, true);
});

test("default sink records structured events without throwing", () => {
  const recorder = new EventRecorder();
  const event = recorder.record("GENERATION_COMPLETED", { generationId: "gen_1" }, { model: "qwen" });
  assert.equal(event.name, "GENERATION_COMPLETED");
  assert.equal(recorder.recentEvents().length, 1);
});
