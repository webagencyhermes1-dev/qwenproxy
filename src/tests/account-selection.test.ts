import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { StickyMap } from "../services/session/stickyMap.ts";
import { HealthTracker } from "../services/account/health.ts";
import { selectAccountForNewSession } from "../services/account/selection.ts";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";

function setup(): { sticky: StickyMap; health: HealthTracker } {
  const sticky = new StickyMap({ autoSweep: false });
  sticky.clearForTests();
  const health = new HealthTracker();
  return { sticky, health };
}

test("selection: highest-scoring account selected", () => {
  const { sticky, health } = setup();
  try {
    markAccountHeadersReady("acc-good");
    markAccountHeadersReady("acc-mid");
    for (let i = 0; i < 5; i++) {
      health.recordSuccess("acc-good", 500);
      health.recordSuccess("acc-mid", 4000);
    }
    // Degrade mid with burst 429s.
    health.record429("acc-mid", "burst", 5_000);
    health.record429("acc-mid", "burst", 5_000);
    const picked = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-good", "acc-mid"],
      stickyKey: "testkey1234567890",
    });
    assert.equal(picked, "acc-good");
  } finally {
    unmarkAccountHeadersReady("acc-good");
    unmarkAccountHeadersReady("acc-mid");
    sticky.clearForTests();
  }
});

test("selection: quota-exhausted accounts skipped", () => {
  const { sticky, health } = setup();
  try {
    markAccountHeadersReady("acc-a");
    markAccountHeadersReady("acc-b");
    for (let i = 0; i < 3; i++) health.recordSuccess("acc-a", 500);
    for (let i = 0; i < 3; i++) health.recordSuccess("acc-b", 500);
    for (let i = 0; i < 5; i++) health.record429("acc-a", "quota", 3600_000);
    const picked = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b"],
    });
    assert.equal(picked, "acc-b");
  } finally {
    unmarkAccountHeadersReady("acc-a");
    unmarkAccountHeadersReady("acc-b");
    sticky.clearForTests();
  }
});

test("selection: exclusion list honored", () => {
  const { sticky, health } = setup();
  try {
    markAccountHeadersReady("acc-a");
    markAccountHeadersReady("acc-b");
    for (let i = 0; i < 3; i++) {
      health.recordSuccess("acc-a", 500);
      health.recordSuccess("acc-b", 500);
    }
    const picked = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-a", "acc-b"],
      excludeAccountIds: ["acc-a", "acc-b"],
    });
    assert.equal(picked, null);
  } finally {
    unmarkAccountHeadersReady("acc-a");
    unmarkAccountHeadersReady("acc-b");
    sticky.clearForTests();
  }
});

test("selection: empty pool returns null", () => {
  const { sticky, health } = setup();
  try {
    const picked = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: [],
    });
    assert.equal(picked, null);
  } finally {
    sticky.clearForTests();
  }
});

test("selection: deterministic tiebreak (LRU then id)", () => {
  const { sticky, health } = setup();
  try {
    markAccountHeadersReady("acc-a");
    markAccountHeadersReady("acc-b");
    // No history: both score 1.0, lastUsed 0 -> lexicographic.
    const picked = selectAccountForNewSession({
      stickyMap: sticky,
      healthTracker: health,
      availableAccounts: ["acc-b", "acc-a"],
    });
    assert.equal(picked, "acc-a");
  } finally {
    unmarkAccountHeadersReady("acc-a");
    unmarkAccountHeadersReady("acc-b");
    sticky.clearForTests();
  }
});
