import { test } from "node:test";
import assert from "node:assert";
import { getDatabase } from "../core/database.ts";
import {
  BROKEN_INIT_FAIL_THRESHOLD,
  flushAccountHealth,
  getAccountHealth,
  getPoolHealthAggregates,
  isAccountBrokenByHealth,
  noteAccountInitFailure,
  noteAccountInitSuccess,
  recordAccountFailure,
  recordAccountSuccess,
  resetAccountHealthForTests,
} from "../core/account-health.ts";

function cleanHealth(ids: string[]): void {
  const db = getDatabase();
  try {
    db.prepare(
      `DELETE FROM account_health WHERE account_id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  } catch {
    // Table may not exist on very old setups — migration creates it.
  }
  resetAccountHealthForTests();
}

test("Pool health: bounded score, single transient failure never destroys priority", () => {
  const id = "health-t1";
  cleanHealth([id]);
  try {
    assert.strictEqual(getAccountHealth(id).healthScore, 100);
    // Single network blip: small debit only.
    const after = recordAccountFailure(id, "network");
    assert.strictEqual(after.healthScore, 94);
    assert.strictEqual(after.failureCount, 1);
    assert.strictEqual(after.consecutiveFailures, 1);
    assert.strictEqual(after.networkFailures, 1);
    // Quota hits harder but stays far from zero.
    const q = recordAccountFailure(id, "quota");
    assert.ok(q.healthScore >= 70 && q.healthScore < 94);
    assert.strictEqual(q.quotaEvents, 1);
  } finally {
    cleanHealth([id]);
  }
});

test("Pool health: per-kind counters and gradual recovery on success", () => {
  const id = "health-t2";
  cleanHealth([id]);
  try {
    recordAccountFailure(id, "rate_limit");
    recordAccountFailure(id, "waf");
    recordAccountFailure(id, "auth");
    let rec = getAccountHealth(id);
    assert.strictEqual(rec.rateLimitEvents, 1);
    assert.strictEqual(rec.wafEvents, 1);
    assert.strictEqual(rec.authFailures, 1);
    assert.strictEqual(rec.consecutiveFailures, 3);
    const before = rec.healthScore;
    // Success recovers gradually and resets the streak.
    rec = recordAccountSuccess(id, 120);
    assert.strictEqual(rec.consecutiveFailures, 0);
    assert.strictEqual(rec.successCount, 1);
    assert.ok(rec.healthScore > before);
    assert.ok(rec.healthScore <= 100);
    assert.strictEqual(rec.averageLatencyMs, 30); // 120ms / 4 events
    // Recovery caps at 100, never above (3 failures = -43, needs 15×+3).
    for (let i = 0; i < 20; i++) recordAccountSuccess(id);
    assert.strictEqual(getAccountHealth(id).healthScore, 100);
  } finally {
    cleanHealth([id]);
  }
});

test("Pool health: floor at zero under sustained failures", () => {
  const id = "health-t3";
  cleanHealth([id]);
  try {
    for (let i = 0; i < 20; i++) recordAccountFailure(id, "auth");
    const rec = getAccountHealth(id);
    assert.strictEqual(rec.healthScore, 0);
    assert.strictEqual(rec.failureCount, 20);
  } finally {
    cleanHealth([id]);
  }
});

test("Pool health: persists across process restart (flush + cold cache)", () => {
  const id = "health-t4";
  cleanHealth([id]);
  try {
    recordAccountFailure(id, "quota");
    recordAccountSuccess(id, 50);
    recordAccountSuccess(id, 50);
    assert.strictEqual(flushAccountHealth() >= 0, true);
    // Simulate restart: drop the in-memory cache, reload from SQLite.
    resetAccountHealthForTests();
    const reloaded = getAccountHealth(id);
    assert.strictEqual(reloaded.failureCount, 1);
    assert.strictEqual(reloaded.successCount, 2);
    assert.strictEqual(reloaded.quotaEvents, 1);
    assert.ok(reloaded.healthScore < 100);
    assert.ok(reloaded.lastRequestAt !== null);
    assert.ok(reloaded.lastSuccessAt !== null);
    assert.ok(reloaded.lastFailureAt !== null);
  } finally {
    cleanHealth([id]);
  }
});

test("Pool health: repeated init failures escalate to BROKEN, success restores", () => {
  const id = "health-t5";
  cleanHealth([id]);
  try {
    assert.strictEqual(isAccountBrokenByHealth(id), false);
    for (let i = 0; i < BROKEN_INIT_FAIL_THRESHOLD; i++) {
      noteAccountInitFailure(id);
    }
    assert.strictEqual(isAccountBrokenByHealth(id), true);
    noteAccountInitSuccess(id);
    assert.strictEqual(isAccountBrokenByHealth(id), false);
    assert.strictEqual(getAccountHealth(id).initFailCount, 0);
  } finally {
    cleanHealth([id]);
  }
});

test("Pool health: aggregates compute pool success rate and latency", () => {
  const ids = ["health-a6", "health-a7"];
  cleanHealth(ids);
  try {
    recordAccountSuccess(ids[0], 100);
    recordAccountSuccess(ids[0], 100);
    recordAccountFailure(ids[1], "network");
    const agg = getPoolHealthAggregates(ids);
    assert.strictEqual(agg.totalSuccess, 2);
    assert.strictEqual(agg.totalFailure, 1);
    assert.ok(Math.abs(agg.successRate - 2 / 3) < 1e-9);
    assert.ok(Math.abs(agg.failureRate - 1 / 3) < 1e-9);
    assert.ok(agg.averageLatencyMs >= 0);
  } finally {
    cleanHealth(ids);
  }
});
