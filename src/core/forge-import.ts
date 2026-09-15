/**
 * Bulk importer for the Qwen-Forge accounts export format.
 *
 * Feeds accounts into the EXISTING encrypted SQLite account store — it does
 * not create a second account database and does not bypass the existing
 * encryption, priority, health, cooldown or scheduler systems.
 *
 * Accepted schema (validated before anything is written):
 * {
 *   "format": "qwen-forge-accounts-v1",
 *   "generated_at": "...",           // optional, informational
 *   "accounts": [{ "email": "...", "password": "...", "status": "ready" }]
 * }
 *
 * Duplicate policy (deterministic): an email already present in the account
 * store is reported as "already present" and left COMPLETELY untouched — its
 * stored credential, health, cooldown, priority and disabled state are
 * preserved. The importer never silently replaces credentials; a future
 * credential-update mode must be an explicit, separate feature.
 *
 * Email is normalized (trim + lowercase) ONLY for duplicate comparison; the
 * original trimmed email is stored. Passwords are stored verbatim through the
 * existing AES-256-GCM encrypt() and are never logged or returned.
 *
 * The whole batch is written in a single SQLite transaction: if the database
 * write fails, the entire batch is rolled back (never half-imported).
 * Invalid individual records are rejected before the transaction and do not
 * block valid ones.
 *
 * The module itself never prints — the CLI (src/import-forge-accounts.ts)
 * renders the summary, so credential leakage through logs is structurally
 * limited to this file's error strings, which carry emails/reasons only.
 */

import fs from "fs";
import path from "path";
import { config } from "./config.ts";
import { getDatabase } from "./database.ts";
import { encrypt } from "./crypto-utils.ts";
import { generateAccountId, invalidateAccountsCache } from "./accounts.ts";
import { ensureAccountInPriority } from "./account-priority.ts";

export const FORGE_FORMAT_ID = "qwen-forge-accounts-v1";

/** Only accounts exported as "ready", "SUCCESS" or "ACTIVATION_FAILED" are imported; anything else is rejected. */
export const FORGE_ACCEPTED_STATUSES = new Set(["ready", "SUCCESS", "ACTIVATION_FAILED"]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 2048;

export interface ForgeImportRejected {
  /** Email when known, otherwise a positional label. Never a password. */
  email: string;
  reason: string;
}

export interface ForgeImportSummary {
  source: string;
  found: number;
  imported: number;
  alreadyPresent: number;
  invalid: number;
  poolTotal: number;
  importedIds: string[];
  rejected: ForgeImportRejected[];
  /** Present when the file/envelope is unusable or the DB batch rolled back. */
  error?: string;
}

/**
 * Resolve the export path for this invocation.
 * Precedence: explicit CLI path > QWEN_FORGE_ACCOUNTS_PATH env > centralized
 * default (config.forge.defaultAccountsPath). The env var is read live (not
 * via the static config snapshot) so operators and tests can override it
 * without restarting module evaluation.
 */
export function resolveForgeAccountsPath(explicit?: string | null): string {
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  const fromEnv = process.env.QWEN_FORGE_ACCOUNTS_PATH;
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  return config.forge.defaultAccountsPath;
}

type ParseResult =
  | { ok: true; accounts: unknown[] }
  | { ok: false; error: string };

function parseExport(raw: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // Generic message on purpose: never echo file content back.
    return { ok: false, error: "file is not valid JSON" };
  }
  // Accept bare array format (qwen-forge data/accounts.json style)
  if (Array.isArray(doc)) {
    return { ok: true, accounts: doc };
  }
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, error: "export root must be a JSON object or array" };
  }
  const obj = doc as Record<string, unknown>;
  if (obj.format !== FORGE_FORMAT_ID) {
    return {
      ok: false,
      error: `unsupported format "${String(obj.format ?? "")}" (expected "${FORGE_FORMAT_ID}")`,
    };
  }
  if (!Array.isArray(obj.accounts)) {
    return { ok: false, error: 'export is missing the "accounts" array' };
  }
  return { ok: true, accounts: obj.accounts };
}

type RecordValidation =
  | { ok: true; email: string; password: string }
  | { ok: false; email: string; reason: string };

