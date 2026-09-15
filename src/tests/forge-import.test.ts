import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { config } from "../core/config.ts";
import { getDatabase } from "../core/database.ts";
import {
  generateAccountId,
  invalidateAccountsCache,
  loadAccounts,
} from "../core/accounts.ts";
import {
  getAccountHealth,
  resetAccountHealthForTests,
} from "../core/account-health.ts";
import {
  getAccountCooldownInfo,
  markAccountRateLimited,
  clearAccountCooldown,
  resetAccountManagerForTests,
} from "../core/account-manager.ts";
import {
  getAccountsByPriority,
  invalidatePriorityCache,
} from "../core/account-priority.ts";
import { resetAccountStateForTests } from "../core/account-state.ts";
import { resetAccountConcurrencyForTests } from "../core/account-concurrency.ts";
import {
  FORGE_FORMAT_ID,
  importForgeAccountsFromPath,
  resolveForgeAccountsPath,
} from "../core/forge-import.ts";
import { isEncrypted } from "../core/crypto-utils.ts";

const TEST_DIR = path.join(os.tmpdir(), "qwenproxy-forge-tests");

function setup(): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function writeFixture(name: string, content: string): string {
  const filePath = path.join(TEST_DIR, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function forgeJson(
  accounts: Array<{ email?: string; password?: string; status?: string }>,
  overrides?: Record<string, unknown>,
): string {
  return JSON.stringify({
    format: FORGE_FORMAT_ID,
    generated_at: "2026-01-01T00:00:00Z",
    accounts,
    ...overrides,
  });
}

function freshDb(): void {
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  try {
    db.prepare("DELETE FROM account_health").run();
  } catch {}
  invalidateAccountsCache();
  resetAccountHealthForTests();
  resetAccountStateForTests();
  resetAccountConcurrencyForTests();
  resetAccountManagerForTests();
  invalidatePriorityCache();
  delete process.env.QWEN_ACCOUNTS;
  delete process.env.QWEN_FORGE_ACCOUNTS_PATH;
}

function cleanup(): void {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

test("forge-import: resolveForgeAccountsPath returns config default", () => {
  delete process.env.QWEN_FORGE_ACCOUNTS_PATH;
  const result = resolveForgeAccountsPath();
  assert.equal(result, config.forge.defaultAccountsPath);
  assert.ok(result.includes("qwen-forge"));
  assert.ok(result.includes("accounts.json"));
});

test("forge-import: explicit path takes precedence", () => {
  process.env.QWEN_FORGE_ACCOUNTS_PATH = "/env/override.json";
  const result = resolveForgeAccountsPath("C:\\explicit\\path.json");
  assert.equal(result, path.resolve("C:\\explicit\\path.json"));
  delete process.env.QWEN_FORGE_ACCOUNTS_PATH;
});

test("forge-import: QWEN_FORGE_ACCOUNTS_PATH env override", () => {
  process.env.QWEN_FORGE_ACCOUNTS_PATH = "C:\\custom\\forge.json";
  const result = resolveForgeAccountsPath();
  assert.equal(result, path.resolve("C:\\custom\\forge.json"));
  delete process.env.QWEN_FORGE_ACCOUNTS_PATH;
});

test("forge-import: valid one-account import", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "one.json",
      forgeJson([{ email: "user1@test.com", password: "pass123", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.error, undefined);
    assert.equal(summary.found, 1);
    assert.equal(summary.imported, 1);
    assert.equal(summary.alreadyPresent, 0);
    assert.equal(summary.invalid, 0);
    assert.equal(summary.importedIds.length, 1);
    assert.equal(summary.importedIds[0], generateAccountId("user1@test.com"));
    const accounts = loadAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, "user1@test.com");
  } finally {
    cleanup();
  }
});

test("forge-import: 50+ account bulk import", () => {
  freshDb();
  setup();
  try {
    const accounts = Array.from({ length: 55 }, (_, i) => ({
      email: `bulk${i}@test.com`,
      password: `pass${i}`,
      status: "ready",
    }));
    const file = writeFixture("bulk.json", forgeJson(accounts));
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.error, undefined);
    assert.equal(summary.found, 55);
    assert.equal(summary.imported, 55);
    assert.equal(summary.poolTotal, 55);
  } finally {
    cleanup();
  }
});

test("forge-import: malformed JSON returns error", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture("bad.json", "{not valid json!!!");
    const summary = importForgeAccountsFromPath(file);
    assert.ok(summary.error);
    assert.ok(summary.error!.includes("not valid JSON"));
    assert.equal(summary.imported, 0);
  } finally {
    cleanup();
  }
});

