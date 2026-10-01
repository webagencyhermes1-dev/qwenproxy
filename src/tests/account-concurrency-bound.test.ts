import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  abortLeaseByLabel,
  acquireAccountLease,
  getAccountConcurrencySnapshot,
  hasActiveAccountLease,
  isAccountBusy,
  resetAccountConcurrencyForTests,
  trackExternalLease,
  tryAcquireAccountLease,
} from "../core/account-concurrency.ts";
import {
  getAccountOwnership,
  initAccountOwnership,
  resetAccountOwnershipForTests,
} from "../runtime/account/instance.ts";
import { clearAllHeadersReadyAccounts } from "../core/account-manager.ts";
import type { OwnershipFence } from "../runtime/contracts.ts";

const SYSTEM_FENCE: OwnershipFence = { leaseId: "system", ownerToken: "system" };
const ACCOUNTS = ["bound-a", "bound-b"];

function bindReadyPool(): void {
  const ownership = initAccountOwnership(
    ACCOUNTS.map((accountId) => ({
      accountId,
      disabled: false,
      cooldownUntil: 0,
      cooldownReason: null,
    })),
  );
  for (const id of ACCOUNTS) {
    ownership.transition(id, "WARMING", SYSTEM_FENCE, "test-warm");
    ownership.transition(id, "READY", SYSTEM_FENCE, "test-ready");
  }
}

test.beforeEach(() => {
  resetAccountConcurrencyForTests();
  resetAccountOwnershipForTests();
  bindReadyPool();
});

test.afterEach(() => {
  resetAccountConcurrencyForTests();
  resetAccountOwnershipForTests();
  clearAllHeadersReadyAccounts();
});

test("bound leases: at capacity fails fast with account_busy (no queue)", async () => {
  const first = await acquireAccountLease("bound-a", { label: "sess-1" });
  assert.equal(first.accountId, "bound-a");
  assert.equal(isAccountBusy("bound-a"), true);

  // .env.test busyWaitMs is 30s: a queued implementation would hang here.
  // Bound mode must reject immediately.
  const started = Date.now();
  await assert.rejects(() => acquireAccountLease("bound-a", { label: "sess-2" }), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "account_busy");
    return true;
  });
  assert.ok(Date.now() - started < 5000, "fail-fast must not wait out the busy timeout");

  first.release();
  assert.equal(isAccountBusy("bound-a"), false);
  const again = await acquireAccountLease("bound-a", { label: "sess-3" });
  assert.equal(again.accountId, "bound-a");
  again.release();
});

test("bound leases: tryAcquire returns null at capacity, lease after release", () => {
  const first = tryAcquireAccountLease("bound-a", "sess-1");
  assert.ok(first);
  assert.strictEqual(tryAcquireAccountLease("bound-a", "sess-2"), null);
  first!.release();
  assert.ok(tryAcquireAccountLease("bound-a", "sess-3"));
});

test("bound leases: release returns the account to READY", async () => {
  const lease = await acquireAccountLease("bound-a", { label: "sess-1" });
  assert.equal(getAccountOwnership().getAccountStatus("bound-a"), "RESERVED");
  assert.equal(hasActiveAccountLease("bound-a"), true);
  lease.release();
  assert.equal(getAccountOwnership().getAccountStatus("bound-a"), "READY");
  assert.equal(hasActiveAccountLease("bound-a"), false);
});

test("bound leases: direct gateway claims are visible to busy checks", () => {
  const ownership = getAccountOwnership();
  const claimed = ownership.acquire({
    generationId: "gen-direct",
    candidates: ["bound-a"],
    deadline: Date.now() + 60_000,
    requirements: { purpose: "generation", generationId: "gen-direct" },
  });
  assert.equal(claimed.ok, true);
  // Untracked by the registry: busy-ness still observed via the authority.
  assert.equal(isAccountBusy("bound-a"), true);
  assert.equal(hasActiveAccountLease("bound-a"), true);
  if (claimed.ok) {
    ownership.release({
      leaseId: claimed.lease.leaseId,
      ownerToken: claimed.lease.ownerToken,
      outcome: "completed",
    });
  }
  assert.equal(isAccountBusy("bound-a"), false);
});

test("bound leases: tracked external leases support latest-wins supersede", () => {
  const ownership = getAccountOwnership();
  const claimed = ownership.acquire({
    generationId: "gen-ext",
    candidates: ["bound-a"],
    deadline: Date.now() + 60_000,
    requirements: { purpose: "generation", generationId: "gen-ext" },
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;

  const aborter = new AbortController();
  const tracked = trackExternalLease("bound-a", claimed.lease, {
    label: "sess-X",
    leaseAbortController: aborter,
  });
  assert.equal(
    getAccountConcurrencySnapshot().find((s) => s.accountId === "bound-a")?.active,
    1,
  );

  // Same-session retry supersedes: abort fires and the account returns to READY.
  assert.equal(abortLeaseByLabel("bound-a", "sess-X"), true);
  assert.equal(aborter.signal.aborted, true);
  assert.equal(ownership.getAccountStatus("bound-a"), "READY");

  // The losing handle's late release is a safe no-op (fenced + deregistered).
  tracked.release();
  assert.equal(ownership.getAccountStatus("bound-a"), "READY");
});
