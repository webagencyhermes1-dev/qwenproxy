import Database from "better-sqlite3";
import assert from "node:assert";
import test from "node:test";

import type { RuntimeEvent } from "../../domain/events.ts";
import { TypedRuntimeError } from "../../domain/errors.ts";
import type {
  Generation,
  GenerationAttempt,
} from "../../domain/generation.ts";
import type {
  AccountLease,
  AccountStatus,
} from "../../domain/types.ts";
import type {
  AcquireLeaseRequest,
  AcquireLeaseResult,
  EligibilityDecision,
  IAccountOwnership,
  OwnershipFence,
  OwnershipSnapshot,
  PersistedAccountState,
  PoolSnapshot,
  ReleaseRequest,
  ReleaseResult,
  StaleFenceOptions,
  StaleFenceResult,
  TransitionResult,
  UsageRequirements,
} from "../contracts.ts";
import { GenerationRepository } from "../persistence/generation-repository.ts";
import { NEW_TABLE_DDL } from "../persistence/schema.ts";
import {
  RetryCoordinator,
  type RetryCoordinatorConfig,
} from "../retry/retry-coordinator.ts";
import {
  EventRecorder,
  type EventSink,
} from "../observability/event-recorder.ts";
import type {
  CloseReason,
  CreateStreamInput,
  DeadlineCascade,
  ManagedStream,
} from "../stream/stream-manager.ts";
import {
  GenerationCoordinator,
  type GenerationStreamSource,
} from "./generation-coordinator.ts";

class FakeOwnership implements IAccountOwnership {
  readonly leases = new Map<string, AccountLease>();
  readonly releases: Array<{ leaseId: string; outcome: string }> = [];

  acquire(request: AcquireLeaseRequest): AcquireLeaseResult {
    const accountId = request.candidates[0];
    if (accountId === undefined) {
      return {
        ok: false,
        failureCode: "NO_CANDIDATES",
        errorCode: "ACCOUNT_UNAVAILABLE",
        rejections: [],
      };
    }
    if (this.leases.has(accountId)) {
      return {
        ok: false,
        failureCode: "ALL_BUSY",
        errorCode: "ACCOUNT_COOLDOWN",
        rejections: [{ accountId, reason: "busy" }],
      };
    }
    const lease: AccountLease = {
      leaseId: `lease_${request.generationId}_${accountId}`,
      ownerToken: `own_${request.generationId}_${accountId}`,
      accountId,
      generationId: request.generationId,
      acquiredAt: 1_000,
      deadline: request.deadline,
    };
    this.leases.set(accountId, lease);
    return { ok: true, lease, accountId, rejections: [] };
  }

  release(request: ReleaseRequest): ReleaseResult {
    for (const [accountId, lease] of this.leases) {
      if (lease.leaseId === request.leaseId) {
        if (lease.ownerToken !== request.ownerToken) {
          return { released: false, stale: true };
        }
        this.leases.delete(accountId);
        this.releases.push({
          leaseId: request.leaseId,
          outcome: request.outcome,
        });
        return { released: true, stale: false };
      }
    }
    return { released: false, stale: true };
  }

  transition(
    _accountId: string,
    to: AccountStatus,
    _fence: OwnershipFence,
    _reason?: string,
  ): TransitionResult {
    return {
      transitioned: true,
      from: "READY",
      to,
      stale: false,
      illegal: false,
    };
  }

  async markStaleAndFence(
    accountId: string,
    _options: StaleFenceOptions,
  ): Promise<StaleFenceResult> {
    return {
      accountId,
      fenced: false,
      invalidatedOwnerToken: null,
      cleanExit: true,
    };
  }

  isLegallyUsable(
    _accountId: string,
    _requirements: UsageRequirements,
  ): EligibilityDecision {
    return { usable: true };
  }

  getOwnership(accountId: string): OwnershipSnapshot {
    const lease = this.leases.get(accountId) ?? null;
    return {
      accountId,
      status: lease === null ? "READY" : "GENERATING",
      lease,
      fencingEpoch: 1,
      cooldownUntil: null,
      lastTransitionReason: null,
    };
  }

