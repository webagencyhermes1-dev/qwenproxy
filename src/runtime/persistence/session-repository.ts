/**
 * Durable repository for the Session aggregate.
 *
 * Every write is fenced on the session's monotonic `version`: the mutation only
 * lands when the caller's expected version still holds. The claim is a single
 * `UPDATE ... WHERE version = ?` whose affected-row count is the verdict, so a
 * stale request loses cleanly instead of clobbering a newer commit.
 */
import type Database from "better-sqlite3";

import { getDatabase } from "../../core/database.ts";
import { newBranchId } from "../../domain/ids.ts";
import { assertMonotonicVersion } from "../../domain/session.ts";
import type { Session, SessionUpstreamMapping } from "../../domain/session.ts";

/**
 * Verdict of a version-fenced write. `advanced` means the caller's expected
 * version still held and the mutation landed atomically; otherwise a faster
 * writer already moved the session on and the caller must re-read and retry.
 */
export type AdvanceResult =
  | { advanced: true }
  | { advanced: false; conflict: true; currentVersion: number };

export interface CreateSessionInput {
  sessionId: string;
  tenantId: string;
  modelId: string;
}

export interface AdvanceVersionInput {
  sessionId: string;
  fromVersion: number;
  toVersion: number;
  updatedAt: number;
}

interface SessionRow {
  session_id: string;
  tenant_id: string;
  model_id: string | null;
  version: number;
  current_branch_id: string | null;
  created_at: number;
  updated_at: number;
  upstream_account_id: string | null;
  upstream_chat_id: string | null;
  upstream_parent_id: string | null;
  upstream_mapping_version: number | null;
}

const SESSION_COLUMNS =
  "session_id, tenant_id, model_id, version, current_branch_id, " +
  "created_at, updated_at, upstream_account_id, upstream_chat_id, " +
  "upstream_parent_id, upstream_mapping_version";

/**
 * Upstream handles are execution detail, never canonical state, so they ride
 * along on the `sessions` row as nullable columns. The v2 schema in schema.ts
 * predates them; they are added idempotently with the same add-column-then-
 * tolerate-duplicates approach the legacy migrations in core/database.ts use,
 * and they can be dropped and rebuilt at any time without losing conversation
 * state.
 */
const UPSTREAM_COLUMNS: readonly string[] = [
  "upstream_account_id TEXT",
  "upstream_chat_id TEXT",
  "upstream_parent_id TEXT",
  "upstream_mapping_version INTEGER",
];

const ensuredUpstreamColumns = new WeakSet<Database.Database>();

