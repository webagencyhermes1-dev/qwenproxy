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
import type { AccountStatus } from "../domain/types.ts";
import type { IAccountOwnership } from "../runtime/contracts.ts";
import type { ReadinessController, TickReport } from "../runtime/readiness/readiness-controller.ts";
import type { MaintenanceScheduler } from "../runtime/maintenance/maintenance-scheduler.ts";
import type { EventRecorder } from "../runtime/observability/event-recorder.ts";

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

/**
 * Feature flag (spec §14): when "true" the guard stops acting as a competing
 * account authority and becomes a maintenance CLIENT of the bounded
 * ReadinessController / MaintenanceScheduler built in runtime/bootstrap.ts.
 * Default "false" preserves the legacy behavior exactly.
 */
export const READINESS_CONTROLLER_FLAG = "QWEN_READINESS_CONTROLLER";

export function isReadinessControllerEnabled(): boolean {
  return process.env[READINESS_CONTROLLER_FLAG] === "true";
}

/** Dedupe key under which exactly one warmup job per account may be outstanding. */
export const WARMUP_DEDUPE_PREFIX = "warmup:";

export function warmupDedupeKey(accountId: string): string {
  return `${WARMUP_DEDUPE_PREFIX}${accountId}`;
}

/** Ownership statuses that mean user traffic currently owns the browser context. */
const GENERATING_STATUSES: ReadonlySet<AccountStatus> = new Set([
  "GENERATING",
  "RESERVED",
]);

/** Ownership statuses that mean an initializer is already running. */
const INITIALIZING_STATUSES: ReadonlySet<AccountStatus> = new Set([
  "WARMING",
  "RECOVERING",
]);

/**
 * The bounded controller + scheduler the guard delegates to when the flag is
 * on. Registered by startRuntimeServices (runtime/bootstrap.ts); while null,
 * the guard keeps its legacy standalone behavior.
 */
export interface ReadinessControllerClients {
  readonly ownership: IAccountOwnership;
  readonly scheduler: MaintenanceScheduler;
  readonly controller: ReadinessController;
  readonly events?: EventRecorder;
}

let controllerClients: ReadinessControllerClients | null = null;

export function registerReadinessControllerClients(
  clients: ReadinessControllerClients,
): void {
  controllerClients = clients;
}

/** Test hook: detach the controller so the guard falls back to legacy behavior. */
export function resetReadinessControllerClientsForTests(): void {
  controllerClients = null;
}

function ownershipAccountStatus(accountId: string): AccountStatus | undefined {
  return controllerClients?.ownership.getAccountStatus(accountId);
}

/** True when the ownership authority says an initializer already owns the account. */
function isInitializingElsewhere(accountId: string): boolean {
  const status = ownershipAccountStatus(accountId);
  return status !== undefined && INITIALIZING_STATUSES.has(status);
}

/** True when the ownership authority says user traffic owns the account. */
function isGeneratingOrReserved(accountId: string): boolean {
  const status = ownershipAccountStatus(accountId);
  return status !== undefined && GENERATING_STATUSES.has(status);
}

/** Accounts currently being warmed by the guard (prevents double-init). */
const warmingInProgress = new Set<string>();

/**
 * Recovery/readiness observability (Loop 8). Counters prove that the
 * thundering-herd coalescing (Loop 6), the bucket-spread validation sweeps
 * (Loop 6) and the warmup guards are actually engaging in production, and
 * drive /health/recovery.
 */
export interface ReadinessDiagnostics {
  poolChecksRun: number;
  coalescedTriggers: number;
  accountsWarmed: number;
  warmSkippedAlreadyWarming: number;
  warmSkippedActiveLease: number;
  warmupFailures: number;
  validationSweepsRun: number;
  accountsRevalidated: number;
  accountsWarming: number;
  readyAccounts: number;
  standbyAccounts: number;
  lastPoolCheckAt: number | null;
  lastValidationSweepAt: number | null;
}

let poolChecksRun = 0;
let coalescedTriggers = 0;
let accountsWarmed = 0;
let warmSkippedAlreadyWarming = 0;
let warmSkippedActiveLease = 0;
let warmupFailures = 0;
let validationSweepsRun = 0;
let accountsRevalidated = 0;
let lastPoolCheckAt: number | null = null;
let lastValidationSweepAt: number | null = null;

