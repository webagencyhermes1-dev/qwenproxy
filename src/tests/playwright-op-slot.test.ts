import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  PW_OP_SEMAPHORE_MAX,
  getPlaywrightOpHighWater,
  resetPlaywrightOpHighWaterForTests,
  withPlaywrightOpSlot,
} from "../services/playwright.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("playwright op slot: 50 concurrent ops never exceed 5 at once", async () => {
  resetPlaywrightOpHighWaterForTests();
  let active = 0;
  let maxObserved = 0;
  const tasks = Array.from({ length: 50 }, (_, i) =>
    withPlaywrightOpSlot(async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await sleep(5);
      active--;
      return i;
    }),
  );
  const results = await Promise.all(tasks);
  assert.equal(results.length, 50);
  assert.ok(
    maxObserved <= PW_OP_SEMAPHORE_MAX,
    `at most 5 ops at once, observed ${maxObserved}`,
  );
  assert.ok(maxObserved >= 2, `ops should actually overlap, observed ${maxObserved}`);
  assert.ok(
    getPlaywrightOpHighWater() <= PW_OP_SEMAPHORE_MAX,
    `high-water ${getPlaywrightOpHighWater()} must respect the cap`,
  );
});

test("playwright op slot: errors release the slot (no leak)", async () => {
  resetPlaywrightOpHighWaterForTests();
  await assert.rejects(
    withPlaywrightOpSlot(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // Slot freed: a fresh op proceeds immediately.
  const ok = await withPlaywrightOpSlot(async () => "free");
  assert.equal(ok, "free");
});
