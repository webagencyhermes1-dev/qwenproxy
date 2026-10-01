import type { Context, MiddlewareHandler, Next } from "hono";

export interface RateLimiterOptions {
  requestsPerMinute: number;
  burst?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RateLimitCheck {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export interface RateLimiter {
  check(key: string): RateLimitCheck;
  resetForTests(): void;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-API-key token-bucket limiter. Pure in-memory with lazy refill on
 * check() — no timers. Disabled when requestsPerMinute <= 0.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const rpm = opts.requestsPerMinute;
  const nowFn = opts.now ?? Date.now;
  const disabled = rpm <= 0;
  const capacity = opts.burst ?? rpm;
  const refillPerMs = disabled ? 0 : rpm / 60_000;
  const buckets = new Map<string, Bucket>();

  function check(key: string): RateLimitCheck {
    if (disabled) {
      return { allowed: true, retryAfterMs: 0, remaining: capacity };
    }
    const nowMs = nowFn();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: nowMs };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          capacity,
          bucket.tokens + elapsed * refillPerMs,
        );
        bucket.lastRefillMs = nowMs;
      }
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.floor(bucket.tokens),
      };
    }
    const needed = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(needed / refillPerMs);
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  function resetForTests(): void {
    buckets.clear();
  }

  return { check, resetForTests };
}

/**
 * Hono middleware factory. On deny returns 429 JSON with Retry-After
 * (seconds). Pass-through when the limiter is disabled (rpm <= 0).
 */
export function rateLimitMiddleware(
  limiter: RateLimiter,
  getKey: (c: Context) => string,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const result = limiter.check(getKey(c));
    if (result.allowed) {
      await next();
      return;
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil(result.retryAfterMs / 1000),
    );
    c.header("Retry-After", String(retryAfterSec));
    return c.json(
      {
        error: {
          message: `Rate limit exceeded. Retry in ${retryAfterSec} second(s).`,
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
      429,
    );
  };
}
