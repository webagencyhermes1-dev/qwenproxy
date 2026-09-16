import test from "node:test";
import assert from "node:assert/strict";

import {
  RetryCoordinator,
  defaultConfig,
  type RetryCoordinatorConfig,
  type RetryDecision,
} from "./retry-coordinator.ts";
import { type ErrorCode, TypedRuntimeError } from "../../domain/errors.ts";
import {
  type Generation,
  type GenerationAttempt,
  type SideEffectRecord,
  isAttemptedAccount,
  nextAttempt,
} from "../../domain/generation.ts";
import { config } from "../../core/config.ts";

const FIXED: RetryCoordinatorConfig = {
  maxAttempts: 4,
  maxAccountSwitches: 2,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  chatInProgressMaxSameChat: 6,
  jitter: () => 0,
};

function cleanSideEffects(): SideEffectRecord {
  return { outputEmittedToClient: false, toolCallsExecuted: [], lastUpdatedAt: 0 };
}

function makeGeneration(overrides: Partial<Generation> = {}): Generation {
  return {
    generationId: "gen-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sessionVersionAtStart: 1,
    state: "STREAMING",
    attemptIds: ["gen-1_attempt_1"],
    attemptedAccountIds: ["acct-a"],
    snapshotId: null,
    leaseId: null,
    deadline: Number.MAX_SAFE_INTEGER,
    createdAt: 0,
    terminalAt: null,
    sideEffects: cleanSideEffects(),
    idempotencyKey: null,
    ...overrides,
  };
}

function makeAttempt(attemptNumber: number, accountId = "acct-a"): GenerationAttempt {
  return {
    attemptId: `gen-1_attempt_${attemptNumber}`,
    generationId: "gen-1",
    attemptNumber,
    accountId,
    state: "FAILED",
    startedAt: null,
    upstreamStartedAt: null,
    firstTokenAt: null,
    completedAt: null,
    failureCode: "UPSTREAM_UNAVAILABLE",
    failureReason: null,
  };
}

function decide(
  coordinator: RetryCoordinator,
  code: ErrorCode,
  attemptNumber: number,
  overrides: {
    generation?: Partial<Generation>;
    chatCorrupted?: boolean;
    accountLevelFailure?: boolean;
  } = {},
): RetryDecision {
  return coordinator.decide({
    error: TypedRuntimeError.fromCode(code, code),
    generation: makeGeneration({
      attemptIds: Array.from(
        { length: attemptNumber },
        (_, i) => `gen-1_attempt_${i + 1}`,
      ),
      ...overrides.generation,
    }),
    attempt: makeAttempt(attemptNumber),
    chatCorrupted: overrides.chatCorrupted ?? false,
    accountLevelFailure: overrides.accountLevelFailure ?? false,
  });
}

test("defaultConfig mirrors the actual config.ts retry knobs", () => {
  const defaults = defaultConfig();

  assert.equal(defaults.maxAttempts, config.retry.maxAttempts);
  assert.equal(defaults.maxAccountSwitches, config.retry.maxAccountSwitches);
  assert.equal(defaults.baseDelayMs, config.retry.baseDelayMs);
  assert.equal(defaults.maxDelayMs, config.retry.maxDelayMs);
  assert.equal(defaults.chatInProgressMaxSameChat, config.retry.chatInProgressMaxAttempts);
  assert.equal(typeof defaults.jitter, "function");
  assert.equal(RetryCoordinator.defaultConfig().maxAttempts, config.retry.maxAttempts);
});

test("configured retry defaults: 3 attempts, 2 account switches", () => {
  assert.equal(config.retry.maxAttempts, 3);
  assert.equal(config.retry.maxAccountSwitches, 2);
});