test("forge-import: invalid format version rejected", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "wrongformat.json",
      JSON.stringify({ format: "qwen-forge-accounts-v99", accounts: [] }),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.ok(summary.error);
    assert.ok(summary.error!.includes("unsupported format"));
    assert.equal(summary.imported, 0);
  } finally {
    cleanup();
  }
});

test("forge-import: missing email rejected", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "noemail.json",
      forgeJson([{ password: "pass", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 0);
    assert.equal(summary.invalid, 1);
    assert.ok(summary.rejected[0].reason.includes("missing email"));
  } finally {
    cleanup();
  }
});

test("forge-import: missing password rejected", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "nopass.json",
      forgeJson([{ email: "a@b.com", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 0);
    assert.equal(summary.invalid, 1);
    assert.ok(summary.rejected[0].reason.includes("missing password"));
  } finally {
    cleanup();
  }
});

test("forge-import: invalid status rejected", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "badstatus.json",
      forgeJson([{ email: "a@b.com", password: "x", status: "pending" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 0);
    assert.equal(summary.invalid, 1);
    assert.ok(summary.rejected[0].reason.includes("invalid status"));
  } finally {
    cleanup();
  }
});

test("forge-import: duplicate within same file", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "dup.json",
      forgeJson([
        { email: "dup@test.com", password: "p1", status: "ready" },
        { email: "dup@test.com", password: "p2", status: "ready" },
        { email: "DUP@TEST.COM", password: "p3", status: "ready" },
      ]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 1);
    assert.equal(summary.alreadyPresent, 2);
    assert.equal(summary.poolTotal, 1);
  } finally {
    cleanup();
  }
});

test("forge-import: existing DB account preserved", () => {
  freshDb();
  setup();
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(
      "existing-id",
      "existing@test.com",
      "encrypted-old",
    );
    invalidateAccountsCache();

    const file = writeFixture(
      "existing.json",
      forgeJson([{ email: "existing@test.com", password: "new-pass", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 0);
    assert.equal(summary.alreadyPresent, 1);
    assert.ok(summary.rejected[0].reason.includes("already present"));

    const row = db.prepare("SELECT password FROM accounts WHERE email = ?").get("existing@test.com") as { password: string };
    assert.equal(row.password, "encrypted-old");
  } finally {
    cleanup();
  }
});

test("forge-import: password containing colon", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "colon.json",
      forgeJson([{ email: "colon@test.com", password: "pass:with:colons", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 1);
    assert.equal(summary.error, undefined);
  } finally {
    cleanup();
  }
});

test("forge-import: unicode credentials", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "unicode.json",
      forgeJson([{ email: "user@tëst.com", password: "pässwörd_日本語", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 1);
    assert.equal(summary.error, undefined);
  } finally {
    cleanup();
  }
});

test("forge-import: transaction rollback on DB failure", () => {
  freshDb();
  setup();
  const db = getDatabase();
  try {
    const file = writeFixture(
      "rollback.json",
      forgeJson([
        { email: "rb1@test.com", password: "p1", status: "ready" },
        { email: "rb2@test.com", password: "p2", status: "ready" },
      ]),
    );
    db.prepare("DROP TABLE accounts").run();
    let summary: ReturnType<typeof importForgeAccountsFromPath>;
    try {
      summary = importForgeAccountsFromPath(file);
    } finally {
      db.exec(`CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')), cooldown_until INTEGER DEFAULT 0,
        cooldown_reason TEXT, disabled INTEGER DEFAULT 0)`);
    }
    assert.ok(summary!.error);
    assert.equal(summary!.imported, 0);
  } finally {
    cleanup();
  }
});

test("forge-import: cache invalidation — loadAccounts sees new accounts immediately", () => {
  freshDb();
  setup();
  try {
    assert.equal(loadAccounts().length, 0);
    const file = writeFixture(
      "cache.json",
      forgeJson([{ email: "cache@test.com", password: "p", status: "ready" }]),
    );
    importForgeAccountsFromPath(file);
    const accounts = loadAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, "cache@test.com");
  } finally {
    cleanup();
  }
});

test("forge-import: priority ordering preserves source order", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "priority.json",
      forgeJson([
        { email: "first@test.com", password: "p1", status: "ready" },
        { email: "second@test.com", password: "p2", status: "ready" },
        { email: "third@test.com", password: "p3", status: "ready" },
      ]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 3);

    const accounts = loadAccounts();
    const ordered = getAccountsByPriority(accounts);
    const emails = ordered.map((a) => a.email);
    assert.deepEqual(emails, ["first@test.com", "second@test.com", "third@test.com"]);
  } finally {
    cleanup();
  }
});

