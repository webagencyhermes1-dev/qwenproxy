import type {
  IAccountOwnership,
  OwnershipFence,
  ReleaseOutcome,
} from "../contracts.ts";
import {
  TypedRuntimeError,
  type ErrorCode,
} from "../../domain/errors.ts";
import {
  canAcceptResult,
  isAttemptedAccount,
  nextAttempt,
  remainingDeadline,
  MAX_GENERATION_ATTEMPTS,
  type Generation,
  type GenerationAttempt,
} from "../../domain/generation.ts";
import { newGenerationId } from "../../domain/ids.ts";
import {
  isTerminalGenerationState,
  type GenerationState,
} from "../../domain/types.ts";
import type { GenerationRepository } from "../persistence/generation-repository.ts";
import type { EventRecorder } from "../observability/event-recorder.ts";
import { RetryCoordinator } from "../retry/retry-coordinator.ts";
import type {
  DecideInput,
  RetryDecision,
} from "../retry/retry-coordinator.ts";
import type {
  CreateStreamInput,
  ManagedStream,
  StreamSink,
} from "../stream/stream-manager.ts";

// StreamManager (stream-manager.ts) is a per-stream handle implementing
// ManagedStream, not a factory. The module-level createStream/getStream
// functions are the factory, so the coordinator depends on this structural
// factory instead of the concrete class. Wire it as
// `{ createStream, getStream }` from stream-manager.ts.
export interface GenerationStreamSource {
  createStream(input: CreateStreamInput): ManagedStream;
  getStream(streamId: string): ManagedStream | undefined;
}

export interface GenerationCoordinatorDeps {
  ownership: IAccountOwnership;
  retry: RetryCoordinator;
  generations: GenerationRepository;
  events: EventRecorder;
  streams: GenerationStreamSource;
  now?: () => number;
}

export interface CreateGenerationInput {
  tenantId: string;
  sessionId: string;
  turnId: string;
  sessionVersionAtStart: number;
  snapshotId: string | null;
  deadline: number;
  idempotencyKey?: string | null;
}

export interface StartAttemptInput {
  generation: Generation;
  accountId: string;
  modelId?: string;
}

export interface OwnershipProof {
  generationId: string;
  attemptId: string;
  expectedState: GenerationState;
}

export interface ToolCallInput extends OwnershipProof {
  callId: string;
}

export interface ToolResultInput extends OwnershipProof {
  callId: string;
  roundComplete: boolean;
}

export interface CompleteOutcome {
  status: "completed" | "failed";
  failureCode?: ErrorCode;
  failureReason?: string;
  chatCorrupted?: boolean;
  accountLevelFailure?: boolean;
}

export type CompleteResult =
  | { status: "completed" }
  | { status: "failed" }
  | { status: "retry"; retry: RetryDecision }
  | { status: "ignored" };

export type SettleResult = CompleteResult;

export interface CancelResult {
  cancelled: boolean;
}

interface TrackedRuntime {
  attempts: Map<string, GenerationAttempt>;
  fence: OwnershipFence | null;
  accountId: string | null;
  stream: ManagedStream | null;
}

const MAX_STREAM_BUFFER_BYTES = 1_048_576;

const voidSink: StreamSink = {
  write(): void {},
  close(): void {},
};

export class GenerationCoordinator {
  private readonly deps: GenerationCoordinatorDeps;
  private readonly clock: () => number;
  private readonly tracked = new Map<string, TrackedRuntime>();

  constructor(deps: GenerationCoordinatorDeps) {
    this.deps = deps;
    this.clock = deps.now ?? Date.now;
  }