test("context-budget errors fail terminally and never enter the network retry path", () => {
  const coordinator = new RetryCoordinator(FIXED);
  const codes: ErrorCode[] = [
    "CONTEXT_TOO_LARGE",
    "CONTEXT_RECONSTRUCTION_FAILED",
    "CONTEXT_COMPACTION_NON_CONVERGENT",
  ];

  for (const code of codes) {
    const decision = decide(coordinator, code, 1);

    assert.equal(decision.action, "FAIL_TERMINAL");
    assert.equal(decision.tier, 4);
    assert.equal(decision.switchAccount, false);
    assert.equal(decision.newChat, false);
    assert.equal(decision.delayMs, 0);
    assert.ok(decision.reason.startsWith("context_budget:"), decision.reason);

    const classification = coordinator.classifyFailure(TypedRuntimeError.fromCode(code));
    assert.equal(classification.terminal, true);
    assert.equal(classification.tier, 4);
  }
});

test("terminal generation errors fail without a network retry", () => {
  const coordinator = new RetryCoordinator(FIXED);
  const codes: ErrorCode[] = [
    "SESSION_BUSY",
    "SESSION_CONFLICT",
    "GENERATION_TIMEOUT",
    "TOOL_CALL_INVALID",
    "INVALID_REQUEST",
    "SESSION_NOT_FOUND",
  ];

  for (const code of codes) {
    const decision = decide(coordinator, code, 1);
    assert.equal(decision.action, "FAIL_TERMINAL");
    assert.equal(decision.tier, 4);
    assert.equal(decision.switchAccount, false);
    assert.ok(decision.reason.startsWith("terminal:"), decision.reason);
  }
});

test("irreversible side effects terminalize even a transport error (J.21)", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const emitted = decide(coordinator, "UPSTREAM_UNAVAILABLE", 1, {
    generation: {
      sideEffects: { outputEmittedToClient: true, toolCallsExecuted: [], lastUpdatedAt: 1 },
    },
  });
  assert.equal(emitted.action, "FAIL_TERMINAL");
  assert.equal(emitted.tier, 4);
  assert.equal(emitted.switchAccount, false);
  assert.equal(emitted.reason, "side_effect:output_emitted");

  const tools = decide(coordinator, "UPSTREAM_UNAVAILABLE", 1, {
    generation: {
      sideEffects: {
        outputEmittedToClient: false,
        toolCallsExecuted: ["tc-1", "tc-2"],
        lastUpdatedAt: 1,
      },
    },
  });
  assert.equal(tools.action, "FAIL_TERMINAL");
  assert.equal(tools.tier, 4);
  assert.equal(tools.reason, "side_effect:tool_calls_executed:2");
});

test("client cancellation is CANCEL, never a retry or a failure", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const decision = decide(coordinator, "GENERATION_CANCELLED", 1);
  assert.equal(decision.action, "CANCEL");
  assert.equal(decision.tier, 4);
  assert.equal(decision.delayMs, 0);
  assert.equal(decision.switchAccount, false);
  assert.equal(decision.newChat, false);
  assert.equal(decision.reason, "client_cancelled");
  assert.equal(decision.remainingBudget, 3);
});

test("tier ladder: successive transport failures escalate 1 -> 2 -> 3, then 4 at budget exhaustion", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const first = decide(coordinator, "UPSTREAM_UNAVAILABLE", 1);
  assert.equal(first.action, "RETRY");
  assert.equal(first.tier, 1);
  assert.equal(first.switchAccount, false);
  assert.equal(first.newChat, false);
  assert.equal(first.reason, "transport:UPSTREAM_UNAVAILABLE");
  assert.equal(first.remainingBudget, 3);

  const second = decide(coordinator, "UPSTREAM_UNAVAILABLE", 2);
  assert.equal(second.action, "RETRY");
  assert.equal(second.tier, 2);
  assert.equal(second.switchAccount, false);
  assert.equal(second.newChat, true);
  assert.equal(second.remainingBudget, 2);

  const third = decide(coordinator, "UPSTREAM_UNAVAILABLE", 3, {
    generation: { attemptedAccountIds: ["acct-a", "acct-b"] },
  });
  assert.equal(third.action, "RETRY");
  assert.equal(third.tier, 3);
  assert.equal(third.switchAccount, true);
  assert.equal(third.newChat, true);
  assert.equal(third.remainingBudget, 1);

  const exhausted = decide(coordinator, "UPSTREAM_UNAVAILABLE", 4, {
    generation: { attemptedAccountIds: ["acct-a", "acct-b", "acct-c"] },
  });
  assert.equal(exhausted.action, "FAIL_TERMINAL");
  assert.equal(exhausted.tier, 4);
  assert.equal(exhausted.delayMs, 0);
  assert.equal(exhausted.remainingBudget, 0);
  assert.equal(exhausted.reason, "budget_exhausted:attempts");
});

