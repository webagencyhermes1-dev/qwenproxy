import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { getDatabase } from "./core/database.ts";
import { encrypt } from "./core/crypto-utils.ts";
import { invalidateAccountsCache } from "./core/accounts.ts";

function generateId(email: string): string {
  return crypto
    .createHash("md5")
    .update(email)
    .digest("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

function usage(): never {
  console.error("Usage: npx tsx src/import-accounts.ts <accounts-file>");
  console.error("");
  console.error("File format: one account per line");
  console.error("  email:password");
  console.error("Blank lines and lines starting with '#' are ignored.");
  console.error("");
  console.error("Accounts are upserted (existing emails get their password");
  console.error("updated) and go live within ~5 seconds without a restart.");
  process.exit(1);
}

function main(): void {
  const file = process.argv[2];
  if (!file) usage();

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`[import] File not found: ${resolved}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(resolved, "utf-8").split(/\r?\n/);
  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password = excluded.password,
      updated_at = datetime('now')
  `);

  let imported = 0;
  let skipped = 0;

  const apply = db.transaction(() => {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const idx = line.indexOf(":");
      if (idx === -1) {
        console.warn(`[import] Skipping malformed line (no ':'): "${line}"`);
        skipped++;
        continue;
      }
      const email = line.substring(0, idx).trim();
      const password = line.substring(idx + 1).trim();
      if (!email || !password) {
        console.warn(`[import] Skipping empty email/password: "${line}"`);
        skipped++;
        continue;
      }
      if (password.includes(";")) {
        console.warn(
          `[import] Warning: password for ${email} contains ';' (only matters for QWEN_ACCOUNTS env, safe here)`,
        );
      }
      upsert.run(generateId(email), email, encrypt(password));
      imported++;
    }
  });

  apply();
  invalidateAccountsCache();

  console.log(
    `[import] Done. Upserted: ${imported} | skipped: ${skipped} | file: ${resolved}`,
  );
}

main();
