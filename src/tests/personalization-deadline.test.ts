import test from "node:test";
import assert from "node:assert/strict";
import {
  computePersonalizationDeadlineMs,
  PERSONALIZATION_SYNC_DEADLINE_MS,
  PERSONALIZATION_LOCK_ACQUIRE_TIMEOUT_MS,
} from "../routes/chat/account.ts";
import {
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
} from "../services/playwright.ts";

test("Personalization Deadline: sync is hard-capped at 5s for every account", () => {
  // The sync deadline is a hard 5s cap regardless of account warmth or the
  // navigation timeout — a stuck browser op must never hold the personalization
  // mutex for minutes (observed: heldFor=62011ms). A normal sync takes ~2s.
  assert.equal(PERSONALIZATION_SYNC_DEADLINE_MS, 5_000);

  const deadlineCold = computePersonalizationDeadlineMs("non-existent-account-id");
  assert.equal(deadlineCold, PERSONALIZATION_SYNC_DEADLINE_MS);
  assert.equal(deadlineCold, 5_000);

  const deadlineUndefined = computePersonalizationDeadlineMs(undefined);
  assert.equal(deadlineUndefined, PERSONALIZATION_SYNC_DEADLINE_MS);

  // Even a huge navigation timeout must NOT extend the sync deadline.
  assert.equal(computePersonalizationDeadlineMs("cold-acc"), PERSONALIZATION_SYNC_DEADLINE_MS);
});

test("Personalization Deadline: warm account gets the same 5s hard cap", () => {
  const warmAccountId = "test-warm-acc-" + Date.now();
  try {
    registerPlaywrightAccountForTests(warmAccountId, {} as any, Date.now());
    const deadlineWarm = computePersonalizationDeadlineMs(warmAccountId);
    assert.equal(deadlineWarm, PERSONALIZATION_SYNC_DEADLINE_MS);
    assert.equal(deadlineWarm, 5_000);
  } finally {
    unregisterPlaywrightAccountForTests(warmAccountId);
  }
});

test("Personalization Deadline: lock acquire budget is 2s", () => {
  assert.equal(PERSONALIZATION_LOCK_ACQUIRE_TIMEOUT_MS, 2_000);
});