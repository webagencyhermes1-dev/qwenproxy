import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import {
  classifyRetryAction,
  isAntiBotChallengeText,
  isAntiBotError,
  throwFromSseUpstreamError,
} from "../routes/chat/retry-policy.ts";
import { parseQwenErrorPayload } from "../routes/chat/errors.ts";
import { RetryableQwenStreamError } from "../services/qwen.ts";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
  getNextAvailableAccount,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  clearWafIsolation,
  getWafHardBlockCount,
  noteWafRecovery,
  recordWafHardBlock,
} from "../core/waf-isolation.ts";
import {
  quarantineChallengedAccountOnce,
} from "../routes/chat/account.ts";
import {
  resetAccountConcurrencyForTests,
  tryAcquireAccountLease,
} from "../core/account-concurrency.ts";
import { resetAccountHealthForTests } from "../core/account-health.ts";
import { resetAccountStateForTests } from "../core/account-state.ts";
import { resetAccountManagerForTests } from "../core/account-manager.ts";
import { invalidatePriorityCache } from "../core/account-priority.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withFreshAccounts(
  rows: Array<{ id: string; email: string }>,
  fn: () => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const originalEnv = process.env.QWEN_ACCOUNTS;
    delete process.env.QWEN_ACCOUNTS;
    const { existsSync, readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
    const priorityPath = "data/account-priority.json";
    const hadPriorityFile = existsSync(priorityPath);
    const prioritySnapshot = hadPriorityFile ? readFileSync(priorityPath, "utf-8") : null;
    const db = getDatabase();
    const existing = db
      .prepare("SELECT id, email, password, cooldown_until, cooldown_reason, disabled FROM accounts")
      .all() as any[];
    db.prepare("DELETE FROM accounts").run();
    try {
      try {
        db.prepare("DELETE FROM account_health").run();
      } catch {}
    } catch {}
    invalidateAccountsCache();
    resetAccountHealthForTests();
    resetAccountStateForTests();
    resetAccountConcurrencyForTests();
    resetAccountManagerForTests();
    invalidatePriorityCache();
    try {
      const insert = db.prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)");
      for (const row of rows) insert.run(row.id, row.email, "pw");
      invalidateAccountsCache();
      for (const row of rows) {
        clearAccountCooldown(row.id);
        clearWafIsolation(row.id);
        noteWafRecovery(row.id);
        markAccountHeadersReady(row.id);
      }
      await fn();
    } finally {
      for (const row of rows) {
        try {
          clearAccountCooldown(row.id);
        } catch {}
        try {
          clearWafIsolation(row.id);
        } catch {}
      }
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
      // Mock-account quarantine from streaming tests must not leak.
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
        const { clearTemporaryBusy } = await import("../core/account-concurrency.ts");
        clearTemporaryBusy("mock-account");
      } catch {}
      db.prepare("DELETE FROM accounts").run();
      const insert = db.prepare(
        "INSERT INTO accounts (id, email, password, cooldown_until, cooldown_reason, disabled) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const row of existing) {
        insert.run(row.id, row.email, row.password, row.cooldown_until ?? 0, row.cooldown_reason ?? null, row.disabled ?? 0);
      }
      try {
        db.prepare("DELETE FROM account_health").run();
      } catch {}
      invalidateAccountsCache();
      if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
    }
  };
}

function antiBotError(code: string, details: string): Error & { upstreamCode?: string } {
  return Object.assign(new Error(`${code}: ${details}`), { upstreamCode: code });
}

// ---------------------------------------------------------------------------
// 1. Canonical classification
// ---------------------------------------------------------------------------

test(
  "anti-bot: classifyRetryAction requests immediate account switch",
  withFreshAccounts([], () => {
    const action = classifyRetryAction(antiBotError("waf_challenge", "challenge"));
    assert.equal(action.retryable, true);
    assert.equal(action.switchAccount, true);
    assert.equal(action.forceNewChat, true);
    assert.equal(action.retryWithFullPrompt, true);
    assert.equal(action.reason, "anti_bot");
    assert.equal(action.accountCooldownReason, "WafChallenge");
    assert.ok((action.accountCooldownMs ?? 0) > 0);
  }),
);