  getAccountStatus(accountId: string): AccountStatus {
    return this.leases.has(accountId) ? "GENERATING" : "READY";
  }

  listAccountsByStatus(_status: AccountStatus): readonly string[] {
    return [];
  }

  getPoolSnapshot(): PoolSnapshot {
    return {
      byStatus: {},
      ready: 0,
      warming: 0,
      reserved: 0,
      generating: 0,
      cooldown: 0,
      failed: 0,
      target: 0,
    };
  }

  registerAccount(
    _accountId: string,
    _persisted: PersistedAccountState,
  ): void {}

  setDraining(_accountId: string, _draining: boolean): void {}

  async recoverAccount(_accountId: string, _reason: string): Promise<void> {}
}

class FakeStream implements ManagedStream {
  readonly generationId: string | null;
  readonly accountId: string | null;
  readonly signal: AbortSignal = new AbortController().signal;
  closed = false;
  closedAt: number | null = null;
  terminalReason: CloseReason | null = null;
  terminal: Promise<void> | null = null;
  bufferedBytes = 0;
  highWaterBytes = 0;
  pushedBytes = 0;
  pushCount = 0;
  readonly pushed: string[] = [];

  constructor(
    readonly streamId: string,
    generationId?: string,
    accountId?: string,
  ) {
    this.generationId = generationId ?? null;
    this.accountId = accountId ?? null;
  }

  get hasEmitted(): boolean {
    return this.pushed.length > 0;
  }

  async push(chunk: string): Promise<void> {
    if (this.closed) throw new Error(`stream ${this.streamId} closed`);
    this.pushed.push(chunk);
    this.pushedBytes += chunk.length;
    this.pushCount += 1;
  }

  async close(reason: CloseReason = "completed"): Promise<void> {
    this.closed = true;
    this.closedAt = 1_000;
    this.terminalReason = reason;
  }

  async cancel(): Promise<void> {
    this.closed = true;
    this.closedAt = 1_000;
    this.terminalReason = "cancelled";
  }

  remainingMs(): number {
    return 1_000;
  }

  deadlines(): DeadlineCascade {
    return { queue: 0, firstToken: 0, idle: 0, total: 0 };
  }

  startHeartbeat(
    _intervalMs: number,
    _sendFn: () => void | Promise<void>,
  ): void {}

  stopHeartbeat(): void {}
}

class FakeStreams implements GenerationStreamSource {
  readonly created: FakeStream[] = [];
  private readonly byId = new Map<string, FakeStream>();

  createStream(input: CreateStreamInput): ManagedStream {
    const stream = new FakeStream(
      input.streamId,
      input.generationId,
      input.accountId,
    );
    this.created.push(stream);
    this.byId.set(input.streamId, stream);
    return stream;
  }

  getStream(streamId: string): ManagedStream | undefined {
    return this.byId.get(streamId);
  }

  latest(): FakeStream {
    const stream = this.created[this.created.length - 1];
    if (stream === undefined) throw new Error("no stream created");
    return stream;
  }
}

interface Harness {
  db: Database.Database;
  repo: GenerationRepository;
  ownership: FakeOwnership;
  seen: RuntimeEvent[];
  streams: FakeStreams;
  coordinator: GenerationCoordinator;
  setNow: (value: number) => void;
}

const RETRY_TEST_CONFIG: RetryCoordinatorConfig = {
  maxAttempts: 4,
  maxAccountSwitches: 2,
  baseDelayMs: 10,
  maxDelayMs: 100,
  chatInProgressMaxSameChat: 2,
  jitter: () => 0,
};

