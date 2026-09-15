import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { HealthTracker, classify429 } from "../services/account/health.ts";

test("health: successful requests raise score toward 1", () => {
  const h = new HealthTracker();
  for (let i = 0; i < 10; i++) h.recordSuccess("acc-a", 500);
  const health = h.getHealth("acc-a");
  assert.equal(health.successRate, 1);
  assert.ok(health.score > 0.9, `score=${health.score}`);
});

test("health: burst 429 lowers score without marking quota", () => {
  const h = new HealthTracker();
  for (let i = 0; i < 5; i++) h.recordSuccess("acc-a", 500);
  h.record429("acc-a", "burst", 5_000);
  const health = h.getHealth("acc-a");
  assert.equal(health.lastQuotaExhaustedAt, null);
  assert.equal(health.quotaResetAt, null);
  assert.ok(health.recent429Count >= 1);
  assert.ok(health.score < 1);
});

test("health: quota 429 drops score near zero and sets quotaResetAt", () => {
  const h = new HealthTracker();
  for (let i = 0; i < 5; i++) h.recordSuccess("acc-a", 500);
  for (let i = 0; i < 5; i++) h.record429("acc-a", "quota", 3600_000);
  const health = h.getHealth("acc-a");
  assert.ok(health.lastQuotaExhaustedAt !== null);
  assert.ok(health.quotaResetAt !== null && health.quotaResetAt > Date.now());
  assert.ok(health.score < 0.2, `score=${health.score}`);
});

test("health: consume-first multiplier imminent reset boosts score", () => {
  const h = new HealthTracker();
  h.recordSuccess("acc-a", 500);
  // Simulate reset in 1h (within 2h window) -> 1.5x.
  const s = (h as unknown as { stateFor(id: string): { quotaResetAt: number } }).stateFor("acc-a");
  s.quotaResetAt = Date.now() + 60 * 60 * 1000;
  assert.equal(h.consumeFirstMultiplier("acc-a"), 1.5);
  // Far reset (>5d) -> 0.5x.
  s.quotaResetAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
  assert.equal(h.consumeFirstMultiplier("acc-a"), 0.5);
});

test("health: classify429 burst vs quota", () => {
  assert.equal(classify429(5_000), "burst");
  assert.equal(classify429(120_000), "quota");
  assert.equal(classify429(5_000, "RateLimited try again tomorrow"), "quota");
});

test("health: latency degrades score (p99)", () => {
  const h = new HealthTracker();
  for (let i = 0; i < 10; i++) h.recordSuccess("acc-slow", 70_000);
  const health = h.getHealth("acc-slow");
  assert.ok(health.p99TtfbMs >= 60_000);
  assert.ok(health.score < 0.5, `score=${health.score}`);
});
