import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.ACCOUNT_MAX_CONCURRENT_STREAMS = "1";

import { StickyMap, STICKY_TTL_MS } from "../services/session/stickyMap.ts";
import { generateStickyKey } from "../services/session/key.ts";
import { HealthTracker } from "../services/account/health.ts";
import { selectAccountForNewSession } from "../services/account/selection.ts";
import { assembleCompressedContext } from "../services/context/tiered.ts";
import {
  acquireAccountLease,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";
import type { Message } from "../utils/types.ts";

function bigConversation(exchanges: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < exchanges; i++) {
    out.push({ role: "user", content: `A step ${i} ${"x".repeat(4000)}` });
    out.push({ role: "assistant", content: `A result ${i} ${"y".repeat(4000)}` });
  }
  return out;
}

test("two sessions: different first messages bind different accounts; A failover leaves B", async () => {
  const sticky = new StickyMap({ autoSweep: false });
  sticky.clearForTests();
  const health = new HealthTracker();
  resetAccountConcurrencyForTests();
  try {
    const keyA = generateStickyKey({
      messages: [{ role: "user", content: "session A: refactor auth module" } as Message],
    });
    const keyB = generateStickyKey({
      messages: [{ role: "user", content: "session B: optimize database queries" } as Message],
    });
    assert.notEqual(keyA, keyB);

    for (const acc of ["acc-a", "acc-b", "acc-c"]) {
      for (let i = 0; i < 3; i++) health.recordSuccess(acc, 700);
    }

    // Session A binds first.
    const pickA = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b", "acc-c"],
      stickyKey: keyA,
    });
    assert.ok(pickA);
    sticky.set(keyA, {
      accountId: pickA!,
      proxyId: null,
      boundAt: Date.now(),
      lastUsedAt: Date.now(),
      ttlMs: STICKY_TTL_MS,
    });
    // Mark A usage so LRU steers B elsewhere.
    health.recordSuccess(pickA!, 700);

    // Session B binds to a different account.
    const pickB = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b", "acc-c"],
      stickyKey: keyB,
    });
    assert.ok(pickB);
    assert.notEqual(pickB, pickA, "concurrent sessions must land on different accounts");
    sticky.set(keyB, {
      accountId: pickB!,
      proxyId: null,
      boundAt: Date.now(),
      lastUsedAt: Date.now(),
      ttlMs: STICKY_TTL_MS,
    });
    health.recordSuccess(pickB!, 700);

    // Simulate A generating: hold its lease.
    const leaseA = await acquireAccountLease(pickA!, { label: "sess-A" });
    try {
      // B's selection must not block on A's generation (<500ms).
      const t0 = Date.now();
      const pickB2 = selectAccountForNewSession({
        stickyMap: sticky,
        healthTracker: health,
        availableAccounts: ["acc-a", "acc-b", "acc-c"],
        excludeAccountIds: [pickA!],
        stickyKey: keyB,
      });
      const dt = Date.now() - t0;
      assert.ok(dt < 500, `B selection blocked ${dt}ms by A`);
      assert.ok(pickB2 && pickB2 !== pickA);
    } finally {
      leaseA.release();
    }

    // Exhaust A's account with quota.
    for (let i = 0; i < 5; i++) health.record429(pickA!, "quota", 3600_000);
    const rebindTo = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b", "acc-c"],
      excludeAccountIds: [pickA!],
      stickyKey: keyA,
    });
    assert.ok(rebindTo);
    assert.notEqual(rebindTo, pickA);
    assert.notEqual(rebindTo, pickB, "failover should prefer the unused account");

    const messages = bigConversation(250);
    const compressed = assembleCompressedContext({
      systemPrompt: "System: agent",
      tools: [],
      messages,
      currentTurn: messages[messages.length - 1],
      rollingSummary: "A summary",
      tokenBudget: 100_000,
    });
    assert.ok(compressed.totalChars <= 100_000, `failover=${compressed.totalChars}`);

    sticky.rebind(keyA, rebindTo!, null);

    // B unaffected.
    assert.equal(sticky.get(keyB)!.accountId, pickB);
    // A stays on new account.
    for (let i = 0; i < 3; i++) {
      assert.equal(sticky.get(keyA)!.accountId, rebindTo);
      sticky.touch(keyA);
    }
  } finally {
    sticky.clearForTests();
    resetAccountConcurrencyForTests();
  }
});
