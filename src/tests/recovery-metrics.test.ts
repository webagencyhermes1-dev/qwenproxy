import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.ACCOUNT_MAX_CONCURRENT_STREAMS = "1";

import {
  addAccount,
  removeAccount,
  invalidateAccountsCache,
} from "../core/accounts.ts";
import {
  clearAccountCooldown,
  clearAllAccountCooldowns,
  getHeadersReadyAccountIds,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { getDatabase } from "../core/database.ts";
import { resetAccountConcurrencyForTests } from "../core/account-concurrency.ts";
import {
  getAccountOwnership,
  initAccountOwnership,
  resetAccountOwnershipForTests,
} from "../runtime/account/instance.ts";
import type { OwnershipFence } from "../runtime/contracts.ts";
import {
  ReadinessController,
  type WarmupOutcome,
} from "../runtime/readiness/readiness-controller.ts";
import { app } from "../api/server.ts";

const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };

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
 * otherwise skew strict assertions. Drop them and wipe the in-memory
 * headers-ready/cooldown state (mirrors the server-lifecycle.test.ts
 * accounts-table precedent).
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

function bindPool(ids: string[]): void {
  initAccountOwnership(
    ids.map((accountId) => ({
      accountId,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    })),
  );
}

/** Production-shaped warmup: claim WARMING, capture headers, report outcome. */
function makeExecutor(calls: string[]): (id: string) => Promise<WarmupOutcome> {
  return async (id: string) => {
    calls.push(id);
    const ownership = getAccountOwnership();
    if (ownership.getAccountStatus(id) === "RECOVERING") {
      ownership.transition(id, "STANDBY", SYSTEM_FENCE, "recovery-requeue");
    }
    const claimed = ownership.transition(id, "WARMING", SYSTEM_FENCE, "warmup-start");
    if (!claimed.transitioned) return "failed";
    markAccountHeadersReady(id);
    return getAccountOwnership().getAccountStatus(id) === "READY" ? "ready" : "failed";
  };
}

function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("recovery: controller tick warms the standby exactly once", async () => {
  resetAccountConcurrencyForTests();
  resetAccountOwnershipForTests();
  cleanSlate();
  const cleanup = seedAccount("rg-metrics-warm");
  bindPool(["rg-metrics-warm"]);
  const calls: string[] = [];
  const controller = new ReadinessController(
    getAccountOwnership(),
    {
      targetReady: 1,
      warmupConcurrency: 1,
      warmupTimeoutMs: 5000,
      maxWarmupFailures: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
    },
    { warmWarmup: makeExecutor(calls), jitter: () => 0 },
  );
  try {
    const report = await controller.tick();
    assert.deepEqual(report.launched, ["rg-metrics-warm"]);
    await settle();
    assert.deepEqual(calls, ["rg-metrics-warm"], "standby must be warmed exactly once");
    assert.equal(
      getAccountOwnership().getAccountStatus("rg-metrics-warm"),
      "READY",
    );
    controller.stop();
  } finally {
    cleanup();
    cleanSlate();
    resetAccountConcurrencyForTests();
    resetAccountOwnershipForTests();
  }
});

test("recovery: concurrent ticks coalesce, never duplicate warmups", async () => {
  resetAccountConcurrencyForTests();
  resetAccountOwnershipForTests();
  cleanSlate();
  const cleanup = seedAccount("rg-metrics-herd");
  bindPool(["rg-metrics-herd"]);
  const calls: string[] = [];
  const controller = new ReadinessController(
    getAccountOwnership(),
    {
      targetReady: 1,
      warmupConcurrency: 1,
      warmupTimeoutMs: 5000,
      maxWarmupFailures: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
    },
    {
      warmWarmup: async (id: string) => {
        calls.push(id);
        await settle(60);
        return makeExecutor([])(id);
      },
      jitter: () => 0,
    },
  );
  try {
    const reports = await Promise.all([
      controller.tick(),
      controller.tick(),
      controller.tick(),
      controller.tick(),
      controller.tick(),
    ]);
    const launched = reports.flatMap((r) => r.launched);
    assert.ok(
      launched.length <= 2,
      `expected coalesced passes, got ${launched.length} launches`,
    );
    await settle(100);
    assert.deepEqual(calls, ["rg-metrics-herd"], "herd must warm the standby exactly once");
    controller.stop();
  } finally {
    cleanup();
    cleanSlate();
    resetAccountConcurrencyForTests();
    resetAccountOwnershipForTests();
  }
});

test("health/recovery endpoint surfaces controller diagnostics", async () => {
  resetAccountConcurrencyForTests();
  resetAccountOwnershipForTests();
  cleanSlate();
  const res = await app.fetch(new Request("http://localhost/health/recovery"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    readiness: { inFlight: string[]; targetReady: number; readyCount: number; deficit: number };
    leases: unknown[];
    queuedLeaseCount: number;
    pool: { ready: number };
    timestamp: number;
  };
  assert.ok(body.readiness, "readiness diagnostics must be present");
  assert.ok(Array.isArray(body.readiness.inFlight));
  assert.equal(typeof body.readiness.deficit, "number");
  assert.equal(body.queuedLeaseCount, 0, "no request queue exists (fail-fast admission)");
  assert.ok(Array.isArray(body.leases));
  assert.ok(body.timestamp > 0);
  cleanSlate();
  resetAccountConcurrencyForTests();
  resetAccountOwnershipForTests();
});
