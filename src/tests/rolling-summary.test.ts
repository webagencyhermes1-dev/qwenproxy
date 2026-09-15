import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { RollingSummary, SUMMARY_MAX_CHARS } from "../services/context/summary.ts";

function msgs(n: number, prefix = "hello"): Array<never> {
  const out: Array<never> = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `${prefix} message ${i} with some content` } as never);
  }
  return out;
}

test("summary: updates incrementally", async () => {
  const s = new RollingSummary();
  s.clearForTests();
  try {
    await s.update("sess-a", msgs(2));
    const first = s.get("sess-a");
    assert.ok(first.length > 0);
    await s.update("sess-a", msgs(2, "followup"));
    const second = s.get("sess-a");
    assert.ok(second.length >= first.length);
    assert.ok(second.includes("followup"));
  } finally {
    s.clearForTests();
  }
});

test("summary: failure keeps old summary", async () => {
  const s = new RollingSummary();
  s.clearForTests();
  try {
    await s.update("sess-b", msgs(2));
    const before = s.get("sess-b");
    s.failNextUpdateForTests();
    await s.update("sess-b", msgs(2, "newstuff"));
    const after = s.get("sess-b");
    assert.equal(after, before);
  } finally {
    s.clearForTests();
  }
});

test("summary: size cap enforced", async () => {
  const s = new RollingSummary();
  s.clearForTests();
  try {
    const big = [{ role: "user", content: "x".repeat(10_000) } as never];
    for (let i = 0; i < 5; i++) await s.update("sess-c", big);
    assert.ok(s.get("sess-c").length <= SUMMARY_MAX_CHARS);
  } finally {
    s.clearForTests();
  }
});
