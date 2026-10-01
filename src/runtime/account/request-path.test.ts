/**
 * Hermetic request-path tests for the single account authority.
 *
 * No DB, no network, no browser: the ownership authority is exercised directly
 * with in-memory accounts, and the request-path seams (gateway claim, fenced
 * release, failover compaction, slot pass-through) are tested in isolation.
 * Bound tests register an in-memory authority; unbound tests exercise the
 * slot path used by hermetic suites that never bind.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ContextLengthExceededError } from "../../core/errors.ts";
import {
  acquireAccountLease,
  resetAccountConcurrencyForTests,
  tryAcquireAccountLease,
} from "../../core/account-concurrency.ts";
import {
  acquireGenerationAccount,
  resetGatewayForTests,
  type AcquireGenerationAccountResult,
} from "../gateway.ts";
import {
  getAccountOwnership,
  initAccountOwnership,
  resetAccountOwnershipForTests,
  toLegacyAccountLease,
} from "./instance.ts";
import { buildCompressedFailoverPrompt } from "../../routes/chat/account.ts";
import {
  isContextLengthExceededError,
  isTerminalLocalError,
} from "../../routes/chat/retry-policy.ts";

/** A generation claim requires a READY account; register and warm one. */
function registerReady(...accountIds: string[]): void {
  initAccountOwnership(
    accountIds.map((accountId) => ({
      accountId,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    })),
  );
  const manager = getAccountOwnership();
  const systemFence = { leaseId: "system", ownerToken: "system" };
  for (const accountId of accountIds) {
    manager.transition(accountId, "WARMING", systemFence);
    manager.transition(accountId, "READY", systemFence);
  }
}

function winningAccountIds(
  results: readonly AcquireGenerationAccountResult[],
): string[] {
  return results
    .filter((r): r is Extract<AcquireGenerationAccountResult, { ok: true }> => r.ok)
    .map((r) => r.accountId);
}

test.afterEach(() => {
  resetGatewayForTests();
  resetAccountOwnershipForTests();
  resetAccountConcurrencyForTests();
});

test("bound: two concurrent acquires for the same candidate list claim each account exactly once", async () => {
  registerReady("g1", "g2");

  let resolveA!: () => void;
  let resolveB!: () => void;
  const gateA = new Promise<void>((resolve) => {
    resolveA = resolve;
  });
  const gateB = new Promise<void>((resolve) => {
    resolveB = resolve;
  });

  const results: AcquireGenerationAccountResult[] = [];
  const run = async (
    generationId: string,
    gate: Promise<void>,
  ): Promise<void> => {
    await gate;
    results.push(
      acquireGenerationAccount({
        generationId,
        candidates: ["g1", "g2"],
        deadline: Date.now() + 60_000,
      }),
    );
  };

  const pA = run("genA", gateA);
  const pB = run("genB", gateB);
  resolveA();
  resolveB();
  await Promise.all([pA, pB]);

  const claimed = winningAccountIds(results);
  assert.equal(claimed.length, 2, "both generations must find an account");
  assert.equal(
    claimed.filter((id) => id === "g1").length,
    1,
    "g1 must be claimed exactly once",
  );
  assert.deepEqual(
    [...claimed].sort(),
    ["g1", "g2"],
    "the two generations must never win the same account",
  );
});

test("bound: fenced release rejects a stale token and keeps the current owner", () => {
  registerReady("h1");

  const claimed = acquireGenerationAccount({
    generationId: "genX",
    candidates: ["h1"],
    deadline: Date.now() + 60_000,
  });
  assert.equal(claimed.ok, true);

  // A release carrying a wrong token must not disturb the ownership record.
  const stale = getAccountOwnership().release({
    leaseId: "lease_unknown",
    ownerToken: "own_deadbeef",
    outcome: "failed",
  });
  assert.equal(stale.released, false);
  assert.equal(stale.stale, true);

  // The account is still owned by genX: a different generation cannot claim it.
  const rival = acquireGenerationAccount({
    generationId: "genY",
    candidates: ["h1"],
    deadline: Date.now() + 60_000,
  });
  assert.equal(rival.ok, false);

  // The correct token releases cleanly and the account becomes free again.
  const clean = getAccountOwnership().release({
    leaseId: claimed.lease.leaseId,
    ownerToken: claimed.lease.ownerToken,
    outcome: "completed",
  });
  assert.equal(clean.released, true);
  assert.equal(clean.stale, false);

  const reclaimed = acquireGenerationAccount({
    generationId: "genZ",
    candidates: ["h1"],
    deadline: Date.now() + 60_000,
  });
  assert.equal(reclaimed.ok, true);
});

