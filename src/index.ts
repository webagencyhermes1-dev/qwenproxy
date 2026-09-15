process.env.DOTENV_CONFIG_QUIET = 'true'
import dotenv from 'dotenv'
import fs from 'node:fs'
import { getEnvFilePath, ensureDataDirs } from './core/paths.ts'

// Ensure persistent user data directory exists
ensureDataDirs()

// Load .env from local directory or persistent global OS directory
const envPath = getEnvFilePath()
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true })
} else {
  dotenv.config({ quiet: true })
}
// Prevent benign asynchronous driver/browser teardown exceptions from crashing the server
process.on('uncaughtException', async (error: unknown) => {
  const { isPlaywrightAlreadyClosedError } = await import('./services/playwright.ts');
  if (isPlaywrightAlreadyClosedError(error)) {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as any).message)
          : String(error);
    console.warn(`⚠️  [Playwright] Handled benign driver teardown exception: ${msg}`);
    return;
  }
  console.error('❌ [Process] Uncaught Exception:', error);
});

process.on('unhandledRejection', async (reason: unknown) => {
  const { isPlaywrightAlreadyClosedError } = await import('./services/playwright.ts');
  if (isPlaywrightAlreadyClosedError(reason)) {
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'object' && reason !== null && 'message' in reason
          ? String((reason as any).message)
          : String(reason);
    console.warn(`⚠️  [Playwright] Handled benign driver teardown rejection: ${msg}`);
    return;
  }
  console.error('❌ [Process] Unhandled Rejection:', reason);
});
import { startServer } from './api/server.js'
const isTui = process.argv.includes('--tui') || process.env.QWEN_TUI === 'true'

// Auto-import Qwen-Forge accounts on startup (non-fatal if file is absent).
async function autoImportForgeAccounts(): Promise<void> {
  try {
    const { resolveForgeAccountsPath, importForgeAccountsFromPath } = await import('./core/forge-import.ts');
    const forgePath = resolveForgeAccountsPath();
    if (!fs.existsSync(forgePath)) return;
    const summary = importForgeAccountsFromPath(forgePath);
    if (summary.error) {
      console.warn(`⚠️  [ForgeImport] ${summary.error}`);
      return;
    }
    if (summary.imported > 0 || summary.alreadyPresent > 0) {
      console.log(
        `📥 [ForgeImport] found=${summary.found} imported=${summary.imported} already_present=${summary.alreadyPresent} invalid=${summary.invalid} pool_total=${summary.poolTotal}`,
      );
    }
  } catch (error) {
    console.warn(
      `⚠️  [ForgeImport] skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (isTui) {
  await autoImportForgeAccounts()
  const { TuiApp } = await import('./tui/app.ts')
  const app = new TuiApp()
  await app.start()
} else {
  await autoImportForgeAccounts()
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // Expected configuration errors are already formatted with an emoji and
    // actionable guidance; print only the message to avoid leaking stack traces.
    if (message.includes('No Qwen accounts configured')) {
      console.error(message)
      console.log('\n👉 Dica: Execute a interface interativa com "qpx" (ou "npm run tui") para gerenciar contas,')
      console.log('   ou configure a variável QWEN_ACCOUNTS no seu arquivo .env.\n')
    } else if (message.includes('[Server]')) {
      console.error(message)
    } else {
      console.error('❌ [Server] Failed to start:', message)
    }
    process.exit(1)
  })
}
