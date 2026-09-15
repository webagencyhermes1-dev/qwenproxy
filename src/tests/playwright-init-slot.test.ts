import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import { withPlaywrightInitSlot } from "../services/playwright.ts";

test("config default caps parallel Playwright inits", () => {
  assert.equal(typeof config.playwright.maxParallelInit, "number");
  assert.ok(config.playwright.maxParallelInit >= 1);
});

test("withPlaywrightInitSlot never exceeds the configured concurrency ceiling", async () => {
  const originalCap = config.playwright.maxParallelInit;
  config.playwright.maxParallelInit = 3;
  try {
    let concurrent = 0;
    let peak = 0;
    const task = () =>
      withPlaywrightInitSlot(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 40);
          timer.unref?.();
        });
        concurrent--;
      });

    // A burst of 12 cold accounts initializing at once must serialize through
    // the slot: this is the crash-cascade guard (each init forks its own
    // Chromium process).
    const results = await Promise.all(Array.from({ length: 12 }, () => task()));
    assert.equal(results.length, 12, "every queued init must eventually run");
    assert.ok(
      peak <= 3,
      `peak concurrency of ${peak} must not exceed the configured cap of 3`,
    );
    assert.equal(concurrent, 0, "all slots must drain after the burst");
  } finally {
    config.playwright.maxParallelInit = originalCap;
  }
});

test("withPlaywrightInitSlot preserves thrown errors", async () => {
  const originalCap = config.playwright.maxParallelInit;
  config.playwright.maxParallelInit = 2;
  try {
    await assert.rejects(
      () => withPlaywrightInitSlot(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
  } finally {
    config.playwright.maxParallelInit = originalCap;
  }
});