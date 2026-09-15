import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { StickyMap, STICKY_TTL_MS } from "../services/session/stickyMap.ts";
import { generateStickyKey } from "../services/session/key.ts";
import { HealthTracker } from "../services/account/health.ts";
import { selectAccountForNewSession } from "../services/account/selection.ts";

test("burst 429 does not rebind; quota 429 does", () => {
  const sticky = new StickyMap({ autoSweep: false });
  sticky.clearForTests();
  const health = new HealthTracker();
  try {
    const key = generateStickyKey({
      messages: [{ role: "user", content: "burst test session" } as never],
    });
    for (let i = 0; i < 3; i++) {
      health.recordSuccess("acc-a", 600);
      health.recordSuccess("acc-b", 600);
    }
    sticky.set(key, {
      accountId: "acc-a",
      proxyId: null,
      boundAt: Date.now(),
      lastUsedAt: Date.now(),
      ttlMs: STICKY_TTL_MS,
    });

    // Burst: single short 429. No quota mark, still selectable, binding stays.
    health.record429("acc-a", "burst", 5_000);
    const h1 = health.getHealth("acc-a");
    assert.equal(h1.lastQuotaExhaustedAt, null);
    assert.ok(h1.score > 0.2, `burst score=${h1.score} must stay selectable`);
    assert.equal(sticky.get(key)!.accountId, "acc-a");

    // Quota: repeated long 429s exhaust. Selection must rotate, then rebind.
    for (let i = 0; i < 5; i++) health.record429("acc-a", "quota", 3600_000);
    const h2 = health.getHealth("acc-a");
    assert.ok(h2.lastQuotaExhaustedAt !== null);
    const next = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b"],
      excludeAccountIds: ["acc-a"],
      stickyKey: key,
    });
    assert.equal(next, "acc-b");
    sticky.rebind(key, next!, null);
    assert.equal(sticky.get(key)!.accountId, "acc-b");
  } finally {
    sticky.clearForTests();
  }
});