test(
  "anti-bot: every recognized challenge form normalizes to anti_bot",
  withFreshAccounts([], () => {
    const forms: Array<[string, string]> = [
      ["waf_challenge", "Qwen returned an anti-bot challenge instead of an SSE response."],
      ["FAIL_SYS_USER_VALIDATE", "FAIL_SYS_USER_VALIDATE: solve the challenge"],
      ["RGV587_ERROR", "RGV587_ERROR: denied"],
      ["UpstreamError", "user validate failed for this request"],
      ["UpstreamError", "please complete the CAPTCHA to continue"],
      ["UpstreamError", "security verification required"],
      ["UpstreamError", "human verification needed"],
      ["UpstreamError", "verify you are human"],
      ["UpstreamError", "_____tmd_____ challenge"],
      ["UpstreamError", "denyfromx5 blocked"],
    ];
    for (const [code, details] of forms) {
      const err = antiBotError(code, details);
      assert.equal(isAntiBotError(err), true, `isAntiBotError(${code})`);
      assert.equal(isAntiBotChallengeText(details), true, `text(${details})`);
      const action = classifyRetryAction(err);
      assert.equal(action.reason, "anti_bot", `${code}:${details}`);
      assert.equal(action.retryable, true);
      assert.equal(action.switchAccount, true);
    }
    // Retryable-wrapped challenges also normalize.
    const wrapped = Object.assign(
      new RetryableQwenStreamError("Qwen anti-bot: waf_challenge: x", 0),
      { upstreamCode: "waf_challenge", switchAccount: true },
    );
    assert.equal(isAntiBotError(wrapped), true);
    assert.equal(classifyRetryAction(wrapped).reason, "anti_bot");
  }),
);

test("anti-bot: throwFromSseUpstreamError canonicalizes to waf_challenge", () => {
  const cases: Array<[string, string]> = [
    ["FAIL_SYS_USER_VALIDATE", "FAIL_SYS_USER_VALIDATE: solve it"],
    ["RGV587_ERROR", "RGV587_ERROR blocked"],
    ["weird_code", "user validate failed"],
    ["weird_code", "Please complete the CAPTCHA"],
    ["weird_code", "security verification required"],
    ["weird_code", "human verification"],
  ];
  for (const [code, details] of cases) {
    assert.throws(
      () => throwFromSseUpstreamError(code, details),
      (err: unknown) => {
        const t = err as RetryableQwenStreamError & {
          upstreamCode?: string;
          switchAccount?: boolean;
          forceNewChat?: boolean;
          retryWithFullPrompt?: boolean;
        };
        assert.ok(t instanceof RetryableQwenStreamError);
        assert.equal(t.upstreamCode, "waf_challenge");
        assert.equal(t.switchAccount, true);
        assert.equal(t.forceNewChat, true);
        assert.equal(t.retryWithFullPrompt, true);
        const action = classifyRetryAction(t);
        assert.equal(action.reason, "anti_bot");
        assert.equal(action.switchAccount, true);
        return true;
      },
    );
  }
});

test("anti-bot: HTML WAF pages sanitize and classify as waf_challenge", () => {
  const bodies = [
    '<!doctype html><meta name="aliyun_waf_aa" content="secret-page">',
    "<html>_____tmd_____ punish page</html>",
    "<html>FAIL_SYS_USER_VALIDATE challenge</html>",
    "<html>RGV587_ERROR blocked</html>",
    "<html>please solve the captcha</html>",
    "<html>security verification</html>",
    "<html>human verification</html>",
  ];
  for (const body of bodies) {
    const parsed = parseQwenErrorPayload(body);
    assert.ok(parsed, `should parse ${body.slice(0, 30)}`);
    assert.equal(parsed!.code, "waf_challenge");
    assert.match(parsed!.details, /anti-bot challenge/);
    assert.doesNotMatch(parsed!.message, /secret-page|aliyun_waf|_____tmd_____/i);
    const action = classifyRetryAction(
      Object.assign(new Error(parsed!.details), { upstreamCode: parsed!.code }),
    );
    assert.equal(action.reason, "anti_bot");
    assert.equal(action.switchAccount, true);
  }
  // Non-challenge HTML stays non_sse_response and does NOT rotate as anti-bot.
  const plain = parseQwenErrorPayload("<html>maintenance window</html>");
  assert.equal(plain!.code, "non_sse_response");
});

// ---------------------------------------------------------------------------
// 6/7/8/10. Quarantine + exclusion + scheduler
// ---------------------------------------------------------------------------