test("an authentication failure on the account escalates straight to a switch", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const decision = decide(coordinator, "AUTHENTICATION_FAILED", 1, {
    generation: { attemptedAccountIds: ["acct-a"] },
  });
  assert.equal(decision.action, "RETRY");
  assert.equal(decision.tier, 3);
  assert.equal(decision.switchAccount, true);
  assert.equal(decision.newChat, true);
  assert.equal(decision.reason, "account_authentication");
});

test("an account-level failure input switches accounts instead of replaying the chat", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const decision = decide(coordinator, "UPSTREAM_UNAVAILABLE", 1, {
    accountLevelFailure: true,
  });
  assert.equal(decision.action, "RETRY");
  assert.equal(decision.tier, 3);
  assert.equal(decision.switchAccount, true);
  assert.equal(decision.reason, "account_level_failure");
});

test("a corrupted chat rebuilds on the same account before rotating", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const first = decide(coordinator, "UPSTREAM_UNAVAILABLE", 1, { chatCorrupted: true });
  assert.equal(first.tier, 2);
  assert.equal(first.switchAccount, false);
  assert.equal(first.newChat, true);
  assert.equal(first.reason, "chat_corrupted");

  const repeated = decide(coordinator, "UPSTREAM_UNAVAILABLE", 3, { chatCorrupted: true });
  assert.equal(repeated.tier, 3);
  assert.equal(repeated.switchAccount, true);
  assert.equal(repeated.reason, "chat_corruption_repeated");
});

test("no account-switch budget left terminalizes an account-level failure", () => {
  const coordinator = new RetryCoordinator({ ...FIXED, maxAccountSwitches: 0 });

  const decision = decide(coordinator, "ACCOUNT_UNAVAILABLE", 1);
  assert.equal(decision.action, "FAIL_TERMINAL");
  assert.equal(decision.tier, 4);
  assert.equal(decision.reason, "budget_exhausted:account_switches");
});

test("a timeout retries the same chat and never jumps to an account switch", () => {
  const coordinator = new RetryCoordinator(FIXED);

  const first = decide(coordinator, "UPSTREAM_TIMEOUT", 1);
  assert.equal(first.action, "RETRY");
  assert.equal(first.tier, 1);
  assert.equal(first.switchAccount, false);
  assert.equal(first.newChat, false);
  assert.equal(first.reason, "chat_settle:UPSTREAM_TIMEOUT");

  const second = decide(coordinator, "UPSTREAM_TIMEOUT", 2);
  assert.equal(second.tier, 1);
  assert.equal(second.switchAccount, false);
  assert.equal(second.newChat, false);

  const third = decide(coordinator, "UPSTREAM_TIMEOUT", 3, {
    generation: { attemptedAccountIds: ["acct-a", "acct-b"] },
  });
  assert.equal(third.tier, 1);
  assert.equal(third.switchAccount, false);
});

test("timeouts escalate only after the same-chat settle bound is exhausted", () => {
  const bounded = new RetryCoordinator({ ...FIXED, chatInProgressMaxSameChat: 1 });

  const second = decide(bounded, "UPSTREAM_TIMEOUT", 2);
  assert.equal(second.tier, 2);
  assert.equal(second.switchAccount, false);
  assert.equal(second.newChat, true);
});

test("zero jitter yields an exact exponential backoff sequence", () => {
  const coordinator = new RetryCoordinator({ ...FIXED, maxAttempts: 5 });

  const decisions = [1, 2, 3, 4].map((n) =>
    decide(coordinator, "UPSTREAM_UNAVAILABLE", n),
  );
  assert.deepEqual(
    decisions.map((d) => d.delayMs),
    [100, 200, 400, 800],
  );
  assert.deepEqual(
    decisions.map((d) => d.remainingBudget),
    [4, 3, 2, 1],
  );

  const exhausted = decide(coordinator, "UPSTREAM_UNAVAILABLE", 5);
  assert.equal(exhausted.action, "FAIL_TERMINAL");
  assert.equal(exhausted.delayMs, 0);
});

