import assert from "node:assert/strict";
import test from "node:test";

import { generateStickyKey, extractFirstUserText } from "../services/session/key.ts";

const HEX16 = /^[0-9a-f]{16}$/;
const EPHEM = /^ephem:[0-9a-f-]{36}$/;

test("stickyKey: header takes priority over first message", () => {
  const a = generateStickyKey({
    sessionHeader: "my-session-123",
    messages: [{ role: "user", content: "hello" } as never],
  });
  const b = generateStickyKey({
    sessionHeader: "my-session-123",
    messages: [{ role: "user", content: "different" } as never],
  });
  assert.match(a, HEX16);
  assert.equal(a, b);
});

test("stickyKey: same first message without a key produces distinct keys", () => {
  const a = generateStickyKey({
    messages: [{ role: "user", content: "fix the bug" } as never],
  });
  const b = generateStickyKey({
    messages: [{ role: "user", content: "fix the bug" } as never],
  });
  assert.notEqual(a, b, "content must never identify the sticky namespace");
});

test("stickyKey: different first messages produce different keys", () => {
  const a = generateStickyKey({
    messages: [{ role: "user", content: "alpha task" } as never],
  });
  const b = generateStickyKey({
    messages: [{ role: "user", content: "beta task" } as never],
  });
  assert.notEqual(a, b);
});

test("stickyKey: missing both produces ephemeral key", () => {
  const a = generateStickyKey({ messages: [] });
  const b = generateStickyKey({ messages: [] });
  assert.match(a, EPHEM);
  assert.match(b, EPHEM);
  // Ephemeral fallback must (almost certainly) differ.
  assert.notEqual(a, b);
});

test("stickyKey: explicitKey behaves like header", () => {
  const a = generateStickyKey({ explicitKey: "conv-1" });
  const b = generateStickyKey({ sessionHeader: "conv-1" });
  // Both hash with the same header: prefix, so they match.
  assert.equal(a, b);
});

test("stickyKey: array content first user extracted", () => {
  const text = extractFirstUserText([
    {
      role: "user",
      content: [
        { type: "text", text: "hello world" },
        { type: "image_url", image_url: { url: "x" } },
      ],
    } as never,
  ]);
  assert.equal(text, "hello world");
});
