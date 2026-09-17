/**
 * Construct the single runtime container with all 9 components.
 * Handles crash recovery, account registration, readiness controller,
 * maintenance scheduler, and warmup via the bounded controller.
 */
import type { QwenRuntime, QwenAccount } from "../domain/types.ts";
import { config } from "../core/config.ts";
import { getQwenRuntime } from "./runtime.ts";
import { getAccountOwnership } from "./account/instance.ts";
import { startRuntimeServices } from "./bootstrap.ts";
import { prepareAccountRuntime } from "../services/qwen.ts";
import { loadAccounts, getAccountCredentials } from "../core/accounts.ts";
import { initPlaywrightForAccount } from "../services/playwright.ts";
import { disableNativeTools, warmQwenChatPool } from "../services/qwen.ts";

export async function constructRuntime(accounts: QwenAccount[]): Promise<{
  runtime: QwenRuntime;
  runtimeServices: { stop(): void; maintenance: { stop(): Promise<void> } };
}> {
  // 1. Durable runtime: versioned schema + crash recovery.
  // Runs BEFORE warmup so orphaned ownership from a previous process is fenced
  // before any account is declared ready. Fail fast on a schema problem.
  const { bootPersistence } = await import("../persistence/bootstrap.ts");
  const { recoverCrashedState } = await import("../persistence/recovery.ts");
  bootPersistence();
  const recovery = recoverCrashedState();
  if (recovery.abandonedGenerations > 0) {
    console.log(
      `🧹 [Server] Crash recovery: ${recovery.abandonedGenerations} abandoned generation(s), ${recovery.fencedLeases} fenced lease(s), ${recovery.recoveredAccounts} recovered account(s)`,
    );
  }

  // 2. Build the single runtime container with all 9 components.
  const runtime = getQwenRuntime();

  // 3. Register accounts with the ownership authority.
  const { getAccountOwnership, initAccountOwnership } = await import(
    "./account/instance.ts"
  );
  initAccountOwnership(
    accounts.map((a) => ({
      accountId: a.id,
      disabled: a.disabled ?? false,
      cooldownUntil: a.cooldown_until ?? 0,
      cooldownReason: a.cooldown_reason ?? null,
    })),
  );

  // 4. Start the readiness controller + maintenance scheduler.
  // These drive warmup/keepalive as maintenance clients.
  const { startRuntimeServices } = await import("./bootstrap.ts");
  const runtimeServices = startRuntimeServices({
    ownership: getAccountOwnership(),
    executors: {
      warmup: async (accountId: string) => {
        const { prepareAccountRuntime } = await import("../services/qwen.ts");
        const { getAccountCredentials } = await import("../core/accounts.ts");
        const { initPlaywrightForAccount } = await import(
          "../services/playwright.ts"
        );
        const { disableNativeTools, warmQwenChatPool } = await import(
          "../services/qwen.ts"
        );
        const account = (await loadAccounts()).find((a) => a.id === accountId);
        if (!account) return false;
        const ok = await prepareAccountRuntime(
          account,
          getAccountCredentials,
          initPlaywrightForAccount,
          disableNativeTools,
          warmQwenChatPool,
        );
        if (ok) {
          // Transition to READY via ownership authority
          const { getAccountOwnership } = await import(
            "./account/instance.ts"
          );
          const mgr = getAccountOwnership();
          mgr.transition(accountId, "READY", {
            leaseId: "system",
            ownerToken: "system",
          });
        }
        return ok;
      },
      keepAlive: async (accountId: string) => {
        const { validateAccountLogin } = await import("../services/playwright.ts");
        const creds = getAccountCredentials(accountId);
        if (!creds) return;
        await validateAccountLogin(creds, config.playwright.headless, config.playwright.browser);
      },
    },
  });

  return { runtime, runtimeServices };
}