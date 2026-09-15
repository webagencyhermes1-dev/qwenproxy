import "dotenv/config";
import {
  importForgeAccountsFromPath,
  resolveForgeAccountsPath,
} from "./core/forge-import.ts";

/**
 * Qwen-Forge bulk account importer CLI.
 *
 * Usage:
 *   npm run import:accounts                     (default Forge export path)
 *   npm run import:accounts -- "C:\path.json"   (explicit path)
 *
 * Precedence: explicit path > QWEN_FORGE_ACCOUNTS_PATH > built-in default.
 * Credentials are NEVER printed — the summary shows counts and emails only.
 */
function main(): void {
  const explicit = process.argv[2];
  const source = resolveForgeAccountsPath(explicit);

  console.log("QwenProxy Account Import");
  console.log(`Source: ${source}`);

  const summary = importForgeAccountsFromPath(source);

  if (summary.error) {
    console.error("");
    console.error(`Error: ${summary.error}`);
    process.exit(1);
  }

  console.log("");
  console.log(`Found: ${summary.found}`);
  console.log(`Imported: ${summary.imported}`);
  console.log(`Already present: ${summary.alreadyPresent}`);
  console.log(`Invalid: ${summary.invalid}`);
  console.log(`Pool total: ${summary.poolTotal}`);

  if (summary.rejected.length > 0) {
    console.log("");
    console.log("Rejected records:");
    for (const entry of summary.rejected) {
      console.log(`  - ${entry.email}: ${entry.reason}`);
    }
  }
}

main();
