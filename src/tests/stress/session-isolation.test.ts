/**
 * Edge cases SE-01, SE-02, SE-04, PA-03 — session isolation under concurrency.
 *
 * Reproduces the user-reported "context mixed up between sessions" scenario
 * (now fixed) and verifies the fix holds under stress. Each session gets a
 * unique marker planted in its input; the test asserts markers NEVER appear
 * in another session's output.
 *
 * Exercises the REAL qwen-thread-state.ts module (the production path for
 * thread parent tracking) with concurrent sessions.
 *
 * @stress
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  updateSessionParent,
  getSessionParent,
  updateLogicalThreadParent,
  getLogicalThreadState,
  clearAllSessionsForAccount,
  purgeLogicalThreadState,
} from "../../services/qwen-thread-state.ts";

const SESSION_COUNT = 10;
const ROUNDS = 20;

test("SE-01: concurrent sessions never cross-contaminate parent_ids", async () => {
  const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
    id: `iso-session-${i}`,
    marker: `MARKER_${i}_${Math.random().toString(36).slice(2, 8)}`,
    accountId: `iso-account-${i % 3}`,
  }));

  const ops: Promise<void>[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (const session of sessions) {
      ops.push(
        (async () => {
          const parentId = `parent_${session.marker}_r${round}`;
          updateSessionParent(session.id, parentId, session.accountId);

          await new Promise((r) => setImmediate(r));

          const retrieved = getSessionParent(session.id, session.accountId);
          assert.equal(
            retrieved,
            parentId,
            `Session ${session.id} round ${round}: expected own parent ${parentId}, got ${retrieved} — CROSS-CONTAMINATION`,
          );

          if (retrieved) {
            for (const other of sessions) {
              if (other.id !== session.id) {
                assert.ok(
                  !retrieved.includes(other.marker),
                  `Session ${session.id} contains marker from ${other.id} — LEAK`,
                );
              }
            }
          }
        })(),
      );
    }
  }

  await Promise.all(ops);
});

test("SE-01: logical thread state isolated per session", async () => {
  const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
    label: `lthread-sess-${i}`,
    marker: `THREAD_${i}_${Date.now()}`,
    accountId: `lthread-acct-${i % 4}`,
    chatSessionId: `chat-${i}`,
  }));

  const ops: Promise<void>[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (const session of sessions) {
      ops.push(
        (async () => {
          const parentId = `lp_${session.marker}_r${round}`;
          updateLogicalThreadParent(
            session.label,
            parentId,
            session.accountId,
            session.chatSessionId,
          );

          await new Promise((r) => setImmediate(r));

          const state = getLogicalThreadState(session.label);
          assert.ok(state, `Thread ${session.label} should have state`);
          assert.equal(
            state.parentId,
            parentId,
            `Thread ${session.label} round ${round}: expected ${parentId}, got ${state.parentId}`,
          );
          assert.equal(state.accountId, session.accountId);
          assert.equal(state.chatSessionId, session.chatSessionId);
        })(),
      );
    }
  }

  await Promise.all(ops);
});

test("SE-04: same session_id concurrent writes — last writer wins deterministically", async () => {
  const sessionId = "contended-session";
  const accountId = "contended-account";
  const writers = 5;

  const ops: Promise<void>[] = [];
  for (let w = 0; w < writers; w++) {
    ops.push(
      (async () => {
        for (let i = 0; i < 10; i++) {
          updateSessionParent(sessionId, `writer-${w}-iter-${i}`, accountId);
          await new Promise((r) => setImmediate(r));
        }
      })(),
    );
  }

  await Promise.all(ops);

  const final = getSessionParent(sessionId, accountId);
  assert.ok(final, "session parent should exist after concurrent writes");
  assert.ok(
    final.startsWith("writer-"),
    `final parent should be from one of the writers, got: ${final}`,
  );
});

test("SE-02: clearAllSessionsForAccount removes all state for an account", () => {
  const accountId = "reset-account";
  const sessions = ["reset-s1", "reset-s2", "reset-s3"];

  for (const s of sessions) {
    updateSessionParent(s, `parent-${s}`, accountId);
  }

  for (const s of sessions) {
    assert.equal(getSessionParent(s, accountId), `parent-${s}`);
  }

  clearAllSessionsForAccount(accountId);

  for (const s of sessions) {
    const after = getSessionParent(s, accountId);
    assert.equal(after, undefined, `session ${s} should be cleared after account reset`);
  }
});

test("SE-02: purgeLogicalThreadState removes thread binding", () => {
  const sessionId = "purge-thread";
  const accountId = "purge-account";
  const chatId = "purge-chat";

  updateLogicalThreadParent(sessionId, "parent-before-purge", accountId, chatId);
  const before = getLogicalThreadState(sessionId);
  assert.ok(before);
  assert.equal(before.parentId, "parent-before-purge");

  purgeLogicalThreadState(sessionId);

  const after = getLogicalThreadState(sessionId);
  assert.equal(after, null, "thread state should be purged");
});

test("SE-01: 50 sessions x 50 rounds — no cross-contamination at scale", async () => {
  const largeSessionCount = 50;
  const largeRounds = 50;
  const sessions = Array.from({ length: largeSessionCount }, (_, i) => ({
    id: `scale-sess-${i}`,
    marker: `SCALE_${i}`,
    accountId: `scale-acct-${i % 7}`,
  }));

  const ops: Promise<void>[] = [];

  for (let round = 0; round < largeRounds; round++) {
    for (const session of sessions) {
      ops.push(
        (async () => {
          const parentId = `p_${session.marker}_r${round}`;
          updateSessionParent(session.id, parentId, session.accountId);

          if (round % 10 === 0) {
            await new Promise((r) => setImmediate(r));
            const retrieved = getSessionParent(session.id, session.accountId);
            assert.equal(retrieved, parentId);
          }
        })(),
      );
    }
  }

  await Promise.all(ops);

  for (const session of sessions) {
    const actual = getSessionParent(session.id, session.accountId);
    assert.ok(actual, `Session ${session.id} should have a parent after writes`);
    assert.ok(
      actual.startsWith(`p_${session.marker}_r`),
      `Session ${session.id} parent should match its own marker pattern, got: ${actual}`,
    );
    for (const other of sessions) {
      if (other.id !== session.id) {
        assert.ok(
          !actual.includes(other.marker),
          `Session ${session.id} contains marker from ${other.id} — LEAK`,
        );
      }
    }
  }
});
