import { AuthError } from "../core/errors.ts";
import { loadAccounts } from "../core/accounts.ts";
import { getHeadersReadyAccountIds } from "../core/account-manager.ts";
import {
  getBasicHeaders as getPlaywrightBasicHeaders,
  isPlaywrightInitialized,
  refreshHeaders,
} from "./playwright.ts";

export interface HeaderResult {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}

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
  if (isPlaywrightInitialized(accountId)) return;

  if (isRunningUnderNodeTest()) {
    throw new Error(`Playwright not initialized for account: ${accountId}`);
  }

  throw new AuthError(
    `Account ${accountId} is not warmed. The pool controller will prepare it in the background.`,
  );
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
    };
  }

  const resolvedAccountId =
    accountId ?? getHeadersReadyAccountIds()[0] ?? loadAccounts()[0]?.id;
  if (!resolvedAccountId) {
    throw new AuthError(
      "No Qwen accounts configured. Add accounts with npm run login.",
    );
  }

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
      },
      chatSessionId: "",
      parentMessageId: null,
    };
  }

  const resolvedAccountId =
    accountId ?? getHeadersReadyAccountIds()[0] ?? loadAccounts()[0]?.id;
  if (!resolvedAccountId) {
    throw new AuthError(
      "No Qwen accounts configured. Add accounts with npm run login.",
    );
  }

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
    },
    chatSessionId: "",
    parentMessageId: null,
  };
}
