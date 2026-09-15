import "dotenv/config";
import { loadAccounts, setAccountDisabled } from "./core/accounts.ts";
import { config } from "./core/config.ts";
import { maskEmail } from "./core/logger.ts";
import {
  initPlaywrightForAccount,
  closePlaywrightForAccount,
} from "./services/playwright.ts";

/**
 * Bulk account validation with progressive readiness.
 *
 * Gets the FIRST valid account ready immediately (so the API can start
 * serving), then validates remaining accounts in parallel in the background.
 *
 * Usage:
 *   npx tsx src/validate-accounts.ts [options]
 *
 * Options:
 *   --remove         Permanently delete failed accounts (default: disable only)
 *   --concurrency N  Max parallel browser contexts for background validation (default: 2, max: 4)
 *   --serve-first    Get first account ready immediately, validate rest in background (default)
 *   --all-first      Wait for ALL accounts before reporting (legacy behavior)
 */

interface ValidationResult {
  accountId: string;
  email: string;
  success: boolean;
  reason?: string;
}

async function validateAccount(
  accountId: string,
  email: string,
  password: string,
): Promise<ValidationResult> {
  try {
    await initPlaywrightForAccount(
      { id: accountId, email, password },
      true,
      config.playwright.browser,
    );
    await closePlaywrightForAccount(accountId).catch(() => {});
    return { accountId, email, success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closePlaywrightForAccount(accountId).catch(() => {});
    return { accountId, email, success: false, reason: message };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const removeMode = args.includes("--remove");
  const allFirst = args.includes("--all-first");
  const concurrencyIdx = args.indexOf("--concurrency");
  const concurrency = concurrencyIdx !== -1
    ? Math.min(4, Math.max(1, parseInt(args[concurrencyIdx + 1]) || 2))
    : 2;

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    return;
  }

  console.log(`🔍 [Validate] ${accounts.length} account(s) | concurrency=${concurrency} | mode=${allFirst ? "all-first" : "serve-first"}`);
  console.log(`   Failure action: ${removeMode ? "REMOVE" : "DISABLE"}`);
  console.log("");

  const results: ValidationResult[] = [];

  if (allFirst) {
    // Legacy: validate all, then report
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < accounts.length) {
        const current = idx++;
        const account = accounts[current];
        console.log(`  [${current + 1}/${accounts.length}] Testing ${maskEmail(account.email)}...`);
        const result = await validateAccount(account.id, account.email, account.password);
        results.push(result);
        if (result.success) {
          console.log(`  ✅ ${maskEmail(account.email)} — OK`);
        } else {
          console.log(`  ❌ ${maskEmail(account.email)} — FAILED: ${result.reason?.slice(0, 120)}`);
        }
      }
    }
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
  } else {
    // Serve-first: get ONE account ready immediately, then validate rest in background
    console.log("  ⚡ Phase 1: Getting first account ready...");
    let firstReady = false;

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      console.log(`  [${i + 1}/${accounts.length}] Testing ${maskEmail(account.email)}...`);
      const result = await validateAccount(account.id, account.email, account.password);
      results.push(result);

      if (result.success) {
        console.log(`  ✅ ${maskEmail(account.email)} — READY (API can serve now)`);
        firstReady = true;
        break;
      } else {
        console.log(`  ❌ ${maskEmail(account.email)} — FAILED: ${result.reason?.slice(0, 80)}`);
      }
    }

    if (!firstReady) {
      console.log("\n  ⚠️  No account could be made ready. All failed.");
    } else {
      console.log(`\n  🚀 Phase 2: Validating ${accounts.length - results.length} remaining account(s) in background...`);
    }

    // Validate remaining accounts concurrently
    const remaining = accounts.filter((a) => !results.some((r) => r.accountId === a.id));
    let idx = 0;
    async function bgWorker(): Promise<void> {
      while (idx < remaining.length) {
        const current = idx++;
        const account = remaining[current];
        const result = await validateAccount(account.id, account.email, account.password);
        results.push(result);
        if (result.success) {
          console.log(`  ✅ ${maskEmail(account.email)} — validated`);
        } else {
          console.log(`  ❌ ${maskEmail(account.email)} — FAILED: ${result.reason?.slice(0, 80)}`);
        }
      }
    }
    const workers = Array.from({ length: concurrency }, () => bgWorker());
    await Promise.all(workers);
  }

  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log(`  ✅ Passed: ${passed.length}`);
  console.log(`  ❌ Failed: ${failed.length}`);
  console.log("═══════════════════════════════════════════");

  if (failed.length > 0) {
    console.log("");
    console.log("Failed accounts:");
    for (const f of failed) {
      console.log(`  - ${maskEmail(f.email)}: ${f.reason?.slice(0, 100)}`);
      if (removeMode) {
        const { removeAccount } = await import("./core/accounts.ts");
        removeAccount(f.accountId);
        console.log(`    🗑️  Removed from database`);
      } else {
        setAccountDisabled(f.accountId, true);
        console.log(`    🚫 Disabled`);
      }
    }
  }

  if (failed.length === 0) {
    console.log("\n  All accounts are valid! 🎉");
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
