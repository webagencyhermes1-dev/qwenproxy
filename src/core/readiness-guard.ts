import { loadAccounts, type QwenAccount } from "./accounts.ts";
import {
  getAccountCooldownInfo,
  isAccountHeadersReady,
  markAccountHeadersReady,
} from "./account-manager.ts";
import { config } from "./config.ts";
import type { IAccountOwnership } from "../runtime/contracts.ts";
import type { MaintenanceScheduler } from "../runtime/maintenance/maintenance-scheduler.ts";
import type {
  ReadinessController,
  TickReport,
} from "../runtime/readiness/readiness-controller.ts";

export const READINESS_CONTROLLER_FLAG = "QWEN_READINESS_CONTROLLER";

const MIN_WARMING = 1;
const MAX_CONCURRENT_WARMING = 1;
const VALIDATION_BUCKETS = 3;
const VALIDATION_BUCKET_WINDOW_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const WARMUP_DEDUPE_PREFIX = "WARM_ACCOUNT:";
const EXHAUSTION_RESET_MS = 600_000;

function getMinReady(): number {
  return config.pool?.targetReady ?? 2;
}

const mask = (id: string) => id.slice(0, 8) + "...";

export interface ReadinessGuardDeps {
  getAccountCredentials: (accountId: string) => QwenAccount | undefined;
  initPlaywrightForAccount: (account: QwenAccount) => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
}

export interface ReadinessControllerClients {
  ownership: IAccountOwnership;
  scheduler: MaintenanceScheduler;
  controller: ReadinessController;
}

export interface ReadinessDiagnostics {
  poolChecksRun: number;
  coalescedTriggers: number;
  accountsWarmed: number;
  lastPoolCheckAt: number | null;
  readyAccounts: number;
  validationSweepsRun: number;
  accountsRevalidated: number;
  warmupFailures: number;
}

export interface ValidationPassResult {
  bucket: number;
  revalidated: string[];
}

const counters = {
  poolChecksRun: 0,
  coalescedTriggers: 0,
  accountsWarmed: 0,
  lastPoolCheckAt: null as number | null,
  validationSweepsRun: 0,
  accountsRevalidated: 0,
  warmupFailures: 0,
};

let guardDeps: ReadinessGuardDeps | null = null;
let controllerClients: ReadinessControllerClients | null = null;
let checkInFlight: Promise<void> | null = null;
let trailingRecheckRequested = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
const warmingAccounts = new Set<string>();
const warmupFailures = new Map<string, { count: number; backoffUntil: number }>();
const exhaustedAccounts = new Map<string, number>();

export function isReadinessControllerEnabled(): boolean {
  return process.env[READINESS_CONTROLLER_FLAG] === "true";
}

export function registerReadinessControllerClients(
  clients: ReadinessControllerClients,
): void {
  controllerClients = clients;
}

export function resetReadinessControllerClientsForTests(): void {
  controllerClients = null;
}

export function warmupDedupeKey(accountId: string): string {
  return `${WARMUP_DEDUPE_PREFIX}${accountId}`;
}

export function getWarmingAccountIds(): string[] {
  return Array.from(warmingAccounts);
}

export function getWarmupFailureInfo(): Map<
  string,
  { count: number; backoffUntil: number }
> {
  return new Map(warmupFailures);
}

export function registerReadinessGuardDeps(
  deps: ReadinessGuardDeps | null,
): void {
  guardDeps = deps;
  if (deps) {
    console.log("[Pool Readiness] controller registered | deps=ready");
  }
}

export function getReadinessDiagnostics(): ReadinessDiagnostics {
  let readyAccounts = 0;
  for (const account of loadAccounts()) {
    if (isAccountHeadersReady(account.id)) readyAccounts += 1;
  }
  return {
    poolChecksRun: counters.poolChecksRun,
    coalescedTriggers: counters.coalescedTriggers,
    accountsWarmed: counters.accountsWarmed,
    lastPoolCheckAt: counters.lastPoolCheckAt,
    readyAccounts,
    validationSweepsRun: counters.validationSweepsRun,
    accountsRevalidated: counters.accountsRevalidated,
    warmupFailures: counters.warmupFailures,
  };
}

