import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.ACCOUNT_MAX_CONCURRENT_STREAMS = "1";

import {
  addAccount,
  removeAccount,
  invalidateAccountsCache,
  type QwenAccount,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  clearAllAccountCooldowns,
  getHeadersReadyAccountIds,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { getDatabase } from "../core/database.ts";
import { resetAccountConcurrencyForTests } from "../core/account-concurrency.ts";
import {
  ensurePoolReadiness,
  getReadinessDiagnostics,
  registerReadinessGuardDeps,
  recoveredValidationBucket,
  resetReadinessCountersForTests,
  runReadinessValidationForTests,
  stopReadinessGuardSweep,
} from "../core/readiness-guard.ts";
import { config } from "../core/config.ts";
import { app } from "../api/server.ts";

function seedAccount(id: string): () => void {
  addAccount(`${id}@example.com`, "secret", id);
  clearAccountCooldown(id);
  unmarkAccountHeadersReady(id);
  return () => {
    try {
      removeAccount(id);
    } catch {
      // Already removed.
    }
    clearAccountCooldown(id);
  };
}

/**
 * Hermetic slate: the .env.test database carries real Qwen accounts that would
 * otherwise get warmed as standbys and skew strict counter assertions. Drop
 * them and wipe the in-memory headers-ready/cooldown state (mirrors the
 * server-lifecycle.test.ts accounts-table precedent).
 */
function cleanSlate(): void {
  try {
    getDatabase().prepare("DELETE FROM accounts").run();
  } catch {
    // Best-effort.
  }
  invalidateAccountsCache();
  clearAllAccountCooldowns();
  for (const id of getHeadersReadyAccountIds()) unmarkAccountHeadersReady(id);
}

function registerDeps(opts: { initDelayMs?: number } = {}): {
  release: () => void;
} {
  registerReadinessGuardDeps({
    getAccountCredentials: (id) =>
      ({ id, email: `${id}@example.com`, username: id, password: "secret" }) as QwenAccount,
    initPlaywrightForAccount: async () => {
      const delayed = opts.initDelayMs ?? 0;
      if (delayed > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayed);
          timer.unref?.();
        });
      }
    },
    disableNativeTools: async () => {},
    warmQwenChatPool: async () => {},
  });
  return {
    release: () => {
      registerReadinessGuardDeps(null as never);
    },
  };
}

test("recovery counters: pool check and warmups are recorded", async () => {
  stopReadinessGuardSweep();
  resetAccountConcurrencyForTests();
  resetReadinessCountersForTests();
  cleanSlate();
  const cleanup = seedAccount("rg-metrics-warm");
  const priorModels = config.qwen.chatPoolModels;
  config.qwen.chatPoolModels = ["qwen3.6-plus"];
  const { release } = registerDeps();
  try {
    await ensurePoolReadiness();
    const diag = getReadinessDiagnostics();
    assert.ok(diag.poolChecksRun >= 1, "pool check must be counted");
    assert.equal(diag.accountsWarmed, 1, "the single standby must be warmed once");
    assert.ok(diag.lastPoolCheckAt != null, "last pool check timestamp must be set");
    assert.equal(diag.readyAccounts, 1, "warmed account is now ready");
  } finally {
    release();
    config.qwen.chatPoolModels = priorModels;
    cleanup();
    cleanSlate();
    resetReadinessCountersForTests();
  }
});

test("recovery counters: thundering herd is counted as coalesced", async () => {
  stopReadinessGuardSweep();
  resetAccountConcurrencyForTests();
  resetReadinessCountersForTests();
  cleanSlate();
  const cleanup = seedAccount("rg-metrics-herd");
  const priorModels = config.qwen.chatPoolModels;
  config.qwen.chatPoolModels = ["qwen3.6-plus"];
  const { release } = registerDeps({ initDelayMs: 60 });
  try {
    await Promise.all([
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
      ensurePoolReadiness(),
    ]);
    const diag = getReadinessDiagnostics();
    // 4 of the 5 triggers arrived while the check was running.
    assert.ok(
      diag.coalescedTriggers >= 4,
      `expected at least 4 coalesced triggers, got ${diag.coalescedTriggers}`,
    );
    // One check + one trailing re-check, never one check per trigger.
    assert.ok(
      diag.poolChecksRun <= 2,
      `expected <= 2 pool checks, got ${diag.poolChecksRun}`,
    );
    assert.equal(diag.accountsWarmed, 1, "herd must warm the standby exactly once");
  } finally {
    release();
    config.qwen.chatPoolModels = priorModels;
    cleanup();
    cleanSlate();
    resetReadinessCountersForTests();
  }
});

test("recovery counters: validation sweep runs and revalidates the matching bucket", async () => {
  stopReadinessGuardSweep();
  resetAccountConcurrencyForTests();
  resetReadinessCountersForTests();
  cleanSlate();
  const priorModels = config.qwen.chatPoolModels;
  config.qwen.chatPoolModels = ["qwen3.6-plus"];
  const { release } = registerDeps();

  // Pick an account id whose validation bucket matches the CURRENT sweep bucket
  // so this sweep deterministically revalidates it (no sweep-boundary flake).
  const sweepBucket = Math.floor(Date.now() / 60_000) % 3;
  let recoveredId: string | null = null;
  for (let i = 0; i < 32; i++) {
    const candidate = `rg-metrics-recover-${String(i).padStart(2, "0")}`;
    if (recoveredValidationBucket(candidate) === sweepBucket) {
      recoveredId = candidate;
      break;
    }
  }
  assert.ok(recoveredId, "must find an id matching the current validation bucket");
  const cleanup = seedAccount(recoveredId!);
  try {
    await runReadinessValidationForTests();
    const diag = getReadinessDiagnostics();
    assert.equal(diag.validationSweepsRun, 1, "validation sweep must be counted");
    assert.equal(diag.accountsRevalidated, 1, "bucket-matched recovered account must revalidate");
  } finally {
    release();
    config.qwen.chatPoolModels = priorModels;
    cleanup();
    cleanSlate();
    resetReadinessCountersForTests();
  }
});

test("health/recovery endpoint surfaces readiness diagnostics", async () => {
  stopReadinessGuardSweep();
  resetAccountConcurrencyForTests();
  resetReadinessCountersForTests();
  cleanSlate();
  const res = await app.fetch(new Request("http://localhost/health/recovery"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    readiness: Record<string, number>;
    leases: unknown[];
    pool: { ready: number };
    timestamp: number;
  };
  assert.ok(body.readiness, "readiness diagnostics must be present");
  assert.equal(typeof body.readiness.poolChecksRun, "number");
  assert.equal(typeof body.readiness.coalescedTriggers, "number");
  assert.ok(Array.isArray(body.leases));
  assert.ok(body.timestamp > 0);
  cleanSlate();
  resetReadinessCountersForTests();
});