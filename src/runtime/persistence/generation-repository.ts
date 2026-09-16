/**
 * Durable repository for logical generations.
 *
 * Terminal transitions are fenced on the generation's own state: the mutation
 * is a single `UPDATE ... WHERE state = ?` whose affected-row count is the
 * verdict, so a late success callback and a timeout callback racing from the
 * same expected state cannot both commit — exactly one terminal outcome wins.
 *
 * Attempt ids, attempted-account ids, side effects and terminal failure detail
 * ride on the `generations` row as JSON documents. The v2 schema in schema.ts
 * predates them; they are added idempotently with the same add-column-then-
 * tolerate-duplicates approach the legacy migrations in core/database.ts use.
 */
import type Database from "better-sqlite3";

import { getDatabase } from "../../core/database.ts";
import type {
  Generation,
  GenerationAttempt,
  SideEffectRecord,
} from "../../domain/generation.ts";
import type { GenerationState } from "../../domain/types.ts";
import {
  TERMINAL_GENERATION_STATES,
  isTerminalGenerationState,
} from "../../domain/types.ts";
import { EPOCH_MS_NOW } from "./migrations.ts";

export interface CreateGenerationInput {
  generationId: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  sessionVersionAtStart: number;
  /** Absolute root deadline, epoch ms. */
  deadline: number;
  idempotencyKey?: string | null;
  createdAt?: number;
}

export interface UpdateStateInput {
  generationId: string;
  to: GenerationState;
  /** Defaults to the clock when the target state is terminal. */
  terminalAt?: number;
  failureCode?: string | null;
  failureReason?: string | null;
}

/** Compare-and-swap fence: the update applies only to a row in this state. */
export interface UpdateFence {
  expectedState: GenerationState;
}

export interface UpdateResult {
  updated: boolean;
  /** State the row held when the attempt ran; null when no such row exists. */
  from: GenerationState | null;
  to: GenerationState;
}

/** Active lease joined onto the generation it points at. */
export interface RecoveryLeaseRow {
  generationId: string;
  leaseId: string;
  accountId: string;
  ownerToken: string;
  deadline: number;
}

interface GenerationRow {
  generation_id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  session_version_at_start: number;
  state: string;
  snapshot_id: string | null;
  lease_id: string | null;
  deadline: number | null;
  idempotency_key: string | null;
  created_at: number;
  terminal_at: number | null;
  attempt_ids_json: string | null;
  attempted_account_ids_json: string | null;
  side_effects_json: string | null;
  failure_code: string | null;
  failure_reason: string | null;
}

const GENERATION_COLUMNS =
  "generation_id, tenant_id, session_id, turn_id, session_version_at_start, " +
  "state, snapshot_id, lease_id, deadline, idempotency_key, created_at, " +
  "terminal_at, attempt_ids_json, attempted_account_ids_json, " +
  "side_effects_json, failure_code, failure_reason";

const EXTRA_COLUMNS: readonly string[] = [
  "attempt_ids_json TEXT NOT NULL DEFAULT '[]'",
  "attempted_account_ids_json TEXT NOT NULL DEFAULT '[]'",
  "side_effects_json TEXT NOT NULL DEFAULT '{}'",
  "failure_code TEXT",
  "failure_reason TEXT",
];

const TERMINAL_STATES: readonly GenerationState[] = [
  ...TERMINAL_GENERATION_STATES,
];

const TERMINAL_PLACEHOLDERS = TERMINAL_STATES.map(() => "?").join(", ");

const ensuredExtraColumns = new WeakSet<Database.Database>();

function ensureExtraColumns(db: Database.Database): void {
  if (ensuredExtraColumns.has(db)) return;

  const columns = db.prepare("PRAGMA table_info(generations)").all() as Array<{
    name: string;
  }>;
  if (columns.length === 0) return; // v2 schema not installed; the first query reports it

  const known = new Set(columns.map((column) => column.name));
  for (const definition of EXTRA_COLUMNS) {
    if (!known.has(definition.split(" ")[0])) {
      db.exec(`ALTER TABLE generations ADD COLUMN ${definition}`);
    }
  }

  ensuredExtraColumns.add(db);
}

