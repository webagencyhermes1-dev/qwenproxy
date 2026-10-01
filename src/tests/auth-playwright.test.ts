import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import { clearAllHeadersReadyAccounts } from "../core/account-manager.ts";

const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;

function snapshotAccounts(): any[] {
  return getDatabase()
    .prepare("SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts")
    .all() as any[];
}

function restoreAccounts(rows: any[]): void {
  const db = getDatabase();
  db.prepare("DELETE FROM accounts").run();
  const insert = db.prepare(
    "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.email,
      row.password,
      row.cooldown_until ?? 0,
      row.cooldown_reason ?? null,
    );
  }
  invalidateAccountsCache();
}

afterEach(() => {
  if (originalMockAuth === undefined) delete process.env.TEST_MOCK_QWEN_AUTH;
  else process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;

  if (originalQwenAccounts === undefined) delete process.env.QWEN_ACCOUNTS;
  else process.env.QWEN_ACCOUNTS = originalQwenAccounts;

  invalidateAccountsCache();
});

test("auth-playwright: mock mode returns complete headers", async () => {
  process.env.TEST_MOCK_QWEN_AUTH = "true";
  const { getBasicHeaders, getQwenHeaders, isAuthMockEnabled } = await import(
    "../services/auth-playwright.ts"
  );

  assert.equal(isAuthMockEnabled(), true);

  const basic = await getBasicHeaders();
  assert.equal(basic.cookie, "token=mock");
  assert.equal(basic.userAgent, "mock");
  assert.equal(basic.bxV, "2.5.37");
  assert.equal(basic.bxUa, "mock-bx-ua");
  assert.equal(basic.bxUmidtoken, "mock-bx-umidtoken");

  const full = await getQwenHeaders(true);
  assert.equal(full.headers.cookie, "token=mock");
  assert.equal(full.headers["bx-ua"], "mock-bx-ua");
  assert.equal(full.parentMessageId, null);
});

test("auth-playwright: requires configured account outside mock mode", async () => {
  const existing = snapshotAccounts();
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    restoreAccounts([]);
    const { getBasicHeaders } = await import("../services/auth-playwright.ts");
    await assert.rejects(
      () => getBasicHeaders(),
      /No Qwen accounts configured/,
    );
  } finally {
    restoreAccounts(existing);
  }
});

