/**
 * RetryCoordinator — the ONE authoritative retry decision-maker.
 *
 * Transports, stream layers and account pools classify and REPORT failures
 * ({@link classifyFailure}); they no longer decide whether a generation is
 * replayed. Every replay decision flows through here, so recursive and
 * distributed retry behavior cannot re-emerge in a low-level component.
 */
import { config } from "../../core/config.ts";
import {
  type ErrorCode,
  type TypedRuntimeError,
  isContextBudgetError,
  isTerminalGenerationError,
} from "../../domain/errors.ts";
import {
  type Generation,
  type GenerationAttempt,
  type SideEffectRecord,
  hasIrreversibleSideEffects,
} from "../../domain/generation.ts";

export type RetryTier = 1 | 2 | 3 | 4;

export interface RetryDecision {
  action: "RETRY" | "FAIL_TERMINAL" | "CANCEL";
  tier: RetryTier;
  delayMs: number;
  switchAccount: boolean;
  newChat: boolean;
  reason: string;
  remainingBudget: number;
}

export interface RetryCoordinatorConfig {
  maxAttempts: number;
  maxAccountSwitches: number;
  baseDelayMs: number;
  maxDelayMs: number;
  chatInProgressMaxSameChat: number;
  jitter: () => number;
}

export interface DecideInput {
  error: TypedRuntimeError;
  generation: Generation;
  attempt: GenerationAttempt;
  chatCorrupted: boolean;
  accountLevelFailure: boolean;
}

export interface FailureClassification {
  tier: RetryTier;
  terminal: boolean;
  reason: string;
}

/** The failure is the ACCOUNT, not the chat: an untried account must serve it. */
const ACCOUNT_LEVEL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "ACCOUNT_UNAVAILABLE",
  "ACCOUNT_COOLDOWN",
  "ACCOUNT_INITIALIZATION_FAILED",
]);

/** Safe transport failures: replay the same account+chat before escalating. */
const TRANSPORT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UPSTREAM_UNAVAILABLE",
  "QUEUE_TIMEOUT",
  "PERSISTENCE_FAILURE",
  "SERVICE_BUSY",
]);

/** Chat-state failures that settle with a bounded same-chat wait. */
const CHAT_SETTLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_CHAT_BUSY",
]);

export function defaultConfig(): RetryCoordinatorConfig {
  return {
    maxAttempts: config.retry.maxAttempts,
    maxAccountSwitches: config.retry.maxAccountSwitches,
    baseDelayMs: config.retry.baseDelayMs,
    maxDelayMs: config.retry.maxDelayMs,
    chatInProgressMaxSameChat: config.retry.chatInProgressMaxAttempts,
    jitter: Math.random,
  };
}

export class RetryCoordinator {
  constructor(private readonly config: RetryCoordinatorConfig) {}

  static defaultConfig(): RetryCoordinatorConfig {
    return defaultConfig();
  }

  /**
   * Pure classification the transport can call to report a failure WITHOUT
   * deciding a replay. Callers use this to log/metric the failure class; the
   * retry decision is always {@link decide}.
   */
  classifyFailure(error: TypedRuntimeError): FailureClassification {
    const code = error.code;
    if (isContextBudgetError(code)) {
      return { tier: 4, terminal: true, reason: `context_budget:${code}` };
    }
    if (code === "GENERATION_CANCELLED") {
      return { tier: 4, terminal: true, reason: "client_cancelled" };
    }
    if (code === "AUTHENTICATION_FAILED") {
      return { tier: 3, terminal: false, reason: "account_authentication" };
    }
    if (isTerminalGenerationError(code)) {
      return { tier: 4, terminal: true, reason: `terminal:${code}` };
    }
    if (ACCOUNT_LEVEL_CODES.has(code)) {
      return { tier: 3, terminal: false, reason: `account_level:${code}` };
    }
    if (code === "UPSTREAM_CHAT_CORRUPTED") {
      return { tier: 2, terminal: false, reason: "chat_corrupted" };
    }
    if (CHAT_SETTLE_CODES.has(code)) {
      return { tier: 1, terminal: false, reason: `chat_settle:${code}` };
    }
    if (TRANSPORT_CODES.has(code)) {
      return { tier: 1, terminal: false, reason: `transport:${code}` };
    }
    return { tier: 3, terminal: false, reason: `unknown:${code}` };
  }