  create(input: CreateGenerationInput): Generation {
    const generationId = newGenerationId();
    this.deps.generations.create({
      generationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sessionVersionAtStart: input.sessionVersionAtStart,
      deadline: input.deadline,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (input.snapshotId !== null) {
      this.deps.generations.setSnapshot(generationId, input.snapshotId);
    }
    this.deps.events.record(
      "GENERATION_CREATED",
      {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        generationId,
      },
      { sessionVersion: input.sessionVersionAtStart },
    );
    return this.require(generationId);
  }

  startAttempt(input: StartAttemptInput): GenerationAttempt {
    const started = this.require(input.generation.generationId);
    if (isTerminalGenerationState(started.state)) {
      throw new TypedRuntimeError(
        started.state === "CANCELLED"
          ? "GENERATION_CANCELLED"
          : "GENERATION_TIMEOUT",
        `generation ${started.generationId} already terminal (${started.state})`,
        { generationId: started.generationId },
      );
    }
    if (isAttemptedAccount(started, input.accountId)) {
      throw new TypedRuntimeError(
        "ACCOUNT_UNAVAILABLE",
        `account ${input.accountId} already attempted for generation ${started.generationId}`,
        { generationId: started.generationId, accountId: input.accountId },
      );
    }
    const opened = nextAttempt(started, input.accountId);
    if (opened === null) {
      throw new TypedRuntimeError(
        "GENERATION_TIMEOUT",
        `retry budget exhausted for generation ${started.generationId}`,
        {
          generationId: started.generationId,
          maxAttempts: MAX_GENERATION_ATTEMPTS,
        },
      );
    }
    const acquired = this.deps.ownership.acquire({
      generationId: started.generationId,
      candidates: [input.accountId],
      deadline: started.deadline,
      requirements: {
        purpose: "generation",
        modelId: input.modelId,
        generationId: started.generationId,
      },
    });
    if (!acquired.ok) {
      throw new TypedRuntimeError(
        acquired.errorCode,
        `lease acquisition failed (${acquired.failureCode}) for account ${input.accountId}`,
        { generationId: started.generationId, accountId: input.accountId },
      );
    }

    const now = this.clock();
    this.releaseTracked(started.generationId, "failed", "attempt superseded");
    const attempt: GenerationAttempt = {
      ...opened.attempt,
      startedAt: now,
      upstreamStartedAt: now,
    };
    this.deps.generations.appendAttempt(started.generationId, attempt);
    this.deps.generations.addAttemptedAccount(
      started.generationId,
      input.accountId,
    );
    this.deps.generations.setLease(
      started.generationId,
      acquired.lease.leaseId,
    );
    const runtime = this.runtimeFor(started.generationId);
    runtime.attempts.set(attempt.attemptId, attempt);
    runtime.fence = {
      leaseId: acquired.lease.leaseId,
      ownerToken: acquired.lease.ownerToken,
    };
    runtime.accountId = input.accountId;

    let current = this.require(started.generationId);
    if (current.state !== "RESERVING") {
      current = this.casStep(current, "RESERVING");
      this.deps.events.record(
        "GENERATION_RESERVED",
        {
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          generationId: current.generationId,
          attemptId: attempt.attemptId,
          accountId: input.accountId,
          leaseId: acquired.lease.leaseId,
        },
        { attemptNumber: attempt.attemptNumber },
      );
    }
    current = this.casStep(current, "PREPARING");
    current = this.casStep(current, "STARTING");
    current = this.casStep(current, "STREAMING");
    this.deps.events.record(
      "GENERATION_STARTED",
      {
        tenantId: current.tenantId,
        sessionId: current.sessionId,
        generationId: current.generationId,
        attemptId: attempt.attemptId,
        accountId: input.accountId,
        leaseId: acquired.lease.leaseId,
      },
      { attemptNumber: attempt.attemptNumber },
    );
    this.ensureStream(current, input.accountId);
    return attempt;
  }

  recordFirstToken(proof: OwnershipProof): boolean {
    const current = this.deps.generations.getById(proof.generationId);
    if (
      current === null ||
      !canAcceptResult(current, proof.attemptId, proof.expectedState)
    ) {
      return false;
    }
    const attempt = this.attemptFor(current, proof.attemptId);
    const now = this.clock();
    attempt.firstTokenAt = now;
    this.deps.generations.recordSideEffects(proof.generationId, {
      outputEmittedToClient: true,
      lastUpdatedAt: now,
    });
    this.deps.events.record(
      "GENERATION_FIRST_TOKEN",
      {
        tenantId: current.tenantId,
        sessionId: current.sessionId,
        generationId: current.generationId,
        attemptId: proof.attemptId,
        accountId: attempt.accountId,
      },
      { attemptNumber: attempt.attemptNumber },
    );
    return true;
  }

  recordToolCall(input: ToolCallInput): boolean {
    const current = this.deps.generations.getById(input.generationId);
    if (current === null || isTerminalGenerationState(current.state)) {
      return false;
    }
    if (
      current.attemptIds[current.attemptIds.length - 1] !== input.attemptId
    ) {
      return false;
    }
    if (
      current.state !== "STREAMING" &&
      current.state !== "WAITING_FOR_TOOL_RESULTS"
    ) {
      return false;
    }
    if (current.state === "STREAMING") {
      const moved = this.deps.generations.updateState(
        { generationId: input.generationId, to: "WAITING_FOR_TOOL_RESULTS" },
        { expectedState: "STREAMING" },
      );
      if (!moved.updated) return false;
      this.deps.events.record(
        "GENERATION_WAITING_FOR_TOOL",
        {
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          generationId: current.generationId,
          attemptId: input.attemptId,
        },
        { callId: input.callId },
      );
    }
    this.deps.generations.recordSideEffects(input.generationId, {
      toolCallsExecuted: [input.callId],
      lastUpdatedAt: this.clock(),
    });
    this.deps.events.record(
      "GENERATION_TOOL_CALL",
      {
        tenantId: current.tenantId,
        sessionId: current.sessionId,
        generationId: current.generationId,
        attemptId: input.attemptId,
      },
      { callId: input.callId },
    );
    return true;
  }

  recordToolResult(input: ToolResultInput): boolean {
    const current = this.deps.generations.getById(input.generationId);
    if (current === null || isTerminalGenerationState(current.state)) {
      return false;
    }
    if (
      current.attemptIds[current.attemptIds.length - 1] !== input.attemptId
    ) {
      return false;
    }
    if (current.state !== "WAITING_FOR_TOOL_RESULTS") {
      return false;
    }
    this.deps.events.record(
      "GENERATION_TOOL_RESULT",
      {
        tenantId: current.tenantId,
        sessionId: current.sessionId,
        generationId: current.generationId,
        attemptId: input.attemptId,
      },
      { callId: input.callId, roundComplete: input.roundComplete },
    );
    if (input.roundComplete) {
      const moved = this.deps.generations.updateState(
        { generationId: input.generationId, to: "STARTING" },
        { expectedState: "WAITING_FOR_TOOL_RESULTS" },
      );
      if (!moved.updated) return false;
    }
    return true;
  }

  complete(proof: OwnershipProof, outcome: CompleteOutcome): CompleteResult {
    const current = this.deps.generations.getById(proof.generationId);
    if (
      current === null ||
      !canAcceptResult(current, proof.attemptId, proof.expectedState)
    ) {
      return { status: "ignored" };
    }
    const attempt = this.attemptFor(current, proof.attemptId);
    const now = this.clock();
    if (outcome.status === "completed") {
      const won = this.deps.generations.updateState(
        {
          generationId: proof.generationId,
          to: "COMPLETED",
          terminalAt: now,
        },
        { expectedState: proof.expectedState },
      );
      if (!won.updated) return { status: "ignored" };
      attempt.state = "COMPLETED";
      attempt.completedAt = now;
      this.releaseTracked(proof.generationId, "completed", "generation completed");
      this.closeStreamFor(proof.generationId, "completed");
      this.deps.events.record(
        "GENERATION_COMPLETED",
        {
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          generationId: current.generationId,
          attemptId: proof.attemptId,
          accountId: attempt.accountId,
        },
        { attemptNumber: attempt.attemptNumber },
      );
      return { status: "completed" };
    }
    const error = new TypedRuntimeError(
      outcome.failureCode ?? "INTERNAL_ERROR",
      outcome.failureReason ?? (outcome.failureCode ?? "generation failed"),
      { generationId: proof.generationId, attemptId: proof.attemptId },
    );
    attempt.state = "FAILED";
    attempt.completedAt = now;
    attempt.failureCode = error.code;
    attempt.failureReason = error.message;
    return this.resolveFailure(current, attempt, error, proof.expectedState, {
      chatCorrupted: outcome.chatCorrupted ?? false,
      accountLevelFailure: outcome.accountLevelFailure ?? false,
    });
  }

  settle(proof: OwnershipProof, settled: boolean): SettleResult {
    const current = this.deps.generations.getById(proof.generationId);
    if (
      current === null ||
      !canAcceptResult(current, proof.attemptId, proof.expectedState)
    ) {
      return { status: "ignored" };
    }
    const entered = this.deps.generations.updateState(
      { generationId: proof.generationId, to: "SETTLING" },
      { expectedState: proof.expectedState },
    );
    if (!entered.updated) return { status: "ignored" };
    const attempt = this.attemptFor(current, proof.attemptId);
    const now = this.clock();
    if (settled) {
      const done = this.deps.generations.updateState(
        {
          generationId: proof.generationId,
          to: "COMPLETED",
          terminalAt: now,
        },
        { expectedState: "SETTLING" },
      );
      if (!done.updated) return { status: "ignored" };
      attempt.state = "COMPLETED";
      attempt.completedAt = now;
      this.releaseTracked(proof.generationId, "completed", "generation settled");
      this.closeStreamFor(proof.generationId, "completed");
      this.deps.events.record(
        "GENERATION_COMPLETED",
        {
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          generationId: current.generationId,
          attemptId: proof.attemptId,
          accountId: attempt.accountId,
        },
        { attemptNumber: attempt.attemptNumber },
      );
      return { status: "completed" };
    }
    const error = new TypedRuntimeError(
      "UPSTREAM_TIMEOUT",
      `generation ${proof.generationId} never settled`,
      { generationId: proof.generationId, attemptId: proof.attemptId },
    );
    attempt.state = "FAILED";
    attempt.completedAt = now;
    attempt.failureCode = error.code;
    attempt.failureReason = error.message;
    return this.resolveFailure(current, attempt, error, "SETTLING", {
      chatCorrupted: false,
      accountLevelFailure: false,
    });
  }

  cancel(generationId: string, reason?: string): CancelResult {
    const existing = this.deps.generations.getById(generationId);
    if (existing === null) {
      throw new TypedRuntimeError(
        "INTERNAL_ERROR",
        `unknown generation ${generationId}`,
        { generationId },
      );
    }
    for (let i = 0; i < 3; i += 1) {
      const current = this.deps.generations.getById(generationId);
      if (current === null || isTerminalGenerationState(current.state)) {
        return { cancelled: false };
      }
      const won = this.deps.generations.updateState(
        {
          generationId,
          to: "CANCELLED",
          terminalAt: this.clock(),
          failureCode: "GENERATION_CANCELLED",
          failureReason: reason ?? "cancelled",
        },
        { expectedState: current.state },
      );
      if (won.updated) {
        const runtime = this.tracked.get(generationId);
        if (runtime !== undefined) {
          for (const attempt of runtime.attempts.values()) {
            if (
              attempt.state === "STARTING" ||
              attempt.state === "STREAMING"
            ) {
              attempt.state = "CANCELLED";
              attempt.completedAt = this.clock();
            }
          }
        }
        this.releaseTracked(generationId, "cancelled", reason ?? "cancelled");
        this.closeStreamFor(generationId, "cancelled");
        this.deps.events.record(
          "GENERATION_CANCELLED",
          {
            tenantId: current.tenantId,
            sessionId: current.sessionId,
            generationId,
          },
          { reason: reason ?? "cancelled" },
        );
        return { cancelled: true };
      }
    }
    const final = this.deps.generations.getById(generationId);
    if (final !== null && isTerminalGenerationState(final.state)) {
      return { cancelled: false };
    }
    throw new TypedRuntimeError(
      "INTERNAL_ERROR",
      `cancel lost its fence for generation ${generationId}`,
      { generationId },
    );
  }

  remainingMs(generationId: string): number {
    return remainingDeadline(this.require(generationId), this.clock());
  }

  private resolveFailure(
    current: Generation,
    attempt: GenerationAttempt,
    error: TypedRuntimeError,
    fence: GenerationState,
    flags: { chatCorrupted: boolean; accountLevelFailure: boolean },
  ): CompleteResult {
    const fresh = this.require(current.generationId);
    const decideInput: DecideInput = {
      error,
      generation: fresh,
      attempt: { ...attempt },
      chatCorrupted: flags.chatCorrupted,
      accountLevelFailure: flags.accountLevelFailure,
    };
    const decision = this.deps.retry.decide(decideInput);
    const now = this.clock();
    if (decision.action === "RETRY") {
      const back = this.deps.generations.updateState(
        { generationId: current.generationId, to: "RESERVING" },
        { expectedState: fence },
      );
      if (!back.updated) return { status: "ignored" };
      this.releaseTracked(current.generationId, "failed", decision.reason);
      this.deps.events.record(
        "GENERATION_FAILOVER",
        {
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          generationId: current.generationId,
          attemptId: attempt.attemptId,
          accountId: attempt.accountId,
        },
        {
          reason: decision.reason,
          tier: decision.tier,
          attemptNumber: attempt.attemptNumber,
        },
      );
      return { status: "retry", retry: decision };
    }
    const terminal: GenerationState =
      decision.action === "CANCEL" ? "CANCELLED" : "FAILED";
    const done = this.deps.generations.updateState(
      {
        generationId: current.generationId,
        to: terminal,
        terminalAt: now,
        failureCode: error.code,
        failureReason: error.message,
      },
      { expectedState: fence },
    );
    if (!done.updated) return { status: "ignored" };
    const terminalOutcome: ReleaseOutcome =
      decision.action === "CANCEL" ? "cancelled" : "failed";
    this.releaseTracked(current.generationId, terminalOutcome, decision.reason);
    this.closeStreamFor(
      current.generationId,
      decision.action === "CANCEL" ? "cancelled" : "failed",
    );
    this.deps.events.record(
      terminal === "CANCELLED" ? "GENERATION_CANCELLED" : "GENERATION_FAILED",
      {
        tenantId: current.tenantId,
        sessionId: current.sessionId,
        generationId: current.generationId,
        attemptId: attempt.attemptId,
        accountId: attempt.accountId,
      },
      {
        errorName: error.code,
        reason: decision.reason,
        attemptNumber: attempt.attemptNumber,
      },
    );
    return { status: "failed" };
  }

  private casStep(current: Generation, to: GenerationState): Generation {
    const result = this.deps.generations.updateState(
      { generationId: current.generationId, to },
      { expectedState: current.state },
    );
    if (!result.updated) {
      const actual = this.deps.generations.getById(current.generationId);
      throw new TypedRuntimeError(
        actual?.state === "CANCELLED"
          ? "GENERATION_CANCELLED"
          : "INTERNAL_ERROR",
        `fenced transition ${current.state}->${to} lost for generation ${current.generationId}`,
        { generationId: current.generationId, from: current.state, to },
      );
    }
    return this.require(current.generationId);
  }

  private ensureStream(
    current: Generation,
    accountId: string,
  ): ManagedStream {
    const runtime = this.runtimeFor(current.generationId);
    const existing =
      this.deps.streams.getStream(current.generationId) ?? runtime.stream;
    if (existing !== undefined && existing !== null && !existing.closed) {
      runtime.stream = existing;
      return existing;
    }
    const remaining = Math.max(
      1,
      remainingDeadline(current, this.clock()),
    );
    const stream = this.deps.streams.createStream({
      streamId: current.generationId,
      generationId: current.generationId,
      accountId,
      totalDeadline: current.deadline,
      firstTokenDeadlineMs: remaining,
      idleTimeoutMs: remaining,
      maxBufferBytes: MAX_STREAM_BUFFER_BYTES,
      sink: voidSink,
    });
    runtime.stream = stream;
    return stream;
  }

  private closeStreamFor(
    generationId: string,
    reason: "completed" | "cancelled" | "failed",
  ): void {
    const runtime = this.tracked.get(generationId);
    const handle =
      runtime?.stream ?? this.deps.streams.getStream(generationId);
    if (handle === undefined || handle === null || handle.closed) return;
    if (reason === "cancelled") {
      void handle.cancel();
    } else {
      void handle.close(reason);
    }
  }

  private releaseTracked(
    generationId: string,
    outcome: ReleaseOutcome,
    reason: string,
  ): void {
    const runtime = this.tracked.get(generationId);
    if (runtime?.fence === null || runtime?.fence === undefined) return;
    this.deps.ownership.release({
      leaseId: runtime.fence.leaseId,
      ownerToken: runtime.fence.ownerToken,
      outcome,
      reason,
    });
    runtime.fence = null;
  }

  private attemptFor(
    current: Generation,
    attemptId: string,
  ): GenerationAttempt {
    const runtime = this.runtimeFor(current.generationId);
    const known = runtime.attempts.get(attemptId);
    if (known !== undefined) return known;
    const synthesized: GenerationAttempt = {
      attemptId,
      generationId: current.generationId,
      attemptNumber: current.attemptIds.length,
      accountId: runtime.accountId ?? "",
      state: "STREAMING",
      startedAt: null,
      upstreamStartedAt: null,
      firstTokenAt: null,
      completedAt: null,
      failureCode: null,
      failureReason: null,
    };
    runtime.attempts.set(attemptId, synthesized);
    return synthesized;
  }

  private runtimeFor(generationId: string): TrackedRuntime {
    let runtime = this.tracked.get(generationId);
    if (runtime === undefined) {
      runtime = {
        attempts: new Map<string, GenerationAttempt>(),
        fence: null,
        accountId: null,
        stream: null,
      };
      this.tracked.set(generationId, runtime);
    }
    return runtime;
  }

  private require(generationId: string): Generation {
    const found = this.deps.generations.getById(generationId);
    if (found === null) {
      throw new TypedRuntimeError(
        "INTERNAL_ERROR",
        `unknown generation ${generationId}`,
        { generationId },
      );
    }
    return found;
  }
}