function setup(): Harness {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const ddl of NEW_TABLE_DDL) db.exec(ddl);
  const repo = new GenerationRepository(db);
  const ownership = new FakeOwnership();
  const seen: RuntimeEvent[] = [];
  const sink: EventSink = {
    record(event: RuntimeEvent): void {
      seen.push(event);
    },
  };
  const recorder = new EventRecorder(sink);
  const streams = new FakeStreams();
  const retry = new RetryCoordinator(RETRY_TEST_CONFIG);
  let now = 1_000;
  const coordinator = new GenerationCoordinator({
    ownership,
    retry,
    generations: repo,
    events: recorder,
    streams,
    now: () => now,
  });
  return {
    db,
    repo,
    ownership,
    seen,
    streams,
    coordinator,
    setNow: (value: number): void => {
      now = value;
    },
  };
}

function eventNames(seen: RuntimeEvent[]): string[] {
  return seen.map((event) => event.name);
}

function createGeneration(h: Harness): Generation {
  return h.coordinator.create({
    tenantId: "tenant_a",
    sessionId: "sess_1",
    turnId: "turn_1",
    sessionVersionAtStart: 3,
    snapshotId: "snap_1",
    deadline: 60_000,
    idempotencyKey: "key_1",
  });
}

function startFirstAttempt(h: Harness, generation: Generation): GenerationAttempt {
  return h.coordinator.startAttempt({
    generation,
    accountId: "acc_1",
    modelId: "qwen-max",
  });
}

test("create persists a QUEUED generation and emits GENERATION_CREATED", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);

  assert.strictEqual(generation.state, "QUEUED");
  assert.deepStrictEqual([...generation.attemptIds], []);
  assert.deepStrictEqual([...generation.attemptedAccountIds], []);
  assert.deepStrictEqual(generation.sideEffects, {
    outputEmittedToClient: false,
    toolCallsExecuted: [],
    lastUpdatedAt: 0,
  });

  const persisted = h.repo.getById(generation.generationId);
  assert.notStrictEqual(persisted, null);
  assert.strictEqual(persisted!.state, "QUEUED");
  assert.strictEqual(persisted!.snapshotId, "snap_1");
  assert.strictEqual(persisted!.idempotencyKey, "key_1");

  const created = h.seen.filter(
    (event) => event.name === "GENERATION_CREATED",
  );
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0]!.generationId, generation.generationId);
});

test("startAttempt acquires the lease and walks to STREAMING; attempt 2 reuses the generation", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  const first = startFirstAttempt(h, generation);

  assert.strictEqual(first.attemptNumber, 1);
  assert.strictEqual(first.generationId, generation.generationId);
  assert.strictEqual(first.accountId, "acc_1");

  const held = h.ownership.leases.get("acc_1");
  assert.notStrictEqual(held, undefined);
  assert.strictEqual(held!.generationId, generation.generationId);

  let current = h.repo.getById(generation.generationId);
  assert.notStrictEqual(current, null);
  assert.strictEqual(current!.state, "STREAMING");
  assert.strictEqual(current!.leaseId, held!.leaseId);
  assert.deepStrictEqual([...current!.attemptIds], [first.attemptId]);
  assert.deepStrictEqual([...current!.attemptedAccountIds], ["acc_1"]);

  const second = h.coordinator.startAttempt({
    generation: current!,
    accountId: "acc_2",
  });
  assert.strictEqual(second.attemptNumber, 2);
  assert.strictEqual(second.generationId, generation.generationId);

  current = h.repo.getById(generation.generationId);
  assert.deepStrictEqual([...current!.attemptIds], [
    first.attemptId,
    second.attemptId,
  ]);
  assert.deepStrictEqual([...current!.attemptedAccountIds], [
    "acc_1",
    "acc_2",
  ]);
  assert.strictEqual(current!.state, "STREAMING");

  const names = eventNames(h.seen);
  assert.ok(names.includes("GENERATION_RESERVED"));
  assert.ok(names.includes("GENERATION_STARTED"));
  assert.strictEqual(h.streams.created.length, 1);
});