/** Snapshot of the guard's counters for /health/recovery and tests. */
export function getReadinessDiagnostics(): ReadinessDiagnostics {
  if (isReadinessControllerEnabled() && controllerClients) {
    // The controller is the authority; report its outstanding work rather than
    // the guard's legacy local sets (which stay empty in client mode).
    const warming = controllerClients.scheduler
      .getInflight()
      .filter((job) => job.kind === "WARM_ACCOUNT" && job.status !== "dead")
      .length;
    const snapshot = controllerClients.ownership.getPoolSnapshot();
    return {
      poolChecksRun,
      coalescedTriggers,
      accountsWarmed,
      warmSkippedAlreadyWarming,
      warmSkippedActiveLease,
      warmupFailures,
      validationSweepsRun,
      accountsRevalidated,
      accountsWarming: warming,
      readyAccounts: snapshot.ready,
      standbyAccounts: controllerClients.ownership.listAccountsByStatus("STANDBY")
        .length,
      lastPoolCheckAt,
      lastValidationSweepAt,
    };
  }
  return {
    poolChecksRun,
    coalescedTriggers,
    accountsWarmed,
    warmSkippedAlreadyWarming,
    warmSkippedActiveLease,
    warmupFailures,
    validationSweepsRun,
    accountsRevalidated,
    accountsWarming: warmingInProgress.size,
    readyAccounts: getReadyAccounts().length,
    standbyAccounts: getStandbyAccounts().length,
    lastPoolCheckAt,
    lastValidationSweepAt,
  };
}

/** Test hook: zero the counters (live warming set is untouched). */
export function resetReadinessCountersForTests(): void {
  poolChecksRun = 0;
  coalescedTriggers = 0;
  accountsWarmed = 0;
  warmSkippedAlreadyWarming = 0;
  warmSkippedActiveLease = 0;
  warmupFailures = 0;
  validationSweepsRun = 0;
  accountsRevalidated = 0;
  lastPoolCheckAt = null;
  lastValidationSweepAt = null;
}

/** Test hook: run one recovered-account validation sweep synchronously. */
export async function runReadinessValidationForTests(): Promise<void> {
  await validateRecoveredAccounts();
}

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

/**
 * The shared init sequence (browser + tools + chat pool + headers). Bounded by
 * the caller: the legacy guard calls it inline, the controller-flagged path
 * only ever reaches it as a MaintenanceScheduler WARM_ACCOUNT job.
 */