function validateRecord(entry: unknown, index: number): RecordValidation {
  const positional = `<record ${index + 1}>`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { ok: false, email: positional, reason: "record is not an object" };
  }
  const rec = entry as Record<string, unknown>;
  const email = typeof rec.email === "string" ? rec.email.trim() : "";
  if (!email) {
    return { ok: false, email: positional, reason: "missing email" };
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return { ok: false, email, reason: "email too long" };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { ok: false, email, reason: "invalid email format" };
  }
  // Password is validated but NEVER trimmed or echoed — verbatim credential.
  if (typeof rec.password !== "string" || rec.password.length === 0) {
    return { ok: false, email, reason: "missing password" };
  }
  if (rec.password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, email, reason: "password too long" };
  }
  if (!FORGE_ACCEPTED_STATUSES.has(rec.status as string)) {
    return {
      ok: false,
      email,
      reason: `invalid status "${String(rec.status)}" (expected one of: ${[...FORGE_ACCEPTED_STATUSES].join(", ")})`,
    };
  }
  return { ok: true, email, password: rec.password };
}

function countAccounts(): number {
  try {
    const row = getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM accounts")
      .get() as { n: number };
    return Number(row.n);
  } catch {
    return 0;
  }
}

/**
 * Import a Qwen-Forge export file into the existing account store.
 * Synchronous by design (better-sqlite3): the whole batch lands in one
 * transaction and the summary is returned once it completes.
 */
export function importForgeAccountsFromPath(
  filePath: string,
): ForgeImportSummary {
  const source = path.resolve(filePath);
  const rejected: ForgeImportRejected[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(source, "utf-8");
  } catch (error) {
    // Message only — never the file contents.
    return {
      source,
      found: 0,
      imported: 0,
      alreadyPresent: 0,
      invalid: 0,
      poolTotal: countAccounts(),
      importedIds: [],
      rejected,
      error: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseExport(raw);
  if (!parsed.ok) {
    return {
      source,
      found: 0,
      imported: 0,
      alreadyPresent: 0,
      invalid: 0,
      poolTotal: countAccounts(),
      importedIds: [],
      rejected,
      error: parsed.error,
    };
  }

  const db = getDatabase();
  let existingEmails: Set<string>;
  try {
    existingEmails = new Set<string>(
      (
        db.prepare("SELECT email FROM accounts").all() as Array<{
          email: string;
        }>
      ).map((row) => row.email.trim().toLowerCase()),
    );
  } catch {
    return {
      source,
      found: 0,
      imported: 0,
      alreadyPresent: 0,
      invalid: 0,
      poolTotal: 0,
      importedIds: [],
      rejected,
      error: "database table unavailable — cannot read existing accounts",
    };
  }

  const toInsert: Array<{ id: string; email: string; password: string }> = [];
  const seenInFile = new Set<string>();
  let alreadyPresent = 0;
  let invalid = 0;

  for (let i = 0; i < parsed.accounts.length; i++) {
    const result = validateRecord(parsed.accounts[i], i);
    if (!result.ok) {
      invalid++;
      rejected.push({ email: result.email, reason: result.reason });
      continue;
    }
    const key = result.email.toLowerCase();
    if (seenInFile.has(key)) {
      alreadyPresent++;
      rejected.push({ email: result.email, reason: "duplicate within file" });
      continue;
    }
    seenInFile.add(key);
    if (existingEmails.has(key)) {
      alreadyPresent++;
      rejected.push({
        email: result.email,
        reason: "already present in account store",
      });
      continue;
    }
    toInsert.push({
      id: generateAccountId(result.email),
      email: result.email,
      password: result.password,
    });
  }

  let transactionError: string | undefined;
  if (toInsert.length > 0) {
    try {
      const insertAccount = db.prepare(
        "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
      );
      // Explicit fresh health row (score 100, zero counters) via column
      // defaults — imported accounts must not inherit stale failures.
      // INSERT OR IGNORE so an existing health record (from a prior import
      // that was later deleted from accounts but not health) is never
      // overwritten.
      const insertHealth = db.prepare(
        "INSERT OR IGNORE INTO account_health (account_id) VALUES (?)",
      );
      const apply = db.transaction(() => {
        for (const account of toInsert) {
          insertAccount.run(account.id, account.email, encrypt(account.password));
          insertHealth.run(account.id);
        }
      });
      apply();
    } catch (error) {
      transactionError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!transactionError && toInsert.length > 0) {
    // Source-file order is preserved: new accounts are appended to the
    // priority list in the order they appear in the export. Existing entries
    // are left untouched (ensureAccountInPriority is a no-op for them).
    for (const account of toInsert) {
      ensureAccountInPriority(account.id);
    }
    invalidateAccountsCache();
  }

  return {
    source,
    found: parsed.accounts.length,
    imported: transactionError ? 0 : toInsert.length,
    alreadyPresent,
    invalid,
    poolTotal: countAccounts(),
    importedIds: transactionError ? [] : toInsert.map((a) => a.id),
    rejected,
    error: transactionError
      ? `database transaction failed, batch rolled back: ${transactionError}`
      : undefined,
  };
}
