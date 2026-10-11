/**
 * Playwright browser automation with stealth plugin for anti-bot evasion.
 * Captures real browser headers (bx-ua, bx-umidtoken) per account.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const requireLocal = createRequire(import.meta.url);

function autoInstallPlaywrightChromium(): void {
  const tryInstall = (mirror?: string): number | null => {
    const installEnv = {
      ...process.env,
      PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:
        process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT || "120000",
      ...(mirror ? { PLAYWRIGHT_DOWNLOAD_HOST: mirror } : {}),
    };
    try {
      const patchrightEntry = requireLocal.resolve("patchright");
      const cliPath = path.join(path.dirname(patchrightEntry), "cli.js");
      if (fs.existsSync(cliPath)) {
        console.log("⏳ [Playwright] Navegador Chromium não encontrado. Instalando automaticamente...");
        const res = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
          stdio: "inherit",
          env: installEnv,
        });
        return res.status;
      }
    } catch {}

    console.log("⏳ [Playwright] Navegador Chromium não encontrado. Instalando via npx...");
    const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const res = spawnSync(cmd, ["--yes", "patchright", "install", "chromium"], {
      stdio: "inherit",
      env: installEnv,
    });
    return res.status;
  };

  const status = tryInstall(process.env.PLAYWRIGHT_DOWNLOAD_HOST);
  if (status !== 0 && !process.env.PLAYWRIGHT_DOWNLOAD_HOST) {
    console.log("\n⚠️ [Playwright] Falha no CDN primário. Tentando espelho global de alta velocidade...");
    tryInstall("https://npmmirror.com/mirrors/playwright");
  }

  try {
    void (async () => {
      const { cleanPlaywrightBrowsers } = await import("../clean-cache.ts");
      await cleanPlaywrightBrowsers(true);
    })();
  } catch {}
}
import { loadAccounts, type QwenAccount } from "../core/accounts.ts";
// Imported here rather than injected from session-keeper.ts: account-concurrency
// only depends on config/logger, so playwright -> account-concurrency stays
// acyclic, while the reverse direction would drag the browser layer into core.
import { hasActiveAccountLease } from "../core/account-concurrency.ts";
import { config } from "../core/config.ts";
import { logger, maskEmail } from "../core/logger.ts";
import { metrics } from "../core/metrics.ts";
import { Mutex } from "../core/mutex.ts";
import {
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import { getAccountsByPriority } from "../core/account-priority.ts";
import {
  clearFingerprintCache,
  getFingerprintProfile,
  updateChromeMajor,
  type FingerprintProfile,
} from "./fingerprint.ts";
import { subtlePageActivity } from "./human-behavior.ts";
import { solveBaxiaCaptcha } from "./captcha-solver.ts";
import { qwenOrigin, qwenUrl } from "./qwen-url.ts";
import { setWafContextResetListener } from "../core/waf-isolation.ts";
import { recordAccountFailure } from "../core/account-health.ts";
import { markAccountAuthError } from "../core/account-state.ts";
import { updateQwenWebVersion, getQwenWebVersion } from "./qwen-headers.ts";
import {
  accountPages,
  isPlaywrightInitialized,
  isPlaywrightPageAlive,
} from "./playwright-page-state.ts";
import { getAccountProfilePath, getProfilesDir } from "../core/paths.ts";
import {
  ensureBrowserProcessHygiene,
  killBrowserProcessTree,
  killBrowserProcessesForProfile,
  killChildBrowserProcessesSync,
} from "../core/browser-process-cleanup.ts";
import {
  operationRegistry,
  browserOwnershipEnabled,
} from "../runtime/browser/operation-registry.ts";

type ContextInitHook = (context: BrowserContext) => Promise<void> | void;
const contextInitHooks: ContextInitHook[] = [];

export function onBrowserContextCreated(hook: ContextInitHook): void {
  contextInitHooks.push(hook);
}
export type BrowserType = "chromium" | "chrome" | "edge";

interface BrowserEngineConfig {
  engine: typeof chromium;
  channel?: string;
}

function resolveBrowserEngine(browserType: BrowserType): BrowserEngineConfig {
  switch (browserType) {
    case "chrome":
      return { engine: chromium, channel: "chrome" };
    case "edge":
      return { engine: chromium, channel: "msedge" };
    case "chromium":
    default:
      return { engine: chromium };
  }
}

/**
 * Chromium launch args tuned for multi-account proxy use.
 * Low-memory flags cap V8 old-space in renderer processes (fork-safe RAM fix).
 */
export function buildChromiumLaunchArgs(viewport: {
  width: number;
  height: number;
}): string[] {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process,TranslateUI,Translate,OptimizationHints,MediaRouter",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-accelerated-2d-canvas",
    `--window-size=${viewport.width},${viewport.height}`,
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--disable-default-apps",
    "--disable-component-extensions-with-background-pages",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-gpu-shader-disk-cache",
  ];

  if (config.playwright.lowMemoryFlags) {
    const heapMb = config.playwright.jsHeapMb;
    args.push(
      `--js-flags=--max-old-space-size=${heapMb}`,
      "--renderer-process-limit=2",
      "--disk-cache-size=1",
      "--media-cache-size=1",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
    );
  }

  // Pin the Qwen origin to the known proxied IP so Chromium never resolves
  // chat.qwen.ai through its own DNS/DoH path (bad-resolution navigations are
  // a documented source of "BrowserContext disposed"/"Target crashed"
  // failures). MAP takes effect before any DNS lookup, so expired/poisoned
  // host entries cannot strand the page.
  if (config.playwright.hostResolverRules && config.playwright.chatOriginIp) {
    args.push(
      `--host-resolver-rules=MAP chat.qwen.ai ${config.playwright.chatOriginIp},MAP qwen.ai ${config.playwright.chatOriginIp}`,
    );
  }

  return args;
}

let activeInitSlots = 0;
let initSlotWaiters: Array<() => void> = [];

/**
 * Bounds how many per-account Chromium context launches/header captures can
 * run at once. Every account boots its own persistent-context browser process,
 * so a burst of cold requests that initialize together forked N renderers off
 * one host and the resulting OOM cascade killed sibling contexts ("Browser has
 * been closed", "Session closed"). A global slot (not per-account: initializing
 * accounts are independent) queues surplus inits until a slot frees.
 */
export async function withPlaywrightInitSlot<T>(
  fn: () => Promise<T>,
  deadlineMs?: number,
): Promise<T> {
  const max = config.playwright.maxParallelInit;
  if (max <= 1) return fn();
  // Bounded queue wait: the caller already holds its account mutex while it
  // waits here, so an unbounded wait turns a burst of cold accounts into lock
  // holds that outlive the pool's warmup window (the waiter then times out on
  // `init:<acct>` and "recovers" an init that was merely queued).
  const startAt = Date.now();
  const slotDeadline = deadlineMs ?? startAt + config.timeouts.page;
  while (activeInitSlots >= max) {
    const remaining = slotDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Playwright init slot wait exceeded ${Math.round((slotDeadline - startAt) / 1000)}s budget`,
      );
    }
    await new Promise<void>((resolve) => {
      initSlotWaiters.push(resolve);
      // Self-wake so a lost hand-off cannot park this waiter forever, and drop
      // our own queue entry on the deadline path so the next releasing init
      // does not resolve a waiter that already left the queue.
      const recheck = setTimeout(() => {
        const index = initSlotWaiters.indexOf(resolve);
        if (index >= 0) initSlotWaiters.splice(index, 1);
        resolve();
      }, Math.min(remaining, 1_000));
      recheck.unref?.();
    });
  }
  activeInitSlots++;
  try {
    return await fn();
  } finally {
    activeInitSlots--;
    initSlotWaiters.shift()?.();
  }
}

/**
 * Global bound on concurrent Playwright BROWSER operations (max 5).
 *
 * Per-account mutexes serialize work for one account, but N accounts
 * recovering at once (cold start, WAF storm) still fork N concurrent
 * navigations/captures/logins against one host — the OOM cascade that killed
 * sibling contexts. Every heavy browser op (header capture, login,
 * keep-alive navigation) runs inside this slot; surplus ops queue FIFO.
 * Leaf-only: never acquire another slot/mutex inside, so no lock ordering
 * cycle is possible.
 */
export const PW_OP_SEMAPHORE_MAX = 5;
let pwOpActive = 0;
const pwOpWaiters: Array<() => void> = [];
let pwOpHighWater = 0;

/**
 * Optional operation identity for the browser-ownership model (Phase 6). When
 * passed AND the QWEN_BROWSER_OWNERSHIP flag is on, the slot registers a live
 * operation (deadline + AbortController) so header captures and page ops are
 * attributable and terminal-cancellable. Omitted => unchanged behavior.
 */
export interface PlaywrightOpIdentity {
  accountId?: string;
  generationId?: string;
  attemptId?: string;
  /** Absolute epoch-ms deadline; defaults to now + config.timeouts.page. */
  deadline?: number;
  kind: string;
  operationId?: string;
}

export async function withPlaywrightOpSlot<T>(
  fn: () => Promise<T>,
  identity?: PlaywrightOpIdentity,
): Promise<T> {
  const op =
    browserOwnershipEnabled() && identity
      ? operationRegistry.register({
          accountId: identity.accountId ?? "global",
          deadline: identity.deadline ?? Date.now() + config.timeouts.page,
          kind: identity.kind,
          ...(identity.generationId ? { generationId: identity.generationId } : {}),
          ...(identity.attemptId ? { attemptId: identity.attemptId } : {}),
          ...(identity.operationId ? { operationId: identity.operationId } : {}),
        })
      : undefined;

  // Bounded queue wait. The semaphore is shared by every browser op, so an
  // init parked here still holds its account mutex — an unbounded wait turns
  // five long captures into a 150s lock hold for the other 15 accounts. The
  // caller's deadline (or one page timeout when no identity was given) caps
  // the wait; whoever expires first leaves the queue and reports why.
  const slotDeadline = identity?.deadline ?? Date.now() + config.timeouts.page;

  try {
    while (pwOpActive >= PW_OP_SEMAPHORE_MAX) {
      if (op?.controller.signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      const remaining = slotDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Playwright op slot wait exceeded ${config.timeouts.page}ms budget for ${
            identity?.kind ?? "browser op"
          }${identity?.accountId ? ` (${identity.accountId})` : ""}`,
        );
      }
      await new Promise<void>((resolve) => {
        pwOpWaiters.push(resolve);
        const recheck = setTimeout(() => {
          // Self-wake so a stalled hand-off cannot park this op forever, and
          // drop our own queue entry first: on the deadline path we leave the
          // loop without ever being shifted, which would leave a resolved
          // no-op in front of the queue for the next releasing op to pick up.
          const idx = pwOpWaiters.indexOf(resolve);
          if (idx >= 0) pwOpWaiters.splice(idx, 1);
          resolve();
        }, Math.min(remaining, 1_000));
        recheck.unref?.();
      });
    }
    pwOpActive++;
    pwOpHighWater = Math.max(pwOpHighWater, pwOpActive);
    try {
      if (op?.controller.signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return await fn();
    } finally {
      pwOpActive--;
      pwOpWaiters.shift()?.();
    }
  } finally {
    if (op) {
      op.resolveCompletion();
      operationRegistry.remove(op.operationId);
    }
  }
}

/** Highest concurrent op-slot occupancy observed (tests/observability). */
export function getPlaywrightOpHighWater(): number {
  return pwOpHighWater;
}

export function resetPlaywrightOpHighWaterForTests(): void {
  pwOpHighWater = 0;
}

// Per-account mutexes for browser access. maxHoldMs = 60s: a page operation
// legitimately takes a few seconds per step, but one exceeding 60s is a stuck
// browser op (closed context / WAF page swallow) and the account should return
// to the pool quickly (the 2026-08-22 log showed a lock held for 154s before
// the waiter's recovery path finally ran). The chat lock keeps its own longer
// hold budget (see acquireChatLock).
const ACCOUNT_MUTEX_MAX_HOLD_MS = 180_000;
const accountMutexes = new Map<string, Mutex>();

/**
 * Hard wall-clock budget for ONE account init — queue wait, context launch,
 * login, session validation and header capture together.
 *
 * Init holds `init:<acct>` for its whole duration, so every unbounded step
 * inside it is a lock hold. Each step used to carry its own timeout (60s
 * navigation twice, 90s capture, unbounded slot queues), which stacked up to
 * 150s+ holds: waiters timed out with "held by init:<acct> for 149527ms",
 * `terminateWarmup` then parked another 60s on `close:<acct>` and the account
 * never finished warming. The budget deliberately sits BELOW the pool warmup
 * window so the controller's timeout cannot race an init that is still
 * healthy (the 90s warmup + 60s close double-hold above).
 *
 * Override with PLAYWRIGHT_INIT_TIMEOUT_MS when the pool window is raised.
 */
const PLAYWRIGHT_INIT_TIMEOUT_MS = ((): number => {
  const parsed = parseInt(process.env.PLAYWRIGHT_INIT_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Math.max(45_000, config.pool.warmupTimeoutMs - 15_000);
})();

/** Cooldown for an init failure no retry can fix (wrong password, activation pending). */
export const PERMANENT_INIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Cancellation handle for the browser work of ONE account. Recovery and the
 * init deadline both use it: closing the context makes in-flight awaits fail,
 * but a body parked between awaits (sleeping, queued on a slot) would keep
 * going — the signal is what stops it at the next stage boundary.
 */
const accountCancelControllers = new Map<string, AbortController>();

function cancelAccountBrowserWork(accountId: string, reason: string): void {
  const controller = accountCancelControllers.get(accountId);
  if (controller && !controller.signal.aborted) {
    controller.abort(reason);
  }
}

function describeAbortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : "cancelled";
}

/**
 * Stage gate for init: notice a cancellation (recovery took the mutex back, or
 * the deadline teardown ran) and a spent budget BEFORE paying for the next
 * browser step, so the abort costs one bounded await instead of a whole
 * navigation.
 */
function assertInitProgress(
  accountId: string,
  signal: AbortSignal,
  stage: string,
  deadlineMs: number,
): void {
  if (signal.aborted) {
    throw new Error(
      `Playwright init cancelled for ${accountId} during ${stage}: ${describeAbortReason(signal)}`,
    );
  }
  if (Date.now() >= deadlineMs) {
    throw new Error(
      `Playwright init deadline exceeded after ${PLAYWRIGHT_INIT_TIMEOUT_MS}ms for ${accountId} during ${stage}`,
    );
  }
}

/** Thrown by capture/classification paths whose failure no retry can fix. */
export class PermanentAuthError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentAuthError";
  }
}

/**
 * True when retrying the init cannot succeed: the credentials are missing, the
 * login answer is a hard auth rejection, or the account itself is still
 * awaiting activation. Everything else (WAF, timeouts, contention) stays
 * retryable.
 */
export function isPermanentInitFailure(error: unknown): boolean {
  if (error instanceof PermanentAuthError) return true;
  const message = getErrorMessage(error);
  return (
    message.includes("AuthPermanentFailure") ||
    message.includes("credentials unresolved") ||
    message.includes("no credentials available for re-login") ||
    message.includes("pending activation")
  );
}

/**
 * Park an account that can never initialize on its own: 24h cooldown, the
 * AUTH_ERROR flag (survives any cooldown a caller may overwrite, and only a
 * successful init clears it) and an auth failure in the health ledger.
 * Mirrors what `loginToQwen` already does for its own permanent rejections.
 */
function markPermanentInitFailure(accountId: string, reason: string): void {
  console.error(
    `🛑 [Playwright] Permanent init failure | account=${accountId} | reason=${reason}`,
  );
  markAccountRateLimited(
    accountId,
    PERMANENT_INIT_COOLDOWN_MS,
    `AuthPermanentFailure: ${reason}`,
  );
  try {
    markAccountAuthError(accountId);
    recordAccountFailure(accountId, "auth");
  } catch {
    // Best-effort: the cooldown is already set.
  }
}


function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex(`playwright:${accountId.substring(0, 8)}`, ACCOUNT_MUTEX_MAX_HOLD_MS);
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

async function recoverStuckAccountMutex(
  accountId: string,
  mutex: Mutex,
  key: string,
): Promise<void> {
  // A waiter timing out means the holder is either a browser op with no live
  // promise behind it (locks held for hours in the 2026-08-22 log) or an init
  // that overran its own budget. Recovering must do all three of these, in
  // this order — logging alone (the old behavior) left the lock, the browser
  // and the in-flight task exactly where they were.
  if (accountMutexes.get(accountId) !== mutex) return;

  const holder = mutex.state();
  console.warn(
    `[Playwright] Recovering stuck account mutex | account=${accountId} | key=${key} | heldBy=${holder.heldBy || "unknown"} | heldFor=${holder.heldForMs}ms`,
  );

  // 1) Cancel the holder's task first. An init that keeps driving the page
  //    would re-wedge the account the instant we hand the lock over.
  cancelAccountBrowserWork(
    accountId,
    `stuck mutex recovery (waiter=${key}, heldBy=${holder.heldBy || "unknown"})`,
  );

  // 2) Close the context so every await still in flight fails fast instead of
  //    holding browser resources while the new owner starts.
  const context = accountContexts.get(accountId);
  if (context) {
    await closePlaywrightContextBestEffort(accountId, context, {
      skipStorageSave: true,
    });
  }
  await cleanupPlaywrightAccountState(accountId);

  // 3) Reclaim the lock itself. Deleting the map entry (the old behavior)
  //    orphaned a mutex whose waiter queue stayed stranded and whose holder
  //    still believed it owned the lock. forceRelease bumps the generation —
  //    the stuck holder's later release() becomes a fenced no-op — and wakes
  //    the OLDEST waiter, so queued acquirers resume immediately instead of
  //    burning their own 60s timeout on the same dead holder.
  mutex.forceRelease(`stuck-holder recovery (waiter=${key})`);

  // Re-warm through the readiness controller only: cleanupPlaywrightAccountState
  // already requested a tick (and READY -> RECOVERING via unmark). The old
  // schedulePlaywrightProfileReset() here spawned a private re-init that
  // bypassed the controller's failure budget and warmup timeout — the
  // un-accounted retry loop that kept relaunching browsers for dead accounts.
}

async function acquireAccountMutex(
  accountId: string,
  key: string,
  timeoutMs = PLAYWRIGHT_MUTEX_WAIT_MS,
  recoverOnTimeout = true,
): Promise<() => void> {
  const mutex = getAccountMutex(accountId);
  try {
    return await mutex.acquire(timeoutMs, key);
  } catch (error) {
    if (
      recoverOnTimeout &&
      error instanceof Error &&
      error.message.startsWith("Mutex[playwright:") &&
      error.message.includes("acquire timeout")
    ) {
      await recoverStuckAccountMutex(accountId, mutex, key);
    }
    throw error;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

// Per-account browser contexts and pages. accountPages lives in
// ./playwright-page-state.ts so core readiness gates can query page state
// without importing this module (see the note there).
const accountContexts = new Map<string, BrowserContext>();
const cachedUserAgents = new Map<string, string>();

let sharedBrowser: Browser | null = null;
let sharedBrowserPromise: Promise<Browser> | null = null;

export function getSharedBrowser(): Browser | null {
  return sharedBrowser;
}

export function getStorageStatePath(accountId: string): string {
  const profileDir = getAccountProfilePath(accountId);
  return path.join(profileDir, "storage_state.json");
}

/** Legacy backup filename written by older providers. */
function pickStorageStatePath(accountId: string): string | undefined {
  const p1 = getStorageStatePath(accountId);
  const p2 = path.join(path.dirname(p1), `${accountId}_state.json`);
  return fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : undefined;
}

/**
 * Whether a token cookie's JWT payload is already past its `exp`. Unparseable
 * (opaque) tokens are treated as valid so we never throw away a working
 * session on a format change.
 */
export function isTokenCookieJwtExpired(cookie: { name: string; value: string }): boolean {
  if (!/token/i.test(cookie.name)) return false;
  let raw = cookie.value;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep the raw value.
  }
  const segments = raw.split(".");
  if (segments.length !== 3 || !segments[1]) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf-8"),
    );
    const exp = payload?.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
    return exp < Date.now() / 1000;
  } catch {
    return false;
  }
}