async function runWarmupSteps(account: QwenAccount): Promise<boolean> {
  const deps = guardDeps;
  if (!deps) return false;
  warmingInProgress.add(account.id);
  const startedAt = Date.now();
  controllerClients?.events?.record("WARMUP_STARTED", { accountId: account.id });
  try {
    const creds = deps.getAccountCredentials(account.id);
    if (!creds) return false;

    const { isPlaywrightInitialized } = await import("../services/playwright.ts");
    if (!isPlaywrightInitialized(account.id)) {
      await deps.initPlaywrightForAccount(
        creds,
        config.playwright.headless,
        config.playwright.browser,
      );
    }

    await deps.disableNativeTools(account.id);

    for (const modelId of config.qwen.chatPoolModels) {
      await deps.warmQwenChatPool(account.id, modelId);
    }

    markAccountHeadersReady(account.id);
    accountsWarmed++;
    controllerClients?.events?.record(
      "WARMUP_COMPLETED",
      { accountId: account.id },
      { durationMs: Date.now() - startedAt },
    );
    console.log(
      `🪶 [ReadinessGuard] Account ready: ${maskEmail(account.email)} (${account.id})`,
    );
    return true;
  } catch (error) {
    warmupFailures++;
    controllerClients?.events?.record(
      "WARMUP_FAILED",
      { accountId: account.id },
      {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "Error",
      },
    );
    console.warn(
      `⚠️  [ReadinessGuard] Warmup failed for ${maskEmail(account.email)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    warmingInProgress.delete(account.id);
  }
}

/**
 * Execute one WARM_ACCOUNT maintenance job (spec §14). The guard is a CLIENT
 * here: it re-checks the ownership authority immediately before mutating, so an
 * account that became GENERATING between submit and execute is skipped, and a
 * second initializer never starts while the account is WARMING/RECOVERING.
 */
export async function performAccountWarmup(
  accountId: string,
): Promise<boolean> {
  if (!guardDeps) return false;
  if (isGeneratingOrReserved(accountId)) {
    console.log(
      `🪶 [ReadinessGuard] Skipping warmup job for ${accountId} — account is generating/reserved`,
    );
    warmSkippedActiveLease++;
    return false;
  }
  if (isInitializingElsewhere(accountId)) {
    console.log(
      `🪶 [ReadinessGuard] Skipping warmup job for ${accountId} — already warming/recovering`,
    );
    warmSkippedAlreadyWarming++;
    return false;
  }
  if (hasActiveAccountLease(accountId)) {
    console.log(
      `🪶 [ReadinessGuard] Skipping warmup job for ${accountId} — active lease`,
    );
    warmSkippedActiveLease++;
    return false;
  }
  const account = loadAccounts().find((a) => a.id === accountId);
  if (!account || !isEligible(account)) return false;
  return runWarmupSteps(account);
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
    warmSkippedAlreadyWarming++;
    return false;
  }
  // Never warm an account that is actively serving a request — initializing
  // Playwright for a busy account could interfere with the browser context.
  if (hasActiveAccountLease(account.id)) {
    console.log(
      `🪶 [ReadinessGuard] Skipping warmup for ${maskEmail(account.email)} (${account.id}) — active lease`,
    );
    warmSkippedActiveLease++;
    return false;
  }
  return runWarmupSteps(account);
}

/**
 * One pool-warm pass: compute the ready/warming/standby deltas and warm the
 * next standby account sequentially. Separate from the exported guard so the
 * thundering-herd coalescing lives in ensurePoolReadiness below.
 */
async function runPoolCheck(): Promise<void> {
  poolChecksRun++;
  lastPoolCheckAt = Date.now();
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
export async function ensurePoolReadiness(): Promise<TickReport | void> {
  if (isReadinessControllerEnabled() && controllerClients) {
    // Client mode (spec §14): the bounded controller owns the deficit math and
    // launches warmups through the scheduler's dedupe table. The guard no
    // longer selects standby accounts itself, and needs no deps of its own.
    poolChecksRun++;
    lastPoolCheckAt = Date.now();
    return controllerClients.controller.tick();
  }
  if (!guardDeps) return;
  if (poolCheckInFlight) {
    coalescedTriggers++;
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
  if (isReadinessControllerEnabled() && controllerClients) {
    void controllerClients.controller.tick().catch(() => {});
    return;
  }
  void ensurePoolReadiness().catch(() => {});
}

/**
 * Validate accounts whose cooldown recently expired. An account returning from
 * a long cooldown may have stale headers or a dead browser context. Re-warm it
 * before it receives traffic. Called by the periodic sweep.
 */
async function validateRecoveredAccounts(): Promise<void> {
  const clientMode = isReadinessControllerEnabled() && controllerClients !== null;
  if (!clientMode && !guardDeps) return;
  validationSweepsRun++;
  lastValidationSweepAt = Date.now();
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
    if (clientMode) {
      // Client mode: submit a bounded job instead of warming inline. The
      // scheduler dedupe (warmup:<id>) and the controller's in-flight tracking
      // allow exactly one initializer per account; the executor re-checks the
      // ownership authority before mutating.
      if (isGeneratingOrReserved(account.id)) continue;
      if (isInitializingElsewhere(account.id)) continue;
      const submitted = controllerClients!.scheduler.submit({
        kind: "WARM_ACCOUNT",
        accountId: account.id,
        dedupeKey: warmupDedupeKey(account.id),
      });
      if (submitted.accepted) {
        console.log(
          `🪶 [ReadinessGuard] Queued recovered account: ${maskEmail(account.email)} (${account.id})`,
        );
        accountsRevalidated++;
      }
      continue;
    }
    // This account is eligible but not ready — it may have just returned from
    // cooldown. Warm it so it can receive traffic.
    console.log(
      `🪶 [ReadinessGuard] Validating recovered account: ${maskEmail(account.email)} (${account.id})`,
    );
    if (await warmAccount(account)) {
      accountsRevalidated++;
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
const SWEEP_INTERVAL_MS = 60_000;

/** Start the periodic sweep. Called once at server startup. */
export function startReadinessGuardSweep(): void {
  if (sweepTimer) return;
  if (isReadinessControllerEnabled() && controllerClients) {
    // Client mode: the bounded controller owns the pool-check interval; this
    // sweep keeps only its recovered-account pass, which now queues bounded
    // WARM_ACCOUNT jobs instead of warming inline.
    controllerClients.controller.start();
    sweepTimer = setInterval(() => {
      void validateRecoveredAccounts().catch(() => {});
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
    return;
  }
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
  if (isReadinessControllerEnabled() && controllerClients) {
    controllerClients.controller.stop();
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
