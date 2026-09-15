import { test } from "node:test";
import assert from "node:assert";
import {
  clearAccountAuthError,
  clearAccountBroken,
  clearAccountSessionExpired,
  deriveAccountState,
  isAccountEffectivelyBroken,
  markAccountAuthError,
  markAccountBroken,
  markAccountSessionExpired,
  noteAccountRecovered,
  resetAccountStateForTests,
  type AccountStateFlags,
} from "../core/account-state.ts";

function base(): AccountStateFlags {
  return {
    disabled: false,
    onCooldown: false,
    headersReady: true,
    initialized: true,
    busy: false,
    authError: false,
    sessionExpired: false,
    broken: false,
  };
}

test("Pool state: READY when healthy and idle", () => {
  assert.strictEqual(deriveAccountState(base()), "READY");
});

test("Pool state: priority order prevents contradictory states", () => {
  // DISABLED wins over everything.
  assert.strictEqual(
    deriveAccountState({ ...base(), disabled: true, broken: true, onCooldown: true }),
    "DISABLED",
  );
  // BROKEN beats cooldown/busy.
  assert.strictEqual(
    deriveAccountState({ ...base(), broken: true, onCooldown: true, busy: true }),
    "BROKEN",
  );
  // AUTH_ERROR beats session-expired/cooldown.
  assert.strictEqual(
    deriveAccountState({ ...base(), authError: true, sessionExpired: true, onCooldown: true }),
    "AUTH_ERROR",
  );
  // SESSION_EXPIRED beats cooldown (recover in place before switching).
  assert.strictEqual(
    deriveAccountState({ ...base(), sessionExpired: true, onCooldown: true }),
    "SESSION_EXPIRED",
  );
  // COOLDOWN beats busy/warming.
  assert.strictEqual(
    deriveAccountState({ ...base(), onCooldown: true, busy: true, headersReady: false }),
    "COOLDOWN",
  );
  // BUSY beats warming.
  assert.strictEqual(
    deriveAccountState({ ...base(), busy: true, headersReady: false }),
    "BUSY",
  );
  // Not ready => WARMING.
  assert.strictEqual(
    deriveAccountState({ ...base(), headersReady: false }),
    "WARMING",
  );
  assert.strictEqual(
    deriveAccountState({ ...base(), headersReady: true, initialized: false }),
    "WARMING",
  );
});

test("Pool state: SESSION_EXPIRED → recovery → READY lifecycle", () => {
  const id = "state-t1";
  resetAccountStateForTests();
  try {
    markAccountSessionExpired(id);
    assert.strictEqual(
      deriveAccountState({ ...base(), sessionExpired: true }),
      "SESSION_EXPIRED",
    );
    // Successful refresh recovers gradually.
    noteAccountRecovered(id);
    clearAccountSessionExpired(id);
    assert.strictEqual(deriveAccountState(base()), "READY");
  } finally {
    resetAccountStateForTests();
  }
});

test("Pool state: AUTH_ERROR flag lifecycle (manual DISABLED stays separate)", () => {
  const id = "state-t2";
  resetAccountStateForTests();
  try {
    markAccountAuthError(id);
    assert.strictEqual(
      deriveAccountState({ ...base(), authError: true }),
      "AUTH_ERROR",
    );
    clearAccountAuthError(id);
    assert.strictEqual(deriveAccountState(base()), "READY");
    // Broken flag is independent of auth flag.
    markAccountBroken(id);
    assert.strictEqual(isAccountEffectivelyBroken(id), true);
    clearAccountBroken(id);
    assert.strictEqual(isAccountEffectivelyBroken(id), false);
  } finally {
    resetAccountStateForTests();
  }
});
