import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
  clearAccountCooldown,
  clearAllHeadersReadyAccounts,
  getAccountCooldownInfo,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  clearWafIsolation,
  noteWafRecovery,
} from "../core/waf-isolation.ts";
import {
  resetAccountConcurrencyForTests,
  clearTemporaryBusy,
} from "../core/account-concurrency.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import { resetAccountStateForTests } from "../core/account-state.ts";
import { resetAccountManagerForTests } from "../core/account-manager.ts";
import { invalidatePriorityCache } from "../core/account-priority.ts";

/**
 * End-to-end proof that quota exhaustion shifts accounts instead of
 * surfacing to the client — including the previously-missed
 * "maximum usage limits" phrasing with a non-RateLimited code.
 *
 * Pattern: mock mode starts every request on `mock-account`; the mocked
 * Qwen fetch fails the first completion call(s) with a quota error and
 * succeeds afterwards. A second upstream call proves failover (the inner
 * loop never retries a real-quota account in a multi-account pool), and
 * the challenged lane must carry a midnight `RateLimited` cooldown.
 */

function withFreshAccounts(
  rows: Array<{ id: string; email: string }>,
  fn: () => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const originalEnv = process.env.QWEN_ACCOUNTS;
    delete process.env.QWEN_ACCOUNTS;
    const { existsSync, readFileSync, writeFileSync, unlinkSync } =
      await import("node:fs");
    const priorityPath = "data/account-priority.json";
    const hadPriorityFile = existsSync(priorityPath);
    const prioritySnapshot = hadPriorityFile
      ? readFileSync(priorityPath, "utf-8")
      : null;
    const db = getDatabase();
    const existing = db
      .prepare(
        "SELECT id, email, password, cooldown_until, cooldown_reason, disabled FROM accounts",
      )
      .all() as any[];
    db.prepare("DELETE FROM accounts").run();
    try {
      db.prepare("DELETE FROM account_health").run();
    } catch {}
    invalidateAccountsCache();
    resetAccountHealthForTests();
    resetAccountStateForTests();
    resetAccountConcurrencyForTests();
    resetAccountManagerForTests();
    invalidatePriorityCache();
    clearAllHeadersReadyAccounts();
    try {
      const insert = db.prepare(
        "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
      );
      for (const row of rows) insert.run(row.id, row.email, "pw");
      invalidateAccountsCache();
      for (const row of rows) {
        clearAccountCooldown(row.id);
        clearWafIsolation(row.id);
        noteWafRecovery(row.id);
        markAccountHeadersReady(row.id);
      }
      clearAccountCooldown("mock-account");
      clearWafIsolation("mock-account");
      noteWafRecovery("mock-account");
      clearTemporaryBusy("mock-account");
      await fn();
    } finally {
      for (const row of rows) {
        try {
          clearAccountCooldown(row.id);
        } catch {}
        try {
          clearWafIsolation(row.id);
        } catch {}
        try {
          unmarkAccountHeadersReady(row.id);
        } catch {}
      }
      try {
        clearAccountCooldown("mock-account");
      } catch {}
      try {
        clearWafIsolation("mock-account");
      } catch {}
      try {
        noteWafRecovery("mock-account");
      } catch {}
      try {
        clearTemporaryBusy("mock-account");
      } catch {}
      resetAccountConcurrencyForTests();
      resetAccountStateForTests();
      resetAccountHealthForTests();
      resetAccountManagerForTests();
      invalidatePriorityCache();
      if (hadPriorityFile && prioritySnapshot !== null) {
        writeFileSync(priorityPath, prioritySnapshot, "utf-8");
      } else if (!hadPriorityFile && existsSync(priorityPath)) {
        unlinkSync(priorityPath);
      }
      db.prepare("DELETE FROM accounts").run();
      const insert = db.prepare(
        "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason, disabled) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const row of existing) {
        insert.run(
          row.id,
          row.email,
          row.password,
          row.cooldown_until ?? 0,
          row.cooldown_reason ?? null,
          row.disabled ?? 0,
        );
      }
      try {
        db.prepare("DELETE FROM account_health").run();
      } catch {}
      invalidateAccountsCache();
      if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
    }
  };
}