test("backoff is capped at maxDelayMs", () => {
  const coordinator = new RetryCoordinator({ ...FIXED, maxDelayMs: 150, maxAttempts: 5 });

  const delays = [1, 2, 3, 4].map((n) => decide(coordinator, "UPSTREAM_UNAVAILABLE", n).delayMs);
  assert.deepEqual(delays, [100, 150, 150, 150]);
});

function seededJitter(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

test("seeded jitter is reproducible and perturbs the backoff", () => {
  const run = (seed: number): number[] => {
    const coordinator = new RetryCoordinator({
      ...FIXED,
      maxAttempts: 5,
      jitter: seededJitter(seed),
    });
    return [1, 2, 3, 4].map(
      (n) => decide(coordinator, "UPSTREAM_UNAVAILABLE", n).delayMs,
    );
  };

  assert.deepEqual(run(42), run(42));
  assert.notDeepEqual(run(42), [100, 200, 400, 800]);
});

test("tier 3 switches account; the caller honors the generation's attempted-account guard", () => {
  const coordinator = new RetryCoordinator(FIXED);
  const generation = makeGeneration({
    attemptIds: ["gen-1_attempt_1", "gen-1_attempt_2", "gen-1_attempt_3"],
    attemptedAccountIds: ["acct-a", "acct-b"],
  });

  const decision = coordinator.decide({
    error: TypedRuntimeError.fromCode("AUTHENTICATION_FAILED", "session expired"),
    generation,
    attempt: makeAttempt(3),
    chatCorrupted: false,
    accountLevelFailure: false,
  });

  assert.equal(decision.tier, 3);
  assert.equal(decision.switchAccount, true);

  // The caller must claim an account NOT already burned by this generation.
  assert.equal(isAttemptedAccount(generation, "acct-a"), true);
  assert.equal(isAttemptedAccount(generation, "acct-b"), true);
  assert.equal(isAttemptedAccount(generation, "acct-c"), false);
});

test("the domain layer backstops the budget: no replay past the attempt cap or after side effects", () => {
  const atCap = makeGeneration({
    attemptIds: ["gen-1_attempt_1", "gen-1_attempt_2", "gen-1_attempt_3", "gen-1_attempt_4"],
  });
  assert.equal(nextAttempt(atCap, "acct-c"), null);

  const withOutput = makeGeneration({
    sideEffects: { outputEmittedToClient: true, toolCallsExecuted: [], lastUpdatedAt: 1 },
  });
  assert.equal(nextAttempt(withOutput, "acct-c"), null);
});

test("classifyFailure reports the failure class without deciding a replay", () => {
  const coordinator = new RetryCoordinator(FIXED);

  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("UPSTREAM_UNAVAILABLE")),
    { tier: 1, terminal: false, reason: "transport:UPSTREAM_UNAVAILABLE" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("UPSTREAM_TIMEOUT")),
    { tier: 1, terminal: false, reason: "chat_settle:UPSTREAM_TIMEOUT" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("UPSTREAM_CHAT_CORRUPTED")),
    { tier: 2, terminal: false, reason: "chat_corrupted" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("ACCOUNT_COOLDOWN")),
    { tier: 3, terminal: false, reason: "account_level:ACCOUNT_COOLDOWN" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("AUTHENTICATION_FAILED")),
    { tier: 3, terminal: false, reason: "account_authentication" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("SESSION_BUSY")),
    { tier: 4, terminal: true, reason: "terminal:SESSION_BUSY" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("GENERATION_CANCELLED")),
    { tier: 4, terminal: true, reason: "client_cancelled" },
  );
  assert.deepEqual(
    coordinator.classifyFailure(TypedRuntimeError.fromCode("INTERNAL_ERROR")),
    { tier: 3, terminal: false, reason: "unknown:INTERNAL_ERROR" },
  );
});
