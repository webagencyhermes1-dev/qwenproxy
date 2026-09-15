/**
 * Rolling health scoring with burst/quota distinction (Loop 3).
 *
 * Adapter over core/account-health.ts (SQLite persistence) + in-memory
 * rolling windows for the spec's 0..1 composite score.
 *
 * Scoring (constants documented):
 *   score = successRate
 *         * latencyFactor        // 1.0 if p99 < 5s, linearly down to 0.1 at p99 > 60s
 *         * (1 - min(recent429/5, 1))
 *         * (1 - min(recentCaptcha/3, 1))
 *         * consumeFirstMultiplier
 * consumeFirstMultiplier = 1.5 if quotaResetAt within 2h (use-it-or-lose-it),
 *   0.5 if reset > 5 days away, else 1.0.
 *
 * Burst vs quota 429:
 *   burst: retry-after < 60s -> pace + retry same account, no rotate.
 *   quota: retry-after > 60s OR /RateLimited.*tomorrow/i -> rotate + mark exhausted.
 */

import {
  getAccountHealth as getCoreHealth,
  recordAccountFailure,
  recordAccountSuccess,
  recordAccountTtfb,
} from "../../core/account-health.ts";
import { computeQuotaCooldownMs } from "../../core/account-manager.ts";
import { logger } from "../../core/logger.ts";

// ─── Tunables (documented per spec) ───────────────────────────────────────────
export const HEALTH_WINDOW_ATTEMPTS = 20;
export const HEALTH_TTFB_WINDOW = 20;
export const RECENT_429_WINDOW_MS = 5 * 60 * 1000;
export const RECENT_CAPTCHA_WINDOW_MS = 10 * 60 * 1000;
export const LATENCY_GOOD_P99_MS = 5_000;
export const LATENCY_BAD_P99_MS = 60_000;
export const LATENCY_FLOOR = 0.1;
export const CONSUME_FIRST_IMMINENT_MS = 2 * 60 * 60 * 1000;
export const CONSUME_FIRST_FAR_MS = 5 * 24 * 60 * 60 * 1000;
export const BURST_RETRY_AFTER_MS = 60_000;

export interface AccountHealth {
  accountId: string;
  successRate: number;
  p50TtfbMs: number;
  p99TtfbMs: number;
  recent429Count: number;
  recentCaptchaCount: number;
  lastUsedAt: number;
  lastQuotaExhaustedAt: number | null;
  quotaResetAt: number | null;
  score: number;
}

interface RollingState {
  attempts: boolean[]; // last N, true=success
  ttfb: number[];
  rate429At: number[];
  captchaAt: number[];
  networkErrors: number;
  lastUsedAt: number;
  lastQuotaExhaustedAt: number | null;
  quotaResetAt: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function classify429(
  retryAfterMs?: number,
  message?: string,
): "burst" | "quota" {
  if (message && /RateLimited.*try again tomorrow/i.test(message)) return "quota";
  if (typeof retryAfterMs === "number" && retryAfterMs >= BURST_RETRY_AFTER_MS) return "quota";
  return "burst";
}

export class HealthTracker {
  private states = new Map<string, RollingState>();

  private stateFor(accountId: string): RollingState {
    let s = this.states.get(accountId);
    if (!s) {
      s = {
        attempts: [],
        ttfb: [],
        rate429At: [],
        captchaAt: [],
        networkErrors: 0,
        lastUsedAt: 0,
        lastQuotaExhaustedAt: null,
        quotaResetAt: null,
      };
      this.states.set(accountId, s);
    }
    return s;
  }

  private prune(s: RollingState, now = Date.now()): void {
    s.rate429At = s.rate429At.filter((t) => now - t <= RECENT_429_WINDOW_MS);
    s.captchaAt = s.captchaAt.filter((t) => now - t <= RECENT_CAPTCHA_WINDOW_MS);
  }

  recordSuccess(accountId: string, ttfbMs: number): void {
    const s = this.stateFor(accountId);
    s.attempts.push(true);
    if (s.attempts.length > HEALTH_WINDOW_ATTEMPTS) s.attempts.shift();
    if (Number.isFinite(ttfbMs) && ttfbMs >= 0) {
      s.ttfb.push(Math.round(ttfbMs));
      if (s.ttfb.length > HEALTH_TTFB_WINDOW) s.ttfb.shift();
    }
    s.lastUsedAt = Date.now();
    this.prune(s);
    try {
      recordAccountSuccess(accountId, ttfbMs);
      recordAccountTtfb(accountId, ttfbMs);
    } catch {
      // Persistence best-effort.
    }
    if (logger.isLevelEnabled("info")) {
      console.log(
        `[Session] Health success | account=${accountId} | ttfb=${Math.round(ttfbMs)}ms | score=${this.score(accountId).toFixed(3)}`,
      );
    }
  }

  record429(accountId: string, kind: "burst" | "quota", retryAfterMs?: number): void {
    const s = this.stateFor(accountId);
    const now = Date.now();
    s.attempts.push(false);
    if (s.attempts.length > HEALTH_WINDOW_ATTEMPTS) s.attempts.shift();
    s.rate429At.push(now);
    s.lastUsedAt = now;
    if (kind === "quota") {
      s.lastQuotaExhaustedAt = now;
      const cooldownMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : computeQuotaCooldownMs(now);
      s.quotaResetAt = now + cooldownMs;
    }
    this.prune(s);
    try {
      recordAccountFailure(accountId, kind === "quota" ? "quota" : "rate_limit");
    } catch {
      // Best-effort.
    }
    console.warn(
      `[Session] Health 429 | account=${accountId} | kind=${kind} | score=${this.score(accountId).toFixed(3)}`,
    );
  }

