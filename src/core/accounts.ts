import "dotenv/config";
import crypto from "crypto";
import { getDatabase } from "./database.ts";
import { decrypt, encrypt } from "./crypto-utils.ts";

export interface QwenAccount {
  id: string;
  email: string;
  password: string;
  cooldown_until?: number;
  cooldown_reason?: string | null;
  disabled?: number;
}

/**
 * Deterministic account ID from the email (md5 formatted as a UUID). Shared
 * by the QWEN_ACCOUNTS env sync and the Qwen-Forge importer so the same email
 * always maps to the same account identity across imports/restarts.
 */
export function generateAccountId(email: string): string {
  return crypto
    .createHash("md5")
    .update(email)
    .digest("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

function parseEnvAccounts(): QwenAccount[] {
  const envAccounts = process.env.QWEN_ACCOUNTS;
  if (!envAccounts) return [];

  const separator = envAccounts.includes(";") ? ";" : ",";

  return envAccounts
    .split(separator)
    .map((entry, index) => {
      const trimmed = entry.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) {
        console.warn(
          `[Accounts] Invalid QWEN_ACCOUNTS entry at index ${index}: "${trimmed}"`,
        );
        return null;
      }
      const email = trimmed.substring(0, colonIdx);
      const password = trimmed.substring(colonIdx + 1);
      if (!email || !password) {
        console.warn(
          `[Accounts] Invalid QWEN_ACCOUNTS entry at index ${index}: "${trimmed}"`,
        );
        return null;
      }
      return {
        id: generateAccountId(email),
        email: email.trim(),
        password: password.trim(),
      };
    })
    .filter((a): a is QwenAccount => a !== null);
}

let lastSyncedEnv = "";
let lastSyncTime = 0;
const SYNC_INTERVAL = 30_000;

function syncEnvAccounts(): void {
  const envAccounts = process.env.QWEN_ACCOUNTS || "";
  const now = Date.now();
  if (envAccounts === lastSyncedEnv && now - lastSyncTime < SYNC_INTERVAL)
    return;

  lastSyncedEnv = envAccounts;
  lastSyncTime = now;

  const accounts = parseEnvAccounts();
  if (accounts.length === 0) return;

  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET password = excluded.password, updated_at = datetime('now')
  `);

  const sync = db.transaction(() => {
    for (const acc of accounts) {
      upsert.run(acc.id, acc.email, encrypt(acc.password));
    }
  });

  sync();
}

let accountsCache: QwenAccount[] | null = null;
let accountsCacheTime = 0;
const ACCOUNTS_CACHE_TTL = 5_000;

function getCachedAccounts(): QwenAccount[] {
  syncEnvAccounts();

  const now = Date.now();
  if (accountsCache && now - accountsCacheTime < ACCOUNTS_CACHE_TTL) {
    return accountsCache;
  }

  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT id, email, password, cooldown_until, cooldown_reason, disabled FROM accounts ORDER BY created_at ASC",
    )
    .all() as QwenAccount[];

  accountsCache = rows.flatMap((row) => {
    try {
      return [{ ...row, password: decrypt(row.password) }];
    } catch (err) {
      console.warn(
        `[Accounts] Skipping account ${row.email}: decryption failed (${(err as Error).message})`,
      );
      return [];
    }
  });
  accountsCacheTime = now;
  return accountsCache;
}

export function loadAccounts(): QwenAccount[] {
  return getCachedAccounts().map((account) => ({
    ...account,
    password: "***",
  }));
}

export function invalidateAccountsCache(): void {
  accountsCache = null;
  accountsCacheTime = 0;
}

export function addAccount(
  email: string,
  password: string,
  id?: string,
): QwenAccount {
  if (!email || typeof email !== "string" || email.trim().length === 0) {
    throw new Error("Email is required");
  }

  const db = getDatabase();

  const existing = db
    .prepare("SELECT id FROM accounts WHERE email = ?")
    .get(email.trim());
  if (existing) {
    throw new Error("Account with this email already exists");
  }

  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email: email.trim(),
    password,
  };

  db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)").run(
    newAccount.id,
    newAccount.email,
    encrypt(newAccount.password),
  );

  invalidateAccountsCache();
  return newAccount;
}

export function removeAccount(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  invalidateAccountsCache();
  return result.changes > 0;
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts();
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const cached = getCachedAccounts();
  return cached.find((a) => a.id === id);
}

export function updateAccountCooldown(
  id: string,
  cooldownUntil: number,
  reason: string | null,
): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE accounts SET cooldown_until = ?, cooldown_reason = ? WHERE id = ?",
  ).run(cooldownUntil, reason, id);
  invalidateAccountsCache();
}

/** Manual admin disable (DISABLED state). Never set automatically. */
export function setAccountDisabled(id: string, disabled: boolean): void {
  const db = getDatabase();
  db.prepare("UPDATE accounts SET disabled = ? WHERE id = ?").run(
    disabled ? 1 : 0,
    id,
  );
  invalidateAccountsCache();
}

export function isAccountDisabledRecord(
  account: Pick<QwenAccount, "disabled"> | undefined,
): boolean {
  return Boolean(account?.disabled);
}
