import { AuthError, ServiceUnavailable } from "../core/errors.ts";
import { loadAccounts } from "../core/accounts.ts";
import {
  getHeadersReadyAccountIds,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  getBasicHeaders as getPlaywrightBasicHeaders,
  isPlaywrightInitialized,
  isPlaywrightPageAlive,
  refreshHeaders,
} from "./playwright.ts";

export interface HeaderResult {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}

/**
 * Bounded retry-after for the "no live context" capacity error. Mirrors
 * NO_HOT_ACCOUNT_RETRY_AFTER_MS at the chat selection boundary (same pool,
 * same readiness-controller cadence) without pulling a routes module into
 * the services layer.
 */
const NO_LIVE_CONTEXT_RETRY_AFTER_MS = 3_000;

export function isAuthMockEnabled(): boolean {
  return (
    process.env.TEST_MOCK_QWEN_AUTH === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

function isRunningUnderNodeTest(): boolean {
  return process.argv.some(
    (arg) =>
      arg === "--test" ||
      arg.includes("src/tests/") ||
      arg.includes("src\\tests\\"),
  );
}

async function ensurePlaywrightInitialized(accountId: string): Promise<void> {
  if (isPlaywrightInitialized(accountId) && isPlaywrightPageAlive(accountId)) return;

  // The account was selected as ready but has no usable context: a phantom
  // readiness entry (the context died while a lease blocked the unmark, or the
  // page was evicted). Unmark it so the readiness controller re-warms it
  // instead of every later request rediscovering the same failure. No-op when
  // the account was never marked, and for a leased account
  // (RESERVED/GENERATING recovers through the release path instead).
  try {
    await unmarkAccountHeadersReady(accountId);
  } catch {
    // Best-effort: healing must never mask the readiness failure below.
  }

  if (isRunningUnderNodeTest()) {
    throw new Error(`Playwright not initialized for account: ${accountId}`);
  }

  throw new AuthError(
    `Account ${accountId} is not warmed. The pool controller will prepare it in the background.`,
  );
}

/**
 * Pick the account an unpinned header fetch should use (model catalog, upload,
 * personalization sync). Only accounts with a LIVE Playwright context are
 * eligible — READY entries first, then any other live context. Returns null
 * when nothing in the pool can serve headers.
 *
 * Exported for unit tests; the production path goes through
 * resolveHeaderAccountId below.
 */
export function pickLiveContextAccountId(
  accounts: ReadonlyArray<{ id: string }>,
): string | null {
  for (const id of getHeadersReadyAccountIds()) {
    if (isPlaywrightPageAlive(id)) return id;
  }
  for (const account of accounts) {
    if (isPlaywrightPageAlive(account.id)) return account.id;
  }
  return null;
}

function createNoLiveContextCapacityError(): ServiceUnavailable & {
  retryAfterMs: number;
} {
  // Wake the readiness controller out-of-band: the next reconcile tick may be
  // up to 30s away, but the client is told to retry within 3s. Skipped under
  // the test runner (no controller is running there and the import would pull
  // the whole runtime into a unit test).
  if (!isRunningUnderNodeTest()) {
    void import("../runtime/construct.ts")
      .then((m) => m.requestReadinessTick("no-live-context"))
      .catch(() => {});
  }
  const err = new ServiceUnavailable(
    `No warmed Qwen account context is available right now. The pool controller is preparing accounts in the background; retry in about ${Math.ceil(NO_LIVE_CONTEXT_RETRY_AFTER_MS / 1000)}s.`,
    "no_hot_account",
  ) as ServiceUnavailable & { retryAfterMs: number };
  err.retryAfterMs = NO_LIVE_CONTEXT_RETRY_AFTER_MS;
  return err;
}

/**
 * Resolve the account for a header fetch. An explicit accountId is honored as
 * given (the HOT gate upstream already vouched for it). Otherwise only live
 * contexts are eligible: the previous fallback
 * (`getHeadersReadyAccountIds()[0] ?? loadAccounts()[0]?.id`) happily picked a
 * READY record whose context had died — or a cold first account — and the
 * request then failed with "Account <id> is not warmed" at the client.
 * Zero configured accounts stays an AuthError (configuration problem); a
 * configured pool with no live context is a bounded 503 capacity error.
 *
 * Exported for unit tests.
 */
export function resolveHeaderAccountId(accountId?: string): string {
  if (accountId) return accountId;

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    throw new AuthError(
      "No Qwen accounts configured. Add accounts with npm run login.",
    );
  }

  const live = pickLiveContextAccountId(accounts);
  if (live) return live;

  // Hermetic test seam: no browser is launched under `tsx --test`, so a live
  // context never exists there. Keep the deterministic legacy fallback so
  // tests still reach ensurePlaywrightInitialized (and its test-mode error)
  // instead of the production capacity path.
  if (isRunningUnderNodeTest()) {
    return getHeadersReadyAccountIds()[0] ?? accounts[0].id;
  }

  throw createNoLiveContextCapacityError();
}

export async function getBasicHeaders(accountId?: string): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  version: string;
  /** Authorization: Bearer <jwt> the web client attaches to every API call. */
  authorization: string;
}> {
  if (isAuthMockEnabled()) {
    return {
      cookie: "token=mock",
      userAgent: "mock",
      bxV: "2.5.37",
      bxUa: "mock-bx-ua",
      bxUmidtoken: "mock-bx-umidtoken",
      secChUa: "",
      secChUaMobile: "?0",
      secChUaPlatform: "",
      version: "0.2.89",
      authorization: "",
    };
  }

  const resolvedAccountId = resolveHeaderAccountId(accountId);

  await ensurePlaywrightInitialized(resolvedAccountId);
  return getPlaywrightBasicHeaders(resolvedAccountId);
}