export function resetReadinessCountersForTests(): void {
  counters.poolChecksRun = 0;
  counters.coalescedTriggers = 0;
  counters.accountsWarmed = 0;
  counters.lastPoolCheckAt = null;
  counters.validationSweepsRun = 0;
  counters.accountsRevalidated = 0;
  counters.warmupFailures = 0;
  warmupFailures.clear();
  exhaustedAccounts.clear();
}

export function recoveredValidationBucket(
  accountId: string,
  buckets: number = VALIDATION_BUCKETS,
): number {
  const divisor = Math.max(1, Math.floor(buckets));
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash += accountId.charCodeAt(i);
  }
  return hash % divisor;
}

export async function ensurePoolReadiness(): Promise<TickReport | undefined> {
  if (isReadinessControllerEnabled() && controllerClients) {
    counters.poolChecksRun += 1;
    counters.lastPoolCheckAt = Date.now();
    return controllerClients.controller.tick();
  }
  await coalescedPoolCheck();
  return undefined;
}

export function triggerReadinessCheck(reason?: string): void {
  if (isReadinessControllerEnabled() && controllerClients) {
    void controllerClients.controller.tick().then(noop, noop);
    return;
  }
  if (!guardDeps) return;
  void coalescedPoolCheck().then(noop, noop);
  if (reason) {
    console.log(`🔥 [ReadinessGuard] Check triggered | reason=${reason}`);
  }
}

async function coalescedPoolCheck(): Promise<void> {
  if (!guardDeps) return;
  if (checkInFlight) {
    trailingRecheckRequested = true;
    counters.coalescedTriggers += 1;
    return checkInFlight;
  }
  checkInFlight = runPoolCheckLoop();
  return checkInFlight;
}

async function runPoolCheckLoop(): Promise<void> {
  try {
    do {
      trailingRecheckRequested = false;
      await runPoolCheck();
    } while (trailingRecheckRequested);
  } finally {
    checkInFlight = null;
  }
}

async function runPoolCheck(): Promise<void> {
  counters.poolChecksRun += 1;
  counters.lastPoolCheckAt = Date.now();
  const deps = guardDeps;
  if (!deps) return;

  resetExpiredExhaustions();

  const accounts = loadAccounts();
  const ready = accounts.filter((account) =>
    isAccountHeadersReady(account.id),
  );
  const standby = accounts.filter(
    (account) =>
      !isAccountHeadersReady(account.id) &&
      !getAccountCooldownInfo(account.id) &&
      !warmingAccounts.has(account.id) &&
      !exhaustedAccounts.has(account.id) &&
      !isInWarmupBackoff(account.id),
  );
  const target = getMinReady();
  const deficit = Math.max(0, target - ready.length);
  const needWarming = Math.max(0, MIN_WARMING - warmingAccounts.size);
  const totalNeeded = Math.min(deficit + needWarming, standby.length);
  const slots = Math.min(
    totalNeeded,
    Math.max(0, MAX_CONCURRENT_WARMING - warmingAccounts.size),
  );
  if (deficit > 0) {
    console.log(
      `[Pool Readiness] reconcile | ready=${ready.length} target=${target} deficit=${deficit}`,
    );
  }

  for (let i = 0; i < slots; i++) {
    const account = standby[i];
    if (!account) break;
    if (isAccountHeadersReady(account.id)) continue;
    if (getAccountCooldownInfo(account.id)) continue;
    if (warmingAccounts.has(account.id)) continue;
    if (exhaustedAccounts.has(account.id)) continue;
    if (isInWarmupBackoff(account.id)) continue;
    console.log(
      `[Pool Readiness] warmup scheduled | account=${mask(account.id)} reason=ready_deficit`,
    );
    await warmStandbyAccount(deps, account.id);
  }
}

