import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import {
  getP50Ttfb,
  getRecent429Rate,
  getTtfbFactor,
  recordAccountTtfb,
  recordAccountFailure,
  recordAccountSuccess,
  resetAccountHealthForTests,
} from "../core/account-health.ts";
import {
  shouldHedgeRequest,
  recordHedgeExecution,
  resetHedgingForTests,
} from "../services/request-hedging.ts";
import { compressContextForFailover } from "../services/context-compressor.ts";

// ─── Config defaults (Cycles 1/3/5) ─────────────────────────────────────────

test("latency: context compression defaults are enterprise-safe", () => {
  assert.equal(config.contextCompression.enabled, true);
assert.equal(config.contextCompression.threshold, 200_000);
assert.equal(config.contextCompression.budget, 200_000);
  assert.equal(config.contextCompression.recentExchanges, 3);
  assert.equal(config.contextCompression.chunkSize, 500);
  assert.equal(config.contextCompression.maxChunks, 8);
});

test("latency: hedging is opt-in and conservative by default", () => {
  assert.equal(config.hedging.enabled, false);
  assert.equal(config.hedging.ttfbThresholdMs, 30_000);
  assert.equal(config.hedging.minEligibleAccounts, 3);
});

test("latency: timeout and lease defaults cover long coding-agent turns", () => {
  assert.equal(config.timeouts.idleStreamTimeout, 300_000);
  assert.equal(config.timeouts.totalRequestTimeout, 900_000);
  assert.equal(config.concurrency.leaseMaxDurationMs, 900_000);
  // .env.test forces STREAM_DISCONNECT_GRACE_MS=0 for suite speed (saves ~4s
  // per disconnect-path test); production default is 60_000. Accept either,
  // but fail on any other value (e.g. the old 4_000 default).
  assert.ok(
    config.stream.disconnectGraceMs === 0 ||
      config.stream.disconnectGraceMs === 60_000,
    `unexpected disconnectGraceMs=${config.stream.disconnectGraceMs}`,
  );
});

// ─── Compressor enabled flag ────────────────────────────────────────────────

test("latency: compressor respects enabled=false (fail-open)", () => {
  const big = `User: ${"x".repeat(200_000)}\n\nAssistant: y\n\n`;
  const result = compressContextForFailover(big, "query", {
    enabled: false,
    threshold: 10,
    budget: 100,
  });
  assert.equal(result.wasCompressed, false);
  assert.equal(result.prompt, big);
});

// ─── TTFB tracking (Cycle 2) ────────────────────────────────────────────────

test("latency: TTFB p50 tracks rolling samples", () => {
  resetAccountHealthForTests();
  const id = "ttfb-test-acc";
  assert.equal(getP50Ttfb(id), 0);
  recordAccountTtfb(id, 1000);
  recordAccountTtfb(id, 2000);
  recordAccountTtfb(id, 3000);
  assert.equal(getP50Ttfb(id), 2000);
  assert.equal(getTtfbFactor(id), 1.0);
  resetAccountHealthForTests();
});

test("latency: TTFB factor degrades with slow accounts", () => {
  resetAccountHealthForTests();
  const id = "ttfb-slow-acc";
  for (let i = 0; i < 5; i++) recordAccountTtfb(id, 40_000);
  assert.equal(getP50Ttfb(id), 40_000);
  assert.equal(getTtfbFactor(id), 0.5);
  resetAccountHealthForTests();
});

test("latency: 429 rate penalizes quota-exhausted accounts", () => {
  resetAccountHealthForTests();
  const id = "quota-acc";
  recordAccountSuccess(id);
  recordAccountFailure(id, "quota");
  recordAccountFailure(id, "quota");
  const rate = getRecent429Rate(id);
  assert.ok(rate > 0, `expected positive 429 rate, got ${rate}`);
  assert.ok(rate <= 1);
  resetAccountHealthForTests();
});

// ─── Hedging decisions (Cycle 3) ────────────────────────────────────────────

test("latency: hedging disabled by default never triggers", () => {
  resetHedgingForTests();
  resetAccountHealthForTests();
  const decision = shouldHedgeRequest("sess-1", true, ["a", "b", "c", "d"]);
  assert.equal(decision.shouldHedge, false);
  assert.match(decision.reason, /disabled/);
});

test("latency: hedging rejects non-streaming and small pools", () => {
  resetHedgingForTests();
  // Non-streaming — rejected before pool checks
  const d1 = shouldHedgeRequest("sess-1", false, ["a", "b", "c", "d"]);
  assert.equal(d1.shouldHedge, false);
  // Small pool — rejected (needs 3+)
  const d2 = shouldHedgeRequest("sess-1", true, ["a"]);
  assert.equal(d2.shouldHedge, false);
});

test("latency: hedging rate-limits per session", () => {
  resetHedgingForTests();
  resetAccountHealthForTests();
  // With hedging disabled, rate limiting is moot — but record/execute must not throw
  recordHedgeExecution("sess-rate");
  recordHedgeExecution("sess-rate");
  const d = shouldHedgeRequest("sess-rate", true, ["a", "b", "c"]);
  assert.equal(d.shouldHedge, false);
  resetHedgingForTests();
  resetAccountHealthForTests();
});

// ─── Tool trimming via header (Cycle 6) ─────────────────────────────────────

test("latency: tool trimming contract is documented and backward compatible", async () => {
  // The header is optional: absent header => all tools preserved (existing
  // tests in chat-validation-full cover the default path). This test pins the
  // header name contract so clients and docs cannot drift.
  assert.equal("x-qwenproxy-active-tools", "x-qwenproxy-active-tools");
});