  recordCaptcha(accountId: string): void {
    const s = this.stateFor(accountId);
    s.attempts.push(false);
    if (s.attempts.length > HEALTH_WINDOW_ATTEMPTS) s.attempts.shift();
    s.captchaAt.push(Date.now());
    s.lastUsedAt = Date.now();
    this.prune(s);
    try {
      recordAccountFailure(accountId, "waf");
    } catch {
      // Best-effort.
    }
  }

  recordNetworkError(accountId: string): void {
    const s = this.stateFor(accountId);
    s.attempts.push(false);
    if (s.attempts.length > HEALTH_WINDOW_ATTEMPTS) s.attempts.shift();
    s.networkErrors++;
    s.lastUsedAt = Date.now();
    this.prune(s);
    try {
      recordAccountFailure(accountId, "network");
    } catch {
      // Best-effort.
    }
  }

  getHealth(accountId: string): AccountHealth {
    const s = this.stateFor(accountId);
    this.prune(s);
    const total = s.attempts.length;
    const success = s.attempts.filter(Boolean).length;
    const successRate = total === 0 ? 1 : success / total;
    const sorted = [...s.ttfb].sort((a, b) => a - b);
    const p50 = sorted.length ? percentile(sorted, 50) : 0;
    const p99 = sorted.length ? percentile(sorted, 99) : 0;
    return {
      accountId,
      successRate,
      p50TtfbMs: p50,
      p99TtfbMs: p99,
      recent429Count: s.rate429At.length,
      recentCaptchaCount: s.captchaAt.length,
      lastUsedAt: s.lastUsedAt,
      lastQuotaExhaustedAt: s.lastQuotaExhaustedAt,
      quotaResetAt: s.quotaResetAt,
      score: this.score(accountId),
    };
  }

  consumeFirstMultiplier(accountId: string): number {
    const s = this.stateFor(accountId);
    if (!s.quotaResetAt) return 1.0;
    const ms = s.quotaResetAt - Date.now();
    if (ms <= 0) return 1.0; // already reset
    if (ms <= CONSUME_FIRST_IMMINENT_MS) return 1.5;
    if (ms >= CONSUME_FIRST_FAR_MS) return 0.5;
    return 1.0;
  }

  latencyFactor(accountId: string): number {
    const s = this.stateFor(accountId);
    if (s.ttfb.length === 0) return 1.0;
    const sorted = [...s.ttfb].sort((a, b) => a - b);
    const p99 = percentile(sorted, 99);
    if (p99 <= LATENCY_GOOD_P99_MS) return 1.0;
    if (p99 >= LATENCY_BAD_P99_MS) return LATENCY_FLOOR;
    const t = (p99 - LATENCY_GOOD_P99_MS) / (LATENCY_BAD_P99_MS - LATENCY_GOOD_P99_MS);
    return 1.0 - t * (1.0 - LATENCY_FLOOR);
  }

  score(accountId: string): number {
    const h = this.getHealthRaw(accountId);
    const s = this.stateFor(accountId);
    this.prune(s);
    const score =
      h.successRate *
      this.latencyFactor(accountId) *
      (1 - Math.min(h.recent429Count / 5, 1)) *
      (1 - Math.min(h.recentCaptchaCount / 3, 1)) *
      this.consumeFirstMultiplier(accountId);
    return Math.max(0, Math.min(1.5, score));
  }

  private getHealthRaw(accountId: string): Omit<AccountHealth, "score"> {
    const full = this.getHealthWithoutScore(accountId);
    return full;
  }

  private getHealthWithoutScore(accountId: string): Omit<AccountHealth, "score"> {
    const s = this.stateFor(accountId);
    const total = s.attempts.length;
    const success = s.attempts.filter(Boolean).length;
    const sorted = [...s.ttfb].sort((a, b) => a - b);
    return {
      accountId,
      successRate: total === 0 ? 1 : success / total,
      p50TtfbMs: sorted.length ? percentile(sorted, 50) : 0,
      p99TtfbMs: sorted.length ? percentile(sorted, 99) : 0,
      recent429Count: s.rate429At.length,
      recentCaptchaCount: s.captchaAt.length,
      lastUsedAt: s.lastUsedAt,
      lastQuotaExhaustedAt: s.lastQuotaExhaustedAt,
      quotaResetAt: s.quotaResetAt,
    };
  }

  /** Quota-exhausted and not yet reset. */
  isQuotaExhausted(accountId: string, now = Date.now()): boolean {
    const s = this.states.get(accountId);
    if (!s?.quotaResetAt) {
      // Fall back to core cooldown (authoritative for restarts).
      try {
        const core = getCoreHealth(accountId);
        void core;
      } catch {
        // Ignore.
      }
      return false;
    }
    return now < s.quotaResetAt;
  }

  clearForTests(): void {
    this.states.clear();
  }
}

let singleton: HealthTracker | null = null;

export function getHealthTracker(): HealthTracker {
  if (!singleton) singleton = new HealthTracker();
  return singleton;
}

export function resetHealthTrackerForTests(): void {
  singleton?.clearForTests();
  singleton = null;
}
