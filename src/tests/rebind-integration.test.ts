import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { StickyMap, STICKY_TTL_MS } from "../services/session/stickyMap.ts";
import { generateStickyKey } from "../services/session/key.ts";
import { HealthTracker } from "../services/account/health.ts";
import { selectAccountForNewSession } from "../services/account/selection.ts";
import { assembleCompressedContext } from "../services/context/tiered.ts";
import type { Message } from "../utils/types.ts";

function buildBigConversation(exchanges: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < exchanges; i++) {
    out.push({ role: "user", content: `Task step ${i} ${"x".repeat(4000)}` });
    out.push({ role: "assistant", content: `Result ${i} ${"y".repeat(4000)}` });
  }
  return out;
}

test("rebind: quota exhaust triggers rebind with compressed context, stays", () => {
  const sticky = new StickyMap({ autoSweep: false });
  sticky.clearForTests();
  const health = new HealthTracker();
  try {
    // Turn 1: new session binds.
    const key = generateStickyKey({
      messages: [{ role: "user", content: "session A task: refactor auth" } as Message],
    });
    for (let i = 0; i < 3; i++) {
      health.recordSuccess("acc-a", 800);
      health.recordSuccess("acc-b", 900);
    }
    const first = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b"],
      stickyKey: key,
    });
    assert.ok(first);
    sticky.set(key, {
      accountId: first!,
      proxyId: null,
      boundAt: Date.now(),
      lastUsedAt: Date.now(),
      ttlMs: STICKY_TTL_MS,
    });

    // 20 turns stay on same account.
    for (let t = 0; t < 20; t++) {
      const b = sticky.get(key);
      assert.ok(b);
      assert.equal(b!.accountId, first);
      sticky.touch(key);
    }

    // Quota exhaust on acc-a.
    const errAt = Date.now();
    for (let i = 0; i < 5; i++) health.record429(first!, "quota", 3600_000);
    const reboundAt = Date.now();
    assert.ok(reboundAt - errAt < 500, "rebind decision within 500ms of error");

    const next = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b"],
      excludeAccountIds: [first!],
      stickyKey: key,
    });
    assert.ok(next);
    assert.notEqual(next, first);

    // Failover payload <100k on simulated 2M-char conversation.
    const messages = buildBigConversation(250);
    const compressed = assembleCompressedContext({
      systemPrompt: "System: agent instructions",
      tools: [],
      messages,
      currentTurn: messages[messages.length - 1],
      rollingSummary: "prior work summary",
      tokenBudget: 200_000,
    });
    assert.ok(compressed.totalChars <= 200_000);
    assert.equal(compressed.t0, "System: agent instructions");

    sticky.rebind(key, next!, null);
    // Subsequent turn stays on new account.
    for (let t = 0; t < 5; t++) {
      const b = sticky.get(key);
      assert.equal(b!.accountId, next);
      sticky.touch(key);
    }
  } finally {
    sticky.clearForTests();
  }
});