async function warmStandbyAccount(
  deps: ReadinessGuardDeps,
  accountId: string,
): Promise<boolean> {
  const credentials = deps.getAccountCredentials(accountId);
  if (!credentials) return false;
  warmingAccounts.add(accountId);
  const startedAt = Date.now();
  const timeoutMs = config.pool?.warmupTimeoutMs ?? 90_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Warmup timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timeoutHandle.unref?.();
  });
  try {
    await Promise.race([
      (async () => {
        await deps.initPlaywrightForAccount(credentials);
        await deps.disableNativeTools(accountId).catch(noop);
        await Promise.all(
          config.qwen.chatPoolModels.map((modelId) =>
            deps.warmQwenChatPool(accountId, modelId).catch(noop),
          ),
        );
      })(),
      timeoutPromise,
    ]);
    if (getAccountCooldownInfo(accountId)) return false;
    markAccountHeadersReady(accountId);
    counters.accountsWarmed += 1;
    warmupFailures.delete(accountId);
    console.log(
      `[Pool Readiness] warmup success | account=${mask(accountId)} duration=${Date.now() - startedAt}ms`,
    );
    return true;
  } catch (error) {
    recordWarmupFailure(accountId, getErrorMessage(error));
    return false;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    warmingAccounts.delete(accountId);
  }
}

function recordWarmupFailure(accountId: string, message: string): void {
  counters.warmupFailures += 1;
  const info = warmupFailures.get(accountId) ?? { count: 0, backoffUntil: 0 };
  info.count += 1;
  const baseMs = config.pool?.backoffBaseMs ?? 500;
  const maxMs = config.pool?.backoffMaxMs ?? 300_000;
  info.backoffUntil =
    Date.now() + Math.min(baseMs * 2 ** (info.count - 1), maxMs);
  warmupFailures.set(accountId, info);
  if (info.count >= (config.pool?.maxWarmupFailures ?? 3)) {
    exhaustedAccounts.set(accountId, Date.now());
  }
  console.warn(
    `[Pool Readiness] warmup failed | account=${mask(accountId)} error=${message}`,
  );
}

function isInWarmupBackoff(accountId: string): boolean {
  const info = warmupFailures.get(accountId);
  return info !== undefined && info.backoffUntil > Date.now();
}

function resetExpiredExhaustions(): void {
  const now = Date.now();
  for (const [accountId, exhaustedAt] of exhaustedAccounts) {
    if (now - exhaustedAt >= EXHAUSTION_RESET_MS) {
      exhaustedAccounts.delete(accountId);
      warmupFailures.delete(accountId);
    }
  }
}

async function runValidationPass(): Promise<ValidationPassResult> {
  counters.validationSweepsRun += 1;
  const bucket =
    Math.floor(Date.now() / VALIDATION_BUCKET_WINDOW_MS) % VALIDATION_BUCKETS;
  const revalidated: string[] = [];
  const deps = guardDeps;
  if (!deps) return { bucket, revalidated };

  for (const account of loadAccounts()) {
    if (recoveredValidationBucket(account.id) !== bucket) continue;
    if (getAccountCooldownInfo(account.id)) continue;
    if (warmingAccounts.has(account.id)) continue;
    const credentials = deps.getAccountCredentials(account.id);
    if (!credentials) continue;
    warmingAccounts.add(account.id);
    try {
      await deps.initPlaywrightForAccount(credentials);
      if (!getAccountCooldownInfo(account.id)) {
        markAccountHeadersReady(account.id);
      }
      counters.accountsRevalidated += 1;
      revalidated.push(account.id);
    } catch (error) {
      console.warn(
        `⚠️ [ReadinessGuard] Revalidation failed | account=${account.id} | error=${getErrorMessage(error)}`,
      );
    } finally {
      warmingAccounts.delete(account.id);
    }
  }
  return { bucket, revalidated };
}

export function runReadinessValidationForTests(): Promise<ValidationPassResult> {
  return runValidationPass();
}

export function startReadinessGuardSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void runValidationPass().then(noop, noop);
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopReadinessGuardSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

export function startReconciliationTimer(): void {
  if (reconciliationTimer) return;
  reconciliationTimer = setInterval(() => {
    void coalescedPoolCheck().then(noop, noop);
  }, config.pool?.reconciliationIntervalMs ?? 30_000);
  reconciliationTimer.unref?.();
}

export function stopReconciliationTimer(): void {
  if (!reconciliationTimer) return;
  clearInterval(reconciliationTimer);
  reconciliationTimer = null;
}

function noop(): void {}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