/** Max age of the persisted storage_state.json backup reused at re-init. */
export const STORAGE_STATE_TTL_MS = config.playwright.storageStateTtlMs;

/**
 * Cookies from the persisted storage state that are still worth injecting:
 * the backup must be younger than `maxAgeMs` and every returned cookie must be
 * unexpired (both `expires` and JWT `exp`). Returns [] for a stale or dead
 * session so the caller falls through to credential re-login.
 */
export function getRestorableCookies(
  accountId: string,
  maxAgeMs = STORAGE_STATE_TTL_MS,
): Array<{ name: string; value: string }> {
  const chosenPath = pickStorageStatePath(accountId);
  if (!chosenPath) return [];
  try {
    const stat = fs.statSync(chosenPath);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return [];
    const parsed = JSON.parse(fs.readFileSync(chosenPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cookies)) {
      return [];
    }
    const nowMs = Date.now();
    return parsed.cookies.filter(
      (c: any) =>
        c &&
        typeof c.name === "string" &&
        // Playwright writes session cookies as expires === -1.
        (c.expires === undefined || c.expires === -1 || c.expires * 1000 > nowMs) &&
        !isTokenCookieJwtExpired(c),
    ) as Array<{ name: string; value: string }>;
  } catch {
    return [];
  }
}

export function loadStorageState(
  accountId: string,
  maxAgeMs = STORAGE_STATE_TTL_MS,
): string | undefined {
  if (getRestorableCookies(accountId, maxAgeMs).length === 0) return undefined;
  return pickStorageStatePath(accountId);
}

export async function saveStorageState(
  context: BrowserContext,
  accountId: string,
  timeoutMs = 5_000,
): Promise<void> {
  try {
    const stateFile = getStorageStatePath(accountId);
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await withTimeout(
      context.storageState({ path: stateFile }),
      timeoutMs,
      `storageState timed out after ${timeoutMs}ms`,
    );
  } catch (error) {
    if (!isPlaywrightAlreadyClosedError(error)) {
      console.warn(
        `[Playwright] Failed to save storage state for ${accountId}: ${getErrorMessage(error)}`,
      );
    }
  }
}

async function hasValidAuthCookie(context: BrowserContext, timeoutMs = 3_000): Promise<boolean> {
  try {
    const cookies = await withTimeout(
      context.cookies(),
      timeoutMs,
      `cookies check timed out after ${timeoutMs}ms`,
    );
    return cookies.some(
      (c) =>
        (c.name.toLowerCase().includes("token") || c.name.toLowerCase().includes("session")) &&
        (c.expires === undefined || c.expires === -1 || c.expires * 1000 > Date.now()),
    );
  } catch {
    return false;
  }
}

/**
 * Detect whether the page is authenticated.
 * Probes the authoritative /api/v1/auths/ endpoint from the page context (verified via HAR forensics)
 * and falls back to inspecting the presence of visible "Log in" / "Sign up" buttons.
 *
 * The probe is bounded: page.evaluate ignores Playwright's default timeouts, so a
 * WAF-blocked page whose in-page fetch never settles would hang the caller with no
 * error at all. A probe that cannot answer is treated as "not logged in" — the
 * caller re-authenticates or reloads, which is strictly better than burning the
 * whole header budget waiting on a frozen page.
 */
export async function isPageLoggedIn(
  page: Page,
  timeoutMs = SESSION_PROBE_NAVIGATION_TIMEOUT_MS,
): Promise<boolean> {
  if (!page) return false;
  if (typeof page.isClosed === "function" && page.isClosed()) return false;
  try {
    const url = typeof page.url === "function" ? page.url() : "";
    if (url.includes("/auth") || url.includes("/login")) return false;
    if (typeof page.evaluate !== "function") return true;

    const probe = page
      .evaluate(async () => {
        try {
          const res = await fetch("/api/v1/auths/", { method: "GET" });
          return res.status === 200;
        } catch {
          const btn = document.querySelector(
            ".header-right-auth-button, button.header-right-auth-button, a[href*='/auth'], a[href*='/login']",
          );
          return !btn || (btn as HTMLElement).offsetWidth === 0;
        }
      })
      .catch(() => false);

    return await withTimeout(
      probe,
      Math.max(1_000, timeoutMs),
      `session probe timed out after ${timeoutMs}ms`,
    );
  } catch {
    return false;
  }
}

export async function getOrLaunchSharedBrowser(
  browserType: BrowserType = "chromium",
  headless = true,
): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (sharedBrowserPromise) {
    return sharedBrowserPromise;
  }

  sharedBrowserPromise = (async () => {
    const { engine, channel } = resolveBrowserEngine(browserType);
    const defaultViewport = { width: 1280, height: 800 };
    const launchArgs = buildChromiumLaunchArgs(defaultViewport);

    console.log(
      `🌐 [Playwright] Launching single shared ${browserType} browser...`,
    );

    let browser: Browser;
    try {
      browser = await engine.launch({
        headless,
        channel,
        ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features"],
        args: launchArgs,
      });
    } catch (launchErr: any) {
      if (launchErr?.message?.includes("Executable doesn't exist")) {
        autoInstallPlaywrightChromium();
        browser = await engine.launch({
          headless,
          channel,
          ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features"],
          args: launchArgs,
        });
      } else {
        throw launchErr;
      }
    }

    try {
      const v = browser.version();
      const major = parseInt(v.split(".")[0], 10);
      if (major >= 100) {
        updateChromeMajor(major);
      }
    } catch {}
    browser.on("disconnected", () => {
      console.warn("[Playwright] Shared browser disconnected");
      sharedBrowser = null;
      for (const accountId of Array.from(accountPages.keys())) {
        void cleanupPlaywrightAccountState(accountId);
      }
    });

    sharedBrowser = browser;
    return browser;
  })();

  try {
    return await sharedBrowserPromise;
  } finally {
    sharedBrowserPromise = null;
  }
}

// Header cache per account
interface AccountHeaderCache {
  headers: Record<string, string>;
  lastRefresh: number;
  refreshInProgress: boolean;
}

const headerCaches = new Map<string, AccountHeaderCache>();
// Real TTL measured from Qwen: auth token = 30 days, shortest cookie (acw_tc) = 24 min.
// 20 min is safe: under the 24-min acw_tc, and bx-ua expiry is handled by 403 retry.
const HEADER_CACHE_TTL = 20 * 60 * 1000; // 20 minutes
const HEADER_REFRESH_THRESHOLD = 0.8; // Background refresh at 80% of TTL (16 min)
const COOKIE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const cookieCaches = new Map<string, { cookie: string; timestamp: number }>();
const lastAccountActivity = new Map<string, number>();
const lastKeepAliveNavigation = new Map<string, number>();
const profileResetQueue = new Map<string, Promise<void>>();
let profileResetChain: Promise<void> = Promise.resolve();
let closingAllPlaywright = false;
const captureHeaderLogSeen = new Set<string>();