test("a late complete for a superseded attempt is ignored", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  const first = startFirstAttempt(h, generation);
  const failed = h.coordinator.complete(
    {
      generationId: generation.generationId,
      attemptId: first.attemptId,
      expectedState: "STREAMING",
    },
    {
      status: "failed",
      failureCode: "UPSTREAM_TIMEOUT",
      failureReason: "boom",
    },
  );
  assert.strictEqual(failed.status, "retry");

  const mid = h.repo.getById(generation.generationId);
  const second = h.coordinator.startAttempt({
    generation: mid!,
    accountId: "acc_2",
  });
  const done = h.coordinator.complete(
    {
      generationId: generation.generationId,
      attemptId: second.attemptId,
      expectedState: "STREAMING",
    },
    { status: "completed" },
  );
  assert.strictEqual(done.status, "completed");

  const late = h.coordinator.complete(
    {
      generationId: generation.generationId,
      attemptId: first.attemptId,
      expectedState: "STREAMING",
    },
    { status: "completed" },
  );
  assert.strictEqual(late.status, "ignored");
  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "COMPLETED",
  );
});

test("success racing timeout yields exactly one terminal outcome", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  const first = startFirstAttempt(h, generation);
  const proof = {
    generationId: generation.generationId,
    attemptId: first.attemptId,
    expectedState: "STREAMING" as const,
  };

  assert.strictEqual(
    h.coordinator.complete(proof, { status: "completed" }).status,
    "completed",
  );
  assert.strictEqual(
    h.coordinator.complete(proof, {
      status: "failed",
      failureCode: "UPSTREAM_TIMEOUT",
      failureReason: "late timeout",
    }).status,
    "ignored",
  );

  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "COMPLETED",
  );
  const names = eventNames(h.seen);
  assert.strictEqual(
    names.filter((name) => name === "GENERATION_COMPLETED").length,
    1,
  );
  assert.ok(!names.includes("GENERATION_FAILED"));
});

test("retryable failure returns a tier-1 retry; emitted output forces terminal failure", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  const first = startFirstAttempt(h, generation);
  const retried = h.coordinator.complete(
    {
      generationId: generation.generationId,
      attemptId: first.attemptId,
      expectedState: "STREAMING",
    },
    {
      status: "failed",
      failureCode: "UPSTREAM_TIMEOUT",
      failureReason: "slow upstream",
    },
  );
  assert.strictEqual(retried.status, "retry");
  if (retried.status !== "retry") assert.fail("expected a retry decision");
  assert.strictEqual(retried.retry.action, "RETRY");
  assert.strictEqual(retried.retry.tier, 1);
  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "RESERVING",
  );

  const h2 = setup();
  t.after(() => h2.db.close());
  const gen2 = createGeneration(h2);
  const att2 = startFirstAttempt(h2, gen2);
  assert.strictEqual(
    h2.coordinator.recordFirstToken({
      generationId: gen2.generationId,
      attemptId: att2.attemptId,
      expectedState: "STREAMING",
    }),
    true,
  );
  const terminal = h2.coordinator.complete(
    {
      generationId: gen2.generationId,
      attemptId: att2.attemptId,
      expectedState: "STREAMING",
    },
    {
      status: "failed",
      failureCode: "UPSTREAM_TIMEOUT",
      failureReason: "slow upstream",
    },
  );
  assert.strictEqual(terminal.status, "failed");
  assert.strictEqual(
    h2.repo.getById(gen2.generationId)!.state,
    "FAILED",
  );
  assert.ok(eventNames(h2.seen).includes("GENERATION_FAILED"));
});

test("cancel is idempotent and a no-op after complete", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  startFirstAttempt(h, generation);

  assert.deepStrictEqual(h.coordinator.cancel(generation.generationId, "user"), {
    cancelled: true,
  });
  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "CANCELLED",
  );
  assert.strictEqual(h.ownership.leases.size, 0);
  assert.strictEqual(h.streams.latest().closed, true);
  assert.strictEqual(h.streams.latest().terminalReason, "cancelled");

  assert.deepStrictEqual(h.coordinator.cancel(generation.generationId), {
    cancelled: false,
  });
  assert.strictEqual(
    eventNames(h.seen).filter((name) => name === "GENERATION_CANCELLED")
      .length,
    1,
  );

  const gen2 = h.coordinator.create({
    tenantId: "tenant_a",
    sessionId: "sess_1",
    turnId: "turn_2",
    sessionVersionAtStart: 3,
    snapshotId: null,
    deadline: 60_000,
  });
  const att = startFirstAttempt(h, gen2);
  assert.strictEqual(
    h.coordinator.complete(
      {
        generationId: gen2.generationId,
        attemptId: att.attemptId,
        expectedState: "STREAMING",
      },
      { status: "completed" },
    ).status,
    "completed",
  );
  assert.deepStrictEqual(h.coordinator.cancel(gen2.generationId), {
    cancelled: false,
  });
  assert.strictEqual(
    h.repo.getById(gen2.generationId)!.state,
    "COMPLETED",
  );
});

