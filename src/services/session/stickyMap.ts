/**
 * Sticky session map: stickyKey (16hex) -> account binding with TTL.
 *
 * Loop 1 of account-routing plan. Lookup-only wiring in chat route;
 * rebind path lands in Loop 8.
 *
 * Persistence: SQLite `sticky_bindings` is authoritative across restarts.
 * If REDIS_URL is set, Redis is L1 (SET with PX TTL, atomic rebind);
 * SQLite remains L2. Without Redis, in-memory Map + SQLite is used.
 * If Redis is unreachable at startup, warn and fall back.
 */

import { createHash } from "node:crypto";
import { getDatabase } from "../../core/database.ts";
import { logger } from "../../core/logger.ts";

export const STICKY_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
const KEY_RE = /^[0-9a-f]{16}$/;

export interface StickyBinding {
  accountId: string;
  proxyId: string | null;
  boundAt: number;
  lastUsedAt: number;
  ttlMs: number;
}

type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit?(): Promise<unknown>;
};

function redisKey(key: string): string {
  return `qwenproxy:sticky:${key}`;
}

function isExpired(b: StickyBinding, now = Date.now()): boolean {
  return now - b.lastUsedAt > b.ttlMs;
}

function ensureTable(): void {
  try {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sticky_bindings (
        session_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        proxy_id TEXT,
        bound_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL DEFAULT ${STICKY_TTL_MS},
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sticky_used ON sticky_bindings(last_used_at);
    `);
  } catch (err) {
    logger.warn("[Session] sticky table ensure failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function tryConnectRedis(): Promise<RedisClient | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    // Optional dep: only loaded when REDIS_URL is set.
    // @ts-ignore - ioredis is optional
    const mod = (await import("ioredis")) as unknown as {
      default?: new (url: string) => RedisClient;
      Redis?: new (url: string) => RedisClient;
    };
    const Ctor = mod.default ?? mod.Redis;
    if (!Ctor) throw new Error("ioredis module has no Redis export");
    const client = new Ctor(url);
    return client;
  } catch (err) {
    console.warn(
      `[Session] Redis unreachable, using in-memory+SQLite fallback | error=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function isValidStickyKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function hashToStickyKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export class StickyMap {
  private mem = new Map<string, StickyBinding>();
  private redis: RedisClient | null = null;
  private redisReady = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private rebindCount = 0;
  private rebindTimestamps: number[] = [];

  constructor(opts?: { redis?: RedisClient | null; autoSweep?: boolean }) {
    ensureTable();
    if (opts && "redis" in opts) {
      this.redis = opts.redis ?? null;
      this.redisReady = !!this.redis;
    } else if (process.env.REDIS_URL?.trim()) {
      // Async connect; fallback to SQLite+mem until ready.
      void tryConnectRedis().then((c) => {
        this.redis = c;
        this.redisReady = !!c;
        if (c) this.hydrateFromDb();
      });
    }
    this.hydrateFromDb();
    if (opts?.autoSweep !== false && !isTestEnv()) {
      this.startSweep();
    }
  }

  /** Test hook: inject a fake redis client. */
  _setRedisForTests(client: RedisClient | null): void {
    this.redis = client;
    this.redisReady = !!client;
  }

  private hydrateFromDb(): void {
    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          "SELECT session_key, account_id, proxy_id, bound_at, last_used_at, ttl_ms FROM sticky_bindings",
        )
        .all() as Array<{
        session_key: string;
        account_id: string;
        proxy_id: string | null;
        bound_at: number;
        last_used_at: number;
        ttl_ms: number;
      }>;
      const now = Date.now();
      for (const r of rows) {
        const b: StickyBinding = {
          accountId: r.account_id,
          proxyId: r.proxy_id,
          boundAt: r.bound_at,
          lastUsedAt: r.last_used_at,
          ttlMs: r.ttl_ms || STICKY_TTL_MS,
        };
        if (isExpired(b, now)) continue;
        if (!this.mem.has(r.session_key)) this.mem.set(r.session_key, b);
      }
    } catch {
      // Best-effort; mem stays authoritative this run.
    }
  }

  private persistToDb(key: string, b: StickyBinding): void {
    try {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO sticky_bindings (session_key, account_id, proxy_id, bound_at, last_used_at, ttl_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(session_key) DO UPDATE SET
           account_id = excluded.account_id,
           proxy_id = excluded.proxy_id,
           bound_at = excluded.bound_at,
           last_used_at = excluded.last_used_at,
           ttl_ms = excluded.ttl_ms,
           updated_at = datetime('now')`,
      ).run(key, b.accountId, b.proxyId, b.boundAt, b.lastUsedAt, b.ttlMs);
    } catch (err) {
      logger.warn("[Session] sticky persist failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private deleteFromDb(key: string): void {
    try {
      getDatabase().prepare("DELETE FROM sticky_bindings WHERE session_key = ?").run(key);
    } catch {
      // Best-effort.
    }
  }

  get(key: string): StickyBinding | null {
    const b = this.mem.get(key);
    if (!b) return null;
    if (isExpired(b)) {
      this.mem.delete(key);
      this.deleteFromDb(key);
      return null;
    }
    return { ...b };
  }

  set(key: string, binding: StickyBinding): void {
    if (!isValidStickyKey(key)) {
      throw new Error(`Invalid sticky key: ${key}`);
    }
    const copy = { ...binding };
    this.mem.set(key, copy);
    this.persistToDb(key, copy);
    if (this.redisReady && this.redis) {
      void this.redis
        .set(redisKey(key), JSON.stringify(copy), "PX", copy.ttlMs)
        .catch(() => {});
    }
    if (logger.isLevelEnabled("info")) {
      console.log(
        `[Session] New session bound | key=${key} | account=${copy.accountId} | ttl=${Math.round(copy.ttlMs / 3600000)}h`,
      );
    }
  }

  rebind(key: string, newAccountId: string, newProxyId: string | null): void {
    const prev = this.mem.get(key);
    const now = Date.now();
    const next: StickyBinding = {
      accountId: newAccountId,
      proxyId: newProxyId,
      boundAt: prev?.boundAt ?? now,
      lastUsedAt: now,
      ttlMs: prev?.ttlMs ?? STICKY_TTL_MS,
    };
    // Atomic Redis SET with TTL overwrites previous value in one op.
    this.mem.set(key, next);
    this.persistToDb(key, next);
    if (this.redisReady && this.redis) {
      void this.redis
        .set(redisKey(key), JSON.stringify(next), "PX", next.ttlMs)
        .catch(() => {});
    }
    this.rebindCount++;
    this.rebindTimestamps.push(now);
    // Keep 24h of timestamps for hourly counts.
    const cutoff = now - 24 * 3600 * 1000;
    this.rebindTimestamps = this.rebindTimestamps.filter((t) => t >= cutoff);
    console.warn(
      `[Session] Rebind | key=${key} | from=${prev?.accountId ?? "none"} | to=${newAccountId}`,
    );
  }

  delete(key: string): void {
    this.mem.delete(key);
    this.deleteFromDb(key);
    if (this.redisReady && this.redis) {
      void this.redis.del(redisKey(key)).catch(() => {});
    }
  }

  /** Sliding TTL refresh. */
  touch(key: string): void {
    const b = this.mem.get(key);
    if (!b) return;
    if (isExpired(b)) {
      this.mem.delete(key);
      this.deleteFromDb(key);
      return;
    }
    b.lastUsedAt = Date.now();
    this.persistToDb(key, b);
    if (this.redisReady && this.redis) {
      void this.redis
        .set(redisKey(key), JSON.stringify(b), "PX", b.ttlMs)
        .catch(() => {});
    }
    if (logger.isLevelEnabled("info")) {
      console.log(`[Session] Touch | key=${key} | account=${b.accountId}`);
    }
  }

  /** Remove expired entries; returns count removed. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, b] of this.mem) {
      if (isExpired(b, now)) {
        this.mem.delete(k);
        this.deleteFromDb(k);
        removed++;
      }
    }
    // Also sweep DB rows whose TTL elapsed (covers other workers).
    try {
      const db = getDatabase();
      const rows = db
        .prepare("SELECT session_key, last_used_at, ttl_ms FROM sticky_bindings")
        .all() as Array<{ session_key: string; last_used_at: number; ttl_ms: number }>;
      const stale = rows.filter((r) => now - r.last_used_at > (r.ttl_ms || STICKY_TTL_MS));
      if (stale.length > 0) {
        const del = db.prepare("DELETE FROM sticky_bindings WHERE session_key = ?");
        const tx = db.transaction((keys: string[]) => {
          for (const k of keys) del.run(k);
        });
        tx(stale.map((r) => r.session_key));
        // Count DB-only removals not already counted via mem.
        for (const r of stale) {
          if (!this.mem.has(r.session_key)) removed++;
        }
      }
    } catch {
      // Best-effort.
    }
    if (removed > 0 || logger.isLevelEnabled("info")) {
      console.log(`[Session] Sweep | removed=${removed} | size=${this.mem.size}`);
    }
    return removed;
  }

  size(): number {
    return this.mem.size;
  }

  rebindsLastHour(): number {
    const cutoff = Date.now() - 3600 * 1000;
    return this.rebindTimestamps.filter((t) => t >= cutoff).length;
  }

  entries(): Array<{ key: string; binding: StickyBinding }> {
    const out: Array<{ key: string; binding: StickyBinding }> = [];
    for (const [key, b] of this.mem) {
      if (!isExpired(b)) out.push({ key, binding: { ...b } });
    }
    return out;
  }

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        // Never throw from background sweep.
      }
    }, SWEEP_INTERVAL_MS);
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Test isolation: clear mem + DB rows touched by this instance. */
  clearForTests(): void {
    this.mem.clear();
    this.rebindCount = 0;
    this.rebindTimestamps = [];
    try {
      getDatabase().prepare("DELETE FROM sticky_bindings").run();
    } catch {
      // Best-effort.
    }
  }
}

function isTestEnv(): boolean {
  return (
    process.env.TEST_MOCK_QWEN_AUTH === "true" ||
    process.argv.some((a) => a === "--test" || a.includes("src/tests/"))
  );
}

// Process singleton: chat route uses lookup-only in Loop 1.
let singleton: StickyMap | null = null;

export function getStickyMap(): StickyMap {
  if (!singleton) singleton = new StickyMap();
  return singleton;
}

export function resetStickyMapForTests(): void {
  singleton?.stopSweep();
  singleton = null;
}
