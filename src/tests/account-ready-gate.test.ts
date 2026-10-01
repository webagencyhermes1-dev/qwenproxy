import test from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  isAccountHeadersReady,
  markAccountHeadersReady,
  pickNextHotCandidate,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  clearTemporaryBusy,
} from "../core/account-concurrency.ts";

const TEST_ACCOUNTS = ["ready-a", "ready-b", "ready-c"];

function seedAccounts(ids: string[]): void {
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
  );
  for (const id of ids) insert.run(id, `${id}@example.com`, "pw");
  invalidateAccountsCache();
}

// syncEnvAccounts upserts QWEN_ACCOUNTS (from the real .env) into the test DB
// on the first loadAccounts() call, silently restoring real accounts the test
// just deleted. Neutralize it like rotation.test.ts does.
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;

test.beforeEach(() => {
  delete process.env.QWEN_ACCOUNTS;
});

test.afterEach(() => {
  for (const id of [...TEST_ACCOUNTS, "ready-solo"]) {
    unmarkAccountHeadersReady(id);
    clearTemporaryBusy(id);
  }
  if (originalQwenAccounts !== undefined) {
    process.env.QWEN_ACCOUNTS = originalQwenAccounts;
  }
  seedAccounts([]);
  invalidateAccountsCache();
});

test("account-ready-gate: cold pool yields null (caller emits bounded capacity error)", () => {
  seedAccounts(TEST_ACCOUNTS);
  for (const id of TEST_ACCOUNTS) {
    assert.equal(isAccountHeadersReady(id), false);
  }
  // No HOT account exists: the picker returns null instead of executing on a
  // cold account. The request layer maps null to a single retryable capacity
  // error; the readiness controller warms a replacement in the background.
  assert.strictEqual(pickNextHotCandidate(), null);
  assert.strictEqual(pickNextHotCandidate(new Set(["ready-a"])), null);
});

test("account-ready-gate: once one account is ready, rotation only picks it", () => {
  seedAccounts(TEST_ACCOUNTS);
  markAccountHeadersReady("ready-b");

  const first = pickNextHotCandidate();
  assert.equal(first?.id, "ready-b", "the only ready account must be picked");

  // Even when asked to avoid a specific not-ready account, the picker must
  // skip the OTHER not-ready accounts and land on the ready one.
  const next = pickNextHotCandidate("ready-a");
  assert.equal(next?.id, "ready-b", "ready account must be preferred over cold ones");
});

test("account-ready-gate: unmark removes the account from the rotation pool", () => {
  seedAccounts(TEST_ACCOUNTS);
  markAccountHeadersReady("ready-b");
  unmarkAccountHeadersReady("ready-b");

  // No ready account remains: back to null (capacity error), never a cold pick.
  assert.strictEqual(pickNextHotCandidate(), null);
});

test("account-ready-gate: single cold account yields null until warmed", () => {
  seedAccounts(["ready-solo"]);
  assert.strictEqual(pickNextHotCandidate(), null);
  assert.strictEqual(pickNextHotCandidate("some-other-id"), null);
  markAccountHeadersReady("ready-solo");
  assert.equal(pickNextHotCandidate()?.id, "ready-solo");
});
