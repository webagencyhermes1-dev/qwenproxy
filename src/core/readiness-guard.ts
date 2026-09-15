/**
 * Readiness guard: ensures the pool always has enough ready accounts.
 *
 * Target state:
 *   - At least MIN_READY (2) accounts READY (headers captured, no cooldown).
 *   - One additional account WARMING (browser initialized, headers pending).
 *
 * Triggered whenever an account enters cooldown (quota, WAF, auth) and on a
 * periodic sweep. Runs asynchronously; never blocks request handling.
 */

import { config } from "./config.ts";
import {
  getAccountCooldownInfo,
  isAccountHeadersReady,
  markAccountHeadersReady,
} from "./account-manager.ts";
import {
  isAccountEffectivelyBroken,
  isAccountFlaggedAuthError,
} from "./account-state.ts";
import { isAccountDisabledRecord, loadAccounts, type QwenAccount } from "./accounts.ts";
import { getAccountsByPriority } from "./account-priority.ts";
import { hasActiveAccountLease } from "./account-concurrency.ts";

const MIN_READY = 2;
const MIN_WARMING = 1;
/** Only warm one account at a time to avoid browser resource contention. */
const MAX_CONCURRENT_WARMING = 1;

/**
 * How many sweep buckets recovered-account validation is spread across. When a
 * whole batch of accounts clears cooldown in the same sweep, validating them
 * all at once forks N Chromium processes back-to-back — the same crash cascade
 * the init slot (Loop 3) was added for. Each sweep validates only the bucket
 * matching the sweep counter, so a batch is re-warmed over `buckets` sweeps.
 */
const VALIDATION_BUCKETS = 3;

/** Accounts currently being warmed by the guard (prevents double-init). */
const warmingInProgress = new Set<string>();

/** True while a pool check is running; bursts of triggers coalesce into one. */
let poolCheckInFlight = false;
/** A trigger arrived while a check was running — run one trailing re-check. */
let pendingRecheck = false;
/** Deterministic per-account delay bucket (test hook for the sweep spread). */
export function recoveredValidationBucket(
  accountId: string,
  buckets = VALIDATION_BUCKETS,
): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash * 31 + accountId.charCodeAt(i)) >>> 0;
  }
  return hash % buckets;
}

let guardDeps: {
  getAccountCredentials: (id: string) => QwenAccount | undefined;
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (accountId: string | undefined, modelId: string) => Promise<void>;
} | null = null;

