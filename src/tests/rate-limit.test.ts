import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createRateLimiter, rateLimitMiddleware } from "../core/rate-limit.ts";

test("allow: consumes tokens within burst", () => {
  const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 3 });
  const r1 = limiter.check("k1");
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 2);
  const r2 = limiter.check("k1");
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 1);
  const r3 = limiter.check("k1");
  assert.equal(r3.allowed, true);
  assert.equal(r3.remaining, 0);
});

test("deny: over burst returns retryAfterMs and remaining 0", () => {
  const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 2 });
  limiter.check("k");
  limiter.check("k");
  const denied = limiter.check("k");
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0, "retryAfterMs must be positive");
});

test("refill: tokens replenish over time via injectable now()", () => {
  let t = 1_000_000;
  const limiter = createRateLimiter({
    requestsPerMinute: 60,
    burst: 1,
    now: () => t,
  });
  assert.equal(limiter.check("k").allowed, true);
  assert.equal(limiter.check("k").allowed, false);
  t += 1000; // 60rpm => 1 token/sec
  const refilled = limiter.check("k");
  assert.equal(refilled.allowed, true);
  assert.equal(refilled.retryAfterMs, 0);
});

test("isolated-keys: buckets are independent per key", () => {
  const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1 });
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("a").allowed, false);
  assert.equal(limiter.check("b").allowed, true);
});

test("disabled: requestsPerMinute<=0 always allows", () => {
  for (const rpm of [0, -5]) {
    const limiter = createRateLimiter({ requestsPerMinute: rpm });
    for (let i = 0; i < 5; i++) {
      const r = limiter.check("k");
      assert.equal(r.allowed, true);
      assert.equal(r.retryAfterMs, 0);
    }
  }
});

test("resetForTests: clears buckets", () => {
  const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1 });
  assert.equal(limiter.check("k").allowed, true);
  assert.equal(limiter.check("k").allowed, false);
  limiter.resetForTests();
  assert.equal(limiter.check("k").allowed, true);
});

test("middleware: denies with 429 JSON + Retry-After, allows otherwise", async () => {
  const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1 });
  const app = new Hono();
  app.use("*", rateLimitMiddleware(limiter, () => "fixed-key"));
  app.get("/v1/chat/completions", (c) => c.json({ ok: true }));

  const first = await app.request("/v1/chat/completions");
  assert.equal(first.status, 200);

  const second = await app.request("/v1/chat/completions");
  assert.equal(second.status, 429);
  assert.ok(second.headers.get("Retry-After") !== null);
  const body = await second.json();
  assert.deepEqual(body, {
    error: {
      message: body.error.message,
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    },
  });
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(body.error.code, "rate_limit_exceeded");
});

test("middleware: disabled limiter always passes through", async () => {
  const limiter = createRateLimiter({ requestsPerMinute: 0 });
  const app = new Hono();
  app.use("*", rateLimitMiddleware(limiter, () => "k"));
  app.get("/ping", (c) => c.json({ ok: true }));
  for (let i = 0; i < 3; i++) {
    const res = await app.request("/ping");
    assert.equal(res.status, 200);
  }
});
