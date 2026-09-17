import test from "node:test";
import assert from "node:assert/strict";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  markAccountRateLimited,
  clearAccountCooldown,
  clearAllAccountCooldowns,
  getNextAvailableAccount,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";
import { addAccount, removeAccount } from "../core/accounts.ts";

/**
 * The only accounts this test owns. Under --test-concurrency the shared
 * account pool also contains rows created by concurrently-running files, so
 * every pick assertion must be scoped to these ids.
 */
const OWN_ACCOUNT_IDS = new Set<string>([
  "test-ready-acct-1",
  "test-unready-acct-2",
]);

/**
 * Assert that getNextAvailableAccount() picked exactly `expectedId`.
 *
 * Defense against cross-file state leakage (the old failure mode: a leaked
 * 'cool-id' cooldown from forge-import.test.ts made the fallback pick a
 * foreign account). If the first pick is not the expected OWN id, that is a
 * foreign/unexpected pick: log it, wait 50ms so the leaking file's cleanup
 * can land, and retry once. If the retry still disagrees, fail with a
 * diagnostic proving whether the picked foreign account is on cooldown in
 * the shared manager (i.e. a leak artifact, not a gate regression).
 */
async function expectOwnPick(
  expectedId: string,
  message: string,
): Promise<void> {
  let candidate = getNextAvailableAccount();
  if (!candidate || candidate.id !== expectedId) {
    const firstPick = candidate?.id ?? "null";
    console.warn(
      `[headers-gate] unexpected pick id=${firstPick} (expected ${expectedId}); retrying once after 50ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    candidate = getNextAvailableAccount();
  }
  const picked = candidate?.id ?? "null";
  let diagnostic = `${message} (picked: ${picked}, expected: ${expectedId})`;
  if (picked !== expectedId && picked !== "null") {
    const cooldown = getAccountCooldownInfo(picked);
    if (cooldown?.onCooldown) {
      diagnostic +=
        " — LEAK ARTIFACT: the picked foreign account is currently on cooldown " +
        "in the shared manager (cross-file state leakage, not a gate regression)";
    }
  }
  assert.equal(picked, expectedId, diagnostic);
}

test("HeadersReadyGate gracefully degrades to non-ready accounts when all ready accounts are on cooldown", async (t) => {
  const id1 = "test-ready-acct-1";
  const email1 = "ready1@example.com";
  const id2 = "test-unready-acct-2";
  const email2 = "unready2@example.com";

  addAccount(email1, "dummy-pass-1", id1);
  addAccount(email2, "dummy-pass-2", id2);

  // Defensive BEFORE-side: scrub any cooldown a prior run or a concurrent
  // file may have left on OUR ids. (clearAllAccountCooldowns is deliberately
  // NOT used here — it would wipe other files' in-flight state.)
  clearAccountCooldown(id1);
  clearAccountCooldown(id2);

  t.after(() => {
    clearAccountCooldown(id1);
    clearAccountCooldown(id2);
    unmarkAccountHeadersReady(id1);
    unmarkAccountHeadersReady(id2);
    removeAccount(id1);
    removeAccount(id2);
  });

  // Initially: account1 is marked ready, account2 is unready
  markAccountHeadersReady(id1);
  unmarkAccountHeadersReady(id2);

  // When account1 is NOT on cooldown, rotation prefers the ready account (account1)
  await expectOwnPick(id1, "Should pick ready account when it is available");

  // Put account1 on cooldown
  markAccountRateLimited(id1, 60000, "RateLimited", { silent: true });
  assert.ok(getAccountCooldownInfo(id1)?.onCooldown);

  // Now, since the ONLY ready account is on cooldown, getNextAvailableAccount should
  // fall back to account2 (the unready one) instead of declaring that all accounts are on cooldown!
  await expectOwnPick(
    id2,
    "Should fall back to non-ready account when all ready accounts are on cooldown",
  );

  // Clear all cooldowns using clearAllAccountCooldowns
  const clearedCount = clearAllAccountCooldowns();
  assert.ok(clearedCount >= 1, "Should have cleared at least 1 account cooldown");
  assert.equal(getAccountCooldownInfo(id1), null, "Account 1 cooldown should be cleared");

  // Now account1 is free again and ready, so it should be picked
  await expectOwnPick(id1, "Should pick ready account1 after cooldown reset");
});
