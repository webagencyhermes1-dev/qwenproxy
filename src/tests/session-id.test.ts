import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSessionId } from "../utils/session-id.ts";
import type { Message } from "../utils/types.ts";

function msg(role: string, content: string | any[]): Message {
  return { role, content: content as any };
}

test("deriveSessionId: deterministic output for same inputs", () => {
  const messages: Message[] = [msg("user", "Olá, como vai?")];
  const id1 = deriveSessionId(messages, "system prompt", "conv-a");
  const id2 = deriveSessionId(messages, "system prompt", "conv-a");
  assert.equal(id1, id2);
});

test("deriveSessionId: different messages produce different IDs", () => {
  const id1 = deriveSessionId([msg("user", "Olá")], "", "conv-a");
  const id2 = deriveSessionId([msg("user", "Tchau")], "", "conv-a");
  assert.notEqual(id1, id2);
});

test("deriveSessionId: format is sess_ followed by 16 hex chars", () => {
  const id = deriveSessionId([msg("user", "test")], "", "conv-a");
  assert.match(id, /^sess_[a-f0-9]{16}$/);
});

test("deriveSessionId: anchors on first user message only", () => {
  const base: Message[] = [
    msg("system", "You are a helpful assistant"),
    msg("user", "First message"),
    msg("assistant", "Response"),
    msg("user", "Second message"),
  ];
  const id1 = deriveSessionId(base, "", "conv-a");

  const variant: Message[] = [
    msg("system", "You are a helpful assistant"),
    msg("user", "First message"),
    msg("assistant", "Different response"),
    msg("user", "Completely different later message"),
  ];
  const id2 = deriveSessionId(variant, "", "conv-a");
  assert.equal(id1, id2);
});

test("deriveSessionId: systemPrompt variation changes the ID", () => {
  const messages: Message[] = [msg("user", "Hello")];
  const id1 = deriveSessionId(messages, "prompt A", "conv-a");
  const id2 = deriveSessionId(messages, "prompt B", "conv-a");
  assert.notEqual(id1, id2);
});

test("deriveSessionId: explicit session key changes the ID", () => {
  const messages: Message[] = [msg("user", "Hello")];
  const id1 = deriveSessionId(messages, "prompt", "session-a");
  const id2 = deriveSessionId(messages, "prompt", "session-b");
  assert.notEqual(id1, id2);
});

test("deriveSessionId: empty messages array produces valid hash", () => {
  const id = deriveSessionId([], "", "conv-a");
  assert.match(id, /^sess_[a-f0-9]{16}$/);
});

test("deriveSessionId: absent conversation key yields a unique ephemeral id", () => {
  const messages: Message[] = [msg("user", "same first prompt")];
  const id1 = deriveSessionId(messages, "system prompt");
  const id2 = deriveSessionId(messages, "system prompt");
  const id3 = deriveSessionId(messages, "", "   ");
  assert.match(id1, /^sess_eph_/);
  assert.match(id3, /^sess_eph_/);
  assert.notEqual(id1, id2, "identical prompts must not share an id");
  assert.notEqual(id1, id3);
});