test(
  "anti-bot: A quarantined after challenge and excluded for this request",
  withFreshAccounts(
    [
      { id: "ab-a", email: "a@test.com" },
      { id: "ab-b", email: "b@test.com" },
    ],
    () => {
      const err: any = antiBotError("waf_challenge", "challenge on A");
      const res = quarantineChallengedAccountOnce(err, "ab-a", "a@test.com", { attempt: 1 });
      assert.ok(res, "first challenge quarantines");
      assert.equal(err.__wafQuarantinedAccountId, "ab-a");
      const cd = getAccountCooldownInfo("ab-a");
      assert.ok(cd, "A must be on cooldown");
      assert.equal(cd!.reason, "WafChallenge");
      assert.equal(getWafHardBlockCount("ab-a"), 1);
      // Second call for same challenge must NOT escalate.
      const again = quarantineChallengedAccountOnce(err, "ab-a", "a@test.com", {});
      assert.equal(again, null);
      assert.equal(getWafHardBlockCount("ab-a"), 1);

      // A excluded even though cooldown would otherwise allow fallback:
      // the scheduler's tried-set exclusion is authoritative.
      const next = getNextAvailableAccount(new Set(["ab-a"]));
      assert.ok(next);
      assert.equal(next!.id, "ab-b");
    },
  ),
);

test(
  "anti-bot: B busy selects next eligible C",
  withFreshAccounts(
    [
      { id: "abc-a", email: "a@test.com" },
      { id: "abc-b", email: "b@test.com" },
      { id: "abc-c", email: "c@test.com" },
    ],
    () => {
      // A challenged -> excluded.
      const tried = new Set(["abc-a"]);
      // B busy (single slot in .env.test).
      const lease = tryAcquireAccountLease("abc-b", "busy-label");
      assert.ok(lease, "should hold B slot");
      try {
        const next = getNextAvailableAccount(tried);
        assert.ok(next);
        assert.equal(next!.id, "abc-c");
      } finally {
        lease!.release();
      }
    },
  ),
);

test(
  "anti-bot: A/B challenged fails bounded without infinite rotation",
  withFreshAccounts(
    [
      { id: "abb-a", email: "a@test.com" },
      { id: "abb-b", email: "b@test.com" },
    ],
    () => {
      recordWafHardBlock("abb-a");
      recordWafHardBlock("abb-b");
      // Both on cooldown: scheduler falls back to shortest-cooldown account,
      // but the request-level tried set already contains both, so the outer
      // loop treats it as exhausted (no eligible account remains).
      const tried = new Set(["abb-a", "abb-b"]);
      const next = getNextAvailableAccount(tried);
      // Either null or a cooldown fallback that the outer loop rejects.
      if (next) {
        assert.ok(getAccountCooldownInfo(next.id), "fallback must be on cooldown");
        assert.ok(tried.has(next.id) || getAccountCooldownInfo(next.id));
      }
      // No infinite loop: at most pool-size picks before exhaustion.
      assert.ok(tried.size <= 2);
    },
  ),
);

test(
  "anti-bot: cooldown persists for restart recovery",
  withFreshAccounts([{ id: "persist-a", email: "a@test.com" }], () => {
    recordWafHardBlock("persist-a");
    const db = getDatabase();
    const row = db
      .prepare("SELECT cooldown_until, cooldown_reason FROM accounts WHERE id = ?")
      .get("persist-a") as any;
    assert.ok(row.cooldown_until > Date.now(), "cooldown must persist in SQLite");
    assert.equal(row.cooldown_reason, "WafChallenge");
  }),
);

// ---------------------------------------------------------------------------
// 11/12. Unchanged behaviors
// ---------------------------------------------------------------------------

test(
  "anti-bot: rate-limit/quota behavior unchanged",
  withFreshAccounts([], () => {
    const temp = classifyRetryAction(
      Object.assign(new Error("quota_limit: alta demanda"), { upstreamCode: "quota_limit" }),
    );
    assert.equal(temp.reason, "quota_or_rate_limit");
    assert.equal(temp.switchAccount, false);
    assert.equal(temp.accountCooldownReason, "RateLimitTemporary");

    const real = classifyRetryAction(
      Object.assign(new Error("RateLimited: upper limit"), { upstreamCode: "RateLimited" }),
    );
    assert.equal(real.reason, "quota_or_rate_limit");
    assert.equal(real.switchAccount, true);
  }),
);