export function isTokenExpiringSoon(
  cookie: string,
  minutesBeforeExpiry = 5,
): boolean {
  const tokenMatch = cookie.match(/token=([^;]+)/);
  if (!tokenMatch) return false;

  try {
    const token = decodeURIComponent(tokenMatch[1]);
    const segments = token.split(".");
    // Some Qwen deployments use opaque cookies. Treating those as expired
    // forces expensive header capture on every personalization request.
    if (segments.length !== 3 || !segments[1]) return false;

    const payloadJson = Buffer.from(segments[1], "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    const thresholdSec = minutesBeforeExpiry * 60;
    return exp - nowSec < thresholdSec;
  } catch {
    return false;
  }
}

export async function getQwenHeaders(
  forceNew = false,
  accountId?: string,
): Promise<HeaderResult> {
  if (isAuthMockEnabled()) {
    const basic = await getBasicHeaders(accountId);
    return {
      headers: {
        cookie: basic.cookie,
        "user-agent": basic.userAgent,
        "bx-v": basic.bxV,
        "bx-ua": basic.bxUa,
        "bx-umidtoken": basic.bxUmidtoken,
        version: basic.version,
        authorization: basic.authorization,
      },
      chatSessionId: "",
      parentMessageId: null,
    };
  }

  const resolvedAccountId = resolveHeaderAccountId(accountId);

  await ensurePlaywrightInitialized(resolvedAccountId);

  if (forceNew) {
    await refreshHeaders(resolvedAccountId);
  }

  const basic = await getPlaywrightBasicHeaders(resolvedAccountId);
  return {
    headers: {
      cookie: basic.cookie,
      "user-agent": basic.userAgent,
      "bx-v": basic.bxV,
      "bx-ua": basic.bxUa || "",
      "bx-umidtoken": basic.bxUmidtoken || "",
      "sec-ch-ua": basic.secChUa,
      "sec-ch-ua-mobile": basic.secChUaMobile,
      "sec-ch-ua-platform": basic.secChUaPlatform,
      version: basic.version,
      // The bearer upstream authenticates on; buildCapturedQwenHeaders pairs it
      // with `source: web` exactly like the real client. Empty when the account
      // has no usable token (getBasicHeaders already forced a recapture).
      authorization: basic.authorization || "",
    },
    chatSessionId: "",
    parentMessageId: null,
  };
}
