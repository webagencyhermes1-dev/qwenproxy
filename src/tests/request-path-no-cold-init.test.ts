import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const originalMockAuth = process.env.TEST_MOCK_QWEN_AUTH;
const originalNodeEnv = process.env.NODE_ENV;
const originalArgv = [...process.argv];

process.env.NODE_ENV = "test";

const mockState = {
  initialized: false,
  initCalls: 0,
};

const warmedHeaders = {
  cookie: "token=warmed-session",
  userAgent: "warmed-user-agent",
  bxV: "2.5.37",
  bxUa: "warmed-bx-ua",
  bxUmidtoken: "warmed-bx-umidtoken",
  secChUa: '"Chromium";v="130"',
  secChUaMobile: "?0",
  secChUaPlatform: '"Windows"',
  version: "0.2.89",
};

mock.module("../services/playwright.ts", {
  namedExports: {
    isPlaywrightInitialized: () => mockState.initialized,
    getBasicHeaders: async () => warmedHeaders,
    refreshHeaders: async () => {},
    initPlaywrightForAccount: async () => {
      mockState.initCalls += 1;
    },
  },
});

const { getBasicHeaders, getQwenHeaders } = await import(
  "../services/auth-playwright.ts"
);
const { AuthError } = await import("../core/errors.ts");

function hideTestRunnerArgv(): void {
  process.argv.splice(
    0,
    process.argv.length,
    originalArgv[0] ?? "node",
    "dist/index.js",
  );
}

function restoreArgv(): void {
  process.argv.splice(0, process.argv.length, ...originalArgv);
}

function useRealAuthPath(): void {
  delete process.env.TEST_MOCK_QWEN_AUTH;
  process.env.NODE_ENV = "test";
}

function restoreEnv(): void {
  if (originalMockAuth === undefined) delete process.env.TEST_MOCK_QWEN_AUTH;
  else process.env.TEST_MOCK_QWEN_AUTH = originalMockAuth;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  restoreArgv();
}

describe("request path never cold-initializes a browser", () => {
  it("getBasicHeaders throws AuthError for uninitialized account", async () => {
    useRealAuthPath();
    mockState.initialized = false;
    hideTestRunnerArgv();
    try {
      await assert.rejects(
        () => getBasicHeaders("cold-account"),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /not warmed/);
          return true;
        },
      );
    } finally {
      restoreEnv();
    }
  });

  it("getBasicHeaders succeeds for initialized account", async () => {
    useRealAuthPath();
    mockState.initialized = true;
    try {
      const headers = await getBasicHeaders("warmed-account");
      assert.deepEqual(headers, warmedHeaders);
    } finally {
      restoreEnv();
    }
  });

  it("ensurePlaywrightInitialized does not call initPlaywrightForAccount", async () => {
    useRealAuthPath();
    mockState.initialized = false;
    mockState.initCalls = 0;
    hideTestRunnerArgv();
    try {
      await assert.rejects(() => getBasicHeaders("cold-account"), AuthError);
      await assert.rejects(
        () => getQwenHeaders(false, "cold-account"),
        AuthError,
      );
      assert.equal(mockState.initCalls, 0);
      assert.equal(mockState.initialized, false);
    } finally {
      restoreEnv();
    }
  });
});