/** Parses a stored id array; malformed payloads read back as empty. */
function parseIdArray(json: string | null | undefined): string[] {
  if (!json) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === "string");
}

/** Parses stored side effects; malformed payloads read back as "no effects". */
function parseSideEffects(
  json: string | null | undefined,
): SideEffectRecord {
  if (!json) return emptySideEffects();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return emptySideEffects();
  }

  if (typeof parsed !== "object" || parsed === null) {
    return emptySideEffects();
  }

  const record = parsed as Record<string, unknown>;
  const toolCalls = Array.isArray(record.toolCallsExecuted)
    ? record.toolCallsExecuted.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    outputEmittedToClient:
      typeof record.outputEmittedToClient === "boolean" &&
      record.outputEmittedToClient,
    toolCallsExecuted: toolCalls,
    lastUpdatedAt:
      typeof record.lastUpdatedAt === "number" ? record.lastUpdatedAt : 0,
  };
}

function emptySideEffects(): SideEffectRecord {
  return {
    outputEmittedToClient: false,
    toolCallsExecuted: [],
    lastUpdatedAt: 0,
  };
}

function rowToGeneration(row: GenerationRow | undefined): Generation | null {
  if (!row) return null;

  return {
    generationId: row.generation_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    turnId: row.turn_id ?? "",
    sessionVersionAtStart: row.session_version_at_start,
    state: row.state as GenerationState,
    snapshotId: row.snapshot_id,
    leaseId: row.lease_id,
    deadline: row.deadline ?? 0,
    createdAt: row.created_at,
    terminalAt: row.terminal_at,
    attemptIds: parseIdArray(row.attempt_ids_json),
    attemptedAccountIds: parseIdArray(row.attempted_account_ids_json),
    sideEffects: parseSideEffects(row.side_effects_json),
    idempotencyKey: row.idempotency_key,
  };
}

export class GenerationRepository {
  private readonly insertGeneration: Database.Statement;
  private readonly insertAttempt: Database.Statement;
  private readonly selectById: Database.Statement;
  private readonly selectState: Database.Statement;
  private readonly selectAttemptIds: Database.Statement;
  private readonly setAttemptIds: Database.Statement;
  private readonly selectAttemptedAccounts: Database.Statement;
  private readonly setAttemptedAccounts: Database.Statement;
  private readonly selectSideEffects: Database.Statement;
  private readonly setSideEffects: Database.Statement;
  private readonly setSnapshotStmt: Database.Statement;
  private readonly setLeaseStmt: Database.Statement;
  // The atomic claim: state only moves when it still equals the fence, and the
  // affected-row count separates the winner from every stale loser.
  private readonly updateStateStmt: Database.Statement;
  private readonly selectByIdempotencyKey: Database.Statement;
  private readonly insertClaim: Database.Statement;
  private readonly selectNonterminal: Database.Statement;
  private readonly selectActiveLeases: Database.Statement;