test("bound: a context-budget failure in the retry loop terminates with a typed error instead of looping", () => {
  // An oversized system payload cannot fit any budget: the single failover
  // compressor fails closed with a typed error on the first attempt.
  let iterations = 0;
  let caught: unknown = null;
  try {
    while (iterations < 5) {
      iterations++;
      buildCompressedFailoverPrompt({
        systemPrompt: `System: ${"S".repeat(1_500_000)}`,
        toolInstructions: "",
        tools: [],
        messages: [{ role: "user", content: "x".repeat(100) }],
        usePersonalization: false,
        reason: "request-path-test",
      });
    }
  } catch (err) {
    caught = err;
  }

  assert.equal(iterations, 1, "the loop must stop on the first budget failure");
  assert.ok(caught instanceof ContextLengthExceededError, "must be a typed error");
  assert.equal(
    isContextLengthExceededError(caught),
    true,
    "must carry the typed context-budget code",
  );
  assert.equal(
    isTerminalLocalError(caught),
    true,
    "must classify as terminal so the network retry loop never rides it",
  );
});

test("bound: account-concurrency delegates to the authority and keeps the legacy lease shape", async () => {
  registerReady("d1");

  const lease = await acquireAccountLease("d1", { label: "session-S" });
  assert.equal(typeof lease.accountId, "string");
  assert.equal(typeof lease.leaseId, "string");
  assert.equal(typeof lease.release, "function");
  assert.equal(lease.accountId, "d1");

  // A different session cannot take it while it is held (fail-fast, no queue).
  await assert.rejects(
    () => acquireAccountLease("d1", { label: "session-T", timeoutMs: 50 }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "account_busy");
      return true;
    },
  );

  // Same-session re-entrancy is allowed (retry on the same logical operation).
  const reentrant = await acquireAccountLease("d1", { label: "session-S" });
  assert.equal(reentrant.accountId, "d1");

  lease.release();
  reentrant.release();

  // After release the account is free again.
  const again = await acquireAccountLease("d1", { label: "session-U" });
  assert.equal(again.accountId, "d1");
  again.release();
});

test("bound: the legacy adapter release is fenced and idempotent", () => {
  registerReady("d1");

  const claimed = acquireGenerationAccount({
    generationId: "genAdapter",
    candidates: ["d1"],
    deadline: Date.now() + 60_000,
  });
  assert.equal(claimed.ok, true);
  const legacy = toLegacyAccountLease(claimed.lease);
  assert.equal(legacy.accountId, "d1");
  assert.equal(typeof legacy.release, "function");

  legacy.release();
  legacy.release(); // idempotent: a repeat release must not throw or re-arm.
  assert.equal(getAccountOwnership().getAccountStatus("d1"), "READY");
});

test("unbound: the legacy lease path returns the legacy lease shape", async () => {
  // Per-account capacity is 1 under the repo's test env (.env.test pins
  // ACCOUNT_MAX_CONCURRENT_STREAMS=1 at import time); run this file with
  // --env-file=.env.test like the rest of the suite.

  const lease = await acquireAccountLease("legacy1", { label: "legacy-session" });
  assert.equal(lease.accountId, "legacy1");
  assert.equal(typeof lease.leaseId, "string");
  assert.equal(typeof lease.release, "function");
  assert.ok(lease.leaseId.length > 0);

  // With one lease held and per-account capacity of 1, a second try-acquire on
  // the SAME account must be refused (this is the fence, not a bug): the
  // caller must release first. Assert the free-after-release path instead.
  const blocked = tryAcquireAccountLease("legacy1", "legacy-session-2");
  assert.equal(blocked, null, "capacity-1 account must not double-lease");

  lease.release();

  const quick = tryAcquireAccountLease("legacy1", "legacy-session-2");
  assert.ok(quick, "try-acquire must work once the account is free");
  assert.equal(quick!.accountId, "legacy1");
  assert.equal(typeof quick!.release, "function");
  quick!.release();
});