function sseResponse(...chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function quotaJsonResponse(code: string, details: string): Response {
  return new Response(
    JSON.stringify({ success: false, data: { code, details } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function successSse(chat: string, resp: string, content: string): Response {
  return sseResponse(
    `data: {"response.created":{"chat_id":"${chat}","response_id":"${resp}"}}\n\n`,
    `data: {"response_id":"${resp}","choices":[{"delta":{"phase":"answer","content":"${content}"}}]}\n\n`,
    "data: [DONE]\n\n",
  );
}

function installQwenMock(
  handler: (callIndex: number, body: any) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  const bodies: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? (input as Request).url
          : String(input);
    if (!url.includes("chat.qwen.ai")) return originalFetch(input, init);
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "qwen3.7-plus", owned_by: "qwen" }] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v2/chats/new")) {
      return new Response(
        JSON.stringify({ chat_id: `mock-chat-${Date.now()}-${completionCalls}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      bodies.push(body);
      completionCalls += 1;
      return handler(completionCalls, body);
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    calls: () => completionCalls,
    bodies: () => bodies,
  };
}

async function postChat(messages: any[], stream: boolean, extra?: Record<string, unknown>) {
  const { app } = await import("../api/server.js");
  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.7-plus",
        stream,
        messages,
        ...(extra ?? {}),
      }),
    }),
  );
}

test(
  "quota failover: RateLimited daily quota on A is served from B",
  withFreshAccounts(
    [
      { id: "quota-a", email: "quota-a@test.com" },
      { id: "quota-b", email: "quota-b@test.com" },
    ],
    async () => {
      const mock = installQwenMock((callIndex) => {
        if (callIndex === 1) {
          return quotaJsonResponse(
            "RateLimited",
            "You have reached the upper limit for todays usage.",
          );
        }
        return successSse("chat-quota-ok", "resp-quota-ok", "served-after-quota-failover");
      });
      try {
        const res = await postChat(
          [{ role: "user", content: "quota failover please" }],
          true,
        );
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /served-after-quota-failover/);
        assert.match(text, /data: \[DONE\]/);
        assert.equal(mock.calls(), 2, "exactly one failover hop, no same-account spin");
        // Same logical request replayed on the replacement account.
        assert.equal(mock.bodies().length, 2);
        assert.equal(mock.bodies()[0].model, mock.bodies()[1].model);
        // Exhausted lane cooled until midnight for subsequent routing.
        const cd = getAccountCooldownInfo("mock-account");
        assert.ok(cd, "challenged lane must be quarantined");
        assert.equal(cd!.reason, "RateLimited");
      } finally {
        mock.restore();
      }
    },
  ),
);

test(
  "quota failover: reported 'maximum usage limits' with QuotaExceeded code shifts accounts",
  withFreshAccounts(
    [
      { id: "quota-c", email: "quota-c@test.com" },
      { id: "quota-d", email: "quota-d@test.com" },
    ],
    async () => {
      const mock = installQwenMock((callIndex) => {
        if (callIndex === 1) {
          // Exact shape from the production report: previously escaped quota
          // handling (no cooldown, sticky sessions refused to rotate).
          return quotaJsonResponse(
            "QuotaExceeded",
            "you have reached the maximum usage limits for today",
          );
        }
        return successSse("chat-mul-ok", "resp-mul-ok", "served-after-max-usage-failover");
      });
      try {
        const res = await postChat(
          [{ role: "user", content: "max usage failover please" }],
          true,
        );
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /served-after-max-usage-failover/);
        assert.equal(mock.calls(), 2, "exactly one failover hop");
        const cd = getAccountCooldownInfo("mock-account");
        assert.ok(cd, "exhausted lane must be cooled");
        assert.equal(cd!.reason, "RateLimited");
      } finally {
        mock.restore();
      }
    },
  ),
);

test(
  "quota failover: non-streaming mode recovers on the next account",
  withFreshAccounts(
    [
      { id: "quota-e", email: "quota-e@test.com" },
      { id: "quota-f", email: "quota-f@test.com" },
    ],
    async () => {
      const mock = installQwenMock((callIndex) => {
        if (callIndex === 1) {
          return quotaJsonResponse(
            "RateLimited",
            "You have reached the upper limit for todays usage.",
          );
        }
        return successSse("chat-ns-ok", "resp-ns-ok", "nonstream-recovered");
      });
      try {
        const res = await postChat(
          [{ role: "user", content: "non-stream quota please" }],
          false,
        );
        assert.equal(res.status, 200);
        const json = (await res.json()) as any;
        assert.match(json?.choices?.[0]?.message?.content ?? "", /nonstream-recovered/);
        assert.equal(mock.calls(), 2, "exactly one failover hop");
        assert.ok(getAccountCooldownInfo("mock-account"), "exhausted lane must be cooled");
      } finally {
        mock.restore();
      }
    },
  ),
);

test(
  "quota failover: mid-stream SSE quota error with new phrasing recovers transparently",
  withFreshAccounts(
    [
      { id: "quota-g", email: "quota-g@test.com" },
      { id: "quota-h", email: "quota-h@test.com" },
    ],
    async () => {
      const mock = installQwenMock((callIndex) => {
        if (callIndex === 1) {
          return sseResponse(
            'data: {"error":{"code":"QuotaExceeded","details":"you have reached the maximum usage limits for today"}}\n\n',
          );
        }
        return successSse("chat-sse-ok", "resp-sse-ok", "sse-quota-recovered");
      });
      try {
        const res = await postChat(
          [{ role: "user", content: "sse quota please" }],
          true,
        );
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /sse-quota-recovered/);
        assert.match(text, /data: \[DONE\]/);
        assert.equal(mock.calls(), 2, "exactly one failover hop");
        const cd = getAccountCooldownInfo("mock-account");
        assert.ok(cd, "exhausted lane must be cooled");
        assert.equal(cd!.reason, "RateLimited");
      } finally {
        mock.restore();
      }
    },
  ),
);

test(
  "quota edge: single account retries once then surfaces 429 without looping",
  withFreshAccounts([], async () => {
    const mock = installQwenMock(() =>
      quotaJsonResponse("RateLimited", "You have reached the upper limit for todays usage."),
    );
    try {
      const res = await postChat(
        [{ role: "user", content: "single account quota" }],
        true,
      );
      // Nothing to shift to: one same-account retry, then an honest 429.
      assert.equal(res.status, 429);
      assert.equal(mock.calls(), 2, "one retry on the lone account, then stop");
      assert.ok(getAccountCooldownInfo("mock-account"), "lone account still cooled");
    } finally {
      mock.restore();
    }
  }),
);

test(
  "quota edge: all accounts exhausted surfaces 429 with bounded calls and every lane cooled",
  withFreshAccounts(
    [
      { id: "quota-x", email: "quota-x@test.com" },
      { id: "quota-y", email: "quota-y@test.com" },
    ],
    async () => {
      const mock = installQwenMock(() =>
        quotaJsonResponse(
          "QuotaExceeded",
          "you have reached the maximum usage limits for today",
        ),
      );
      try {
        const res = await postChat(
          [{ role: "user", content: "exhaust everything" }],
          true,
        );
        assert.equal(res.status, 429);
        // One attempt per lane (mock + 2 seeds): no spins, no infinite walk.
        assert.equal(mock.calls(), 3, `expected 3 lane attempts, got ${mock.calls()}`);
        for (const id of ["mock-account", "quota-x", "quota-y"]) {
          assert.ok(getAccountCooldownInfo(id), `${id} must be cooled`);
        }
      } finally {
        mock.restore();
      }
    },
  ),
);