type KillableProcess = {
  killed?: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HEADER_CAPTURE_SETTLE_MS = 1500;
const PLAYWRIGHT_MUTEX_WAIT_MS = 60_000;
const ACCOUNT_PAGE_OPERATION_TIMEOUT_MS = config.timeouts.page;
/**
 * The session probe in front of a header refresh only answers "is this account
 * still logged in". Header capture navigates again right after, so paying the
 * full navigation timeout here doubles the stall of a WAF-blocked account for
 * no extra information.
 */
const SESSION_PROBE_NAVIGATION_TIMEOUT_MS = 15_000;
/** Grace period for the intercepted completion request after the send is triggered. */
const HEADER_CAPTURE_TRIGGER_GRACE_MS = 15_000;
/**
 * First-send grace is short — but it still has to cover the two round trips a
 * first send actually costs: the UI posts `/api/v2/chats/new` first and only
 * then fires the completion request the capture is waiting for (measured end
 * to end at ~3.2s average on a healthy page). At the previous 3s the first
 * send was declared silent while its own request was still in flight, so the
 * attempt count bought nothing and every capture started one attempt down.
 * Fail it fast relative to the 15s re-send grace, and let the retry loop
 * reload + re-send against the warm SDK instead of stalling the boot.
 */
const FIRST_TRIGGER_GRACE_MS = 6_000;
/**
 * Sends (the initial one plus re-triggers) header capture may spend on getting a
 * completion request that actually carries the bx headers. The in-page SDK can
 * fire one before it finished computing its token, and dropping the account on
 * that first unlucky request costs five minutes of cooldown; a couple of extra
 * sends cover it while still failing a page that never produces them.
 *
 * The FIRST send is given the shorter window (see FIRST_TRIGGER_GRACE_MS):
 * it pays the chats/new round trip before the completion request, so it needs
 * more than the old 3s but less than the full re-send grace. Attempt 2 is the
 * realistic recovery window; two attempts bound the reload cost of a truly
 * blocked page (WAF interstitial) at ~2x15s input waits; three only bought a
 * third reload that a WAF-detected page no longer performs.
 */
const HEADER_CAPTURE_TRIGGER_ATTEMPTS = 2;
/**
 * The Qwen chat-input selector family. The first alternative is the stable
 * Qwen-specific class; the rest guard against DOM churn (sibling textareas,
 * contenteditable editors, and the ARIA textbox role). Keeping this in one
 * constant makes future DOM updates a single-point change instead of inline
 * string edits inside triggerSend.
 */
export const CHAT_INPUT_SELECTOR =
  'textarea.message-input-textarea:visible, textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible';
/** Send-button selector family, in preference order, for header capture. */
const SEND_BUTTON_SELECTORS = [
  ".message-input-right-button-send .send-button",
  ".chat-prompt-send-button",
  "button.send-button",
];
/**
 * A healthy Qwen chat page renders its input within a couple of seconds. When
 * it never does, the page is blocked (WAF interstitial, punish document, or a
 * cold SPA that failed to hydrate) and page.focus would wait out the 60s page
 * default, freezing the whole capture. Bound the wait well under the header
 * budget so a stuck page reloads and retries instead of hanging.
 */
const CHAT_INPUT_APPEAR_TIMEOUT_MS = 15_000;
/** Per-action bound for focus/fill/type once the input is already visible. */
const CHAT_INPUT_ACTION_TIMEOUT_MS = 10_000;
/** Bound on the one-shot page-state probe used for WAF / input-miss diagnosis. */
const WAF_PAGE_PROBE_TIMEOUT_MS = 1_500;

/**
 * A challenge blocking the chat page makes the send button inert, so header
 * capture would wait out its whole timeout and report the account as broken.
 * Clearing the challenge first is what keeps that from cooling down a healthy
 * account for five minutes.
 */
async function clearVisibleChallenge(page: Page): Promise<void> {
  if (!config.captcha.enabled) return;
  // waitForMs 0: a single detection pass, so the common no-challenge case adds
  // no measurable cost to header capture.
  await solveBaxiaCaptcha(page, {
    waitForMs: 0,
    maxAttempts: config.captcha.maxAttempts,
    retryDelayMs: config.captcha.retryDelayMs,
    settleMs: config.captcha.settleMs,
  }).catch(() => false);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ChatPageBlock {
  kind: "waf" | null;
  reason?: string;
  markers: string[];
}

/**
 * Markers that alone prove the page is an anti-bot/WAF interstitial rather
 * than a healthy chat UI. Kept in the same spirit as isAntiBotChallengeText
 * (retry-policy.ts) and looksLikeAntiBotChallengeText (media-generation.ts):
 * every recognized variant normalizes to the same "waf" classification.
 */
const WAF_STRONG_MARKERS = [
  "just a moment",
  "attention required!",
  "cf-chl-",
  "challenge-platform",
  "challenges.cloudflare.com",
  "websiteprotection.net",
  "_____tmd_____",
  "____punish____",
  "punish",
  "fk_waf_challenge",
  "aliyun_waf",
  "x5secdata",
  "rgv587_error",
  "fail_sys_user_validate",
  "denyfromx5",
  "access denied",
  "请求被拦截",
  "操作过于频繁",
  "访问被拒绝",
] as const;

/**
 * Markers that only confirm a challenge page in combination (>=2 hits). A
 * healthy chat page can contain "captcha"/"验证码" in its own copy, so a single
 * generic hit is never enough to call the page blocked.
 */
const WAF_CONTEXT_MARKERS = [
  "captcha",
  "verify you are human",
  "verify you're human",
  "verify your browser",
  "human verification",
  "security verification",
  "安全验证",
  "滑动验证",
  "验证码",
  "turnstile",
  "hcaptcha",
] as const;

/**
 * Classify a chat-page state snapshot as WAF-blocked or not. Pure and
 * unit-testable: the DOM probe only supplies title/href/bodyText. Rationale:
 * a missing chat input alone only proves the SPA did not hydrate, whereas a
 * challenge marker set proves the page is deliberately blocking — and the
 * latter must fail the capture immediately instead of reloading into the same
 * needless 15s input waits.
 */
export function detectChatPageBlockText(input: {
  title?: string;
  bodyText?: string;
  href?: string;
}): ChatPageBlock {
  const haystack = [input.title, input.href, input.bodyText]
    .filter((s): s is string => !!s)
    .join("\n")
    .toLowerCase();
  const found: string[] = [];

  for (const marker of WAF_STRONG_MARKERS) {
    if (haystack.includes(marker)) found.push(marker);
  }
  let contextHits = 0;
  for (const marker of WAF_CONTEXT_MARKERS) {
    if (haystack.includes(marker)) {
      found.push(marker);
      contextHits++;
    }
  }
  const strongHit = found.some((m) => (WAF_STRONG_MARKERS as readonly string[]).includes(m));
  const waf = strongHit || contextHits >= 2;
  return {
    kind: waf ? "waf" : null,
    reason: waf
      ? `page shows an anti-bot challenge (${found.slice(0, 3).join(", ") || "unknown"})`
      : undefined,
    markers: found,
  };
}

/**
 * One-shot snapshot of the page's title/URL/body text, bounded so a frozen or
 * WAF-swallowed page cannot hang the caller. Returns null when the page is
 * closed, lacks evaluate (test doubles), or the probe times out — the caller
 * treats null as "no block evidence" (reload path).
 */
async function probeChatPageDom(
  page: Page,
): Promise<{ title: string; href: string; bodyText: string } | null> {
  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    return null;
  }
  if (typeof page.evaluate !== "function") return null;
  try {
    const snapshot = await withTimeout(
      page.evaluate(() => ({
        title: document.title || "",
        href: typeof window !== "undefined" ? window.location.href : "",
        bodyText: (document.body?.innerText || "").slice(0, 4000),
      })),
      WAF_PAGE_PROBE_TIMEOUT_MS,
      "chat page state probe timed out",
    );
    return snapshot as { title: string; href: string; bodyText: string };
  } catch {
    return null;
  }
}

/** Wrap the pure classifier over a live page. */
export async function detectChatPageBlock(page: Page): Promise<ChatPageBlock> {
  const snapshot = await probeChatPageDom(page);
  if (!snapshot) return { kind: null, markers: [] };
  return detectChatPageBlockText(snapshot);
}

/** Phrases that on their own prove the account is still awaiting activation. */
const ACTIVATION_STRONG_MARKERS = [
  "pending activation",
  "activate your account through the verification email",
] as const;
/** Generic phrases that only mean "activation screen" when BOTH are present. */
const ACTIVATION_CONTEXT_MARKERS = ["resend email", "check again"] as const;

export interface AccountActivationBlock {
  reason: string;
  markers: string[];
}

/**
 * Classify a page snapshot as the "account pending activation" screen. Pure and
 * unit-testable like detectChatPageBlockText above. The distinction matters:
 * a WAF block cools the account down for a retry, while an unconfirmed signup
 * mail can never be fixed by retrying — the account has to be parked as a
 * permanent auth failure instead of burning init attempts until it is BROKEN.
 */
export function detectAccountActivationBlockText(input: {
  title?: string;
  bodyText?: string;
  href?: string;
}): AccountActivationBlock | null {
  const haystack = [input.title, input.href, input.bodyText]
    .filter((s): s is string => !!s)
    .join("\n")
    .toLowerCase();

  const strong = ACTIVATION_STRONG_MARKERS.filter((marker) =>
    haystack.includes(marker),
  );
  if (strong.length > 0) {
    return {
      reason: `page shows the account activation screen (${strong[0]})`,
      markers: [...strong],
    };
  }

  const contextHits = ACTIVATION_CONTEXT_MARKERS.filter((marker) =>
    haystack.includes(marker),
  );
  if (contextHits.length === ACTIVATION_CONTEXT_MARKERS.length) {
    return {
      reason: `page shows the account activation screen (${contextHits.join(", ")})`,
      markers: [...contextHits],
    };
  }
  return null;
}

/** Wrap the pure activation classifier over a live page (one bounded probe). */
export async function detectAccountActivationBlock(
  page: Page,
): Promise<AccountActivationBlock | null> {
  const snapshot = await probeChatPageDom(page);
  if (!snapshot) return null;
  return detectAccountActivationBlockText(snapshot);
}

/**
 * Collapse a body-text dump into a single sanitized line for diagnostics:
 * control chars and runs of whitespace removed, length-capped.
 */
export function sanitizeBodySnippet(text: string, maxLength = 500): string {
  return String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\S ]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

/**
 * Write a diagnostic snapshot for a page that never rendered the chat UI
 * (WAF block, punish document, or an SPA that failed to hydrate). Best-effort:
 * a failing dump must never break the capture path it is reporting on.
 */
export async function dumpPlaywrightMiss(
  accountId: string,
  page: Page | undefined,
  opts: { reason: string; attempt?: number; markers?: string[] },
): Promise<void> {
  try {
    const snapshot = page ? await probeChatPageDom(page) : null;
    const dir = path.join(process.cwd(), "logs", "playwright_misses");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${accountId}-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          accountId,
          reason: opts.reason,
          attempt: opts.attempt ?? null,
          markers: opts.markers ?? [],
          url: snapshot?.href ?? "",
          title: snapshot?.title ?? "",
          bodySnippet: snapshot ? sanitizeBodySnippet(snapshot.bodyText) : "",
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Diagnostics never break the capture path.
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function getBrowserProcess(context: BrowserContext): KillableProcess | null {
  const browser = context.browser();
  const maybeBrowser = browser as unknown as {
    process?: () => KillableProcess | null;
  };
  return maybeBrowser.process?.() ?? null;
}

function touchAccountActivity(accountId: string): void {
  lastAccountActivity.set(accountId, Date.now());
}

/**
 * A browser generation hands the renderer the upstream fetch and returns
 * immediately, so the account mutex is free and no page operation happens for
 * the whole stream (see createQwenBrowserResponse in qwen.ts). Mutex idleness
 * plus a stale timestamp therefore describes a mid-flight account exactly like
 * a parked one — the stream lease is the only state held end to end, so the
 * maintenance paths have to ask for it before touching the page.
 */
function isAccountServingStream(accountId: string): boolean {
  if (!hasActiveAccountLease(accountId)) return false;
  // Keep the idle clock honest while the stream runs: without this the account
  // would count as idle since the request started, and a 10-minute generation
  // would be collectable the instant its lease is released.
  touchAccountActivity(accountId);
  return true;
}

export function getStealthScript(profile: FingerprintProfile): string {
  const profileJson = JSON.stringify(profile).replace(/</g, "\\u003c");
  return `
    (function() {
      const PROFILE = ${profileJson};

      function mulberry32(seed) {
        return function() {
          seed |= 0;
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      const canvasRng = mulberry32(PROFILE.canvasNoiseSeed);
      const audioRng = mulberry32(PROFILE.audioNoiseSeed);
      const webglRng = mulberry32(PROFILE.webglNoiseSeed);

      // --- Function.prototype.toString spoofing via WeakSet ---
      const nativeToString = Function.prototype.toString;
      const spoofedFunctions = new WeakSet();

      Function.prototype.toString = function() {
        if (spoofedFunctions.has(this)) {
          return 'function ' + (this.name || '') + '() { [native code] }';
        }
        return nativeToString.call(this);
      };
      spoofedFunctions.add(Function.prototype.toString);

      // --- Prototype-chain patching helper (harder to detect) ---
      function defineOnPrototype(obj, prop, value) {
        const proto = Object.getPrototypeOf(obj);
        if (!proto) return;
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (desc && desc.configurable) {
          const getter = typeof value === 'function' ? value : () => value;
          Object.defineProperty(proto, prop, {
            get: getter,
            configurable: true,
            enumerable: desc.enumerable !== false,
          });
          spoofedFunctions.add(getter);
        }
      }

      // --- navigator.webdriver ---
      try {
        const proto = Object.getPrototypeOf(navigator);
        const desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
        if (desc && desc.configurable) {
          Object.defineProperty(proto, 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true,
          });
          spoofedFunctions.add(Object.getOwnPropertyDescriptor(proto, 'webdriver').get);
        }
      } catch(e) {}

      // iframe-based webdriver bypass
      try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.documentElement.appendChild(iframe);
        const iframeNav = iframe.contentWindow.navigator;
        const cleanWebdriver = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(iframeNav), 'webdriver');
        if (cleanWebdriver && cleanWebdriver.get) {
          Object.defineProperty(Object.getPrototypeOf(iframeNav), 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true,
          });
        }
        document.documentElement.removeChild(iframe);
      } catch(e) {}

      // --- Identity ---
      defineOnPrototype(navigator, 'userAgent', PROFILE.userAgent);
      defineOnPrototype(navigator, 'appVersion', PROFILE.appVersion);
      defineOnPrototype(navigator, 'platform', 'Win32');

      // --- userAgentData ---
      try {
        const userAgentData = {
          brands: PROFILE.brands,
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async (hints) => {
            return {
              brands: PROFILE.fullVersionList,
              mobile: false,
              platform: 'Windows',
              platformVersion: PROFILE.platformVersion,
              architecture: PROFILE.architecture,
              bitness: PROFILE.bitness,
              model: '',
              uaFullVersion: PROFILE.chromeVersion,
              fullVersionList: PROFILE.fullVersionList,
              wow64: false,
            };
          },
          toJSON: () => ({
            brands: PROFILE.brands,
            mobile: false,
            platform: 'Windows',
          }),
        };
        defineOnPrototype(navigator, 'userAgentData', userAgentData);
      } catch(e) {}

      // --- Languages / hardware ---
      defineOnPrototype(navigator, 'languages', Object.freeze(PROFILE.languages));
      defineOnPrototype(navigator, 'language', PROFILE.locale);
      defineOnPrototype(navigator, 'hardwareConcurrency', PROFILE.hardwareConcurrency);
      defineOnPrototype(navigator, 'deviceMemory', PROFILE.deviceMemory);
      defineOnPrototype(navigator, 'maxTouchPoints', 0);
      defineOnPrototype(navigator, 'vendor', 'Google Inc.');
      defineOnPrototype(screen, 'colorDepth', PROFILE.colorDepth);
      defineOnPrototype(screen, 'pixelDepth', PROFILE.pixelDepth);

      // --- outerWidth/outerHeight (headless detection) ---
      try {
        if (window.outerWidth === 0 || window.outerHeight === 0) {
          Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + PROFILE.outerWidthOffset });
          Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + PROFILE.outerHeightOffset });
        }
      } catch(e) {}

      // --- chrome object (realistic) ---
      window.chrome = {
        runtime: {
          onConnect: Object.create(null),
          onMessage: Object.create(null),
          sendMessage: function() {},
          connect: function() { return { onMessage: Object.create(null), postMessage: function() {} }; },
        },
        loadTimes: function() {
          return {
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: false,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'http/1.1',
            wasAlternateProtocolAvailable: false,
            alternateProtocol: '',
          };
        },
        csi: function() {
          return {
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Math.random() * 1000,
            tran: 15,
          };
        },
        app: {
          isInstalled: false,
          getDetails: function() { return null; },
          getIsInstalled: function() { return false; },
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
      };

      // --- permissions ---
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default'), onchange: null })
          : originalQuery(parameters);
      spoofedFunctions.add(window.navigator.permissions.query);

      // --- WebGL getParameter ---
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return PROFILE.webglVendor;
        if (parameter === 37446) return PROFILE.webglRenderer;
        return getParameter.apply(this, arguments);
      };
      spoofedFunctions.add(WebGLRenderingContext.prototype.getParameter);

      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return PROFILE.webglVendor;
          if (parameter === 37446) return PROFILE.webglRenderer;
          return getParameter2.apply(this, arguments);
        };
        spoofedFunctions.add(WebGL2RenderingContext.prototype.getParameter);
      }

      // --- WebGL readPixels noise ---
      const _readPixels = WebGLRenderingContext.prototype.readPixels;
      WebGLRenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
        _readPixels.apply(this, arguments);
        if (pixels) {
          const maxPixels = Math.min(pixels.length, 10000);
          for (let i = 0; i < maxPixels; i++) {
            if (webglRng() < 0.03) {
              pixels[i] = Math.min(255, Math.max(0, pixels[i] + (webglRng() > 0.5 ? 1 : -1)));
            }
          }
        }
      };
      spoofedFunctions.add(WebGLRenderingContext.prototype.readPixels);

      if (typeof WebGL2RenderingContext !== 'undefined') {
        const _readPixels2 = WebGL2RenderingContext.prototype.readPixels;
        WebGL2RenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
          _readPixels2.apply(this, arguments);
          if (pixels) {
            const maxPixels = Math.min(pixels.length, 10000);
            for (let i = 0; i < maxPixels; i++) {
              if (webglRng() < 0.03) {
                pixels[i] = Math.min(255, Math.max(0, pixels[i] + (webglRng() > 0.5 ? 1 : -1)));
              }
            }
          }
        };
        spoofedFunctions.add(WebGL2RenderingContext.prototype.readPixels);
      }

      // --- navigator.connection ---
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });

      // --- Plugins / MimeTypes (realistic structure) ---
      (function() {
        function makeMime(desc, suffixes, type) {
          return { description: desc, suffixes: suffixes, type: type };
        }
        function attachPlugin(mime, plugin) {
          Object.defineProperty(mime, 'enabledPlugin', {
            value: plugin,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }
        const pdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
        const pdfxMime = makeMime('Portable Document Format', 'pdf', 'text/pdf');
        const pdfPlugin = {
          name: 'PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: pdfMime,
          1: pdfxMime,
        };
        attachPlugin(pdfMime, pdfPlugin);
        attachPlugin(pdfxMime, pdfPlugin);

        const chromePdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
        const chromePdfMime2 = makeMime('Portable Document Format', 'pdf', 'text/pdf');
        const chromePdfPlugin = {
          name: 'Chrome PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: chromePdfMime,
          1: chromePdfMime2,
        };
        attachPlugin(chromePdfMime, chromePdfPlugin);
        attachPlugin(chromePdfMime2, chromePdfPlugin);

        const nativePlugin = {
          name: 'Native Client',
          description: '',
          filename: 'internal-nacl-plugin',
          length: 2,
          0: makeMime('Native Client Executable', '', 'application/x-nacl'),
          1: makeMime('Portable Native Client Executable', '', 'application/x-pnacl'),
        };
        attachPlugin(nativePlugin[0], nativePlugin);
        attachPlugin(nativePlugin[1], nativePlugin);
        const pluginsList = [pdfPlugin, chromePdfPlugin, nativePlugin];
        const mimeList = [pdfMime, pdfxMime, chromePdfMime, chromePdfMime2, nativePlugin[0], nativePlugin[1]];

        function makeNamedNodeMap(items, namedEntries) {
          const arr = [...items];
          for (const [k, v] of namedEntries) arr[k] = v;
          arr.item = function(i) { return this[i] || null; };
          arr.namedItem = function(name) { return this[name] || null; };
          arr.refresh = function() {};
          return arr;
        }

        const pluginEntries = pluginsList.map((p) => [p.name, p]);
        const mimeEntries = mimeList.map((m) => [m.type, m]);

        const pluginsArr = makeNamedNodeMap(pluginsList, pluginEntries);
        const mimeArr = makeNamedNodeMap(mimeList, mimeEntries);

        defineOnPrototype(navigator, 'plugins', pluginsArr);
        defineOnPrototype(navigator, 'mimeTypes', mimeArr);
      })();

      // --- Canvas fingerprint noise ---
      (function() {
        const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
        const _toBlob = HTMLCanvasElement.prototype.toBlob;
        const _getImageData = CanvasRenderingContext2D.prototype.getImageData;

        function addNoise(canvas) {
          try {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const style = ctx.fillStyle;
            ctx.fillStyle = 'rgba(255,255,255,0.01)';
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = style;
          } catch(e) {}
        }

        HTMLCanvasElement.prototype.toDataURL = function(...args) {
          addNoise(this);
          return _toDataURL.apply(this, args);
        };
        spoofedFunctions.add(HTMLCanvasElement.prototype.toDataURL);

        HTMLCanvasElement.prototype.toBlob = function(...args) {
          addNoise(this);
          return _toBlob.apply(this, args);
        };
        spoofedFunctions.add(HTMLCanvasElement.prototype.toBlob);

        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
          const imageData = _getImageData.apply(this, arguments);
          const data = imageData.data;
          const maxPixels = Math.min(data.length / 4, 2500);
          for (let i = 0; i < maxPixels * 4; i += 4) {
            if (canvasRng() < 0.05) {
              data[i] = Math.min(255, Math.max(0, data[i] + (canvasRng() > 0.5 ? 1 : -1)));
              data[i+1] = Math.min(255, Math.max(0, data[i+1] + (canvasRng() > 0.5 ? 1 : -1)));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + (canvasRng() > 0.5 ? 1 : -1)));
            }
          }
          return imageData;
        };
        spoofedFunctions.add(CanvasRenderingContext2D.prototype.getImageData);
      })();

      // --- Audio fingerprint noise ---
      (function() {
        if (typeof OfflineAudioContext === 'undefined') return;
        const _startRendering = OfflineAudioContext.prototype.startRendering;
        OfflineAudioContext.prototype.startRendering = function() {
          return _startRendering.apply(this, arguments).then(buffer => {
            try {
              for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < Math.min(data.length, 100); i++) {
                  data[i] += (audioRng() - 0.5) * 1e-7;
                }
              }
            } catch(e) {}
            return buffer;
          });
        };
        spoofedFunctions.add(OfflineAudioContext.prototype.startRendering);
      })();

      // --- Remove ChromeDriver artifacts ---
      try {
        const keys = Object.keys(document);
        for (const key of keys) {
          if (key.startsWith('$cdc_') || key.startsWith('$wdc_')) {
            delete document[key];
          }
        }
      } catch(e) {}

      // --- Filter performance entries (hide addInitScript traces) ---
      try {
        if (window.performance && window.performance.getEntriesByType) {
          const originalGetEntries = window.performance.getEntriesByType.bind(window.performance);
          window.performance.getEntriesByType = function(type) {
            const entries = originalGetEntries(type);
            if (type === 'resource') {
              return entries.filter(e => !e.name.includes('__injectedScript') && !e.name.includes('addInitScript'));
            }
            return entries;
          };
          spoofedFunctions.add(window.performance.getEntriesByType);
        }
      } catch(e) {}
    })();
  `;
}

function getHeaderCache(accountId: string): AccountHeaderCache {
  let cache = headerCaches.get(accountId);
  if (!cache) {
    cache = {
      headers: {},
      lastRefresh: 0,
      refreshInProgress: false,
    };
    headerCaches.set(accountId, cache);
  }
  return cache;
}

/**
 * The web client's access token (Authorization: Bearer <jwt>) is issued with a
 * 15-minute expiry and lives in localStorage["token"]. Upstream authenticates
 * on it: without it the Aliyun SM/WAF punishes the completion request
 * (FAIL_SYS_USER_VALIDATE → _____tmd_____/punish) and JSON endpoints answer
 * `{"code":"unauthorized"}`. The cookie `token` (30 days) is NOT accepted as a
 * bearer — it only authenticates cookie-bearing requests.
 */
const AUTH_TOKEN_MIN_LIFETIME_MS = 30_000;
/** localStorage is re-read at most this often (it is an IPC round trip). */
const AUTH_STORAGE_READ_INTERVAL_MS = 10_000;
/** Recaptures that exist only to obtain a fresh access token are throttled. */
const AUTH_RECAPTURE_MIN_INTERVAL_MS = 60_000;

interface AuthorizationMemo {
  token: string;
  expMs: number | null;
  readAt: number;
}

const authorizationMemos = new Map<string, AuthorizationMemo>();
const lastAuthRecaptureAt = new Map<string, number>();

function decodeJwtExpMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const json = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function asBearer(value: string): string {
  return /^bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}

async function readAuthorizationFromStorage(
  page: Page,
): Promise<AuthorizationMemo | null> {
  try {
    const raw = await page.evaluate(() => {
      try {
        return localStorage.getItem("token");
      } catch {
        return null;
      }
    });
    if (!raw) return null;
    return { token: raw, expMs: decodeJwtExpMs(raw), readAt: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Bearer the relayed request must carry: the app's own token from
 * localStorage, else the last bearer the real browser sent during capture.
 * Returns "" when neither is usable, which must force a recapture — never a
 * request with no credentials (see getBasicHeaders).
 */
async function resolveAuthorization(
  accountId: string,
  page: Page,
  cache: AccountHeaderCache,
  forceRead = false,
): Promise<string> {
  const now = Date.now();
  const usable = (token: string, expMs: number | null): boolean =>
    Boolean(token) &&
    (expMs === null || expMs - now > AUTH_TOKEN_MIN_LIFETIME_MS);

  const memo = authorizationMemos.get(accountId);
  const dueForRead =
    forceRead ||
    !memo ||
    now - memo.readAt >= AUTH_STORAGE_READ_INTERVAL_MS ||
    (memo.expMs !== null && memo.expMs - now <= AUTH_TOKEN_MIN_LIFETIME_MS);
  if (dueForRead) {
    const stored = await readAuthorizationFromStorage(page);
    if (stored) authorizationMemos.set(accountId, stored);
    else authorizationMemos.delete(accountId);
  }

  const current = authorizationMemos.get(accountId);
  if (current && usable(current.token, current.expMs)) {
    return asBearer(current.token);
  }

  const captured = String(cache.headers["authorization"] || "").trim();
  if (captured) {
    const bare = captured.replace(/^bearer\s+/i, "");
    if (usable(bare, decodeJwtExpMs(bare))) return asBearer(captured);
  }
  return "";
}

/**
 * Headers the capture must produce before a request may reach Qwen. With
 * QWEN_SEND_BX_UA=false (default, matching the real client) only the
 * cookie/UA/bx-v trio is required; bx-ua/bx-umidtoken are captured but never
 * injected, so their absence must not gate the pipeline.
 */
function requiredAntiBotHeaderKeys(): string[] {
  return config.qwen.sendBxUa
    ? ["cookie", "user-agent", "bx-ua", "bx-umidtoken", "bx-v"]
    : ["cookie", "user-agent", "bx-v"];
}

export function hasRequiredQwenHeaders(
  headers: Record<string, string>,
): boolean {
  return requiredAntiBotHeaderKeys().every((key) => Boolean(headers[key]?.trim()));
}

/**
 * Validate that all required anti-bot headers are present before making a
 * request. Fails early instead of sending an incomplete request that will
 * certainly be blocked by the WAF.
 */
export function assertAntiBotHeaders(
  headers: Record<string, string>,
  label: string,
): void {
  const missing = requiredAntiBotHeaderKeys().filter(
    (key) => !headers[key]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} missing required browser anti-bot headers: ${missing.join(", ")}`,
    );
  }
}

/**
 * Lightweight cookie refresh: update only the cookie string without a full
 * header re-capture. Used when the header cache is still valid but cookies
 * may have rotated.
 */
async function tryLightweightCookieRefresh(
  accountId: string,
  cache: AccountHeaderCache,
): Promise<boolean> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) return false;

  if (!hasRequiredQwenHeaders(cache.headers)) return false;

  try {
    const cookies = await withTimeout(
      page.context().cookies(),
      config.timeouts.page,
      `Cookie refresh timed out for ${accountId}`,
    );
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    cookieCaches.set(accountId, { cookie: cookieStr, timestamp: Date.now() });
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getCookies(accountId: string): Promise<string> {
  const now = Date.now();
  const cached = cookieCaches.get(accountId);
  if (cached && now - cached.timestamp < COOKIE_CACHE_TTL) {
    return cached.cookie;
  }

  const page = accountPages.get(accountId);
  if (!page) return "";

  const cookies = await withTimeout(
    page.context().cookies(),
    config.timeouts.page,
    `Cookie retrieval timed out for ${accountId}`,
  );
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  if (!/(^|;\s*)token=/.test(cookieStr)) {
    logger.warn("[Playwright] Cookie string missing token cookie", {
      accountId,
      cookieNames: cookies.map((c) => c.name),
      cached: Boolean(cached),
    });
  }
  cookieCaches.set(accountId, { cookie: cookieStr, timestamp: now });
  return cookieStr;
}

export async function getBasicHeaders(accountId: string): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  version: string;
  authorization: string;
}> {
  const page = accountPages.get(accountId);
  if (!page) {
    throw new Error(`Playwright not initialized for account: ${accountId}`);
  }

  // Acquire mutex to prevent concurrent browser access
  const release = await acquireAccountMutex(
    accountId,
    `headers:${accountId.substring(0, 12)}`,
  );
  try {
    touchAccountActivity(accountId);
    // Get real user agent + client hints from the browser. They are constant
    // for the lifetime of the context, so they are fetched once and cached per
    // account to avoid CDP round-trips on every request. The client-hint
    // headers (sec-ch-ua / platform / mobile) are derived from the live
    // browser so the anti-bot fingerprint stays current instead of a hardcoded
    // Chrome version.
    let userAgent = cachedUserAgents.get(accountId) ?? "";
    let clientHints = {
      secChUa: "",
      secChUaMobile: "?0",
      secChUaPlatform: "",
      version: getQwenWebVersion(),
    };
    try {
      if (!userAgent) {
        const nav = await withTimeout(
          page.evaluate(() => {
            const ua = navigator.userAgent;
            const data = (navigator as unknown as {
              userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean };
            }).userAgentData;
            let secChUa = "";
            let platform = "";
            let mobile = "?0";
            if (data?.brands && Array.isArray(data.brands)) {
              secChUa = data.brands
                .map((b) => `${JSON.stringify(b.brand)};v="${b.version}"`)
                .join(", ");
              platform = data.platform || "";
              mobile = data.mobile ? "?1" : "?0";
            }
            let bundleVersion: string | null = null;
            try {
              const el = document.querySelector('link[href*="qwen-chat-fe"], script[src*="qwen-chat-fe"], img[src*="qwen-chat-fe"]');
              const src = el ? (el.getAttribute("href") || el.getAttribute("src") || "") : "";
              const match = src.match(/qwen-chat-fe\/(\d+\.\d+\.\d+)/) || document.documentElement.innerHTML.match(/qwen-chat-fe\/(\d+\.\d+\.\d+)/);
              if (match) bundleVersion = match[1];
            } catch {}
            return { ua, secChUa, platform, mobile, bundleVersion };
          }),
          config.timeouts.page,
          `User-agent lookup timed out for ${accountId}`,
        );
        userAgent = nav.ua;
        if (nav.bundleVersion) {
          updateQwenWebVersion(nav.bundleVersion);
        }
        cachedUserAgents.set(accountId, userAgent);
        const hints = getHeaderCache(accountId).headers;
        clientHints = {
          secChUa: nav.secChUa,
          secChUaMobile: nav.mobile,
          secChUaPlatform: nav.platform ? JSON.stringify(nav.platform) : "",
          version: nav.bundleVersion || hints["version"] || getQwenWebVersion(),
        };
        if (nav.secChUa) hints["sec-ch-ua"] = nav.secChUa;
        hints["sec-ch-ua-mobile"] = nav.mobile;
        if (nav.platform) hints["sec-ch-ua-platform"] = nav.platform;
      } else {
        const hints = getHeaderCache(accountId).headers;
        clientHints = {
          secChUa: hints["sec-ch-ua"] || "",
          secChUaMobile: hints["sec-ch-ua-mobile"] || "?0",
          secChUaPlatform: hints["sec-ch-ua-platform"] || "",
          version: hints["version"] || getQwenWebVersion(),
        };
      }
    } catch {
      userAgent = config.auth.userAgent;
    }

    const cache = getHeaderCache(accountId);
    const hadUsableHeaders = hasRequiredQwenHeaders(cache.headers);

    // Resolve the bearer the relayed request must carry. Both fast paths are
    // closed without it: relaying cookie-only headers is what upstream punishes
    // (see AUTH_TOKEN_MIN_LIFETIME_MS), so a missing token falls through to the
    // recapture below instead of being served from a stale-but-"usable" cache.
    let authorization = await resolveAuthorization(accountId, page, cache);

    // Fast path: if headers are still fresh, just refresh cookies lightly
    const headersAge = Date.now() - cache.lastRefresh;
    if (
      hadUsableHeaders &&
      authorization &&
      headersAge < HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD
    ) {
      await tryLightweightCookieRefresh(accountId, cache);
      markAccountHeadersReady(accountId);
      const bxUa = cache.headers["bx-ua"];
      const bxUmidtoken = cache.headers["bx-umidtoken"];
      const bxV = cache.headers["bx-v"] || "2.5.37";
      const cookie = await getCookies(accountId);
      return { cookie, userAgent, bxV, bxUa, bxUmidtoken, authorization, ...clientHints };
    }

    // Extended fast path: headers are stale but auth token is still valid.
    // Check if we can skip full recapture by verifying cookie validity.
    // This avoids expensive browser interaction when the 30-day token is fresh.
    if (hadUsableHeaders && authorization && headersAge > HEADER_CACHE_TTL) {
      // A single CDP cookies() snapshot feeds both validity checks and the
      // cookie string (previously 3 round-trips: 2 validators + lightweight
      // refresh).
      const cookieSnapshot = await getCookieSnapshot(accountId);
      if (
        cookieSnapshot &&
        isAuthTokenValidFrom(cookieSnapshot) &&
        isShortestCookieValidFrom(cookieSnapshot)
      ) {
        // Token is still valid - just refresh cookies, keep cached headers
        const cookie = cookieSnapshot
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        cookieCaches.set(accountId, { cookie, timestamp: Date.now() });
        const bxUa = cache.headers["bx-ua"];
        const bxUmidtoken = cache.headers["bx-umidtoken"];
        const bxV = cache.headers["bx-v"] || "2.5.37";
        cache.lastRefresh = Date.now();
        markAccountHeadersReady(accountId);
        console.log(
          `🔄 [Playwright] Skipped header recapture for ${accountId} (token still valid, age: ${Math.round(headersAge / 60000)} min)`,
        );
        return { cookie, userAgent, bxV, bxUa, bxUmidtoken, authorization, ...clientHints };
      }
    }

    // No usable access token: the fast paths above are all closed, and any
    // request built from this cache would reach upstream with no credentials.
    // A navigation is what makes the SPA mint a new one (localStorage["token"]),
    // and the capture that follows stores the bearer the browser then sends.
    if (!authorization && !cache.refreshInProgress) {
      const lastForced = lastAuthRecaptureAt.get(accountId) ?? 0;
      if (Date.now() - lastForced >= AUTH_RECAPTURE_MIN_INTERVAL_MS) {
        lastAuthRecaptureAt.set(accountId, Date.now());
        console.warn(
          `🔐 [Playwright] No valid Qwen access token for ${accountId}; forcing header recapture`,
        );
        try {
          await refreshHeadersInternal(accountId);
        } catch (error) {
          console.warn(
            `❌ [Playwright] Access-token recapture failed for ${accountId}: ${getErrorMessage(error)}`,
          );
        }
        const livePage = accountPages.get(accountId);
        authorization = await resolveAuthorization(
          accountId,
          livePage && !livePage.isClosed() ? livePage : page,
          cache,
          true,
        );
      }
    }

    // Refresh headers if stale. A valid cached set remains usable when a
    // browser recapture transiently fails; a cold/partial cache must fail.
    if (headersAge > HEADER_CACHE_TTL && !cache.refreshInProgress) {
      try {
        await refreshHeadersInternal(accountId);
      } catch (error) {
        if (!hadUsableHeaders) throw error;
        console.warn(
          `⚠️  [Playwright] Header refresh failed for ${accountId}; retaining the previous valid cache: ${getErrorMessage(error)}`,
        );
      }
    } else if (
      hadUsableHeaders &&
      headersAge > HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD &&
      !cache.refreshInProgress
    ) {
      // Background refresh at 70% TTL: keep headers fresh without blocking
      cache.refreshInProgress = true;
      refreshHeadersInternal(accountId)
        .catch((error) => {
          console.warn(
            `⚠️  [Playwright] Background header refresh failed for ${accountId}: ${getErrorMessage(error)}`,
          );
        })
        .finally(() => {
          cache.refreshInProgress = false;
        });
    }

    if (!hasRequiredQwenHeaders(cache.headers)) {
      console.log(
        `🔄 [Playwright] Missing required anti-bot headers for ${accountId}, triggering header interception...`,
      );
      try {
        await refreshHeadersInternal(accountId);
      } catch (error) {
        console.warn(
          `❌ [Playwright] Failed to auto-recover headers for ${accountId}: ${getErrorMessage(error)}`,
        );
      }
    }

    if (!hasRequiredQwenHeaders(cache.headers)) {
      throw new Error(
        `Required Qwen anti-fraud headers are unavailable for account: ${accountId}`,
      );
    }

    // Recaptures above (stale, missing anti-bot headers, or missing access
    // token) may have produced a new bearer; re-read it before deciding.
    if (!authorization) {
      const livePage = accountPages.get(accountId);
      authorization = await resolveAuthorization(
        accountId,
        livePage && !livePage.isClosed() ? livePage : page,
        cache,
        true,
      );
    }
    if (!authorization) {
      throw new Error(
        `Qwen access token (authorization) is unavailable for account: ${accountId}`,
      );
    }

    markAccountHeadersReady(accountId);
    const bxUa = cache.headers["bx-ua"];
    const bxUmidtoken = cache.headers["bx-umidtoken"];
    const bxV = cache.headers["bx-v"] || "2.5.37";

    // Read cookie AFTER all refreshes (re-login may have updated it)
    const cookie = await getCookies(accountId);

    return {
      cookie,
      userAgent,
      bxV,
      bxUa,
      bxUmidtoken,
      authorization,
      ...clientHints,
    };
  } finally {
    release();
  }
}

async function resolveAccountCredentials(account: QwenAccount): Promise<QwenAccount> {
  if (account.password && account.password !== "***") {
    return account;
  }
  try {
    const { getAccountCredentials } = await import("../core/accounts.ts");
    const creds = getAccountCredentials(account.id);
    if (creds && creds.password && creds.password !== "***") {
      return creds;
    }
  } catch {}
  throw new Error(
    `Account ${account.id} credentials unresolved: password is masked and store lookup failed`,
  );
}

export async function initPlaywrightForAccount(
  rawAccount: QwenAccount,
  headless = true,
  browserType: BrowserType = "chromium",
): Promise<void> {
  let account: QwenAccount;
  try {
    account = await resolveAccountCredentials(rawAccount);
  } catch (error) {
    // Credentials that cannot be resolved are never fixed by a retry.
    if (isPermanentInitFailure(error)) {
      markPermanentInitFailure(rawAccount.id, getErrorMessage(error));
    }
    throw error;
  }

  // One absolute deadline for the WHOLE init: queue wait, launch, login,
  // session validation and header capture. Every step below is bounded by the
  // time it leaves, the body is raced against the deadline, and the mutex is
  // released in the finally on EVERY path (see PLAYWRIGHT_INIT_TIMEOUT_MS).
  const deadlineMs = Date.now() + PLAYWRIGHT_INIT_TIMEOUT_MS;

  const release = await acquireAccountMutex(
    account.id,
    `init:${account.id.substring(0, 12)}`,
    Math.max(1_000, deadlineMs - Date.now()),
  );
  const cancel = new AbortController();
  accountCancelControllers.set(account.id, cancel);
  const remainingMs = (): number => Math.max(1, deadlineMs - Date.now());
  try {
    const live = accountPages.get(account.id);
    if (live && !live.isClosed()) {
      // Another path won the race while we queued; its context is live.
      console.log(
        `[Playwright] Already initialized for ${maskEmail(account.email)}`,
      );
      return;
    }
    if (live) {
      // A closed page left in the map made init report "success" for an
      // account whose context is gone, so the pool counted it as warmed.
      console.warn(
        `[Playwright] Dropping closed context before re-init | account=${account.id}`,
      );
      await dropDeadAccountContext(account.id);
    }

    const work = withPlaywrightInitSlot(
      async () => {
    assertInitProgress(account.id, cancel.signal, "queued", deadlineMs);

    // If a context limit is configured, make room by closing idle contexts.
    // Bounded: this takes OTHER accounts' mutexes (60s waits each) and must
    // not spend the whole init budget before this account even launches.
    await withTimeout(
      evictIdlePlaywrightContextsToLimit().catch((error: unknown) => {
        logger.warn("[Playwright] idle eviction cleanup suppressed", {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.increment("browser.close.suppressed_errors");
      }),
      Math.min(remainingMs(), 20_000),
      `Idle eviction timed out during init of ${account.id}`,
    ).catch((error: unknown) => {
      logger.warn("[Playwright] idle eviction bounded", {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Hard cap: no launch without a free context slot. Waiting here is bounded
    // by the init deadline (minus 1s so a denial is reported as an admission
    // error instead of losing the race to the generic init-deadline timeout);
    // at the ceiling this throws before a browser is spawned (see
    // acquireContextAdmission).
    await acquireContextAdmission(account.id, deadlineMs - 1_000);

    const profilePath = getAccountProfilePath(account.id);
    const fingerprint = getFingerprintProfile(account.id);
    const { engine, channel } = resolveBrowserEngine(browserType);

    const launchOptions = {
      headless,
      channel,
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      viewport: fingerprint.viewport,
      screen: fingerprint.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: "light" as const,
      extraHTTPHeaders: {
        "sec-ch-ua": fingerprint.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features"],
      args: buildChromiumLaunchArgs(fingerprint.viewport),
      // Never launch past the init budget (Playwright's own default is 30s).
      timeout: Math.min(remainingMs(), 30_000),
    };

    let acctContext: BrowserContext;
    try {
      acctContext = await engine.launchPersistentContext(profilePath, launchOptions);
    } catch (launchErr: any) {
      if (launchErr?.message?.includes("Executable doesn't exist")) {
        autoInstallPlaywrightChromium();
        acctContext = await engine.launchPersistentContext(profilePath, launchOptions);
      } else {
        throw launchErr;
      }
    }

    try {
      const v = acctContext.browser()?.version();
      if (v) {
        const major = parseInt(v.split(".")[0], 10);
        if (major >= 100) {
          updateChromeMajor(major);
        }
      }
    } catch {}

    try {
      // From here on any throw must take the context with it: a half-initialized
      // context left in the maps is what the next attempt used to "reuse".
      assertInitProgress(account.id, cancel.signal, "launch", deadlineMs);
      // Comprehensive stealth scripts for anti-bot evasion
      await acctContext.addInitScript(getStealthScript(fingerprint));
      for (const hook of contextInitHooks) {
        await hook(acctContext);
      }

      // If native profile cookies are empty but a fresh backup
      // storage_state.json exists, restore its still-valid cookies.
      const restorableCookies = getRestorableCookies(account.id);
      if (restorableCookies.length > 0) {
        const currentCookies = await acctContext.cookies();
        if (currentCookies.length === 0) {
          await acctContext.addCookies(restorableCookies).catch((error: unknown) => {
            logger.warn("[Playwright] cookie restore suppressed", {
              accountId: account.id,
              error: error instanceof Error ? error.message : String(error),
            });
            metrics.increment("browser.close.suppressed_errors");
          });
        }
      }

      // Persistent contexts may already contain an initial about:blank tab.
      // Reuse it instead of creating a second tab. Prefer a tab already on the
      // Qwen origin when one exists.
      const existingPages = acctContext.pages().filter((p) => !p.isClosed());
      const acctPage =
        existingPages.find((p) => p.url().startsWith(qwenOrigin())) ??
        existingPages[0] ??
        (await acctContext.newPage());

      // Close any extra blank tabs that may have been created by the browser
      // profile/startup, but keep the primary page selected above.
      for (const extraPage of existingPages.slice(1)) {
        if (extraPage !== acctPage && extraPage.url() === "about:blank") {
          await extraPage.close({ runBeforeUnload: false }).catch((error: unknown) => {
            logger.warn("[Playwright] extra page close suppressed", {
              accountId: account.id,
              error: error instanceof Error ? error.message : String(error),
            });
            metrics.increment("browser.close.suppressed_errors");
          });
        }
      }

      acctPage.setDefaultTimeout(config.timeouts.page);
      acctPage.setDefaultNavigationTimeout(config.timeouts.navigation);
      accountContexts.set(account.id, acctContext);
      accountPages.set(account.id, acctPage);
      installContextDeathHandlers(account.id, acctContext, acctPage);
      touchAccountActivity(account.id);

      // Check if already logged in
      const cookies = await acctContext.cookies();
      const hasAuthCookie = cookies.some(
        (c) =>
          c.name.toLowerCase().includes("token") ||
          c.name.toLowerCase().includes("session"),
      );

      if (!hasAuthCookie && account.email && account.password) {
        assertInitProgress(account.id, cancel.signal, "login", deadlineMs);
        // Bounded: loginToQwen runs up to 3 API+UI attempts with backoff and
        // would happily spend the whole budget before header capture starts.
        // On expiry we fail the init (the throw closes the context) instead of
        // letting a background login keep navigating the page under capture.
        await withTimeout(
          loginToQwen(account.id, account.email, account.password),
          Math.min(
            remainingMs(),
            Math.max(20_000, Math.floor(PLAYWRIGHT_INIT_TIMEOUT_MS * 0.4)),
          ),
          `Login timed out during init of ${account.id}`,
        );
      }

      // Navigate to the stable chat page to validate the session and populate cookies.
      // Retry up to 2 times on transient timeouts before giving up.
      const maxValidationAttempts = 2;
      let validationError: Error | null = null;
      for (let vAttempt = 1; vAttempt <= maxValidationAttempts; vAttempt++) {
        assertInitProgress(account.id, cancel.signal, "validation", deadlineMs);
        try {
          await acctPage.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeouts.navigation, remainingMs()),
          });
          const loggedIn = await isPageLoggedIn(acctPage);
          if (!loggedIn) {
            if (account.email && account.password) {
              console.warn(
                `⚠️  [Playwright] Session expired for ${maskEmail(account.email)}, re-authenticating...`,
              );
              const ok = await withTimeout(
                loginToQwen(account.id, account.email, account.password),
                Math.min(
                  remainingMs(),
                  Math.max(15_000, Math.floor(PLAYWRIGHT_INIT_TIMEOUT_MS * 0.3)),
                ),
                `Re-login timed out during init of ${account.id}`,
              );
              if (!ok) {
                validationError = new Error(
                  `Session expired for ${maskEmail(account.email)} and re-authentication failed`,
                );
                continue;
              }
            } else {
              validationError = new Error(
                `Session expired for account ${account.id} but no credentials available for re-login (run 'qpx login')`,
              );
              break;
            }
          }
          validationError = null;
          break;
        } catch (err: any) {
          validationError = err;
          if (vAttempt < maxValidationAttempts) {
            console.warn(
              `⚠️  [Playwright] Session validation attempt ${vAttempt}/${maxValidationAttempts} failed for ${maskEmail(account.email)}: ${err.message}, retrying...`,
            );
            await sleep(Math.min(3000, remainingMs()));
          }
        }
      }
      if (validationError) {
        console.warn(
          `❌ [Playwright] Failed to validate session for ${maskEmail(account.email)} after ${maxValidationAttempts} attempts: ${validationError.message}`,
        );
        throw validationError;
      }

      // The capture gets whatever is left of the budget, never more than the
      // configured header window: capture used to start a fresh 90s from now
      // (after queueing for an op slot), which is how an init ended up holding
      // its mutex well past the controller's own timeout.
      assertInitProgress(account.id, cancel.signal, "capture", deadlineMs);
      await captureQwenHeaders(
        account.id,
        undefined,
        Math.min(config.timeouts.headers, remainingMs()),
      );
      assertInitProgress(account.id, cancel.signal, "post-capture", deadlineMs);

      // Header capture may leave the UI on a generated chat page. Return the
      // primary tab to the canonical chat home.
      if (!acctPage.isClosed()) {
        try {
          const currentUrl = new URL(acctPage.url());
          if (currentUrl.origin !== qwenOrigin() || currentUrl.pathname !== "/") {
            await acctPage.goto(qwenUrl("/"), {
              waitUntil: "domcontentloaded",
              timeout: Math.min(config.timeouts.navigation, remainingMs()),
            });
          }
        } catch {
          // Non-fatal: the next normal operation will navigate back.
        }
      }

      touchAccountActivity(account.id);
    } catch (error) {
      await closePlaywrightContextBestEffort(account.id, acctContext, { skipStorageSave: true });
      await cleanupPlaywrightAccountState(account.id);
      throw error;
    }
      },
      deadlineMs,
    );

    try {
      await withTimeout(
        work,
        remainingMs(),
        `Playwright init deadline exceeded after ${PLAYWRIGHT_INIT_TIMEOUT_MS}ms for ${account.id}`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("Playwright init deadline exceeded")) {
        // Hard stop: the body is still running in the background. Cancel it and
        // tear the context down so it cannot keep a browser alive, keep queuing
        // on slots, or flip the account's state behind our back — the body's
        // own catch then finds nothing left to clean up.
        console.warn(
          `⏱️  [Playwright] Init deadline hit | account=${account.id} | budget=${PLAYWRIGHT_INIT_TIMEOUT_MS}ms | cancelling and closing context`,
        );
        cancelAccountBrowserWork(account.id, "init deadline exceeded");
        await dropDeadAccountContext(account.id);
      }
      if (isPermanentInitFailure(error)) {
        markPermanentInitFailure(account.id, message);
      }
      throw error;
    }
  } finally {
    release();
    if (accountCancelControllers.get(account.id) === cancel) {
      accountCancelControllers.delete(account.id);
    }
  }
}

/**
 * Close whatever context is registered for the account and forget its state.
 * Idempotent: both the init body's catch and the deadline teardown may run it
 * for the same failed init.
 */
async function dropDeadAccountContext(accountId: string): Promise<void> {
  const context = accountContexts.get(accountId);
  if (context) {
    await closePlaywrightContextBestEffort(accountId, context, {
      skipStorageSave: true,
    }).catch(() => {});
  }
  await cleanupPlaywrightAccountState(accountId);
}

// ─── Standby Validation ──────────────────────────────────────────────────────

/**
 * Validate that an account can log in without keeping the browser open.
 * Opens browser, checks session, logs in if needed, then closes browser.
 * This is much lighter than full initPlaywrightForAccount (no header capture).
 */
export async function validateAccountLogin(
  rawAccount: QwenAccount,
  headless = true,
  browserType: BrowserType = "chromium",
): Promise<boolean> {
  const account = await resolveAccountCredentials(rawAccount);
  if (accountPages.has(account.id)) {
    // Already initialized, no need to validate
    return true;
  }

  const release = await acquireAccountMutex(
    account.id,
    `validate:${account.id.substring(0, 12)}`,
  );
  try {
    if (accountPages.has(account.id)) return true;
    // Same hard cap as a full init: validation also spawns a browser, so it
    // waits for a slot too (bounded — validation is a short maintenance step).
    await acquireContextAdmission(
      account.id,
      Date.now() + Math.min(PLAYWRIGHT_INIT_TIMEOUT_MS, 30_000),
    );
    const profilePath = getAccountProfilePath(account.id);
    const fingerprint = getFingerprintProfile(account.id);
    const { engine, channel } = resolveBrowserEngine(browserType);
    const launchOptions = {
      headless,
      channel,
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      viewport: fingerprint.viewport,
      screen: fingerprint.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: "light" as const,
      extraHTTPHeaders: {
        "sec-ch-ua": fingerprint.secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      ignoreDefaultArgs: ["--enable-automation", "--enable-blink-features"],
      args: buildChromiumLaunchArgs(fingerprint.viewport),
    };

    let acctContext: BrowserContext;
    try {
      acctContext = await engine.launchPersistentContext(profilePath, launchOptions);
    } catch (launchErr: any) {
      if (launchErr?.message?.includes("Executable doesn't exist")) {
        autoInstallPlaywrightChromium();
        acctContext = await engine.launchPersistentContext(profilePath, launchOptions);
      } else {
        throw launchErr;
      }
    }

    try {
      await acctContext.addInitScript(getStealthScript(fingerprint));

      // If native profile cookies are empty but a fresh backup
      // storage_state.json exists, restore its still-valid cookies.
      const restorableCookies = getRestorableCookies(account.id);
      if (restorableCookies.length > 0) {
        const currentCookies = await acctContext.cookies();
        if (currentCookies.length === 0) {
          await acctContext.addCookies(restorableCookies).catch((error: unknown) => {
            logger.warn("[Playwright] cookie restore suppressed", {
              accountId: account.id,
              error: error instanceof Error ? error.message : String(error),
            });
            metrics.increment("browser.close.suppressed_errors");
          });
        }
      }

      const existingPages = acctContext.pages().filter((p) => !p.isClosed());
      const acctPage =
        existingPages.find((p) => p.url().startsWith(qwenOrigin())) ??
        existingPages[0] ??
        (await acctContext.newPage());
      // Check if already logged in via cookies
      const cookies = await acctContext.cookies();
      const hasAuthCookie = cookies.some(
        (c) =>
          c.name.toLowerCase().includes("token") ||
          c.name.toLowerCase().includes("session"),
      );

      let loggedIn = hasAuthCookie;

      if (!loggedIn && account.email && account.password) {
        // Need to register page temporarily for login functions
        accountPages.set(account.id, acctPage);
        try {
          loggedIn = await loginToQwen(account.id, account.email, account.password);
        } finally {
          accountPages.delete(account.id);
        }
      } else {
        // Validate session by navigating to chat page and checking login state
        try {
          await acctPage.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: config.timeouts.navigation,
          });
          loggedIn = await isPageLoggedIn(acctPage);
          if (!loggedIn && account.email && account.password) {
            accountPages.set(account.id, acctPage);
            try {
              loggedIn = await loginToQwen(account.id, account.email, account.password);
            } finally {
              accountPages.delete(account.id);
            }
          }
        } catch {
          loggedIn = false;
        }
      }

      return loggedIn;
    } finally {
      // Always close browser after validation
      await closePlaywrightContextBestEffort(account.id, acctContext);
      await cleanupPlaywrightAccountState(account.id);
    }
  } finally {
    release();
  }
}
// ─── Login ────────────────────────────────────────────────────────────────────

export interface LoginAttemptResult {
  success: boolean;
  permanentFailure?: boolean;
  reason?: string;
}

function isContextDeathError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("target page, context or browser has been closed") ||
    lower.includes("context closed") ||
    lower.includes("browser has been closed") ||
    lower.includes("page.context()") ||
    lower.includes("context was closed") ||
    lower.includes("browser context closed")
  );
}

export function classifyQwenAuthError(
  code?: string,
  details?: string,
): { isPermanent: boolean; reason: string } {
  const c = (code || "").trim().toLowerCase();
  const d = (details || "").trim().toLowerCase();
  const combined = `${c} ${d}`;

  if (
    combined.includes("frozen") ||
    combined.includes("blocked") ||
    combined.includes("suspend") ||
    combined.includes("bloquead")
  ) {
    return {
      isPermanent: true,
      reason: `Conta bloqueada ou suspensa (${details || code || "AccountSuspended"})`,
    };
  }

  if (
    combined.includes("password") ||
    combined.includes("senha") ||
    combined.includes("credential")
  ) {
    return {
      isPermanent: true,
      reason: `Senha incorreta (${details || code || "PasswordError"})`,
    };
  }

  if (
    combined.includes("user") ||
    combined.includes("email") ||
    combined.includes("account") ||
    combined.includes("not exist") ||
    combined.includes("not found") ||
    combined.includes("not registered") ||
    combined.includes("não encontrado") ||
    combined.includes("não existe")
  ) {
    return {
      isPermanent: true,
      reason: `E-mail/usuário não encontrado (${details || code || "UserNotExist"})`,
    };
  }

  return {
    isPermanent: false,
    reason: details || code || "Falha desconhecida no login",
  };
}

async function loginToQwen(
  accountId: string,
  email: string,
  password: string,
): Promise<boolean> {
  return withPlaywrightOpSlot(() =>
    loginToQwenInner(accountId, email, password),
  );
}

async function loginToQwenInner(
  accountId: string,
  email: string,
  password: string,
): Promise<boolean> {
  if (!password || password === "***") {
    try {
      const { getAccountCredentials } = await import("../core/accounts.ts");
      const creds = getAccountCredentials(accountId);
      if (creds && creds.password && creds.password !== "***") {
        password = creds.password;
      } else {
        console.error(
          `❌ [Playwright] Cannot login for ${maskEmail(email)}: password is masked ('***') and real credentials not found in store`,
        );
        return false;
      }
    } catch {
      return false;
    }
  }
  const page = accountPages.get(accountId);
  if (!page) return false;

  const maxAttempts = 3;
  let apiResult: LoginAttemptResult = { success: false, reason: "unknown" };
  let uiResult: LoginAttemptResult = { success: false, reason: "unknown" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Try API login first
    apiResult = await loginViaApi(page, email, password);
    if (apiResult.success) {
      await saveStorageState(page.context(), accountId);
      return true;
    }

    if (apiResult.permanentFailure) {
      console.error(
        `❌ [Playwright] Falha irrecuperável de autenticação para ${maskEmail(email)}: ${apiResult.reason}`,
      );
      markAccountRateLimited(
        accountId,
        24 * 3600 * 1000,
        `AuthPermanentFailure: ${apiResult.reason}`,
      );
      try {
        markAccountAuthError(accountId);
        recordAccountFailure(accountId, "auth");
      } catch {
        // Best-effort.
      }
      return false;
    }

    // Fallback to UI login
    uiResult = await loginViaUi(page, email, password);
    if (uiResult.success) {
      await saveStorageState(page.context(), accountId);
      return true;
    }

    if (uiResult.permanentFailure) {
      console.error(
        `❌ [Playwright] Falha irrecuperável de autenticação para ${maskEmail(email)}: ${uiResult.reason}`,
      );
      markAccountRateLimited(
        accountId,
        24 * 3600 * 1000,
        `AuthPermanentFailure: ${uiResult.reason}`,
      );
      try {
        markAccountAuthError(accountId);
        recordAccountFailure(accountId, "auth");
      } catch {
        // Best-effort.
      }
      return false;
    }

    if (attempt < maxAttempts) {
      const backoffMs = attempt * 5_000;
      console.warn(
        `⚠️  [Playwright] Login attempt ${attempt}/${maxAttempts} failed for ${maskEmail(email)} (${apiResult.reason || uiResult.reason || "falha temporária"}), retrying in ${backoffMs / 1000}s`,
      );
      await sleep(backoffMs);
    }
  }

  const lastReason = apiResult?.reason || uiResult?.reason || "unknown";
  const isContextDeath = isContextDeathError(lastReason);

  if (isContextDeath) {
    console.warn(
      `⚠️  [Playwright] Login failed due to context death for ${maskEmail(email)} - not marking permanent failure`,
    );
    return false;
  }

  console.error(
    `❌ [Playwright] All login methods failed for ${maskEmail(email)}`,
  );
  markAccountRateLimited(
    accountId,
    24 * 3600 * 1000,
    "AuthFailed: All login methods exhausted",
  );
  try {
    markAccountAuthError(accountId);
    recordAccountFailure(accountId, "auth");
  } catch {
    // Best-effort.
  }
  return false;
}

async function loginViaApi(
  page: Page,
  email: string,
  password: string,
): Promise<LoginAttemptResult> {
  try {
    await page.goto(qwenUrl("/auth"), {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });
    await sleep(2000);

    // Check if already logged in
    if (!page.url().includes("/auth")) {
      return { success: true };
    }

    // Qwen's web client sends the password as a SHA256 hex digest, and the
    // API now rejects plaintext with INVALID_CRED ("The email or password
    // provided is incorrect"). Hash first; only fall back to plaintext for
    // deployments that still accept it.
    //
    // NOTE: the evaluated function must stay a plain inline arrow — a nested
    // named function inside page.evaluate gets wrapped by esbuild's keepNames
    // (__name helper), which does not exist in the browser context and throws
    // "ReferenceError: __name is not defined" at runtime.
    const signinUrl = qwenUrl("/api/v2/auths/signin");
    const passwordHash = crypto
      .createHash("sha256")
      .update(password)
      .digest("hex");

    const signInWith = (candidate: string) =>
      page.evaluate(
        async ({ email, password, signinUrl }) => {
          try {
            const response = await fetch(signinUrl, {
              method: "POST",
              signal: AbortSignal.timeout(10_000),
              headers: {
                accept: "application/json, text/plain, */*",
                "content-type": "application/json",
                source: "web",
                timezone: new Date().toString().split(" (")[0],
                "x-request-id": crypto.randomUUID(),
              },
              body: JSON.stringify({
                email,
                password,
                login_type: "email",
              }),
            });
            const data = await response.json().catch(() => null);
            return { ok: response.ok, status: response.status, data };
          } catch (e: any) {
            return { ok: false, status: 0, data: null, error: e.message };
          }
        },
        { email, password: candidate, signinUrl },
      );

    let result = await signInWith(passwordHash);
    const resultCode = result.data?.data?.code ?? result.data?.code;
    if (
      result.data?.success === false &&
      resultCode === "INVALID_CRED"
    ) {
      result = await signInWith(password);
    }

    if (result.data) {
      if (result.data.success === true) {
        await page.goto(qwenUrl("/"), {
          waitUntil: "domcontentloaded",
          timeout: config.timeouts.navigation,
        });
        const loggedIn = !page.url().includes("auth") && !page.url().includes("login");
        if (loggedIn) {
          return { success: true };
        }
      } else if (result.data.success === false) {
        const code = result.data?.data?.code || result.data?.code;
        const details =
          result.data?.data?.details || result.data?.details || result.data?.message;
        const classified = classifyQwenAuthError(code, details);
        return {
          success: false,
          permanentFailure: classified.isPermanent,
          reason: classified.reason,
        };
      }
    }

    if (result.ok) {
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
      const loggedIn = !page.url().includes("auth") && !page.url().includes("login");
      return {
        success: loggedIn,
        reason: loggedIn ? undefined : "Redirecionado de volta para /auth após signin",
      };
    }

    return {
      success: false,
      reason: result.error || `HTTP ${result.status || "desconhecido"} sem corpo JSON válido`,
    };
  } catch (err: any) {
    console.warn(`⚠️  [Playwright] API login error: ${err?.message || err}`);
    return { success: false, reason: err?.message || String(err) };
  }
}

async function loginViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<LoginAttemptResult> {
  try {
    await page.goto(qwenUrl("/auth"), {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });
    await sleep(2000);

    // Check if already logged in
    if (!page.url().includes("/auth")) {
      return { success: true };
    }

    // The auth page now defaults to the OTP ("verification code") flow, which
    // renders no password field and no submit button. Password login lives
    // behind an explicit toggle, so switch modes first — otherwise the
    // password wait below times out on every attempt.
    const passwordSelector =
      'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
    const passwordVisibleInitially = await page
      .locator(passwordSelector)
      .first()
      .isVisible()
      .catch(() => false);
    if (!passwordVisibleInitially) {
      const passwordToggleSelectors = [
        'button:has-text("Log in with a password")',
        'button:has-text("Sign in with a password")',
        'button:has-text("Use password")',
        'button:has-text("Use Password")',
        'button:has-text("Password login")',
        'button:has-text("Continue with password")',
        'button:has-text("password")',
        'a:has-text("Log in with a password")',
        'a:has-text("password")',
        '[role="button"]:has-text("password" i)',
        '[role="tab"]:has-text("password" i)',
      ];
      for (const toggleSel of passwordToggleSelectors) {
        const passwordModeToggle = page.locator(toggleSel).first();
        if (await passwordModeToggle.isVisible().catch(() => false)) {
          await passwordModeToggle.click({ timeout: 3_000 }).catch(() => {});
          await sleep(500);
          break;
        }
      }
    }

    // Wait for email input
    const emailSelector = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="Email"]',
      'input[name="loginId"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[placeholder*="Email" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="account" i]',
      'input[type="text"][name*="mail" i]',
      'input[type="text"][id*="mail" i]',
      'input[type="text"][id*="account" i]',
    ].join(", ");
    try {
      await page.waitForSelector(emailSelector, {
        timeout: config.timeouts.page,
      });
    } catch {
      if (!page.url().includes("/auth")) return { success: true };
      console.warn(
        `⚠️  [Playwright] Email input not found on ${page.url()} (possible captcha or anti-bot challenge)`,
      );
      return { success: false, reason: "Campo de e-mail não encontrado (possível captcha)" };
    }

    // Fill email
    await page.fill(emailSelector, email);

    // The password field may already be visible (single-step form) or only
    // appear after submitting the email (two-step flow).
    const passwordAlreadyVisible = await page
      .locator(passwordSelector)
      .first()
      .isVisible()
      .catch(() => false);

    if (!passwordAlreadyVisible) {
      await page.keyboard.press("Enter");
      await page.waitForSelector(passwordSelector, {
        timeout: config.timeouts.page,
      });
    }
    await sleep(500);

    // Fill password
    await page.fill(passwordSelector, password);

    // Prefer clicking the submit button; fall back to pressing Enter.
    // The button starts disabled and only enables once both fields are filled.
    const submitSelector =
      'button[type="submit"].qwenchat-auth-pc-submit-button, button[type="submit"]';
    const submitButton = page.locator(submitSelector).first();
    try {
      await page.waitForSelector('button[type="submit"]:not([disabled])', {
        timeout: 5_000,
      });
      await submitButton.click();
    } catch {
      await page.keyboard.press("Enter");
    }
    await sleep(3000);

    // If a slider puzzle captcha appeared after submit, solve it automatically
    await solveBaxiaCaptcha(page, {
      waitForMs: 2000,
      maxAttempts: config.captcha.maxAttempts,
      retryDelayMs: config.captcha.retryDelayMs,
    }).catch(() => {});
    // Check for UI error elements in DOM (Ant Design errors, alerts, toasts)
    const errorSelector = [
      ".ant-form-item-explain-error",
      ".ant-message-error",
      ".ant-message-notice",
      '[role="alert"]',
      ".qwenchat-auth-error",
      ".auth-error-message",
    ].join(", ");
    const errorEl = page.locator(errorSelector).first();
    if (await errorEl.isVisible().catch(() => false)) {
      const errorText = (await errorEl.innerText().catch(() => "")).trim();
      if (errorText) {
        const classified = classifyQwenAuthError(undefined, errorText);
        return {
          success: false,
          permanentFailure: classified.isPermanent,
          reason: `Formulário: ${classified.reason}`,
        };
      }
    }

    // Check if login was successful
    const isLoggedIn =
      !page.url().includes("auth") && !page.url().includes("login");

    if (isLoggedIn) {
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
      return { success: true };
    }

    return {
      success: false,
      reason: "A página permaneceu na tela de autenticação após envio do formulário",
    };
  } catch (err: any) {
    console.warn(`⚠️  [Playwright] UI login error: ${err?.message || err}`);
    return { success: false, reason: err?.message || String(err) };
  }
}

// ─── Header Capture ───────────────────────────────────────────────────────────

/**
 * Qwen's age-confirmation gate renders as a centered antd modal
 * (`.ant-modal-wrap.ant-modal-centered`, heading "Confirm your age to
 * continue", birth-year select + "Continue") on top of the composer. Playwright
 * still reports the chat input and the send button as VISIBLE behind it —
 * visibility ignores occlusion — so header capture typed its probe message,
 * focused/clicked the send button, and every pointer event landed on the modal
 * overlay (`document.elementFromPoint` at the send button returns the modal
 * wrap). The page therefore issued no `/api/v2/chats/new` and no completion
 * request at all: the capture only ever saw its own grace timers expire
 * ("Header capture produced no completion request … timed out") with no WAF,
 * login or activation evidence anywhere. Accepting the gate (the year select
 * ships pre-selected to an adult year) is what lets the send reach the app.
 */
export async function dismissAgeConfirmation(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    const gate = page
      .locator("div.ant-modal-wrap")
      .filter({ hasText: /confirm your age/i })
      .first();
    if (!(await gate.isVisible().catch(() => false))) return false;
    console.log(
      `🔞 [Playwright] Age-confirmation gate detected; accepting it for header capture`,
    );

    const primary = gate
      .locator('button:has-text("Continue"), button.ant-btn-primary')
      .first();
    if (await primary.isVisible().catch(() => false)) {
      await primary.click({ timeout: 3_000 }).catch(() => {});
    } else {
      const close = gate.locator(".ant-modal-close").first();
      await close.click({ timeout: 2_000 }).catch(() => {});
    }
    // antd fades the wrapper out after the click; poll until it is really gone
    // so a slow fade is not reported as a failure (a false negative here is
    // indistinguishable from the gate never being handled).
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (!(await gate.isVisible().catch(() => false))) {
        console.log(
          `🔞 [Playwright] Age-confirmation gate dismissed for header capture`,
        );
        return true;
      }
    }
    console.warn(
      `⏱️  [Playwright] Age-confirmation gate still open after accepting for header capture`,
    );
    return false;
  } catch {
    return false;
  }
}

/**
 * Capture a complete anti-fraud header set from a browser completion request.
 * The optional page and timeout make the capture path independently testable
 * without starting a real browser.
 */
export async function captureQwenHeaders(
  accountId: string,
  pageOverride?: Page,
  timeoutMs = config.timeouts.headers,
  triggerGraceMs = HEADER_CAPTURE_TRIGGER_GRACE_MS,
): Promise<void> {
  // One deadline for the WHOLE capture, including the wait for a shared op
  // slot. The budget used to restart after that wait (the slot got the caller's
  // deadline, the body a fresh timeoutMs), so a capture queued behind four
  // others still believed it had a full 90s while holding the account mutex —
  // the arithmetic behind the 150s `init:<acct>` holds.
  const deadline = Date.now() + Math.max(1, timeoutMs);
  return withPlaywrightOpSlot(
    () =>
      captureQwenHeadersInner(
        accountId,
        pageOverride,
        // Recomputed after the queue wait so the wait itself consumes the
        // budget (clamped to 1ms: a spent budget then fails inside with the
        // normal "capture timed out" diagnosis instead of a new error class).
        Math.max(1, deadline - Date.now()),
        triggerGraceMs,
      ),
    { accountId, deadline, kind: "header-capture" },
  );
}

async function captureQwenHeadersInner(
  accountId: string,
  pageOverride?: Page,
  timeoutMs = config.timeouts.headers,
  triggerGraceMs = HEADER_CAPTURE_TRIGGER_GRACE_MS,
): Promise<void> {
  const page = pageOverride ?? accountPages.get(accountId);
  if (!page || page.isClosed()) {
    throw new Error(`Playwright page unavailable for header capture: ${accountId}`);
  }

  touchAccountActivity(accountId);
  const cache = getHeaderCache(accountId);

  let cleanupRoute = async () => {};
  try {
    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      let routeRegistered = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let routeHandler: (route: any, request: any) => Promise<void>;
      let sawIncompleteHeaders = false;
      let headersCaptured = false;
      let retriggerRequested = false;
      let lastAttemptGraceTimedOut = false;
      let lastAttemptInputMissing = false;
      let graceTimeoutCount = 0;
      let wakeTriggerLoop: (() => void) | undefined;
      const deadline = Date.now() + timeoutMs;
      const remainingBudgetMs = () => deadline - Date.now();

      cleanupRoute = async () => {
        if (!routeRegistered) return;
        routeRegistered = false;
        if (!page.isClosed()) {
          try {
            await page.unroute("**/api/v2/chat/completions*", routeHandler);
          } catch {}
        }
      };

      const wakeTrigger = () => {
        const wake = wakeTriggerLoop;
        wakeTriggerLoop = undefined;
        wake?.();
      };

      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        void cleanupRoute();
        // A trigger loop parked between attempts has to be released, otherwise it
        // stays pending forever behind an already-settled capture.
        wakeTrigger();
        // When a trigger grace period expired (page fired no completion request),
        // log the OUTCOME so the operator can see whether the retry loop
        // recovered or the account is being rotated into cooldown — the bare
        // per-attempt warning leaves that dangling.
        if (graceTimeoutCount > 0) {
          if (headersCaptured) {
            console.log(
              `✅ [Playwright] Header capture recovered for ${accountId} after ${graceTimeoutCount} silent send(s)`,
            );
          } else {
            console.warn(
              `❌ [Playwright] Header capture failed for ${accountId} after ${graceTimeoutCount} silent send(s): ${error?.message ?? "no completion request"}`,
            );
          }
        }
        if (error) reject(error);
        else resolve();
      };

    const incompleteHeadersError = () =>
      new Error(
        `Header capture returned incomplete anti-fraud headers for ${accountId}`,
      );

    /**
     * Once a request has been intercepted without bx headers, that is the
     * diagnosis worth reporting: whatever ran out afterwards (budget, a failed
     * re-trigger) is only how the capture ran out of road. The wording is also
     * what the retry policy maps to an account-init cooldown.
     */
    const captureFailure = (fallback: Error) =>
      sawIncompleteHeaders ? incompleteHeadersError() : fallback;

    const armOverallDeadline = () => {
      if (settled) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(
        () => {
          console.warn(`⏱️  [Playwright] Header capture timeout for ${accountId}`);
          settle(
            captureFailure(new Error(`Header capture timed out for ${accountId}`)),
          );
        },
        Math.max(1, remainingBudgetMs()),
      );
    };

    // The send either produces the completion request within a second or two,
    // or the UI is blocked and never will. Waiting out the whole header budget
    // past this point only stalls the caller and, during account init, buys a
    // five-minute cooldown for nothing.
    const armTriggerGrace = (attempt: number) => {
      // A capture that already landed is only waiting out its settle delay, so
      // the send that produced it must not arm a deadline against it.
      if (settled || headersCaptured) return;
      if (timeout) clearTimeout(timeout);
      // The FIRST send pays two round trips (chats/new, then the completion
      // request itself) — measured ~3.2s end to end on a healthy page. The old
      // 3s window fired while its own request was still in flight, so the
      // attempt bought nothing. Cap it at FIRST_TRIGGER_GRACE_MS (6s) and at
      // whatever the caller injected. Never exceed the caller-provided grace
      // (tests inject tiny windows and expect them held).
      const firstSendGraceMs = Math.min(FIRST_TRIGGER_GRACE_MS, triggerGraceMs);
      timeout = setTimeout(
        () => {
          graceTimeoutCount++;
          console.warn(
            `⏱️  [Playwright] Header capture produced no completion request for ${accountId} (attempt ${graceTimeoutCount})`,
          );
          // The page is likely blocked by WAF/captcha or in a broken state.
          // Instead of settling immediately, trigger a retry with a page
          // reload so the next attempt starts from a fresh state.
          lastAttemptGraceTimedOut = true;
          retriggerRequested = true;
          wakeTrigger();
        },
        Math.max(
          1,
          Math.min(
            remainingBudgetMs(),
            attempt === 1 ? firstSendGraceMs : triggerGraceMs,
          ),
        ),
      );
    };

    routeHandler = async (route: any, request: any) => {
      if (settled) {
        // A route installed immediately before timeout must not poison future
        // browser traffic after the capture operation has completed.
        await route.continue().catch(() => {});
        return;
      }

      const reqHeaders = request.headers();
      if (!captureHeaderLogSeen.has(accountId)) {
        captureHeaderLogSeen.add(accountId);
        const plain: Record<string, string> = {};
        for (const [key, value] of Object.entries(reqHeaders)) {
          plain[key] =
            key === "cookie"
              ? `${String(value).slice(0, 16)}...len=${String(value).length}`
              : String(value).slice(0, 300);
        }
        logger.info("[Playwright] Capture request headers", {
          accountId,
          headers: plain,
          authMeta: ((): Record<string, unknown> => {
            const authHeader = String(reqHeaders["authorization"] || "");
            const bare = authHeader.replace(/^bearer\s+/i, "");
            const meta: Record<string, unknown> = {
              len: authHeader.length,
              bearer: /^bearer\s+/i.test(authHeader),
            };
            const parts = bare.split(".");
            if (parts.length === 3) {
              try {
                const payload = JSON.parse(
                  Buffer.from(
                    parts[1].replace(/-/g, "+").replace(/_/g, "/"),
                    "base64",
                  ).toString("utf8"),
                );
                meta.jwt = {
                  exp: payload.exp,
                  iat: payload.iat,
                  sub: payload.sub,
                  inMin: payload.exp
                    ? Math.round((payload.exp * 1000 - Date.now()) / 60000)
                    : null,
                };
              } catch {
                meta.jwt = "unparseable";
              }
            }
            const cookieToken = String(reqHeaders["cookie"] || "")
              .split(/;\s*/)
              .find((entry) => entry.startsWith("token="));
            meta.sameAsCookieToken = cookieToken
              ? bare === cookieToken.slice("token=".length)
              : false;
            return meta;
          })(),
        });
      }
      // Capture the REAL browser request headers — including version and the
      // client-hint fingerprint — so the Node paths reuse exactly what the live
      // browser sends (anti-hardcoded: no stale Chrome/version literals).
      const capturedHeaders: Record<string, string> = {
        cookie: reqHeaders["cookie"] || "",
        authorization: reqHeaders["authorization"] || "",
        "bx-ua": reqHeaders["bx-ua"] || "",
        "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
        "bx-v": reqHeaders["bx-v"] || "2.5.37",
        "user-agent": reqHeaders["user-agent"] || "",
        "x-request-id": reqHeaders["x-request-id"] || "",
        "version": reqHeaders["version"] || "",
        "sec-ch-ua": reqHeaders["sec-ch-ua"] || "",
        "sec-ch-ua-mobile": reqHeaders["sec-ch-ua-mobile"] || "?0",
        "sec-ch-ua-platform": reqHeaders["sec-ch-ua-platform"] || "",
      };

      // Extract chat_id and parent_id from POST body for session coherence
      try {
        const postData = typeof request.postData === "function" ? request.postData() : null;
        if (postData) {
          const payload = JSON.parse(postData);
          if (payload.chat_id) capturedHeaders["x-chat-id"] = payload.chat_id;
          if (payload.parent_id !== undefined)
            capturedHeaders["x-parent-id"] = payload.parent_id || "";
        }
      } catch {
        // Ignore parse errors or missing postData
      }

      if (!hasRequiredQwenHeaders(capturedHeaders)) {
        // Not evidence the page is broken: the SDK also fires completions
        // before it has computed its token. The request still must never reach
        // Qwen, but the capture keeps its route and spends another send —
        // failing here would throw away a budget that is still nearly full.
        sawIncompleteHeaders = true;
        await route.abort("aborted").catch(() => {});
        // Aborting kills the UI's send, so nothing will re-fire on its own.
        retriggerRequested = true;
        wakeTrigger();
        return;
      }

      headersCaptured = true;
      if (timeout) clearTimeout(timeout);
      cache.headers = capturedHeaders;
      if (capturedHeaders["version"]) {
        updateQwenWebVersion(capturedHeaders["version"]);
      }
      markAccountHeadersReady(accountId);
      cache.lastRefresh = Date.now();
      // Header interception can set challenge/session cookies, so do not reuse
      // a cookie snapshot taken before this browser request.
      cookieCaches.delete(accountId);
      touchAccountActivity(accountId);

      await route.abort("aborted").catch(() => {});
      await sleep(HEADER_CAPTURE_SETTLE_MS);
      settle();
    };

    // Navigate to the stable chat page. Only the first attempt pays for this:
    // a re-trigger types into the page that is already loaded, and reloading
    // would throw away the bx SDK state that just finished warming up.
    const openChatPage = async () => {
      if (settled || page.isClosed()) return;
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(config.timeouts.navigation, timeoutMs),
      });
      if (settled || page.isClosed()) return;
      await sleep(2000);
    };

    /** Type the probe message and send it, then wait out the grace window. */
    const triggerSend = async (attempt: number) => {
      if (settled || page.isClosed()) return;
      await clearVisibleChallenge(page);
      if (settled || page.isClosed()) return;

      // Session-expiry fast path: if the page landed on the auth/login screen
      // (redirection after a dead session), typing into the chat input would
      // burn every trigger attempt on a textarea that does not exist. Re-login
      // immediately when credentials are available; otherwise fail fast with a
      // clear diagnosis instead of 3 pointless grace timeouts.
      const loggedIn = await isPageLoggedIn(
        page,
        Math.max(1_000, Math.min(remainingBudgetMs(), SESSION_PROBE_NAVIGATION_TIMEOUT_MS)),
      );
      if (!loggedIn) {
        const { getAccountCredentials } = await import("../core/accounts.ts");
        const creds = getAccountCredentials(accountId);
        if (creds && creds.email && creds.password) {
          console.warn(
            `⚠️  [Playwright] Session expired during header capture for ${accountId}; re-authenticating...`,
          );
          // Direct call to the inner login: this capture ALREADY holds one of
          // the five shared browser-op slots, and loginToQwen would queue for a
          // second one. Five captures each re-logining at once leave all slots
          // held by waiters on each other — the whole semaphore stalls until
          // every deadline fires (the "slot wait exceeded" cascade).
          const ok = await loginToQwenInner(accountId, creds.email, creds.password);
          if (!ok) {
            settle(
              new Error(
                `Header capture failed for ${accountId}: re-login after session expiry did not succeed`,
              ),
            );
            return;
          }
          // Re-login navigated away; reload the chat page so the send below
          // types into a live chat input (never leave the loop parked).
          await openChatPage();
          if (settled || page.isClosed()) return;
        } else {
          settle(
            new Error(
              `Header capture failed for ${accountId}: session expired and no credentials available for re-login (run 'qpx login')`,
            ),
          );
          return;
        }
      }

      if (settled || page.isClosed()) return;

      // Prefer the Qwen-specific input selector first (stable against the DOM
      // picking a sibling textarea/contenteditable), then fall back to generic.
      const inputSelector = CHAT_INPUT_SELECTOR;
      // Bound the appearance wait: a page that never renders the chat input is
      // blocked (WAF interstitial, punish document, or failed SPA hydration).
      // Unbounded, page.focus would burn its 60s default timeout on every
      // attempt, freezing the whole capture and cooling a healthy account with
      // AuthInitFailed. A miss marks the attempt for a reload instead.
      try {
        await page
          .locator(inputSelector)
          .first()
          .waitFor({
            state: "visible",
            timeout: Math.max(
              1,
              Math.min(CHAT_INPUT_APPEAR_TIMEOUT_MS, remainingBudgetMs()),
            ),
          });
      } catch {
        if (settled || page.isClosed()) return;
        // The input never appeared: decide whether the page is a WAF/challenge
        // interstitial (fail fast, do NOT reload into the same 15s wait) or a
        // generic failed-to-hydrate page (reload).
        const blocked = await detectChatPageBlock(page);
        if (blocked.kind === "waf") {
          await dumpPlaywrightMiss(accountId, page, {
            reason: blocked.reason ?? "waf block",
            attempt,
            markers: blocked.markers,
          });
          console.warn(
            `🚫 [Playwright] Chat page WAF-blocked for ${accountId} (attempt ${attempt}): ${blocked.reason ?? "challenge"}`,
          );
          settle(
            new Error(
              `WAF challenge detected for ${accountId}: ${blocked.reason ?? "chat page blocked by anti-bot challenge"}`,
            ),
          );
          return;
        }
        // Not WAF and not hydration: the account itself may be unusable yet
        // ("pending activation" until the signup mail is confirmed — seen in
        // logs/playwright_misses). That never recovers by re-sending, so it is
        // reported as a PERMANENT auth failure instead of consuming the retry
        // budget and cooling the account as if it were a timeout.
        const activation = await detectAccountActivationBlock(page);
        if (activation) {
          await dumpPlaywrightMiss(accountId, page, {
            reason: "account pending activation",
            attempt,
            markers: activation.markers,
          });
          console.warn(
            `🛑 [Playwright] Account not activated for ${accountId} (attempt ${attempt}): ${activation.reason}`,
          );
          settle(
            new PermanentAuthError(
              `Header capture failed for ${accountId}: account pending activation — ${activation.reason}`,
            ),
          );
          return;
        }
        await dumpPlaywrightMiss(accountId, page, {
          reason: "chat input never appeared",
          attempt,
        });
        console.warn(
          `⏱️  [Playwright] Chat input never appeared for ${accountId} (attempt ${attempt}); reloading`,
        );
        lastAttemptInputMissing = true;
        retriggerRequested = true;
        wakeTrigger();
        return;
      }
      if (settled || page.isClosed()) return;
      // The age gate mounts together with the composer, so this is the first
      // point where it can be seen; dismissing it here keeps the typing below
      // focused in a page that is not covered by an overlay.
      await dismissAgeConfirmation(page);
      if (settled || page.isClosed()) return;
      const inputActionTimeoutMs = Math.max(
        1,
        Math.min(CHAT_INPUT_ACTION_TIMEOUT_MS, remainingBudgetMs()),
      );
      try {
        await page.focus(inputSelector, { timeout: inputActionTimeoutMs });
        if (settled || page.isClosed()) return;
        await page.fill(inputSelector, "", { timeout: inputActionTimeoutMs });
        if (settled || page.isClosed()) return;
        await page.type(inputSelector, "a", {
          delay: 100,
          timeout: inputActionTimeoutMs,
        });
      } catch {
        // The input detached mid-interaction (challenge overlay, SPA
        // re-render): same diagnosis as never appearing — only a fresh load
        // recovers it.
        if (settled || page.isClosed()) return;
        console.warn(
          `⏱️  [Playwright] Chat input interaction failed for ${accountId} (attempt ${attempt}); reloading`,
        );
        lastAttemptInputMissing = true;
        retriggerRequested = true;
        wakeTrigger();
        return;
      }
      if (settled || page.isClosed()) return;
      await sleep(2000);
      if (settled || page.isClosed()) return;
      // Re-check: a gate that mounted after the composer finished rendering
      // would otherwise swallow the send below without any visible symptom.
      await dismissAgeConfirmation(page);
      if (settled || page.isClosed()) return;

      const sendSelectors = SEND_BUTTON_SELECTORS;

      let clicked = false;
      for (const selector of sendSelectors) {
        if (settled || page.isClosed()) return;
        try {
          const btn = await page.$(selector);
          if (btn && (await btn.isVisible())) {
            await page.evaluate((sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) {
                element.focus();
                element.click();
              }
            }, selector);
            if (!settled && !page.isClosed()) {
              await btn.click({ force: true, delay: 50 }).catch(() => {});
            }
            clicked = true;
            break;
          }
        } catch {
          // Try the next selector.
        }
      }

      if (!clicked && !settled && !page.isClosed()) {
        await page.keyboard.press("Enter");
      }

      armTriggerGrace(attempt);
    };

    /** Park until the interception asks for another send, or the capture ends. */
    const waitForRetrigger = () =>
      new Promise<void>((wake) => {
        if (settled || retriggerRequested) {
          wake();
          return;
        }
        wakeTriggerLoop = wake;
      });

    const runTriggerLoop = async () => {
      for (
        let attempt = 1;
        attempt <= HEADER_CAPTURE_TRIGGER_ATTEMPTS;
        attempt++
      ) {
        retriggerRequested = false;
        // Driving a send is not the grace window: restore the overall budget
        // so the previous attempt's grace timer cannot expire mid-typing.
        armOverallDeadline();

        try {
          // Navigate on the first attempt, or reload when attempt 2+ produced
          // no request (indicating a stuck page/challenge that needs a fresh load).
          // Attempt 2 preserves the page from attempt 1 so the bx SDK that just
          // finished initializing in the background is not thrown away.
          // A missing chat input is the exception: the page never rendered the
          // chat UI, so there is no warm SDK state to protect and only a fresh
          // load can recover it.
          if (
            attempt === 1 ||
            lastAttemptInputMissing ||
            (lastAttemptGraceTimedOut && attempt >= 3)
          ) {
            lastAttemptGraceTimedOut = false;
            lastAttemptInputMissing = false;
            await openChatPage();
          }
          if (settled) return;
          await triggerSend(attempt);
        } catch (error) {
          console.warn(
            `❌ [Playwright] Error triggering header capture for ${accountId}: ${getErrorMessage(error)}`,
          );
          settle(
            captureFailure(
              error instanceof Error
                ? error
                : new Error(`Header capture failed for ${accountId}`),
            ),
          );
          return;
        }

        if (settled) return;
        await waitForRetrigger();
        if (settled) return;
        if (remainingBudgetMs() <= 0) break;
      }

      // Distinguish between "requests fired but lacked bx headers" and "no
      // request fired at all" so the caller gets an actionable diagnosis.
      // The silent case has one more possibility worth ruling out first: an
      // account awaiting signup confirmation still renders the chat input (so
      // the input-miss detector never fires) but the app ignores the send, so
      // no completion request is ever produced — exactly the signature in
      // logs/playwright_misses. Report that as a PERMANENT auth failure instead
      // of a retryable capture timeout.
      if (!headersCaptured && !sawIncompleteHeaders) {
        const activation = await detectAccountActivationBlock(page);
        if (activation) {
          await dumpPlaywrightMiss(accountId, page, {
            reason: "account pending activation",
            attempt: HEADER_CAPTURE_TRIGGER_ATTEMPTS,
            markers: activation.markers,
          });
          console.warn(
            `🛑 [Playwright] Account not activated for ${accountId}: ${activation.reason}`,
          );
          settle(
            new PermanentAuthError(
              `Header capture failed for ${accountId}: account pending activation — ${activation.reason}`,
            ),
          );
          return;
        }
      }
      settle(
        sawIncompleteHeaders
          ? incompleteHeadersError()
          : new Error(`Header capture timed out for ${accountId}`),
      );
    };

    armOverallDeadline();

    void page
      .route("**/api/v2/chat/completions*", routeHandler)
      .then(async () => {
        routeRegistered = true;
        if (settled) {
          cleanupRoute();
          return;
        }

        await runTriggerLoop();
      })
      .catch((error) => {
        console.warn(
          `[Playwright] Error registering header capture route: ${getErrorMessage(error)}`,
        );
        settle(
          error instanceof Error
            ? error
            : new Error(`Header capture route registration failed for ${accountId}`),
        );
      });
    });
  } finally {
    await cleanupRoute();
  }
}
type CookieSnapshot = Awaited<ReturnType<BrowserContext["cookies"]>>;
/**
 * Fetch the account context cookies once. The snapshot feeds every validity
 * check and the cookie string build, avoiding repeated CDP round-trips.
 */
async function getCookieSnapshot(
  accountId: string,
): Promise<CookieSnapshot | null> {
  const context = accountContexts.get(accountId);
  if (!context) return null;

  try {
    return await withTimeout(
      context.cookies(),
      config.timeouts.page,
      `Cookie snapshot timed out for ${accountId}`,
    );
  } catch {
    return null;
  }
}

/**
 * Check if the auth token cookie is still valid.
 * Used to skip unnecessary header recaptures when the token is still fresh.
 * Returns true if the token cookie exists and is not expired.
 */
function isAuthTokenValidFrom(cookies: CookieSnapshot): boolean {
  const tokenCookie = cookies.find(
    (c) =>
      c.name === "token" && (c.domain === ".qwen.ai" || c.domain === "qwen.ai"),
  );

  if (!tokenCookie) return false;

  // Session cookie (expires = -1) is valid as long as browser is open
  if (tokenCookie.expires === -1) return true;

  // Check if expired (with 5-min safety margin)
  const expiresAt = tokenCookie.expires * 1000;
  return expiresAt > Date.now() + 5 * 60 * 1000;
}

/**
 * Check if the shortest-lived cookie (acw_tc) is still valid.
 * This is the 24-min cookie that gates some requests.
 */
function isShortestCookieValidFrom(cookies: CookieSnapshot): boolean {
  const acwCookie = cookies.find(
    (c) => c.name === "acw_tc" && c.domain.includes("qwen.ai"),
  );

  if (!acwCookie) return true; // If missing, assume OK (will be refreshed by browser)

  if (acwCookie.expires === -1) return true;

  const expiresAt = acwCookie.expires * 1000;
  return expiresAt > Date.now() + 60 * 1000; // 1-min safety margin
}

async function refreshHeadersInternal(
  accountId: string,
  timeoutMs = config.timeouts.headers,
): Promise<void> {
  const cache = getHeaderCache(accountId);
  if (cache.refreshInProgress) return;

  touchAccountActivity(accountId);
  cache.refreshInProgress = true;
  const boundedTimeoutMs = Math.max(1_000, timeoutMs);
  try {
    // Check if session is expired before capturing headers
    const page = accountPages.get(accountId);
    if (page) {
      try {
        await page.goto(qwenUrl("/"), {
          waitUntil: "domcontentloaded",
          timeout: Math.min(
            config.timeouts.navigation,
            boundedTimeoutMs,
            SESSION_PROBE_NAVIGATION_TIMEOUT_MS,
          ),
        });
        const url = page.url();
        if (url.includes("auth") || url.includes("login")) {
          console.warn(
            `⚠️  [Playwright] Session expired during refresh for ${accountId}, re-authenticating...`,
          );
          const { getAccountCredentials } = await import("../core/accounts.ts");
          const creds = getAccountCredentials(accountId);
          if (creds && creds.email && creds.password) {
            await loginToQwen(accountId, creds.email, creds.password);
            // Invalidate cookie cache after re-login
            cookieCaches.delete(accountId);
          } else {
            console.warn(
              `[Playwright] No credentials available for re-login of ${accountId}`,
            );
          }
        }
      } catch (navErr) {
        console.warn(
          `[Playwright] Navigation check failed during refresh for ${accountId}:`,
          (navErr as Error).message,
        );
      }
    }

    await captureQwenHeaders(accountId, undefined, boundedTimeoutMs);

    // Best-effort restore: header capture can leave the tab on a chat page.
    const capturedPage = accountPages.get(accountId);
    if (capturedPage && !capturedPage.isClosed()) {
      try {
        const currentUrl = new URL(capturedPage.url());
        if (currentUrl.origin !== qwenOrigin() || currentUrl.pathname !== "/") {
          await capturedPage.goto(qwenUrl("/"), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeouts.navigation, boundedTimeoutMs),
          });
        }
      } catch {
        // Non-fatal: the next normal operation will navigate back.
      }
    }
  } finally {
    touchAccountActivity(accountId);
    cache.refreshInProgress = false;
  }
}

export async function refreshHeaders(
  accountId: string,
  timeoutMs = config.timeouts.headers,
): Promise<void> {
  const boundedTimeoutMs = Math.max(1_000, timeoutMs);
  const release = await acquireAccountMutex(
    accountId,
    `refresh:${accountId.substring(0, 12)}`,
    boundedTimeoutMs,
  );
  try {
    await refreshHeadersInternal(accountId, timeoutMs);
  } finally {
    release();
  }
}

/**
 * Run work against the account Playwright page under the per-account mutex.
 * Used by captcha recovery so it cannot race header capture / login.
 */
export async function withAccountPage<T>(
  accountId: string,
  fn: (page: Page) => Promise<T>,
  timeoutMs = ACCOUNT_PAGE_OPERATION_TIMEOUT_MS,
  mutexTimeoutMs = PLAYWRIGHT_MUTEX_WAIT_MS,
  recoverOnTimeout = true,
): Promise<T> {
  const page = accountPages.get(accountId);
  if (!page || page.isClosed()) {
    throw new Error(`Playwright page unavailable for account: ${accountId}`);
  }
  const release = await acquireAccountMutex(
    accountId,
    `page:${accountId.substring(0, 12)}`,
    Math.max(1_000, mutexTimeoutMs),
    recoverOnTimeout,
  );
  try {
    touchAccountActivity(accountId);
    try {
      const result = await withTimeout(
        fn(page),
        Math.max(1_000, timeoutMs),
        `Playwright page operation timed out for ${accountId} after ${Math.max(1_000, timeoutMs)}ms`,
      );
      touchAccountActivity(accountId);
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("Playwright page operation timed out")) {
        console.warn(
          `⏱️  [Playwright] Resetting account context after a stuck page operation: ${accountId}`,
        );
        const context = accountContexts.get(accountId);
        if (context) {
          await closePlaywrightContextBestEffort(accountId, context, { skipStorageSave: true });
        }
        await cleanupPlaywrightAccountState(accountId);
      }
      throw error;
    }
  } finally {
    release();
  }
}

function isPlaywrightProfileCorruptedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Session closed") ||
    message.includes("Connection closed")
  );
}

async function resetPlaywrightProfileLocked(accountId: string): Promise<void> {
  await closePlaywrightForAccountLocked(accountId);
  const profilePath = getAccountProfilePath(accountId);
  removePlaywrightProfile(profilePath);
  const stateFile2 = path.join(path.dirname(profilePath), `${accountId}_state.json`);
  try { fs.rmSync(stateFile2, { force: true }); } catch {}
}

/**
 * Best-effort removal of a Playwright profile directory.
 *
 * On Windows, `fs.rmSync` can fail with EPERM/EBUSY/Permission denied because
 * the browser process still holds a file lock on the directory. Instead of
 * letting that failure abort the profile-reset/re-init cycle (which used to
 * cascade into a 45s re-init timeout + 300s account cooldown), the locked
 * directory is renamed to a `.stale-*` sibling so a fresh profile can be
 * created on the next init. Never throws.
 *
 * @param rmSyncOverride test hook: replaces `fs.rmSync` to simulate a lock.
 */
export function removePlaywrightProfile(
  profilePath: string,
  rmSyncOverride?: (path: string, opts: { recursive: boolean; force: boolean }) => void,
): void {
  const doRemove =
    rmSyncOverride ??
    ((p: string, opts: { recursive: boolean; force: boolean }) =>
      fs.rmSync(p, opts));
  try {
    doRemove(profilePath, { recursive: true, force: true });
  } catch (error) {
    if (isPlaywrightProfileCorruptedError(error)) return;
    // EPERM / EBUSY: the OS still holds a file lock (Windows). Rename the
    // locked directory out of the way so re-init can create a fresh profile.
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    if (
      message.includes("EPERM") ||
      message.includes("EBUSY") ||
      message.includes("Permission denied")
    ) {
      try {
        const stalePath = `${profilePath}.stale-${Date.now()}`;
        fs.renameSync(profilePath, stalePath);
      } catch {
        // Best effort: re-init will either reuse or fail cleanly.
      }
      return;
    }
    console.warn(
      `[Playwright] Failed to delete profile at ${profilePath}:`,
      getErrorMessage(error),
    );
  }
}

/**
 * Safely prunes transient cache directories (V8 Code Cache, HTTP disk cache,
 * GPU shader cache) from a Playwright Chromium profile directory.
 *
 * Preserves 100% of session and authentication state:
 * - Cookies, Local Storage, IndexedDB, Preferences, Network state.
 *
 * Never throws.
 */
export function prunePlaywrightProfileCaches(profilePath: string): {
  freedBytes: number;
  freedFiles: number;
} {
  const transientDirNames = [
    "Code Cache",
    "Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
  ];

  let freedBytes = 0;
  let freedFiles = 0;

  try {
    const defaultDir = path.join(profilePath, "Default");
    if (!fs.existsSync(defaultDir)) {
      return { freedBytes, freedFiles };
    }

    for (const dirName of transientDirNames) {
      const targetDir = path.join(defaultDir, dirName);
      if (fs.existsSync(targetDir)) {
        try {
          const countAndRemove = (d: string) => {
            try {
              const entries = fs.readdirSync(d, { withFileTypes: true });
              for (const e of entries) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) {
                  countAndRemove(full);
                } else if (e.isFile()) {
                  try {
                    freedBytes += fs.statSync(full).size;
                    freedFiles++;
                  } catch {}
                }
              }
            } catch {}
          };
          countAndRemove(targetDir);
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // Best-effort: file lock might still linger temporarily
        }
      }
    }
  } catch {
    // Best-effort
  }

  return { freedBytes, freedFiles };
}

/**
 * Prunes transient caches across all profile directories in data/qwen_profiles.
 */
export function pruneAllPlaywrightProfiles(baseDir = getProfilesDir()): {
  totalFreedBytes: number;
  totalFreedFiles: number;
  profilesCleaned: number;
} {
  let totalFreedBytes = 0;
  let totalFreedFiles = 0;
  let profilesCleaned = 0;

  try {
    if (!fs.existsSync(baseDir)) {
      return { totalFreedBytes, totalFreedFiles, profilesCleaned };
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const profilePath = path.join(baseDir, entry.name);
        const { freedBytes, freedFiles } = prunePlaywrightProfileCaches(profilePath);
        if (freedFiles > 0) {
          totalFreedBytes += freedBytes;
          totalFreedFiles += freedFiles;
          profilesCleaned++;
        }
      }
    }
  } catch {}

  return { totalFreedBytes, totalFreedFiles, profilesCleaned };
}
/**
 * Removes profile directories in data/qwen_profiles that do not belong to any
 * active account configured in the database or environment, plus any lingering
 * .stale-* directories from previous lock renames.
 */
export function cleanupOrphanProfiles(
  baseDir = getProfilesDir(),
  activeAccountIds?: Set<string>,
): {
  removedCount: number;
  freedBytes: number;
} {
  let removedCount = 0;
  let freedBytes = 0;

  try {
    if (!fs.existsSync(baseDir)) {
      return { removedCount, freedBytes };
    }

    const activeIds =
      activeAccountIds ?? new Set(loadAccounts().map((a) => a.id));

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const isStale = entry.name.includes(".stale-");
      const isOrphan = !isStale && !activeIds.has(entry.name);

      if (isStale || isOrphan) {
        const targetPath = path.join(baseDir, entry.name);
        try {
          let bytes = 0;
          const countSize = (d: string) => {
            try {
              const subEntries = fs.readdirSync(d, { withFileTypes: true });
              for (const e of subEntries) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) countSize(full);
                else if (e.isFile()) {
                  try { bytes += fs.statSync(full).size; } catch {}
                }
              }
            } catch {}
          };
          countSize(targetPath);
          removePlaywrightProfile(targetPath);
          if (!fs.existsSync(targetPath)) {
            removedCount++;
            freedBytes += bytes;
          }
        } catch {}
      }
    }
  } catch {}

  return { removedCount, freedBytes };
}

const PROFILE_RESET_TIMEOUT_MS = Math.max(90_000, config.timeouts.headers);

export async function refreshHeadersWithProfileReset(
  accountId: string,
): Promise<void> {
  let account: QwenAccount | null = null;

  const release = await acquireAccountMutex(
    accountId,
    `profile-reset:${accountId.substring(0, 12)}`,
  );
  try {
    await resetPlaywrightProfileLocked(accountId);
    const accounts = await import("../core/accounts.ts");
    account = accounts.getAccountCredentials(accountId) ?? null;
    if (!account) {
      throw new Error(`Account ${accountId} not found during profile reset`);
    }
  } finally {
    release();
  }

  await withTimeout(
    initPlaywrightForAccount(account),
    PROFILE_RESET_TIMEOUT_MS,
    `Playwright re-initialization timed out after ${PROFILE_RESET_TIMEOUT_MS}ms`,
  ).catch(async (error) => {
    await closePlaywrightForAccount(accountId).catch(() => {});
    throw error;
  });
}

export function schedulePlaywrightProfileReset(accountId: string): void {
  if (closingAllPlaywright || profileResetQueue.has(accountId)) return;

  const resetPromise = profileResetChain
    .catch(() => {})
    .then(async () => {
      if (closingAllPlaywright) return;
      await refreshHeadersWithProfileReset(accountId);
    })
    .catch((error) => {
      console.warn(
        `[Playwright] Queued profile reset failed for ${accountId}: ${getErrorMessage(error)}`,
      );
    })
    .finally(() => {
      profileResetQueue.delete(accountId);
    });

  profileResetQueue.set(accountId, resetPromise);
  profileResetChain = resetPromise.then(
    () => undefined,
    () => undefined,
  );
}

// ─── Keep Alive ───────────────────────────────────────────────────────────────

export function getActivePlaywrightAccountIds(): string[] {
  return Array.from(accountPages.keys());
}

export function getIdlePlaywrightAccountIds(idleMs: number): string[] {
  const now = Date.now();
  return Array.from(accountPages.keys()).filter((accountId) => {
    if (isAccountServingStream(accountId)) return false;
    const mutex = accountMutexes.get(accountId);
    if (!mutex?.isIdle()) return false;
    const lastActivity = lastAccountActivity.get(accountId) ?? 0;
    return now - lastActivity >= idleMs;
  });
}

/**
 * Order context-eviction candidates so the MOST valuable contexts survive.
 * Pure ordering: unranked accounts first, then ranked accounts from LOWEST to
 * HIGHEST priority, then oldest activity. The priority file is kept in
 * "most recently successful first" order (markAccountSuccessful moves the
 * account to the top), so the accounts actually being used stay warm instead
 * of the last-created ones from the warmup (which previously made the FIRST
 * used account pay a ~12s context recreation).
 */
export function orderContextsForEviction(
  accountIds: string[],
  priorityRank: (id: string) => number | undefined,
  activity: (id: string) => number,
): string[] {
  return [...accountIds].sort((a, b) => {
    const rankA = priorityRank(a) ?? Number.MAX_SAFE_INTEGER;
    const rankB = priorityRank(b) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankB - rankA; // lowest priority first
    return (activity(a) ?? 0) - (activity(b) ?? 0); // oldest activity first
  });
}

function priorityOrderForEviction(accountIds: string[]): string[] {
  const ranked = getAccountsByPriority(accountIds.map((id) => ({ id })));
  const rank = new Map<string, number>();
  for (const [index, account] of ranked.entries()) {
    rank.set(account.id, index);
  }
  return orderContextsForEviction(
    accountIds,
    (id) => rank.get(id),
    (id) => lastAccountActivity.get(id) ?? 0,
  );
}

// ─── Context admission (hard cap) ─────────────────────────────────────────────

/**
 * PLAYWRIGHT_MAX_ACTIVE_CONTEXTS is enforced at LAUNCH time, not only by idle
 * eviction: eviction closes contexts that happen to be idle, so when every
 * open context is busy it frees nothing and the next launch would silently
 * exceed the cap. An account therefore takes a slot here first — counting live
 * pages plus in-flight reservations — and only launches when one is free.
 * Waiters are bounded by the caller's init deadline and fail with a clear
 * error instead of stacking unbounded Chromium launches.
 */
const contextAdmissions = new Map<string, number>();
const contextAdmissionWaiters = new Set<() => void>();

function wakeContextAdmissionWaiters(): void {
  for (const wake of Array.from(contextAdmissionWaiters)) wake();
}

/** Free a slot (any close/cleanup path) and let queued launches retry. */
function releaseContextAdmission(accountId: string): void {
  contextAdmissions.delete(accountId);
  wakeContextAdmissionWaiters();
}

/**
 * Drop reservations that can no longer become a live context: a registered
 * page owns the slot now (the reservation is redundant), the init budget that
 * created it ran out, or the account mutex went idle without a page — the
 * launch failed between admission and `accountPages.set`, so the slot is freed
 * without every failure path having to remember the release.
 */
function reapDeadContextAdmissions(): void {
  const now = Date.now();
  for (const [accountId, reservedAt] of contextAdmissions) {
    if (accountPages.has(accountId)) {
      contextAdmissions.delete(accountId);
      continue;
    }
    if (now - reservedAt > PLAYWRIGHT_INIT_TIMEOUT_MS) {
      contextAdmissions.delete(accountId);
      continue;
    }
    if (accountMutexes.get(accountId)?.isIdle()) {
      contextAdmissions.delete(accountId);
    }
  }
}

/** Slots in use: contexts that are live plus launches that are about to be. */
function liveContextCount(): number {
  reapDeadContextAdmissions();
  const ids = new Set<string>(accountPages.keys());
  for (const accountId of contextAdmissions.keys()) ids.add(accountId);
  return ids.size;
}

/**
 * Wait for a context slot. Throws once the deadline passes while still at the
 * ceiling, so callers fail fast (and the pool retries later) instead of
 * launching past the cap.
 */
async function acquireContextAdmission(
  accountId: string,
  deadlineMs: number,
): Promise<void> {
  // Once per process, before the first launch of the run: reclaim browsers a
  // previous run left behind and arm the exit-time killer (see
  // browser-process-cleanup.ts). Warmup passes through here, so hygiene always
  // completes before any context of this run is launched.
  await ensureBrowserProcessHygiene();

  const max = config.playwright.maxActiveContexts;
  if (max <= 0) return; // 0 = uncapped (idle TTL sweep only)
  if (accountPages.has(accountId)) return;

  const startedAt = Date.now();
  let lastEvictionAttempt = 0;
  for (;;) {
    if (liveContextCount() < max) {
      contextAdmissions.set(accountId, Date.now());
      return;
    }

    const now = Date.now();
    if (now >= deadlineMs) {
      throw new Error(
        `Context admission denied for ${accountId}: ${liveContextCount()} active contexts at the PLAYWRIGHT_MAX_ACTIVE_CONTEXTS=${max} ceiling (waited ${now - startedAt}ms)`,
      );
    }

    // Actively try to free a slot by closing idle contexts (the same bounded
    // machinery the launch path uses) instead of only waiting for a close.
    if (now - lastEvictionAttempt >= 2_000) {
      lastEvictionAttempt = now;
      void withTimeout(
        evictIdlePlaywrightContextsToLimit().catch(() => 0),
        Math.min(20_000, Math.max(1_000, deadlineMs - now)),
        `Admission eviction timed out for ${accountId}`,
      ).catch(() => {});
    }

    await new Promise<void>((resolve) => {
      // NOT unref'd on purpose: a queued launch is real pending work and must
      // keep the event loop alive until it gets a slot or the deadline fires.
      // The waiter entry is removed by whichever comes first (wake or timer).
      setTimeout(() => {
        contextAdmissionWaiters.delete(resolve);
        resolve();
      }, Math.min(1_000, Math.max(50, deadlineMs - now)));
      contextAdmissionWaiters.add(resolve);
    });
  }
}

export async function closeIdlePlaywrightAccounts(
  idleMs: number,
): Promise<number> {
  if (idleMs <= 0) return 0;

  const maxActiveContexts = config.playwright.maxActiveContexts;

  if (maxActiveContexts > 0 && accountPages.size <= maxActiveContexts) {
    return 0;
  }

  // HOT (headers-ready) contexts are the pool's warm working set: keep as many
  // as the effective target allows. They are never allowed to hold the count
  // above the hard cap, so a second pass drops the protection when pass one
  // could not get under the ceiling (same policy as
  // evictIdlePlaywrightContextsToLimit).
  const hotTarget =
    maxActiveContexts > 0
      ? Math.min(config.pool.targetReady, maxActiveContexts)
      : config.pool.targetReady;

  let closed = 0;
  for (const protectHot of [true, false]) {
    if (maxActiveContexts > 0 && accountPages.size <= maxActiveContexts) break;
    // With no cap this is a pure TTL sweep: no ceiling to enforce, so the
    // hot-protection pass is the only one that runs.
    if (maxActiveContexts <= 0 && !protectHot) break;

    const hotCount = Array.from(accountPages.keys()).filter((id) =>
      isAccountHeadersReady(id),
    ).length;
    const hotProtected = protectHot && hotCount <= hotTarget;

    const candidates = priorityOrderForEviction(
      getIdlePlaywrightAccountIds(idleMs).filter((accountId) => {
        if (hotProtected && isAccountHeadersReady(accountId)) return false;
        return true;
      }),
    ).map((accountId) => ({
      accountId,
      lastActivity: lastAccountActivity.get(accountId) ?? 0,
    }));

    for (const candidate of candidates) {
      if (maxActiveContexts > 0 && accountPages.size <= maxActiveContexts) {
        break;
      }

      // Re-checked per account: closing the previous one is awaited, and a
      // request can have claimed this account in the meantime.
      if (isAccountServingStream(candidate.accountId)) continue;

      const mutex = accountMutexes.get(candidate.accountId);
      if (!mutex?.isIdle()) continue;

      const release = await acquireAccountMutex(
        candidate.accountId,
        `idle-close:${candidate.accountId.substring(0, 12)}`,
      ).catch(() => null);
      if (!release) continue;
      try {
        if (isAccountServingStream(candidate.accountId)) continue;
        await closePlaywrightForAccountLocked(candidate.accountId);
        closed++;
      } catch (error) {
        console.warn(
          `[Playwright] Failed to close idle context for ${candidate.accountId}: ${getErrorMessage(error)}`,
        );
      } finally {
        release();
      }
    }
  }
  return closed;
}

/**
 * Close idle browser contexts until the number of active contexts is within
 * PLAYWRIGHT_MAX_ACTIVE_CONTEXTS. Never closes a context whose account mutex
 * is busy, so active streams are preserved.
 */
export async function evictIdlePlaywrightContextsToLimit(): Promise<number> {
  const max = config.playwright.maxActiveContexts;
  if (max <= 0) return 0;
  if (accountPages.size <= max) return 0;

  // Two passes. Pass 1 protects the HOT (headers-ready) working set: while it
  // is at or below the effective target it is what keeps the pool warm, so
  // cold contexts go first. Pass 2 drops that protection if the count is still
  // above the ceiling — the cap is a hard limit and HOT contexts must never be
  // what breaks it (before, `hotProtected` could block every candidate and the
  // eviction silently closed nothing).
  const hotTarget = Math.min(config.pool.targetReady, max);
  let closed = 0;

  for (const protectHot of [true, false]) {
    if (accountPages.size <= max) break;

    const hotCount = Array.from(accountPages.keys()).filter((id) =>
      isAccountHeadersReady(id),
    ).length;
    const hotProtected = protectHot && hotCount <= hotTarget;

    const candidates = priorityOrderForEviction(
      Array.from(accountPages.keys()).filter((accountId) => {
        if (hotProtected && isAccountHeadersReady(accountId)) return false;
        const mutex = accountMutexes.get(accountId);
        return mutex?.isIdle() && !isAccountServingStream(accountId);
      }),
    ).map((accountId) => ({
      accountId,
      mutex: accountMutexes.get(accountId),
      lastActivity: lastAccountActivity.get(accountId) ?? 0,
    }));

    for (const candidate of candidates) {
      if (accountPages.size <= max) break;
      if (isAccountServingStream(candidate.accountId)) continue;
      const mutex = accountMutexes.get(candidate.accountId);
      if (!mutex?.isIdle()) continue;

      const release = await acquireAccountMutex(
        candidate.accountId,
        `idle-evict:${candidate.accountId.substring(0, 12)}`,
      ).catch(() => null);
      if (!release) continue;
      try {
        if (isAccountServingStream(candidate.accountId)) continue;
        await closePlaywrightForAccountLocked(candidate.accountId);
        closed++;
      } catch (error) {
        console.warn(
          `[Playwright] Failed to evict idle context for ${candidate.accountId}: ${getErrorMessage(error)}`,
        );
      } finally {
        release();
      }
    }
  }

  return closed;
}

export async function keepAlivePlaywrightAccount(
  accountId: string,
): Promise<boolean> {
  return withPlaywrightOpSlot(() => keepAlivePlaywrightAccountInner(accountId));
}

async function keepAlivePlaywrightAccountInner(
  accountId: string,
): Promise<boolean> {
  // The keep-alive navigates the same page the renderer is streaming from, so
  // a mid-flight account must be skipped for the same reason it must not be
  // closed: the free mutex does not mean the page is free.
  if (isAccountServingStream(accountId)) return false;

  const mutex = accountMutexes.get(accountId);
  if (!mutex?.isIdle()) return false;

  const lastActivity = lastAccountActivity.get(accountId) ?? 0;
  if (Date.now() - lastActivity < config.sessionKeeper.idleMs) return false;

  const release = await mutex
    .acquire(2_000, `keepalive:${accountId.substring(0, 12)}`)
    .catch(() => null);
  if (!release) return false;

  try {
    if (isAccountServingStream(accountId)) return false;

    const page = accountPages.get(accountId);
    if (!page || page.isClosed()) return false;

    const now = Date.now();
    const currentUrl = page.url();
    const lastNavigation = lastKeepAliveNavigation.get(accountId) ?? 0;
    const shouldNavigate =
      !currentUrl.startsWith(qwenOrigin()) ||
      now - lastNavigation > config.sessionKeeper.navigationIntervalMs;

    if (shouldNavigate) {
      await page.goto(qwenUrl("/"), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(config.timeouts.navigation, 30_000),
      });
      lastKeepAliveNavigation.set(accountId, now);
    } else {
      await subtlePageActivity(page);
    }

    touchAccountActivity(accountId);
    return true;
  } finally {
    release();
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * A renderer crash ("page.evaluate: Target crashed") or browser death leaves
 * a zombie account entry: page.isClosed() can stay false while every page
 * operation fails, so the account would keep failing until something else
 * clears the maps. Forget the state (and best-effort close) on death so the
 * next use re-initializes cleanly — the same proven path as an evicted context.
 */
export function installContextDeathHandlers(
  accountId: string,
  context: BrowserContext,
  page: Page,
): void {
  const onDeath = (): void => {
    void cleanupPlaywrightAccountState(accountId);
    void closePlaywrightContextBestEffort(accountId, context, { skipStorageSave: true }).catch((error: unknown) => {
      logger.warn("[Playwright] context-death close suppressed", {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
      metrics.increment("browser.close.suppressed_errors");
    });
  };
  context.on("close", onDeath);
  page.on("crash", onDeath);
}

async function cleanupPlaywrightAccountState(accountId: string): Promise<void> {
  accountContexts.delete(accountId);
  accountPages.delete(accountId);
  headerCaches.delete(accountId);
  cookieCaches.delete(accountId);
  lastAccountActivity.delete(accountId);
  lastKeepAliveNavigation.delete(accountId);
  releaseContextAdmission(accountId);
  clearFingerprintCache(accountId);
  await unmarkAccountHeadersReady(accountId);
  void import("../runtime/construct.ts")
    .then((m) => m.requestReadinessTick("context-death"))
    .catch(() => {});
}

async function closePlaywrightContextBestEffort(
  accountId: string,
  context: BrowserContext,
  options?: { skipStorageSave?: boolean },
): Promise<void> {
  // Overall bound for the WHOLE close (storage save + unroute + page closes +
  // context.close): each step had its own limit but nothing bounded the
  // sequence, so one wedged step kept closeAllPlaywright hanging while the
  // browser held its RSS. On timeout the close escalates to a process kill
  // instead of being abandoned with the browser still resident.
  const overallMs = config.playwright.contextCloseTimeoutMs + 5_000;
  try {
    await withTimeout(
      closePlaywrightContextBestEffortInner(accountId, context, options),
      overallMs,
      `Bounded close of Playwright context for ${accountId} exceeded ${overallMs}ms`,
    );
  } catch (error) {
    if (isPlaywrightAlreadyClosedError(error)) return;
    console.warn(
      `[Playwright] Failed to close context for ${accountId}: ${getErrorMessage(error)}`,
    );
    metrics.increment("browser.close.escalated");
    await escalateContextCloseToProcessKill(accountId, context);
  }
}

async function closePlaywrightContextBestEffortInner(
  accountId: string,
  context: BrowserContext,
  options?: { skipStorageSave?: boolean },
): Promise<void> {
  if (!options?.skipStorageSave) {
    try {
      if (await hasValidAuthCookie(context)) {
        await saveStorageState(context, accountId);
      }
    } catch {}
  }

  const pages = context.pages();
  for (const page of pages) {
    if (!page.isClosed()) {
      await (page as any).unrouteAll?.({ behavior: "ignoreErrors" }).catch((error: unknown) => {
        logger.warn("[Playwright] unrouteAll suppressed", {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.increment("browser.close.suppressed_errors");
      });
    }
  }
  await Promise.all(
    pages.map((page) =>
      withTimeout(
        page.close({ runBeforeUnload: false }),
        2_000,
        `Timed out closing page for ${accountId}`,
      ).catch((error: unknown) => {
        logger.warn("[Playwright] page close suppressed", {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.increment("browser.close.suppressed_errors");
      }),
    ),
  );

  await withTimeout(
    context.close(),
    config.playwright.contextCloseTimeoutMs,
    `Timed out closing Playwright context for ${accountId}`,
  );
}

/**
 * The context could not be closed cleanly: fall back to killing the browser
 * processes of this account's profile so a hung `context.close()` can never
 * leave a Chromium resident (it would otherwise keep ~400 MB until the next
 * startup reap).
 */
async function escalateContextCloseToProcessKill(
  accountId: string,
  context: BrowserContext,
): Promise<void> {
  let killed = 0;
  try {
    const browserProcess = getBrowserProcess(context) as
      | (KillableProcess & { pid?: number })
      | null;
    if (browserProcess?.pid && killBrowserProcessTree(browserProcess.pid)) {
      killed++;
    } else {
      browserProcess?.kill("SIGKILL");
    }
  } catch {}
  try {
    killed += await killBrowserProcessesForProfile(
      getAccountProfilePath(accountId),
    );
  } catch {}
  console.warn(
    `[Playwright] Escalated close for ${accountId}: ${killed} browser process(es) killed`,
  );
}

async function closePlaywrightForAccountLocked(
  accountId: string,
): Promise<void> {
  const acctContext = accountContexts.get(accountId);
  try {
    if (acctContext) {
      await closePlaywrightContextBestEffort(accountId, acctContext);
    }
  } finally {
    await cleanupPlaywrightAccountState(accountId);
    try {
      const profilePath = getAccountProfilePath(accountId);
      prunePlaywrightProfileCaches(profilePath);
    } catch {}
  }
}

/**
 * True for Playwright rejections that mean "the page/context/browser was
 * closed underneath the operation" — benign races against shutdown/eviction
 * that must not be logged as keep-alive failures.
 */
export function isPlaywrightAlreadyClosedError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && "message" in error
        ? String((error as any).message)
        : String(error);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Target crashed") ||
    message.includes("Page crashed") ||
    message.includes("Assertion error") ||
    message.includes("Cannot find parent object") ||
    message.includes("Connection closed") ||
    message.includes("session closed") ||
    message.includes("Session closed") ||
    message.includes("Network.setCacheDisabled") ||
    message.includes("Protocol error")
  );
}

export function isPlaywrightSessionDeathError(error: unknown): boolean {
  return isPlaywrightAlreadyClosedError(error);
}

export async function closePlaywrightForAccount(
  accountId: string,
): Promise<void> {
  const release = await acquireAccountMutex(
    accountId,
    `close:${accountId.substring(0, 12)}`,
  );
  try {
    await closePlaywrightForAccountLocked(accountId);
  } finally {
    release();
  }
}

// WAF hard-block contingency: after the fingerprint seed rotates, close this
// account's context so the next use re-initializes with the fresh device
// identity (cookies/storage persist in the profile dir). Fire-and-forget — the
// quarantine is already applied; a failed close must not abort it.
setWafContextResetListener((accountId: string) => {
  if (!accountPages.has(accountId)) return;
  void closePlaywrightForAccount(accountId).catch((error: unknown) => {
    console.warn(
      `[Playwright] WAF context reset failed for ${accountId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
});

export async function closeAllPlaywright(): Promise<void> {
  closingAllPlaywright = true;
  try {
    const accountIds = Array.from(
      new Set([
        ...accountContexts.keys(),
        ...accountPages.keys(),
        ...headerCaches.keys(),
        ...cookieCaches.keys(),
        ...lastAccountActivity.keys(),
      ]),
    );
    for (const accountId of accountIds) {
      await closePlaywrightForAccount(accountId);
    }
    if (sharedBrowser && sharedBrowser.isConnected()) {
      await sharedBrowser.close().catch((error: unknown) => {
        logger.warn("[Playwright] shared browser close suppressed", {
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.increment("browser.close.suppressed_errors");
      });
      sharedBrowser = null;
    }
    // Last line of defence for shutdown: any browser child this process still
    // owns (a close that escalated, a renderer Playwright does not track) is
    // killed here so the process can exit without leaving RSS behind. The
    // exit-hook killer covers process.exit()/crash paths as well.
    const stragglers = killChildBrowserProcessesSync();
    if (stragglers > 0) {
      console.warn(
        `[Playwright] Shutdown killed ${stragglers} remaining browser process(es)`,
      );
    }
  } finally {
    closingAllPlaywright = false;
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

// Defined in ./playwright-page-state.ts (leaf: core readiness gates must be
// able to query page state without importing this module and re-creating the
// waf-isolation cycle) and re-exported here for existing consumers.
export { isPlaywrightInitialized, isPlaywrightPageAlive };

/**
 * Register an account as if it had been initialized, with a chosen last
 * activity timestamp. Lets the idle/keep-alive selection be exercised without
 * launching a browser; the mutex is materialized because an account without
 * one is never selected. For tests only.
 */
export function registerPlaywrightAccountForTests(
  accountId: string,
  page: Page,
  lastActivityAt: number,
): void {
  getAccountMutex(accountId);
  accountPages.set(accountId, page);
  lastAccountActivity.set(accountId, lastActivityAt);
}

export function unregisterPlaywrightAccountForTests(accountId: string): void {
  accountPages.delete(accountId);
  accountContexts.delete(accountId);
  lastAccountActivity.delete(accountId);
}

// ─── Token TTL Diagnostics ───────────────────────────────────────────────────

export interface CookieDiagnostic {
  name: string;
  domain: string;
  category: "auth" | "anti-fraud" | "tracking" | "other";
  expiresAt: number | null; // epoch seconds, null = session cookie
  expiresInMin: number | null; // minutes until expiry, null = session
  isExpired: boolean;
  isSession: boolean;
}

export interface HeaderDiagnostic {
  accountId: string;
  hasHeaders: boolean;
  headerAgeMin: number;
  headersTtlMin: number;
  refreshThresholdMin: number;
  refreshInProgress: boolean;
}

function cookieCategory(name: string): CookieDiagnostic["category"] {
  const n = name.toLowerCase();
  if (n.includes("token") || n.includes("session") || n.includes("auth")) return "auth";
  if (n.includes("umid") || n.includes("baxia") || n.includes("_m_h5")) return "anti-fraud";
  if (n.includes("cna") || n.includes("isg") || n.includes("_uab_")) return "tracking";
  return "other";
}

/**
 * Get diagnostic info about cookie lifetimes and header cache state.
 * Useful for determining the real TTL of Qwen tokens.
 */
export async function getTokenDiagnostics(
  accountId?: string,
): Promise<{
  cookies: CookieDiagnostic[];
  headers: HeaderDiagnostic[];
  summary: {
    totalCookies: number;
    sessionCookies: number;
    shortestTtlMin: number | null;
    shortestTtlCookie: string | null;
  };
}> {
  const targetAccounts = accountId
    ? [accountId]
    : Array.from(accountContexts.keys());
  const allCookies: CookieDiagnostic[] = [];
  const headerDiags: HeaderDiagnostic[] = [];

  for (const accId of targetAccounts) {
    const context = accountContexts.get(accId);
    if (!context) continue;

    // Get cookies
    try {
      const cookies = await context.cookies();
      const now = Date.now();

      for (const cookie of cookies) {
        const isSession = cookie.expires === -1;
        const expiresAt = isSession ? null : cookie.expires;
        const expiresInMin = isSession
          ? null
          : Math.round((cookie.expires * 1000 - now) / 60000);

        allCookies.push({
          name: cookie.name,
          domain: cookie.domain.replace(/^\./, ""),
          category: cookieCategory(cookie.name),
          expiresAt,
          expiresInMin,
          isExpired: !isSession && cookie.expires * 1000 < now,
          isSession,
        });
      }
    } catch {
      // Context may be closing
    }

    // Get header cache info
    const cache = headerCaches.get(accId);
    if (cache) {
      const ageMin = Math.round((Date.now() - cache.lastRefresh) / 60000);
      headerDiags.push({
        accountId: accId,
        hasHeaders: !!cache.headers["bx-ua"],
        headerAgeMin: ageMin,
        headersTtlMin: Math.round(HEADER_CACHE_TTL / 60000),
        refreshThresholdMin: Math.round((HEADER_CACHE_TTL * HEADER_REFRESH_THRESHOLD) / 60000),
        refreshInProgress: cache.refreshInProgress,
      });
    }
  }

  // Find shortest TTL among persistent cookies
  const persistentCookies = allCookies.filter(c => !c.isSession && !c.isExpired);
  const shortest = persistentCookies.length > 0
    ? persistentCookies.reduce((min, c) =>
        (c.expiresInMin ?? Infinity) < (min.expiresInMin ?? Infinity) ? c : min
      )
    : null;

  return {
    cookies: allCookies.sort((a, b) => {
      if (a.isSession && !b.isSession) return 1;
      if (!a.isSession && b.isSession) return -1;
      return (a.expiresInMin ?? Infinity) - (b.expiresInMin ?? Infinity);
    }),
    headers: headerDiags,
    summary: {
      totalCookies: allCookies.length,
      sessionCookies: allCookies.filter(c => c.isSession).length,
      shortestTtlMin: shortest?.expiresInMin ?? null,
      shortestTtlCookie: shortest?.name ?? null,
    },
  };
}
