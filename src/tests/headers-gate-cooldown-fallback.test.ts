import test from "node:test";
import assert from "node:assert/strict";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  markAccountRateLimited,
  clearAccountCooldown,
  clearAllAccountCooldowns,
  pickNextHotCandidate,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";
import { addAccount, removeAccount } from "../core/accounts.ts";

/**
 * The only accounts this test owns. Picks are HOT-only, so foreign DB rows
 * from concurrently-running files (never marked in this process) can never
 * be selected — no retry/defensive logic needed.
 */
const ID1 = "test-ready-acct-1";
const ID2 = "test-unready-acct-2";

test("HeadersReadyGate never executes on cold accounts: cooldown yields null, not fallback", async (t) => {
  const email1 = "ready1@example.com";
  const email2 = "unready2@example.com";

  addAccount(email1, "dummy-pass-1", ID1);
  addAccount(email2, "dummy-pass-2", ID2);

  // Defensive BEFORE-side: scrub any cooldown a prior run may have left on OUR ids.
  clearAccountCooldown(ID1);
  clearAccountCooldown(ID2);

  t.after(() => {
    clearAccountCooldown(ID1);
    clearAccountCooldown(ID2);
    unmarkAccountHeadersReady(ID1);
    unmarkAccountHeadersReady(ID2);
    removeAccount(ID1);
    removeAccount(ID2);
  });

  // Initially: account1 is marked ready, account2 is unready
  markAccountHeadersReady(ID1);
  unmarkAccountHeadersReady(ID2);

  // When account1 is NOT on cooldown, rotation prefers the ready account (account1)
  assert.equal(
    pickNextHotCandidate()?.id,
    ID1,
    "Should pick ready account when it is available",
  );

  // Put account1 on cooldown
  markAccountRateLimited(ID1, 60000, "RateLimited", { silent: true });
  assert.ok(getAccountCooldownInfo(ID1)?.onCooldown);

  // The ONLY ready account is on cooldown: the picker returns null instead of
  // falling back to the cold account. The request layer maps null to a
  // bounded 429 + retryAfter; executing on the cold account would surface
  // "not warmed" failures to the client.
  assert.strictEqual(
    pickNextHotCandidate(),
    null,
    "Must not fall back to a non-ready account when all ready accounts are on cooldown",
  );

  // Clear all cooldowns using clearAllAccountCooldowns
  const clearedCount = clearAllAccountCooldowns();
  assert.ok(clearedCount >= 1, "Should have cleared at least 1 account cooldown");
  assert.equal(getAccountCooldownInfo(ID1), null, "Account 1 cooldown should be cleared");

  // Now account1 is free again and ready, so it should be picked
  assert.equal(
    pickNextHotCandidate()?.id,
    ID1,
    "Should pick ready account1 after cooldown reset",
  );
});
