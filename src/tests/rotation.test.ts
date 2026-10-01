import { test } from "node:test";
import assert from "node:assert";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  clearAccountCooldown,
  markAccountHeadersReady,
  markAccountRateLimited,
  pickNextHotCandidate,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";

test("Account Rotation: HOT-only rotation cycle", async () => {
  const originalEnv = process.env.QWEN_ACCOUNTS;
  delete process.env.QWEN_ACCOUNTS;

  const db = getDatabase();
  const existing = db.prepare("SELECT id, email, password FROM accounts").all();
  db.prepare("DELETE FROM accounts").run();
  invalidateAccountsCache();

  try {
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    insert.run("acc1", "account1@test.com", "password1");
    insert.run("acc2", "account2@test.com", "password2");
    insert.run("acc3", "account3@test.com", "password3");
    invalidateAccountsCache();
    markAccountHeadersReady("acc1");
    markAccountHeadersReady("acc2");
    markAccountHeadersReady("acc3");

    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const next = pickNextHotCandidate();
      assert.ok(next, "a HOT pool must always yield a candidate");
      seen.add(next!.id);
    }
    assert.strictEqual(seen.size, 3, "rotation must cycle through all HOT accounts");

    unmarkAccountHeadersReady("acc1");
    unmarkAccountHeadersReady("acc2");
    unmarkAccountHeadersReady("acc3");
  } finally {
    db.prepare("DELETE FROM accounts").run();
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    for (const row of existing as any[]) {
      insert.run(row.id, row.email, row.password);
    }
    invalidateAccountsCache();
    if (originalEnv !== undefined) {
      process.env.QWEN_ACCOUNTS = originalEnv;
    }
  }
});

test("Account Rotation: all-on-cooldown yields null (caller maps to 429+retryAfter)", async () => {
  const originalEnv = process.env.QWEN_ACCOUNTS;
  delete process.env.QWEN_ACCOUNTS;

  const db = getDatabase();
  const existing = db.prepare("SELECT id, email, password FROM accounts").all();
  db.prepare("DELETE FROM accounts").run();
  invalidateAccountsCache();

  try {
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    insert.run("cool-acc-1", "cool1@test.com", "password1");
    insert.run("cool-acc-2", "cool2@test.com", "password2");
    invalidateAccountsCache();

    markAccountHeadersReady("cool-acc-1");
    markAccountHeadersReady("cool-acc-2");
    markAccountRateLimited("cool-acc-1", 60_000, "RateLimited");
    markAccountRateLimited("cool-acc-2", 30_000, "RateLimited");

    // No HOT account is usable: the picker returns null and the request layer
    // maps the exhausted pool to 429 + retryAfter (no cold execution).
    assert.strictEqual(pickNextHotCandidate(), null);
    assert.strictEqual(pickNextHotCandidate(new Set(["cool-acc-1"])), null);

    // Once a cooldown clears, the account is selectable again.
    clearAccountCooldown("cool-acc-2");
    const next = pickNextHotCandidate(new Set(["cool-acc-1"]));
    assert.ok(next);
    assert.strictEqual(next!.id, "cool-acc-2");

    clearAccountCooldown("cool-acc-1");
    unmarkAccountHeadersReady("cool-acc-1");
    unmarkAccountHeadersReady("cool-acc-2");
  } finally {
    db.prepare("DELETE FROM accounts").run();
    const insert = db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    );
    for (const row of existing as any[]) {
      insert.run(row.id, row.email, row.password);
    }
    invalidateAccountsCache();
    if (originalEnv !== undefined) {
      process.env.QWEN_ACCOUNTS = originalEnv;
    }
  }
});