  constructor(private readonly db: Database.Database = getDatabase()) {
    ensureExtraColumns(db);

    this.insertGeneration = db.prepare(
      `INSERT INTO generations
         (${GENERATION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertAttempt = db.prepare(
      `INSERT OR REPLACE INTO generation_attempts
         (attempt_id, generation_id, attempt_number, account_id, state,
          started_at, upstream_started_at, first_token_at, completed_at,
          failure_code, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectById = db.prepare(
      `SELECT ${GENERATION_COLUMNS} FROM generations WHERE generation_id = ?`,
    );
    this.selectState = db.prepare(
      "SELECT state FROM generations WHERE generation_id = ?",
    );
    this.selectAttemptIds = db.prepare(
      "SELECT attempt_ids_json FROM generations WHERE generation_id = ?",
    );
    this.setAttemptIds = db.prepare(
      "UPDATE generations SET attempt_ids_json = ? WHERE generation_id = ?",
    );
    this.selectAttemptedAccounts = db.prepare(
      "SELECT attempted_account_ids_json FROM generations WHERE generation_id = ?",
    );
    this.setAttemptedAccounts = db.prepare(
      "UPDATE generations SET attempted_account_ids_json = ? WHERE generation_id = ?",
    );
    this.selectSideEffects = db.prepare(
      "SELECT side_effects_json FROM generations WHERE generation_id = ?",
    );
    this.setSideEffects = db.prepare(
      "UPDATE generations SET side_effects_json = ? WHERE generation_id = ?",
    );
    this.setSnapshotStmt = db.prepare(
      "UPDATE generations SET snapshot_id = ? WHERE generation_id = ?",
    );
    this.setLeaseStmt = db.prepare(
      "UPDATE generations SET lease_id = ? WHERE generation_id = ?",
    );
    this.updateStateStmt = db.prepare(
      `UPDATE generations
         SET state = ?,
             terminal_at = ?,
             failure_code = ?,
             failure_reason = ?
       WHERE generation_id = ? AND state = ?`,
    );
    this.selectByIdempotencyKey = db.prepare(
      `SELECT ${GENERATION_COLUMNS} FROM generations
        WHERE tenant_id = ? AND idempotency_key = ?
        LIMIT 1`,
    );
    this.insertClaim = db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys
         (tenant_id, idempotency_key, generation_id, created_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.selectNonterminal = db.prepare(
      `SELECT ${GENERATION_COLUMNS} FROM generations
        WHERE state NOT IN (${TERMINAL_PLACEHOLDERS})
        ORDER BY created_at ASC, generation_id ASC`,
    );
    this.selectActiveLeases = db.prepare(
      `SELECT
         g.generation_id AS generationId,
         l.lease_id      AS leaseId,
         l.account_id    AS accountId,
         l.owner_token   AS ownerToken,
         l.deadline      AS deadline
       FROM generations g
       JOIN account_leases l ON l.generation_id = g.generation_id
       WHERE l.state = 'active'`,
    );
  }

  /** Creates a generation in QUEUED with an empty attempt history. */
  create(input: CreateGenerationInput): Generation {
    const now = input.createdAt ?? EPOCH_MS_NOW();
    const attemptIds = JSON.stringify([]);
    const attemptedAccountIds = JSON.stringify([]);
    const sideEffects = JSON.stringify(emptySideEffects());

    this.insertGeneration.run(
      input.generationId,
      input.tenantId,
      input.sessionId,
      input.turnId,
      input.sessionVersionAtStart,
      "QUEUED",
      null, // snapshot_id
      null, // lease_id
      input.deadline,
      input.idempotencyKey ?? null,
      now,
      null, // terminal_at
      attemptIds,
      attemptedAccountIds,
      sideEffects,
      null, // failure_code
      null, // failure_reason
    );

    return {
      generationId: input.generationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sessionVersionAtStart: input.sessionVersionAtStart,
      state: "QUEUED",
      attemptIds: [],
      attemptedAccountIds: [],
      snapshotId: null,
      leaseId: null,
      deadline: input.deadline,
      createdAt: now,
      terminalAt: null,
      sideEffects: emptySideEffects(),
      idempotencyKey: input.idempotencyKey ?? null,
    };
  }

  /** Reads a generation or null when absent. */
  getById(generationId: string): Generation | null {
    return rowToGeneration(this.selectById.get(generationId) as GenerationRow | undefined);
  }

  /**
   * Compare-and-swap state transition. Two racing callbacks (a late success vs.
   * a timeout) issue disjoint UPDATEs, so at most one can match and a
   * generation can never end in two states.
   */
  updateState(input: UpdateStateInput, fence: UpdateFence): UpdateResult {
    const terminalAt =
      input.terminalAt ??
      (isTerminalGenerationState(input.to) ? EPOCH_MS_NOW() : null);

    const result = this.updateStateStmt.run(
      input.to,
      terminalAt,
      input.failureCode ?? null,
      input.failureReason ?? null,
      input.generationId,
      fence.expectedState,
    );
    if (result.changes > 0) {
      return { updated: true, from: fence.expectedState, to: input.to };
    }

    const row = this.selectState.get(input.generationId) as
      | { state: string }
      | undefined;
    return {
      updated: false,
      from: row ? (row.state as GenerationState) : null,
      to: input.to,
    };
  }

  /** Persists the attempt row and appends the live-attempt id in one transaction. */
  appendAttempt(generationId: string, attempt: GenerationAttempt): void {
    const append = this.db.transaction(() => {
      this.insertAttempt.run(
        attempt.attemptId,
        generationId,
        attempt.attemptNumber,
        attempt.accountId,
        attempt.state,
        attempt.startedAt,
        attempt.upstreamStartedAt,
        attempt.firstTokenAt,
        attempt.completedAt,
        attempt.failureCode,
        attempt.failureReason,
      );

      const row = this.selectAttemptIds.get(generationId) as
        | { attempt_ids_json: string | null }
        | undefined;
      const ids = parseIdArray(row?.attempt_ids_json);
      if (!ids.includes(attempt.attemptId)) ids.push(attempt.attemptId);
      this.setAttemptIds.run(JSON.stringify(ids), generationId);
    });
    append();
  }

  /** Failover guard: re-adding an already-recorded account changes nothing. */
  addAttemptedAccount(generationId: string, accountId: string): void {
    const add = this.db.transaction(() => {
      const row = this.selectAttemptedAccounts.get(generationId) as
        | { attempted_account_ids_json: string | null }
        | undefined;
      const ids = parseIdArray(row?.attempted_account_ids_json);
      if (!ids.includes(accountId)) ids.push(accountId);
      this.setAttemptedAccounts.run(JSON.stringify(ids), generationId);
    });
    add();
  }

  setSnapshot(generationId: string, snapshotId: string): void {
    this.setSnapshotStmt.run(snapshotId, generationId);
  }

  setLease(generationId: string, leaseId: string): void {
    this.setLeaseStmt.run(leaseId, generationId);
  }

  /**
   * Latching merge: emitted output and dispatched tool calls are monotone, so a
   * partial patch never retracts what an earlier patch recorded.
   */
  recordSideEffects(
    generationId: string,
    patch: Partial<SideEffectRecord>,
  ): void {
    const merge = this.db.transaction(() => {
      const row = this.selectSideEffects.get(generationId) as
        | { side_effects_json: string | null }
        | undefined;
      const current = parseSideEffects(row?.side_effects_json);
      const patchedTools = patch.toolCallsExecuted ?? [];
      const merged: SideEffectRecord = {
        outputEmittedToClient:
          current.outputEmittedToClient || (patch.outputEmittedToClient ?? false),
        toolCallsExecuted: [
          ...current.toolCallsExecuted,
          ...patchedTools.filter((id) => !current.toolCallsExecuted.includes(id)),
        ],
        lastUpdatedAt: Math.max(
          current.lastUpdatedAt,
          patch.lastUpdatedAt ?? 0,
          EPOCH_MS_NOW(),
        ),
      };
      this.setSideEffects.run(JSON.stringify(merged), generationId);
    });
    merge();
  }

  /** Everything crash recovery must drive to a terminal state. */
  listNonterminal(): Generation[] {
    const rows = this.selectNonterminal.all(...TERMINAL_STATES) as GenerationRow[];
    return rows
      .map((row) => rowToGeneration(row))
      .filter((generation): generation is Generation => generation !== null);
  }

  /** Active leases still pointing at a generation; the recovery sweep's inbox. */
  listActiveLeasesForRecovery(): RecoveryLeaseRow[] {
    return this.selectActiveLeases.all() as RecoveryLeaseRow[];
  }

  /** Unique per (tenant, key): the index guarantees at most one generation. */
  findByIdempotencyKey(tenantId: string, key: string): Generation | null {
    return rowToGeneration(
      this.selectByIdempotencyKey.get(tenantId, key) as GenerationRow | undefined,
    );
  }

  /**
   * INSERT OR IGNORE plus the affected-row count: a retried HTTP call
   * re-claiming the same key reports inserted:false instead of racing the
   * first writer.
   */
  insertIdempotencyClaim(input: {
    tenantId: string;
    key: string;
    generationId: string;
    status: string;
  }): { inserted: boolean } {
    const result = this.insertClaim.run(
      input.tenantId,
      input.key,
      input.generationId,
      EPOCH_MS_NOW(),
      input.status,
    );
    return { inserted: result.changes > 0 };
  }
}