  decide(input: DecideInput): RetryDecision {
    const { error, generation, attempt, chatCorrupted, accountLevelFailure } = input;
    const classification = this.classifyFailure(error);
    const remaining = this.remainingAttempts(attempt);

    // Client cancellation wins outright: never retry, never raise a failure.
    if (error.code === "GENERATION_CANCELLED") {
      return this.cancel(remaining);
    }

    // J.21: never infer "safe to retry" from an exception label. A replay after
    // irreversible side effects duplicates content the client already received
    // or re-executes real tool work.
    if (hasIrreversibleSideEffects(generation.sideEffects)) {
      return this.terminal(sideEffectReason(generation.sideEffects), remaining);
    }

    // Context-budget and terminal generation errors never enter the network
    // retry path: no replay can change the outcome.
    if (classification.terminal) {
      return this.terminal(classification.reason, remaining);
    }

    if (remaining <= 0) {
      return this.terminal("budget_exhausted:attempts", remaining);
    }

    const resolved = this.resolveTier(input, classification);

    // A switch demands an untried account; the generation's attemptedAccountIds
    // guard stops the caller from re-burning one. With no switch budget left the
    // escalation cannot proceed, so the generation fails over.
    if (resolved.tier === 3 && this.remainingSwitches(generation) <= 0) {
      return this.terminal("budget_exhausted:account_switches", remaining);
    }

    return {
      action: "RETRY",
      tier: resolved.tier,
      delayMs: this.backoff(attempt),
      switchAccount: resolved.tier >= 3,
      newChat: resolved.tier >= 2,
      reason: resolved.reason,
      remainingBudget: remaining,
    };
  }

  private resolveTier(
    input: DecideInput,
    classification: FailureClassification,
  ): { tier: RetryTier; reason: string } {
    const { error, attempt, chatCorrupted, accountLevelFailure } = input;
    const repeat = Math.max(0, attempt.attemptNumber - 1);

    if (accountLevelFailure || classification.tier === 3) {
      return {
        tier: 3,
        reason: accountLevelFailure ? "account_level_failure" : classification.reason,
      };
    }

    if (chatCorrupted || classification.tier === 2) {
      if (repeat >= 2) return { tier: 3, reason: "chat_corruption_repeated" };
      return { tier: 2, reason: chatCorrupted ? "chat_corrupted" : classification.reason };
    }

    // A timeout or busy chat settles with bounded same-chat retries: no new
    // chat, no account switch, no full-context replay and no browser recovery
    // until the settle bound is exhausted. Escalation happens only on repeat.
    if (CHAT_SETTLE_CODES.has(error.code) && repeat < this.config.chatInProgressMaxSameChat) {
      return { tier: 1, reason: classification.reason };
    }

    if (repeat >= 2) return { tier: 3, reason: "transport_failure_repeated" };
    if (repeat === 1) return { tier: 2, reason: "transport_failure_repeat" };
    return { tier: 1, reason: classification.reason };
  }

  private remainingAttempts(attempt: GenerationAttempt): number {
    return Math.max(0, this.config.maxAttempts - attempt.attemptNumber);
  }

  private remainingSwitches(generation: Generation): number {
    const used = Math.max(0, generation.attemptedAccountIds.length - 1);
    return Math.max(0, this.config.maxAccountSwitches - used);
  }

  private backoff(attempt: GenerationAttempt): number {
    const exponent = Math.max(0, attempt.attemptNumber - 1);
    const base = Math.min(this.config.maxDelayMs, this.config.baseDelayMs * 2 ** exponent);
    return Math.min(
      this.config.maxDelayMs,
      Math.round(base * (1 + this.config.jitter())),
    );
  }

  private terminal(reason: string, remainingBudget: number): RetryDecision {
    return {
      action: "FAIL_TERMINAL",
      tier: 4,
      delayMs: 0,
      switchAccount: false,
      newChat: false,
      reason,
      remainingBudget,
    };
  }

  private cancel(remainingBudget: number): RetryDecision {
    return {
      action: "CANCEL",
      tier: 4,
      delayMs: 0,
      switchAccount: false,
      newChat: false,
      reason: "client_cancelled",
      remainingBudget,
    };
  }
}

function sideEffectReason(sideEffects: SideEffectRecord): string {
  if (sideEffects.outputEmittedToClient) return "side_effect:output_emitted";
  if (sideEffects.toolCallsExecuted.length > 0) {
    return `side_effect:tool_calls_executed:${sideEffects.toolCallsExecuted.length}`;
  }
  return "side_effect:present";
}