/** Called once at server startup to inject runtime dependencies. */
export function registerReadinessGuardDeps(deps: {
  getAccountCredentials: (id: string) => QwenAccount | undefined;
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (accountId: string | undefined, modelId: string) => Promise<void>;
}): void {
  guardDeps = deps;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function isEligible(account: QwenAccount): boolean {
  return (
    !isAccountDisabledRecord(account) &&
    !isAccountEffectivelyBroken(account.id) &&
    !isAccountFlaggedAuthError(account.id) &&
    !getAccountCooldownInfo(account.id)
  );
}

function getReadyAccounts(): QwenAccount[] {
  return loadAccounts()
    .filter((a) => isEligible(a) && isAccountHeadersReady(a.id));
}

function getWarmingAccounts(): QwenAccount[] {
  return loadAccounts()
    .filter((a) => isEligible(a) && !isAccountHeadersReady(a.id) && warmingInProgress.has(a.id));
}

function getStandbyAccounts(): QwenAccount[] {
  const accounts = loadAccounts();
  const prioritized = getAccountsByPriority(accounts);
  return prioritized.filter(
    (a) =>
      isEligible(a) &&
      !isAccountHeadersReady(a.id) &&
      !warmingInProgress.has(a.id),
  );
}

async function warmAccount(account: QwenAccount): Promise<boolean> {
  if (!guardDeps) return false;
  // Already being warmed by another caller (pool check OR recovered-account
  // validation). Without this guard two async callers can both pass the
  // getStandbyAccounts/validation filter before either awaits, then each run
  // the FULL init for the same account — a double Chromium boot (Loop 3 herd).
  if (warmingInProgress.has(account.id)) {
    console.log(
      `🪶 [ReadinessGuard] Skipping warmup for ${maskEmail(account.email)} (${account.id}) — already warming`,
    );
    return false;
  }
  // Never warm an account that is actively serving a request — initializing
  // Playwright for a busy account could interfere with the browser context.
  if (hasActiveAccountLease(account.id)) {
    console.log(
      `🪶 [ReadinessGuard] Skipping warmup for ${maskEmail(account.email)} (${account.id}) — active lease`,
    );
    return false;
  }
  warmingInProgress.add(account.id);
  try {
    const creds = guardDeps.getAccountCredentials(account.id);
    if (!creds) return false;

    const { isPlaywrightInitialized } = await import("../services/playwright.ts");
    if (!isPlaywrightInitialized(account.id)) {
      await guardDeps.initPlaywrightForAccount(
        creds,
        config.playwright.headless,
        config.playwright.browser,
      );
    }

    await guardDeps.disableNativeTools(account.id);

    for (const modelId of config.qwen.chatPoolModels) {
      await guardDeps.warmQwenChatPool(account.id, modelId);
    }

    markAccountHeadersReady(account.id);
    console.log(
      `🪶 [ReadinessGuard] Account ready: ${maskEmail(account.email)} (${account.id})`,
    );
    return true;
  } catch (error) {
    console.warn(
      `⚠️  [ReadinessGuard] Warmup failed for ${maskEmail(account.email)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    warmingInProgress.delete(account.id);
  }
}

/**
 * One pool-warm pass: compute the ready/warming/standby deltas and warm the
 * next standby account sequentially. Separate from the exported guard so the
 * thundering-herd coalescing lives in ensurePoolReadiness below.
 */
async function runPoolCheck(): Promise<void> {
  const ready = getReadyAccounts();
  const warming = getWarmingAccounts();
  const standby = getStandbyAccounts();

  const needReady = Math.max(0, MIN_READY - ready.length);
  const needWarming = Math.max(0, MIN_WARMING - warming.length);
  const totalNeeded = Math.min(needReady + needWarming, standby.length);

  if (totalNeeded === 0) return;

  const toWarm = standby.slice(0, totalNeeded);
  console.log(
    `🪶 [ReadinessGuard] Pool check: ${ready.length} ready, ${warming.length} warming, ${standby.length} standby → warming ${toWarm.length}`,
  );

  // Warm accounts sequentially to avoid browser resource contention.
  // Only warm up to MAX_CONCURRENT_WARMING at a time.
  for (const account of toWarm.slice(0, MAX_CONCURRENT_WARMING)) {
    await warmAccount(account);
  }
}

/**
 * Check the pool and warm accounts to maintain the target:
 * MIN_READY ready + MIN_WARMING warming.
 * Called after any cooldown and periodically.
 *
 * Thundering-herd guard: many accounts can enter a long cooldown in the same
 * burst (a WAF challenge sweeping all lanes), firing this once per account.
 * Running N parallel selection+warm loops would double-init the same standby
 * and fork N Chromium processes at once. The first caller runs the check;
 * every concurrent trigger coalesces into a single trailing re-check.
 */
export async function ensurePoolReadiness(): Promise<void> {
  if (!guardDeps) return;
  if (poolCheckInFlight) {
    pendingRecheck = true;
    return;
  }
  poolCheckInFlight = true;
  try {
    do {
      pendingRecheck = false;
      await runPoolCheck();
    } while (pendingRecheck);
  } finally {
    poolCheckInFlight = false;
  }
}

/** Fire-and-forget trigger, safe to call from hot paths. */
export function triggerReadinessCheck(): void {
  void ensurePoolReadiness().catch(() => {});
}

/**
 * Validate accounts whose cooldown recently expired. An account returning from
 * a long cooldown may have stale headers or a dead browser context. Re-warm it
 * before it receives traffic. Called by the periodic sweep.
 */
async function validateRecoveredAccounts(): Promise<void> {
  if (!guardDeps) return;
  // Spread validation across sweeps so a whole batch that cleared cooldown at
  // once (shared QWEN_ACCOUNTS expiry, mass rate-limit clearing) is re-warmed
  // over VALIDATION_BUCKETS sweeps instead of N back-to-back Chromium inits.
  const sweepBucket =
    Math.floor(Date.now() / SWEEP_INTERVAL_MS) % VALIDATION_BUCKETS;
  const accounts = loadAccounts();
  for (const account of accounts) {
    // Skip accounts that are still on cooldown, disabled, broken, or auth-failed.
    if (!isEligible(account)) continue;
    // Skip accounts that are already ready or being warmed.
    if (isAccountHeadersReady(account.id)) continue;
    if (warmingInProgress.has(account.id)) continue;
    // Skip accounts with active leases.
    if (hasActiveAccountLease(account.id)) continue;
    // Not this sweep's bucket — the account's re-validation is deferred so
    // batches thin out instead of stampeding.
    if (recoveredValidationBucket(account.id) !== sweepBucket) continue;
    // This account is eligible but not ready — it may have just returned from
    // cooldown. Warm it so it can receive traffic.
    console.log(
      `🪶 [ReadinessGuard] Validating recovered account: ${maskEmail(account.email)} (${account.id})`,
    );
    await warmAccount(account);
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
const SWEEP_INTERVAL_MS = 60_000;

/** Start the periodic sweep. Called once at server startup. */
export function startReadinessGuardSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void ensurePoolReadiness().catch(() => {});
    // Also validate accounts returning from cooldown.
    void validateRecoveredAccounts().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }
}

export function stopReadinessGuardSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