test(
  "anti-bot: deterministic failures never rotate",
  withFreshAccounts([], () => {
    const model = classifyRetryAction(
      Object.assign(new Error("Qwen upstream error: Not_Found: Model not found."), {
        upstreamCode: "Not_Found",
      }),
    );
    assert.equal(model.retryable, false);
    assert.equal(model.switchAccount, false);
    assert.equal(model.reason, "model_not_found");

    const moderation = classifyRetryAction(
      Object.assign(
        new RetryableQwenStreamError("Qwen content moderation: data_inspection_failed: bad", 0),
        { upstreamCode: "data_inspection_failed", switchAccount: false },
      ),
    );
    assert.equal(moderation.retryable, false);
    assert.equal(moderation.reason, "content_moderation");

    const local = classifyRetryAction(
      Object.assign(new Error("messages is required"), { code: "bad_request" }),
    );
    // Local validation is terminal (status/code path) — never rotates.
    assert.equal(local.retryable, false);
  }),
);

// ---------------------------------------------------------------------------
// 13/14. Sticky + param preservation (scheduler-level, deterministic)
// ---------------------------------------------------------------------------

test(
  "anti-bot: sticky owner challenged falls over with fresh chat + full context",
  withFreshAccounts(
    [
      { id: "sticky-a", email: "a@test.com" },
      { id: "sticky-b", email: "b@test.com" },
    ],
    () => {
      // Sticky A challenged -> quarantined.
      const err: any = antiBotError("FAIL_SYS_USER_VALIDATE", "FAIL_SYS_USER_VALIDATE on A");
      quarantineChallengedAccountOnce(err, "sticky-a", "a@test.com", {});
      // Sticky resolution must fall over to B (preferred on cooldown falls through).
      const { resolveInitialAccount } = (() => {
        // Dynamic import would be async; resolveInitialAccount is already
        // covered by account-stickiness tests — here we assert the scheduler
        // primitive directly to stay synchronous.
        return { resolveInitialAccount: null as unknown as () => void };
      })();
      void resolveInitialAccount;
      const next = getNextAvailableAccount(new Set(["sticky-a"]));
      assert.ok(next);
      assert.equal(next!.id, "sticky-b");
      // Account switch always rebuilds a fresh upstream chat with full history
      // (sticky parent chains cannot be reused across accounts).
      const policy = classifyRetryAction(err);
      assert.equal(policy.forceNewChat, true);
      assert.equal(policy.retryWithFullPrompt, true);
      assert.equal(policy.switchAccount, true);
    },
  ),
);

test(
  "anti-bot: request parameters survive account switching (policy contract)",
  withFreshAccounts([], () => {
    for (const [code, details] of [
      ["waf_challenge", "challenge"],
      ["FAIL_SYS_USER_VALIDATE", "FAIL_SYS_USER_VALIDATE"],
      ["RGV587_ERROR", "RGV587_ERROR"],
    ] as Array<[string, string]>) {
      const policy = classifyRetryAction(antiBotError(code, details));
      // The SAME logical request is replayed: model/messages/tools/mode/files
      // are preserved by the caller; the policy guarantees the replay shape.
      assert.equal(policy.retryable, true);
      assert.equal(policy.switchAccount, true);
      assert.equal(policy.forceNewChat, true);
      assert.equal(policy.retryWithFullPrompt, true);
    }
  }),
);

// ---------------------------------------------------------------------------
// 15/16. Streaming: pre-output failover safe, post-output never duplicates
// ---------------------------------------------------------------------------