test("forge-import: health initialization for new accounts", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "health.json",
      forgeJson([{ email: "healthy@test.com", password: "p", status: "ready" }]),
    );
    const summary = importForgeAccountsFromPath(file);
    assert.equal(summary.imported, 1);

    const health = getAccountHealth(summary.importedIds[0]);
    assert.equal(health.healthScore, 100);
    assert.equal(health.successCount, 0);
    assert.equal(health.failureCount, 0);
    assert.equal(health.consecutiveFailures, 0);
  } finally {
    cleanup();
  }
});

test("forge-import: cooldown preservation for existing accounts", () => {
  freshDb();
  setup();
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(
      "cool-id",
      "cool@test.com",
      "enc",
    );
    invalidateAccountsCache();
    markAccountRateLimited("cool-id", 60_000);

    const file = writeFixture(
      "cooldown.json",
      forgeJson([{ email: "cool@test.com", password: "new", status: "ready" }]),
    );
    importForgeAccountsFromPath(file);

    const info = getAccountCooldownInfo("cool-id");
    assert.ok(info, "cooldown must be preserved after re-import attempt");
    clearAccountCooldown("cool-id");
  } finally {
    cleanup();
  }
});

test("forge-import: existing account health preservation", () => {
  freshDb();
  setup();
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(
      "health-id",
      "health@test.com",
      "enc",
    );
    db.prepare(
      "INSERT OR REPLACE INTO account_health (account_id, health_score, failure_count) VALUES (?, ?, ?)",
    ).run("health-id", 42, 7);
    invalidateAccountsCache();

    const file = writeFixture(
      "healthpres.json",
      forgeJson([{ email: "health@test.com", password: "x", status: "ready" }]),
    );
    importForgeAccountsFromPath(file);

    const health = getAccountHealth("health-id");
    assert.equal(health.healthScore, 42);
    assert.equal(health.failureCount, 7);
  } finally {
    cleanup();
  }
});

test("forge-import: summary never contains passwords", () => {
  freshDb();
  setup();
  try {
    const secretPass = "SuperSecret_P@ss_123!";
    const file = writeFixture(
      "leak.json",
      forgeJson([
        { email: "leak@test.com", password: secretPass, status: "ready" },
        { email: "", password: secretPass, status: "ready" },
      ]),
    );
    const summary = importForgeAccountsFromPath(file);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(secretPass), "password must never appear in summary");
    for (const r of summary.rejected) {
      assert.ok(!r.email.includes(secretPass));
      assert.ok(!r.reason.includes(secretPass));
    }
  } finally {
    cleanup();
  }
});

test("forge-import: imported accounts immediately visible without restart", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "live.json",
      forgeJson([
        { email: "live1@test.com", password: "p1", status: "ready" },
        { email: "live2@test.com", password: "p2", status: "ready" },
      ]),
    );
    importForgeAccountsFromPath(file);

    const accounts = loadAccounts();
    assert.equal(accounts.length, 2);
    assert.ok(accounts.some((a) => a.email === "live1@test.com"));
    assert.ok(accounts.some((a) => a.email === "live2@test.com"));

    const db = getDatabase();
    const row = db.prepare("SELECT password FROM accounts WHERE email = ?").get("live1@test.com") as { password: string };
    assert.ok(isEncrypted(row.password), "stored password must be encrypted");
  } finally {
    cleanup();
  }
});

test("forge-import: missing file returns error", () => {
  freshDb();
  const summary = importForgeAccountsFromPath("C:\\nonexistent\\path.json");
  assert.ok(summary.error);
  assert.ok(summary.error!.includes("cannot read file"));
  assert.equal(summary.imported, 0);
});

test("forge-import: stored credentials are encrypted", () => {
  freshDb();
  setup();
  try {
    const file = writeFixture(
      "encrypted.json",
      forgeJson([{ email: "enc@test.com", password: "plaintext-pass", status: "ready" }]),
    );
    importForgeAccountsFromPath(file);

    const db = getDatabase();
    const row = db.prepare("SELECT password FROM accounts WHERE email = ?").get("enc@test.com") as { password: string };
    assert.ok(isEncrypted(row.password));
    assert.notEqual(row.password, "plaintext-pass");
  } finally {
    cleanup();
  }
});
