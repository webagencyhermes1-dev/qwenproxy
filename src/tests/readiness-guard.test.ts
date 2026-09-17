import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  ensurePoolReadiness,
  registerReadinessGuardDeps,
  recoveredValidationBucket,
  startReadinessGuardSweep,
  stopReadinessGuardSweep,
} from "../core/readiness-guard.ts";
import {
  addAccount,
  removeAccount,
  type QwenAccount,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { config } from "../core/config.ts";

function seedAccounts(...ids: string[]): () => void {
  for (const id of ids) {
    addAccount(`${id}@example.com`, "secret", id);
    clearAccountCooldown(id);
    unmarkAccountHeadersReady(id);
  }
  return () => {
    for (const id of ids) {
      try {
        removeAccount(id);
      } catch {
        // Already removed.
      }
      clearAccountCooldown(id);
    }
  };
}

function registerDeps(opts: {
  initDelayMs?: number;
  onInit?: (id: string) => void;
  active?: { value: number; peak: number };
} = {}): {
  initCalls: string[];
  release: () => void;
} {
  const initCalls: string[] = [];

  registerReadinessGuardDeps({
    getAccountCredentials: (id) =>
      ({ id, email: `${id}@example.com`, username: id, password: "secret" }) as QwenAccount,
    initPlaywrightForAccount: async (account) => {
      initCalls.push(account.id);
      if (opts.active) {
        opts.active.value++;
        opts.active.peak = Math.max(opts.active.peak, opts.active.value);
      }
      opts.onInit?.(account.id);
      const delayed = opts.initDelayMs ?? 0;
      if (delayed > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayed);
          timer.unref?.();
        });
      }
      if (opts.active) opts.active.value--;
    },
    disableNativeTools: async () => {},
    warmQwenChatPool: async () => {},
  });

  return {
    initCalls,
    release: () => {
      registerReadinessGuardDeps(null as never);
    },
  };
}

test("readiness: recoveredValidationBucket is deterministic and spreads accounts", () => {
  const buckets = 3;
  const ids = [
    "bucket-acc-a",
    "bucket-acc-b",
    "bucket-acc-c",
    "bucket-acc-d",
    "bucket-acc-e",
    "bucket-acc-f",
  ];
  const seen = new Set<number>();
  for (const id of ids) {
    const b = recoveredValidationBucket(id, buckets);
    assert.ok(b >= 0 && b < buckets, `bucket ${b} out of range`);
    assert.equal(recoveredValidationBucket(id, buckets), b, "must be deterministic");
    seen.add(b);
  }
  // Six accounts across three buckets must not all pile into one bucket.
  assert.ok(seen.size >= 2, `expected spread across buckets, got ${[...seen]}`);
});

test("readiness: concurrent pool-check bursts coalesce — never parallel inits", async () => {
  stopReadinessGuardSweep();
  const ids = ["rg-coalesce-a", "rg-coalesce-b", "rg-coalesce-c"];
  const cleanup = seedAccounts(...ids);
  const priorModels = config.qwen.chatPoolModels;
  config.qwen.chatPoolModels = ["qwen3.6-plus"];
  const active = { value: 0, peak: 0 };

  const { initCalls, release } = registerDeps({
    initDelayMs: 80,
    active,
  });
  try {
    // Fire the thundering herd: 6 triggers while the first check is mid-warm.
    await Promise.all([
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
    ]);
    // Coalescing: one running check + one trailing recheck. Never parallel.
    assert.ok(initCalls.length <= 2, `expected 1-2 coalesced inits, got ${initCalls.length}`);
    assert.ok(active.peak <= 1, `peak concurrent inits was ${active.peak}, expected at most 1`);
    // The single-standby re-check must not double-init an already-warmed account.
    assert.equal(new Set(initCalls).size, initCalls.length, "no account may init twice");
  } finally {
    release();
    config.qwen.chatPoolModels = priorModels;
    cleanup();
  }
});

test("readiness: pool check with no standby accounts is a no-op", async () => {
  stopReadinessGuardSweep();
  const ids = ["rg-nostandby-a", "rg-nostandby-b"];
  const cleanup = seedAccounts(...ids);
  for (const id of ids) markAccountHeadersReady(id);

  const { initCalls, release } = registerDeps();
  try {
    await ensurePoolReadiness();
    // Confirmed policy (src/core/readiness-guard.ts):
    //   MIN_READY = 2 (line 31), MIN_WARMING = 1 (line 32), and in
    //   runPoolCheck (lines 425-429):
    //     needReady   = max(0, MIN_READY   - ready.length)
    //     needWarming = max(0, MIN_WARMING - warming.length)
    //     totalNeeded = min(needReady + needWarming, standby.length)
    // With both own accounts READY, needReady === 0; and because standby
    // requires !isAccountHeadersReady, OUR slice of the pool has zero
    // standby — so this check must never initialize one of OUR accounts.
    // However, under --test-concurrency the shared pool also contains
    // foreign un-ready rows from concurrently-running files; with
    // MIN_WARMING = 1 the guard legitimately schedules at most one warmup
    // for a FOREIGN standby account (capped by MAX_CONCURRENT_WARMING = 1
    // per pass, and a single ensurePoolReadiness() call here runs exactly
    // one pass). So: total inits are bounded by 1, but our own accounts
    // must never be warmed.
    const ownInits = initCalls.filter((id) => ids.includes(id));
    assert.equal(
      ownInits.length,
      0,
      "fully-ready pool must not trigger inits for its own accounts",
    );
    assert.ok(
      initCalls.length <= 1,
      `MIN_WARMING floor allows at most 1 warmup per single pass (got ${initCalls.length})`,
    );
  } finally {
    release();
    cleanup();
  }
});

test("readiness: single standby behind concurrent triggers inits exactly once", async () => {
  stopReadinessGuardSweep();
  const ids = ["rg-single-acc"];
  const cleanup = seedAccounts(...ids);
  const priorModels = config.qwen.chatPoolModels;
  config.qwen.chatPoolModels = ["qwen3.6-plus"];

  const { initCalls, release } = registerDeps();
  try {
    await Promise.all([ensurePoolReadiness(), ensurePoolReadiness()]);
    assert.equal(initCalls.length, 1, "single standby must be initialized exactly once");
  } finally {
    release();
    config.qwen.chatPoolModels = priorModels;
    cleanup();
  }
});

test("readiness: sweep start/stop round-trips without throwing", () => {
  startReadinessGuardSweep();
  stopReadinessGuardSweep();
  startReadinessGuardSweep();
  stopReadinessGuardSweep();
});