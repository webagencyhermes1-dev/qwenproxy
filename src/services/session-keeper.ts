import { config } from "../core/config.ts";
import { hasActiveAccountLease } from "../core/account-concurrency.ts";
import type { IAccountOwnership } from "../runtime/contracts.ts";
import type { MaintenanceScheduler } from "../runtime/maintenance/maintenance-scheduler.ts";

import {
  closeIdlePlaywrightAccounts,
  evictIdlePlaywrightContextsToLimit,
  getActivePlaywrightAccountIds,
  isPlaywrightAlreadyClosedError,
  keepAlivePlaywrightAccount,
} from "./playwright.ts";
import { humanDelay, sleep } from "./human-behavior.ts";

/** Dedupe key under which exactly one keep-alive job per account is outstanding. */
export const KEEP_ALIVE_DEDUPE_PREFIX = "keepalive:";

export function keepAliveDedupeKey(accountId: string): string {
  return `${KEEP_ALIVE_DEDUPE_PREFIX}${accountId}`;
}

/** Ownership statuses that mean user traffic currently owns the browser context. */
const GENERATING_STATUSES: ReadonlySet<string> = new Set([
  "GENERATING",
  "RESERVED",
]);

/**
 * The bounded scheduler the keeper submits to when clients are registered.
 * While null the keeper keeps its direct per-account loop.
 */
export interface SessionKeeperClients {
  readonly ownership: IAccountOwnership;
  readonly scheduler: MaintenanceScheduler;
}

let keeperClients: SessionKeeperClients | null = null;

export function registerSessionKeeperClients(
  clients: SessionKeeperClients,
): void {
  keeperClients = clients;
}

/** Test hook: detach the scheduler so the keeper falls back to legacy behavior. */
export function resetSessionKeeperClientsForTests(): void {
  keeperClients = null;
}

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let cycleInProgress = false;

export function isSessionKeeperRunning(): boolean {
  return running;
}

/**
 * Execute one keep-alive maintenance job. Bounded by the MaintenanceScheduler
 * worker pool and dedupe table; never called directly when the controller flag
 * is on.
 */
export async function performKeepAlive(accountId: string): Promise<void> {
  await keepAlivePlaywrightAccount(accountId).catch((error) => {
    // Shutdown/eviction closes contexts while a cycle is in flight; the
    // resulting "already closed" rejection is benign. The old substring
    // filter ("Target closed"/"Page is closed") missed Playwright's real
    // message ("Target page, context or browser has been closed") and
    // leaked a warning on every Ctrl+C.
    if (isPlaywrightAlreadyClosedError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[SessionKeeper] Keep-alive failed for ${accountId}: ${message}`,
    );
  });
  // TOCTOU check: a lease may have been acquired during the keep-alive.
  // Log a warning so operators can detect races (the keep-alive itself is
  // lightweight and unlikely to interfere, but the signal is useful).
  if (hasActiveAccountLease(accountId)) {
    console.warn(
      `[SessionKeeper] Lease acquired during keep-alive | account=${accountId} | possible race`,
    );
  }
}

/**
 * Client mode: submit one bounded keep-alive job per active account instead of
 * running the keep-alive inline. Accounts carrying user traffic are skipped
 * (the scheduler also defers low-priority work while a generation is active).
 */
function submitKeepAliveJobs(): void {
  const clients = keeperClients;
  if (!clients) return;
  for (const accountId of getActivePlaywrightAccountIds()) {
    const status = clients.ownership.getAccountStatus(accountId);
    if (GENERATING_STATUSES.has(status)) {
      console.log(
        `[SessionKeeper] skipped active account | account=${accountId} | reason=generating`,
      );
      continue;
    }
    if (hasActiveAccountLease(accountId)) {
      console.log(
        `[SessionKeeper] skipped active account | account=${accountId} | reason=active_lease`,
      );
      continue;
    }
    clients.scheduler.submit({
      kind: "CLEAN_SESSION",
      accountId,
      dedupeKey: keepAliveDedupeKey(accountId),
    });
  }
}

async function runKeepAliveCycle(): Promise<void> {
  if (cycleInProgress) return;
  cycleInProgress = true;
  try {
    if (config.sessionKeeper.enabled) {
      // Scheduler path when clients are registered (production runtime via
      // the maintenance scheduler); direct per-account loop otherwise.
      if (keeperClients) {
        submitKeepAliveJobs();
      } else {
        const accountIds = getActivePlaywrightAccountIds();
        for (const accountId of accountIds) {
          if (hasActiveAccountLease(accountId)) {
            console.log(
              `[SessionKeeper] skipped active account | account=${accountId} | reason=active_lease`,
            );
            continue;
          }
          await performKeepAlive(accountId);
          await sleep(humanDelay(250, 900));
        }
      }
    }

    const closed = await closeIdlePlaywrightAccounts(
      config.playwright.idleContextTtlMs,
    );
    const evicted = await evictIdlePlaywrightContextsToLimit();
    const totalClosed = closed + evicted;
    if (totalClosed > 0) {
      console.log(
        `🧹 [SessionKeeper] Closed ${totalClosed} idle Playwright context(s)`,
      );
    }
  } finally {
    cycleInProgress = false;
  }
}

export function startSessionKeeper(): void {
  const hasKeepAliveWork = config.sessionKeeper.enabled;
  const hasIdleCleanupWork = config.playwright.idleContextTtlMs > 0;
  if (running || (!hasKeepAliveWork && !hasIdleCleanupWork)) return;

  running = true;
  intervalId = setInterval(() => {
    if (running) void runKeepAliveCycle();
  }, config.sessionKeeper.intervalMs);
  intervalId.unref?.();

  if (config.sessionKeeper.enabled) {
    console.log(
      `💓 [SessionKeeper] Keep-alive enabled | interval=${config.sessionKeeper.intervalMs}ms idle=${config.sessionKeeper.idleMs}ms`,
    );
  }
}

export function stopSessionKeeper(): void {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  cycleInProgress = false;
}

export async function runSessionKeeperOnceForTesting(): Promise<void> {
  await runKeepAliveCycle();
}