test("reusing an attempted account is rejected", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  startFirstAttempt(h, generation);
  const current = h.repo.getById(generation.generationId)!;

  assert.throws(
    () =>
      h.coordinator.startAttempt({
        generation: current,
        accountId: "acc_1",
      }),
    (error: unknown) =>
      error instanceof TypedRuntimeError &&
      error.code === "ACCOUNT_UNAVAILABLE",
  );
});

test("remainingMs follows the root deadline", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  assert.strictEqual(h.coordinator.remainingMs(generation.generationId), 59_000);

  h.setNow(70_000);
  assert.strictEqual(h.coordinator.remainingMs(generation.generationId), 0);
});

test("settle completes a settled upstream and retries an unsettled one", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  const first = startFirstAttempt(h, generation);
  assert.deepStrictEqual(
    h.coordinator.settle(
      {
        generationId: generation.generationId,
        attemptId: first.attemptId,
        expectedState: "STREAMING",
      },
      true,
    ),
    { status: "completed" },
  );
  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "COMPLETED",
  );

  const h2 = setup();
  t.after(() => h2.db.close());
  const gen2 = createGeneration(h2);
  const att2 = startFirstAttempt(h2, gen2);
  const retried = h2.coordinator.settle(
    {
      generationId: gen2.generationId,
      attemptId: att2.attemptId,
      expectedState: "STREAMING",
    },
    false,
  );
  assert.strictEqual(retried.status, "retry");
  if (retried.status !== "retry") assert.fail("expected a retry decision");
  assert.strictEqual(retried.retry.action, "RETRY");
  assert.strictEqual(
    h2.repo.getById(gen2.generationId)!.state,
    "RESERVING",
  );
});

test("tool-call round trips through WAITING and back; stale callbacks are ignored", (t) => {
  const h = setup();
  t.after(() => h.db.close());

  const generation = createGeneration(h);
  const first = startFirstAttempt(h, generation);

  assert.strictEqual(
    h.coordinator.recordToolCall({
      generationId: generation.generationId,
      attemptId: first.attemptId,
      expectedState: "STREAMING",
      callId: "tc_1",
    }),
    true,
  );
  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "WAITING_FOR_TOOL_RESULTS",
  );

  assert.strictEqual(
    h.coordinator.recordToolResult({
      generationId: generation.generationId,
      attemptId: first.attemptId,
      expectedState: "WAITING_FOR_TOOL_RESULTS",
      callId: "tc_1",
      roundComplete: true,
    }),
    true,
  );
  assert.strictEqual(
    h.repo.getById(generation.generationId)!.state,
    "STARTING",
  );

  const names = eventNames(h.seen);
  assert.ok(names.includes("GENERATION_TOOL_CALL"));
  assert.ok(names.includes("GENERATION_TOOL_RESULT"));
  assert.ok(names.includes("GENERATION_WAITING_FOR_TOOL"));

  assert.strictEqual(
    h.coordinator.recordToolCall({
      generationId: generation.generationId,
      attemptId: "att_stale",
      expectedState: "STARTING",
      callId: "tc_2",
    }),
    false,
  );
  assert.strictEqual(
    h.coordinator.recordFirstToken({
      generationId: generation.generationId,
      attemptId: "att_stale",
      expectedState: "STARTING",
    }),
    false,
  );
});
