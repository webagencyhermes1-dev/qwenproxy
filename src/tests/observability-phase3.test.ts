import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

const { metrics } = await import("../core/metrics.ts");
const { AccountResourceManager, onTransition } = await import(
  "../runtime/account/resource-manager.ts"
);

const SYSTEM_FENCE = { leaseId: "system", ownerToken: "system" };

test("metrics: chat.completions.total registered with labels", () => {
  metrics.reset();
  metrics.increment("chat.completions.total", 1, {
    account: "acc-1",
    model: "qwen-max",
    outcome: "success",
  });
  const out = metrics.formatPrometheus();
  assert.match(out, /^# TYPE chat\.completions\.total counter$/m);
  assert.match(out, /chat\.completions\.total\{[^}]*account="acc-1"[^}]*\} 1 /m);
});

test("metrics: warmup.failures registered with labels", () => {
  metrics.reset();
  metrics.increment("warmup.failures", 1, {
    account: "acc-1",
    reason: "timeout",
  });
  const out = metrics.formatPrometheus();
  assert.match(out, /^# TYPE warmup\.failures counter$/m);
  assert.match(out, /warmup\.failures\{[^}]*reason="timeout"[^}]*\} 1 /m);
});

test("metrics: pool.ready/pool.deficit/pool.warming gauges registered", () => {
  metrics.reset();
  metrics.gauge("pool.ready", 2);
  metrics.gauge("pool.deficit", 1);
  metrics.gauge("pool.warming", 3);
  const out = metrics.formatPrometheus();
  assert.match(out, /^# TYPE pool\.ready gauge$/m);
  assert.match(out, /^pool\.ready 2 /m);
  assert.match(out, /^# TYPE pool\.deficit gauge$/m);
  assert.match(out, /^pool\.deficit 1 /m);
  assert.match(out, /^# TYPE pool\.warming gauge$/m);
  assert.match(out, /^pool\.warming 3 /m);
});

test("metrics: lease.churn registered with account/event labels", () => {
  metrics.reset();
  metrics.increment("lease.churn", 1, { account: "acc-1", event: "acquired" });
  metrics.increment("lease.churn", 1, { account: "acc-1", event: "released" });
  metrics.increment("lease.churn", 1, { account: "acc-2", event: "swept" });
  const out = metrics.formatPrometheus();
  assert.match(out, /^# TYPE lease\.churn counter$/m);
  assert.match(out, /lease\.churn\{[^}]*event="acquired"[^}]*\}/m);
  assert.match(out, /lease\.churn\{[^}]*event="released"[^}]*\}/m);
  assert.match(out, /lease\.churn\{[^}]*event="swept"[^}]*\}/m);
});

test("listener: receives transitions with accountId/from/to/reason/at", () => {
  const mgr = new AccountResourceManager();
  mgr.registerAccount("obs-acc-1", {
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
  });
  const events: Array<{
    accountId: string;
    from: string;
    to: string;
    reason: string;
    at: number;
  }> = [];
  const unsub = onTransition((e) => {
    events.push(e);
  });
  try {
    const before = Date.now();
    const res = mgr.transition("obs-acc-1", "WARMING", SYSTEM_FENCE, "warm");
    assert.equal(res.transitioned, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].accountId, "obs-acc-1");
    assert.equal(events[0].from, "STANDBY");
    assert.equal(events[0].to, "WARMING");
    assert.equal(events[0].reason, "warm");
    assert.ok(events[0].at >= before);
  } finally {
    unsub();
  }
});

test("listener: unsubscribe stops events", () => {
  const mgr = new AccountResourceManager();
  mgr.registerAccount("obs-acc-2", {
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
  });
  let calls = 0;
  const unsub = onTransition(() => {
    calls++;
  });
  unsub();
  mgr.transition("obs-acc-2", "WARMING", SYSTEM_FENCE, "warm");
  assert.equal(calls, 0);
});

test("listener: throwing listener does not break applyTransition", () => {
  const mgr = new AccountResourceManager();
  mgr.registerAccount("obs-acc-3", {
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
  });
  const seen: string[] = [];
  const unsubThrow = onTransition(() => {
    throw new Error("boom");
  });
  const unsubGood = onTransition((e) => {
    seen.push(`${e.from}->${e.to}`);
  });
  try {
    const res = mgr.transition("obs-acc-3", "WARMING", SYSTEM_FENCE, "warm");
    assert.equal(res.transitioned, true);
    assert.equal(mgr.getAccountStatus("obs-acc-3"), "WARMING");
    assert.deepEqual(seen, ["STANDBY->WARMING"]);
  } finally {
    unsubThrow();
    unsubGood();
  }
});