function ensureUpstreamColumns(db: Database.Database): void {
  if (ensuredUpstreamColumns.has(db)) return;

  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  if (columns.length === 0) return; // v2 schema not installed; the first query reports it

  const known = new Set(columns.map((column) => column.name));
  for (const definition of UPSTREAM_COLUMNS) {
    if (!known.has(definition.split(" ")[0])) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${definition}`);
    }
  }

  ensuredUpstreamColumns.add(db);
}

function rowToSession(row: SessionRow | undefined): Session | null {
  if (!row) return null;

  const session: Session = {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    version: row.version,
    currentBranchId: row.current_branch_id ?? "",
    modelId: row.model_id ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  // A mapping exists once it has been persisted (mappingVersion bumps on every
  // (re)creation); absent rows read back as `undefined`, never a fake mapping.
  if (row.upstream_mapping_version !== null) {
    session.upstreamMapping = {
      accountId: row.upstream_account_id,
      upstreamChatId: row.upstream_chat_id,
      upstreamParentId: row.upstream_parent_id,
      mappingVersion: row.upstream_mapping_version,
    };
  }

  return session;
}

export class SessionRepository {
  private readonly insertSession: Database.Statement;
  private readonly insertBranch: Database.Statement;
  private readonly selectById: Database.Statement;
  private readonly selectVersion: Database.Statement;
  private readonly selectByTenant: Database.Statement;
  private readonly bumpVersion: Database.Statement;
  private readonly pointBranch: Database.Statement;
  private readonly writeUpstreamMapping: Database.Statement;

  constructor(private readonly db: Database.Database = getDatabase()) {
    ensureUpstreamColumns(db);

    this.insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, tenant_id, model_id, version, current_branch_id,
          created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    );
    this.insertBranch = db.prepare(
      `INSERT INTO branches
         (branch_id, session_id, parent_branch_id, active, created_at)
       VALUES (?, ?, NULL, 1, ?)`,
    );
    this.selectById = db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`,
    );
    this.selectVersion = db.prepare(
      `SELECT version FROM sessions WHERE session_id = ?`,
    );
    this.selectByTenant = db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE tenant_id = ?
       ORDER BY updated_at DESC, created_at DESC, session_id ASC
       LIMIT ?`,
    );
    // The atomic claim: version only moves when it still equals :from, and the
    // affected-row count separates the winner from every stale loser.
    this.bumpVersion = db.prepare(
      `UPDATE sessions
         SET version = version + 1, updated_at = ?
       WHERE session_id = ? AND version = ?`,
    );
    this.pointBranch = db.prepare(
      `UPDATE sessions
         SET current_branch_id = ?, version = version + 1, updated_at = ?
       WHERE session_id = ? AND version = ?`,
    );
    // Handles only: the canonical version is deliberately NOT advanced, so a
    // mapping refresh can never invalidate a generation holding the version.
    this.writeUpstreamMapping = db.prepare(
      `UPDATE sessions
         SET upstream_account_id = ?,
             upstream_chat_id = ?,
             upstream_parent_id = ?,
             upstream_mapping_version = ?,
             updated_at = ?
       WHERE session_id = ? AND version = ?`,
    );
  }

  /**
   * Creates a session at version 1 together with its default branch in one
   * transaction, so a session never exists without a branch to write into.
   */
  createSession(input: CreateSessionInput): Session {
    const now = Date.now();
    const branchId = newBranchId();

    const insert = this.db.transaction(() => {
      this.insertSession.run(
        input.sessionId,
        input.tenantId,
        input.modelId,
        branchId,
        now,
        now,
      );
      this.insertBranch.run(branchId, input.sessionId, now);
    });
    insert();

    return {
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      version: 1,
      currentBranchId: branchId,
      modelId: input.modelId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Reads a session or null when absent; never throws on a missing row. */
  getById(sessionId: string): Session | null {
    return rowToSession(this.selectById.get(sessionId) as SessionRow | undefined);
  }

  /**
   * Advances the version by exactly one, but only if `fromVersion` still
   * matches. The atomic UPDATE is the whole critical section: two callers
   * racing from the same version cannot both win.
   */
  advanceVersion(input: AdvanceVersionInput): AdvanceResult {
    assertMonotonicVersion(input.fromVersion, input.toVersion);
    const result = this.bumpVersion.run(
      input.updatedAt,
      input.sessionId,
      input.fromVersion,
    );
    return this.toAdvanceResult(result.changes > 0, input.sessionId);
  }

  /**
   * Moves the session's branch pointer under the same optimistic fence. A
   * pointer written against a stale version is rejected as a conflict.
   */
  setCurrentBranch(
    sessionId: string,
    branchId: string,
    fence: { expectedVersion: number },
  ): AdvanceResult {
    const now = Date.now();
    const result = this.pointBranch.run(
      branchId,
      now,
      sessionId,
      fence.expectedVersion,
    );
    return this.toAdvanceResult(result.changes > 0, sessionId);
  }

  /**
   * Persists the upstream account/chat/parent handles plus mappingVersion.
   * Fenced on the session version so a writer whose view is stale cannot
   * clobber a fresher mapping; canonical conversation state is untouched.
   */
  saveUpstreamMapping(
    sessionId: string,
    mapping: SessionUpstreamMapping,
    expectedVersion: number,
  ): AdvanceResult {
    const now = Date.now();
    const result = this.writeUpstreamMapping.run(
      mapping.accountId,
      mapping.upstreamChatId,
      mapping.upstreamParentId,
      mapping.mappingVersion,
      now,
      sessionId,
      expectedVersion,
    );
    return this.toAdvanceResult(result.changes > 0, sessionId);
  }

  /** Lists a tenant's sessions, most recently updated first. */
  listByTenant(tenantId: string, limit = 100): Session[] {
    const rows = this.selectByTenant.all(tenantId, limit) as SessionRow[];
    return rows
      .map((row) => rowToSession(row))
      .filter((session): session is Session => session !== null);
  }

  private toAdvanceResult(advanced: boolean, sessionId: string): AdvanceResult {
    if (advanced) return { advanced: true };
    const row = this.selectVersion.get(sessionId) as
      | { version: number }
      | undefined;
    return {
      advanced: false,
      conflict: true,
      currentVersion: row ? row.version : 0,
    };
  }
}