test("auth-playwright: only a parseable JWT expiry triggers proactive refresh", async () => {
  const { isTokenExpiringSoon } = await import("../services/auth-playwright.ts");
  const now = Math.floor(Date.now() / 1000);
  const token = (exp: number) =>
    `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;

  assert.equal(isTokenExpiringSoon("token=opaque-qwen-session"), false);
  assert.equal(isTokenExpiringSoon("session=without-token"), false);
  assert.equal(isTokenExpiringSoon("token=not.a.valid.jwt"), false);
  assert.equal(isTokenExpiringSoon(`token=${token(now + 60)}`), true);
  assert.equal(isTokenExpiringSoon(`token=${token(now - 1)}`), true);
  assert.equal(isTokenExpiringSoon(`token=${token(now + 3600)}`), false);
});

test("playwright header capture rejects empty headers and timeouts", async () => {
  const { captureQwenHeaders, hasRequiredQwenHeaders } = await import(
    "../services/playwright.ts"
  );

  assert.equal(hasRequiredQwenHeaders({}), false);
  assert.equal(
    hasRequiredQwenHeaders({
      cookie: "token=x",
      "user-agent": "ua",
      "bx-v": " ",
    }),
    false,
  );
  assert.equal(
    hasRequiredQwenHeaders({
      cookie: "token=x",
      "user-agent": "ua",
      "bx-v": "2.5.37",
    }),
    true,
  );

  let timeoutUnroutes = 0;
  const timeoutPage = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async () => {},
    unroute: async () => {
      timeoutUnroutes++;
    },
    goto: () => new Promise<void>(() => {}),
  };
  await assert.rejects(
    () => captureQwenHeaders("test-header-timeout", timeoutPage as any, 20),
    /timed out/,
  );
  assert.equal(timeoutUnroutes, 1);

  let incompleteUnroutes = 0;
  const incompletePage = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async (_pattern: string, handler: any) => {
      await handler(
        { abort: async () => {} },
        { headers: () => ({ "bx-ua": "present" }) },
      );
    },
    unroute: async () => {
      incompleteUnroutes++;
    },
  };
  await assert.rejects(
    () => captureQwenHeaders("test-header-incomplete", incompletePage as any, 20),
    /incomplete anti-fraud headers/,
  );
  assert.equal(incompleteUnroutes, 1);
});

test("playwright header capture gives up shortly after a send that fires no request", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  const invisible = {
    first: () => invisible,
    isVisible: async () => false,
    waitFor: async () => undefined,
    boundingBox: async () => null,
  };
  const silentPage = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {},
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  const startedAt = Date.now();
  await assert.rejects(
    // The overall budget is 30s; the send completes but no completion request
    // ever arrives, so only the trigger grace period may be spent.
    () => captureQwenHeaders("test-header-silent", silentPage as any, 30_000, 50),
    /timed out/,
  );
  assert.ok(
    Date.now() - startedAt < 15_000,
    "capture must not wait out the full header budget after the send",
  );
});
test("playwright header capture reloads instead of hanging when the chat input never appears", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  // A WAF interstitial / punish document renders no chat input. The old code
  // called page.focus directly, which waited out Playwright's 60s page default
  // per attempt and cooled the account with AuthInitFailed.
  const inputWaits: number[] = [];
  const state = { gotos: 0, focuses: 0 };
  const notFound = {
    first: () => notFound,
    isVisible: async () => false,
    waitFor: async (opts: any) => {
      inputWaits.push(opts?.timeout ?? -1);
      throw new Error("Timeout exceeded waiting for locator");
    },
    boundingBox: async () => null,
  };
  const blockedPage = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {
      state.gotos++;
    },
    locator: () => notFound,
    frameLocator: () => ({ locator: () => notFound }),
    focus: async () => {
      state.focuses++;
    },
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    () => captureQwenHeaders("test-header-no-input", blockedPage as any, 30_000, 50),
    /timed out/,
  );

  // Every attempt must bound the input wait well under the 60s page default.
  assert.ok(inputWaits.length >= 2, `expected per-attempt waits, got ${inputWaits.length}`);
  assert.ok(
    inputWaits.every((t) => t > 0 && t <= 15_000),
    `input wait must be bounded to <=15s, got ${JSON.stringify(inputWaits)}`,
  );
  assert.equal(state.focuses, 0, "focus must not be attempted on a page with no input");
  assert.equal(
    state.gotos,
    2,
    "a page with no chat input has no warm SDK state to protect: every attempt reloads",
  );
});

test("playwright header capture fails fast with a WAF diagnosis when the chat page is a challenge interstitial", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  // A Cloudflare "Just a moment..." interstitial renders no chat input. The
  // old code reloaded and re-waited 15s per attempt (2x under the new cap),
  // then reported a generic timeout with no WAF signal. The detector must
  // recognize the block and settle immediately with an actionable diagnosis.
  const state = { gotos: 0 };
  const notFound = {
    first: () => notFound,
    isVisible: async () => false,
    waitFor: async () => {
      throw new Error("Timeout exceeded waiting for locator");
    },
    boundingBox: async () => null,
  };
  const wafPage = {
    isClosed: () => false,
    url: () => "https://challenges.cloudflare.com/",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {
      state.gotos++;
    },
    locator: () => notFound,
    frameLocator: () => ({ locator: () => notFound }),
    focus: async () => {
      throw new Error("must not focus the chat input on a WAF page");
    },
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
    evaluate: async () => ({
      title: "Just a moment...",
      href: "https://challenges.cloudflare.com/",
      bodyText: "Checking your browser before accessing chat.qwen.ai. Access denied for automated requests.",
    }),
  };

  const startedAt = Date.now();
  await assert.rejects(
    () => captureQwenHeaders("test-header-waf", wafPage as any, 30_000, 50),
    /WAF challenge detected/,
  );
  assert.ok(
    Date.now() - startedAt < 8_000,
    "a detected WAF page must fail fast instead of burning 2x15s input waits",
  );
  assert.ok(
    state.gotos <= 1,
    "a detected WAF page must not reload into a second trigger attempt",
  );
});

test("playwright header capture diagnoses the Qwen punish document as a WAF block", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  const notFound = {
    first: () => notFound,
    isVisible: async () => false,
    waitFor: async () => {
      throw new Error("Timeout exceeded waiting for locator");
    },
    boundingBox: async () => null,
  };
  const punishPage = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/____punish____",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => notFound,
    frameLocator: () => ({ locator: () => notFound }),
    focus: async () => {},
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
    evaluate: async () => ({
      title: "",
      href: "https://chat.qwen.ai/____punish____",
      bodyText: "____punish____ 请求被拦截",
    }),
  };

  await assert.rejects(
    () => captureQwenHeaders("test-header-punish", punishPage as any, 30_000, 50),
    /WAF challenge detected/,
  );
});

test("detectChatPageBlockText classifies WAF pages without false positives on healthy chat text", async () => {
  const { detectChatPageBlockText } = await import("../services/playwright.ts");

  const cloudflare = detectChatPageBlockText({
    title: "Just a moment...",
    bodyText: "Checking your browser before accessing chat.qwen.ai.",
    href: "https://challenges.cloudflare.com/",
  });
  assert.equal(cloudflare.kind, "waf", "Cloudflare interstitial must classify as waf");
  assert.ok((cloudflare.markers ?? []).length > 0);

  const punish = detectChatPageBlockText({
    title: "",
    bodyText: "____punish____ access denied",
    href: "https://chat.qwen.ai/____tmd_____",
  });
  assert.equal(punish.kind, "waf", "punish/TMD document must classify as waf");

  const generic = detectChatPageBlockText({
    title: "安全验证",
    bodyText: "拖动滑块完成验证 验证码错误，请重试",
    href: "https://chat.qwen.ai/",
  });
  assert.equal(generic.kind, "waf", "generic captcha markers (>=2) must classify as waf");

  const healthy = detectChatPageBlockText({
    title: "Qwen",
    bodyText: "Welcome back! Ask anything. New chat",
    href: "https://chat.qwen.ai/",
  });
  assert.equal(healthy.kind, null, "a healthy chat page must not classify as blocked");
  assert.equal((healthy.markers ?? []).length, 0);
});

test("CHAT_INPUT_SELECTOR covers the Qwen input class and contenteditable/ARIA fallbacks", async () => {
  const { CHAT_INPUT_SELECTOR } = await import("../services/playwright.ts");
  assert.ok(
    CHAT_INPUT_SELECTOR.includes("message-input-textarea"),
    "the Qwen-specific input class must be the primary selector",
  );
  assert.ok(
    CHAT_INPUT_SELECTOR.includes('contenteditable="true"'),
    "the contenteditable fallback must be present",
  );
  assert.ok(
    CHAT_INPUT_SELECTOR.includes('[role="textbox"]'),
    "the ARIA textbox fallback must be present so a Qwen DOM change cannot strand the selector",
  );
});

test("dumpPlaywrightMiss writes a sanitized diagnostic file for an input-miss", async () => {
  const { dumpPlaywrightMiss } = await import("../services/playwright.ts");

  const page = {
    isClosed: () => false,
    evaluate: async () => ({
      title: "Broken page",
      href: "https://chat.qwen.ai/",
      bodyText: "line1\nline2\n\nline3   with  runs of   whitespace",
    }),
  };
  const dir = path.join(process.cwd(), "logs", "playwright_misses");
  const before = fs.existsSync(dir)
    ? new Set(fs.readdirSync(dir))
    : new Set<string>();
  const accountId = `test-dump-${Date.now()}`;
  await dumpPlaywrightMiss(accountId, page as any, { reason: "chat input never appeared", attempt: 1 });
  const after = fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : new Set<string>();
  const created = Array.from(after).filter((f) => !before.has(f));
  assert.ok(created.length === 1, `expected one diagnostic file, got ${created.length}`);
  const file = path.join(dir, created[0] as string);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.accountId, accountId);
    assert.equal(parsed.reason, "chat input never appeared");
    assert.equal(parsed.bodySnippet, "line1 line2 line3 with runs of whitespace");
  } finally {
    fs.unlinkSync(file);
    const leftover = fs.readdirSync(dir).filter((f) => f !== ".gitkeep");
    if (leftover.length === 0) fs.rmdirSync(dir);
  }
});

test("playwright header capture fails fast when the page sits on the login screen without credentials", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  // The account has no stored credentials: the triggerSend must detect the
  // auth URL and fail with a clear diagnosis instead of burning the 3 trigger
  // attempts typing into a nonexistent chat input.
  const authPage = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/auth",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
        waitFor: async () => undefined,
      }),
      isVisible: async () => false,
      waitFor: async () => undefined,
    }),
    frameLocator: () => ({ locator: () => ({
      first: () => ({
        isVisible: async () => false,
        waitFor: async () => undefined,
      }),
      isVisible: async () => false,
      waitFor: async () => undefined,
    }) }),
    focus: async () => {
      throw new Error("must not focus the chat input on the login screen");
    },
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  await assert.rejects(
    () => captureQwenHeaders("test-header-auth", authPage as any, 5_000, 50),
    /session expired and no credentials available for re-login/,
  );
});

/**
 * Fake page whose send produces one completion request per attempt, with the
 * headers taken from `headerSets` in order (the last entry repeats).
 */
function makeRetriggerPage(headerSets: Record<string, string>[]) {
  const invisible = {
    first: () => invisible,
    isVisible: async () => false,
    waitFor: async () => undefined,
    boundingBox: async () => null,
  };
  const state = { sends: 0, unroutes: 0, aborts: 0 };
  let handler: any;

  const page = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async (_pattern: string, routeHandler: any) => {
      handler = routeHandler;
    },
    unroute: async () => {
      state.unroutes++;
    },
    goto: async () => {},
    locator: () => invisible,
    frameLocator: () => ({ locator: () => invisible }),
    focus: async () => {
      // Stands in for the completion request the previous/next send fires: one
      // interception per trigger attempt, at a point the attempt is still alive.
      const headers = headerSets[Math.min(state.sends, headerSets.length - 1)];
      state.sends++;
      await handler(
        {
          abort: async () => {
            state.aborts++;
          },
        },
        { headers: () => headers },
      );
    },
    fill: async () => {},
    type: async () => {},
    $: async () => null,
    keyboard: { press: async () => {} },
  };

  return { page, state };
}

test("playwright header capture re-triggers the send after incomplete headers", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  // First interception lacks the required cookie/UA/bx-v trio (the SDK had
  // not attached them yet); the re-triggered send carries the complete set.
  const { page, state } = makeRetriggerPage([
    { "bx-ua": "present" },
    {
      cookie: "token=x",
      "user-agent": "ua",
      "bx-v": "2.5.37",
      "bx-ua": "present",
      "bx-umidtoken": "present",
    },
  ]);

  // 30s budget: the two hard-coded 2s sleeps in the trigger sequence plus the
  // settle delay have to fit, the grace window never should.
  await captureQwenHeaders("test-header-retrigger", page as any, 30_000, 50);

  assert.equal(state.sends, 2, "the incomplete interception must cost one extra send");
  assert.equal(state.aborts, 2, "no intercepted request may reach Qwen");
  assert.equal(state.unroutes, 1);
});

test("playwright header capture stops re-triggering when headers stay incomplete", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");

  const { page, state } = makeRetriggerPage([{ "bx-ua": "present" }]);

  const startedAt = Date.now();
  await assert.rejects(
    () => captureQwenHeaders("test-header-retrigger-exhausted", page as any, 30_000, 50),
    /incomplete anti-fraud headers/,
  );
  assert.ok(
    state.sends <= 3,
    `bounded re-triggers expected, got ${state.sends} sends`,
  );
  assert.ok(
    Date.now() - startedAt < 20_000,
    "capture must not keep re-sending for the whole header budget",
  );
  assert.equal(state.unroutes, 1);
});

test("playwright header capture marks the account headers-ready for the rotation gate", async () => {
  const { captureQwenHeaders } = await import("../services/playwright.ts");
  const {
    isAccountHeadersReady,
    unmarkAccountHeadersReady,
  } = await import("../core/account-manager.ts");

  const { page, state } = makeRetriggerPage([
    {
      cookie: "token=x",
      "user-agent": "ua",
      "bx-v": "2.5.37",
      "bx-ua": "present",
      "bx-umidtoken": "present",
    },
  ]);

  try {
    await captureQwenHeaders("test-header-ready", page as any, 30_000, 50);
    assert.equal(
      isAccountHeadersReady("test-header-ready"),
      true,
      "a successful capture must mark the account ready for rotation",
    );
    assert.equal(state.aborts, 1, "no intercepted request may reach Qwen");
  } finally {
    unmarkAccountHeadersReady("test-header-ready");
  }
});

test("auth-playwright: falls back to first configured account when no account id is provided", async () => {
  clearAllHeadersReadyAccounts();
  const existing = snapshotAccounts();
  delete process.env.TEST_MOCK_QWEN_AUTH;
  delete process.env.QWEN_ACCOUNTS;

  try {
    restoreAccounts([
      {
        id: "auth-pw-account",
        email: "auth-pw@example.com",
        password: "secret",
        cooldown_until: 0,
        cooldown_reason: null,
      },
    ]);

    const { getBasicHeaders } = await import("../services/auth-playwright.ts");
    await assert.rejects(
      () => getBasicHeaders(),
      /Playwright not initialized for account: auth-pw-account/,
    );
  } finally {
    restoreAccounts(existing);
  }
});
