import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getRecent429Rate,
  recordRollingRequestEvent,
} from "../core/account-health.ts";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const BASE_NOW = 1_750_000_000_000;

let now = BASE_NOW;

describe("bounded rolling 429 rate measurement", () => {
  beforeEach(() => {
    now = BASE_NOW;
    Date.now = () => now;
  });

  it("getRecent429Rate returns 0 for unknown account", () => {
    assert.strictEqual(getRecent429Rate("rolling-429-unknown"), 0);
  });

  it("getRecent429Rate returns 0 when no events recorded", () => {
    assert.strictEqual(getRecent429Rate("rolling-429-no-events"), 0);
  });

  it("getRecent429Rate returns correct rate for mixed events", () => {
    const id = "rolling-429-mixed";
    for (let i = 0; i < 15; i += 1) recordRollingRequestEvent(id, false);
    for (let i = 0; i < 5; i += 1) recordRollingRequestEvent(id, true);
    assert.strictEqual(getRecent429Rate(id), 0.25);
  });

  it("rolling window is bounded to last 20 events", () => {
    const id = "rolling-429-bounded";
    for (let i = 0; i < 25; i += 1) recordRollingRequestEvent(id, false);
    for (let i = 0; i < 5; i += 1) recordRollingRequestEvent(id, true);
    assert.strictEqual(getRecent429Rate(id), 0.25);
  });

  it("getRecent429Rate returns 0 when window has expired", () => {
    const id = "rolling-429-expired";
    recordRollingRequestEvent(id, false);
    recordRollingRequestEvent(id, true);
    assert.strictEqual(getRecent429Rate(id), 0.5);
    now += RATE_LIMIT_WINDOW_MS + 1;
    assert.strictEqual(getRecent429Rate(id), 0);
  });

  it("all rate-limited events gives rate of 1.0", () => {
    const id = "rolling-429-all-limited";
    for (let i = 0; i < 10; i += 1) recordRollingRequestEvent(id, true);
    assert.strictEqual(getRecent429Rate(id), 1);
  });

  it("single event gives correct rate", () => {
    const limitedId = "rolling-429-single-limited";
    const normalId = "rolling-429-single-normal";
    recordRollingRequestEvent(limitedId, true);
    assert.strictEqual(getRecent429Rate(limitedId), 1);
    recordRollingRequestEvent(normalId, false);
    assert.strictEqual(getRecent429Rate(normalId), 0);
  });
});