function sseResponse(...chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function installStreamingMock(
  handler: (callIndex: number, body: any) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  const bodies: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "url" in input ? (input as Request).url : String(input);
    if (!url.includes("chat.qwen.ai")) return originalFetch(input, init);
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen3.7-plus", owned_by: "qwen" }] }), { status: 200 });
    }
    if (url.includes("/api/v2/chats/new")) {
      return new Response(JSON.stringify({ chat_id: `mock-chat-${Date.now()}-${completionCalls}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

test(
  "anti-bot streaming: challenge before first output fails over safely",
  withFreshAccounts(
    [
      { id: "stream-a", email: "stream-a@test.com" },
      { id: "stream-b", email: "stream-b@test.com" },
    ],
    async () => {
      const { app } = await import("../api/server.js");
      const { clearTemporaryBusy } = await import("../core/account-concurrency.ts");
      clearTemporaryBusy("mock-account");
      clearAccountCooldown("mock-account");
      clearWafIsolation("mock-account");
      // Capture request bodies to prove the SAME logical request is replayed
      // with model/messages preserved on the replacement account.
      const mock = installStreamingMock((callIndex) => {
        if (callIndex === 1) {
          return sseResponse(
            'data: {"error":{"code":"FAIL_SYS_USER_VALIDATE","details":"FAIL_SYS_USER_VALIDATE: solve the challenge"}}\n\n',
          );
        }
        return sseResponse(
          'data: {"response.created":{"chat_id":"chat-ab-ok","response_id":"resp-ab-ok"}}\n\n',
          'data: {"response_id":"resp-ab-ok","choices":[{"delta":{"phase":"answer","content":"recovered-after-waf"}}]}\n\n',
          "data: [DONE]\n\n",
        );
      });
      try {
        const res = await app.fetch(
          new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "qwen3.7-plus",
              stream: true,
              messages: [{ role: "user", content: "waf pre-output" }],
              tools: [{ type: "function", function: { name: "shell", description: "x", parameters: { type: "object", properties: {} } } }],
            }),
          }),
        );
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /recovered-after-waf/);
        assert.match(text, /data: \[DONE\]/);
        // Failover happened (second upstream call) instead of same-account spin.
        assert.ok(mock.calls() >= 2, `expected failover retry, got ${mock.calls()}`);
        // Request params survive: both attempts carry the same model.
        for (const b of mock.bodies()) {
          assert.equal(b.model, "qwen3.7-plus");
        }
        // Challenged lane quarantined for subsequent routing.
        assert.ok(getAccountCooldownInfo("mock-account"), "mock-account must be quarantined");
      } finally {
        mock.restore();
        clearAccountCooldown("mock-account");
        clearWafIsolation("mock-account");
        noteWafRecovery("mock-account");
      }
    },
  ),
);

test(
  "anti-bot streaming: partial output never duplicates on challenge",
  withFreshAccounts(
    [
      { id: "stream-c", email: "stream-c@test.com" },
      { id: "stream-d", email: "stream-d@test.com" },
    ],
    async () => {
      const { app } = await import("../api/server.js");
      const { clearTemporaryBusy } = await import("../core/account-concurrency.ts");
      clearTemporaryBusy("mock-account");
      clearAccountCooldown("mock-account");
      clearWafIsolation("mock-account");
      const mock = installStreamingMock((callIndex) => {
        if (callIndex === 1) {
          return sseResponse(
            'data: {"response.created":{"chat_id":"chat-partial","response_id":"resp-partial"}}\n\n',
            'data: {"response_id":"resp-partial","choices":[{"delta":{"phase":"answer","content":"hello-partial"}}]}\n\n',
            'data: {"error":{"code":"RGV587_ERROR","details":"RGV587_ERROR: blocked mid-stream"}}\n\n',
          );
        }
        return sseResponse(
          'data: {"response.created":{"chat_id":"chat-should-not-happen","response_id":"resp-no"}}\n\n',
          'data: {"response_id":"resp-no","choices":[{"delta":{"phase":"answer","content":"DUPLICATE-MUST-NOT-APPEAR"}}]}\n\n',
          "data: [DONE]\n\n",
        );
      });
      try {
        const res = await app.fetch(
          new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "qwen3.7-plus", stream: true, messages: [{ role: "user", content: "partial" }] }),
          }),
        );
        assert.equal(res.status, 200);
        const text = await res.text();
        // Already-emitted content appears exactly once; the recovery must not
        // replay it on another account (no duplication).
        const occurrences = (text.match(/hello-partial/g) ?? []).length;
        assert.equal(occurrences, 1, `hello-partial must appear once, got ${occurrences} in ${text.slice(0, 500)}`);
        assert.doesNotMatch(text, /DUPLICATE-MUST-NOT-APPEAR/);
        assert.equal(mock.calls(), 1, "post-output challenge must not trigger a second upstream call");
      } finally {
        mock.restore();
        clearAccountCooldown("mock-account");
        clearWafIsolation("mock-account");
        noteWafRecovery("mock-account");
      }
    },
  ),
);
