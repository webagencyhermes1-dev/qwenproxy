import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { VectorStore } from "../services/context/vectorStore.ts";

test("vectorStore: add and query returns relevant messages", async () => {
  const vs = new VectorStore();
  vs.clearForTests();
  try {
    await vs.add("sess-a", "m1", "database optimization with indexes and query plans");
    await vs.add("sess-a", "m2", "caching strategies with redis and memoization");
    await vs.add("sess-a", "m3", "frontend styling with css variables");
    const hits = await vs.query("sess-a", "database optimization", 2);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].messageId, "m1");
    // Score-descending.
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i - 1].score >= hits[i].score);
    }
  } finally {
    vs.clearForTests();
  }
});

test("vectorStore: BM25 fallback works without embeddings", async () => {
  const vs = new VectorStore();
  vs.clearForTests();
  try {
    await vs.add("sess-b", "m1", "fix authentication bug in login handler");
    const hits = await vs.query("sess-b", "authentication login bug", 5);
    assert.ok(hits.length === 1);
    assert.equal(hits[0].messageId, "m1");
  } finally {
    vs.clearForTests();
  }
});

test("vectorStore: deduplication works", async () => {
  const vs = new VectorStore();
  vs.clearForTests();
  try {
    await vs.add("sess-c", "m1", "same text about databases");
    await vs.add("sess-c", "m1", "same text about databases");
    const hits = await vs.query("sess-c", "databases", 5);
    const ids = hits.map((h) => h.messageId);
    assert.deepEqual(ids, [...new Set(ids)]);
    assert.ok(ids.filter((id) => id === "m1").length <= 1);
  } finally {
    vs.clearForTests();
  }
});

test("vectorStore: deleting a session removes its index", async () => {
  const vs = new VectorStore();
  vs.clearForTests();
  try {
    await vs.add("sess-d", "m1", "some content here");
    await vs.delete("sess-d");
    const hits = await vs.query("sess-d", "content", 5);
    assert.equal(hits.length, 0);
  } finally {
    vs.clearForTests();
  }
});
