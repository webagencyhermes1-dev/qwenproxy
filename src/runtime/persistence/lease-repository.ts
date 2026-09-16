/**
 * Durable repository for account leases — the ownership oracle crash recovery
 * consults on boot. Row state is the source of truth for who may touch an
 * account: an 'active' row is a live claim, anything else is history.
 */
import type Database from "better-sqlite3";

import { getDatabase } from "../../core/database.ts";
import type { AccountLease } from "../../domain/types.ts";
import { EPOCH_MS_NOW } from "./migrations.ts";

export type LeaseState = "active" | "released" | "abandoned";

export interface AccountLeaseRow {
  leaseId: string;
  ownerToken: string;
  accountId: string;
  generationId: string | null;
  acquiredAt: number;
  deadline: number;
  state: LeaseState;
  abandonedAt: number | null;
}

interface LeaseRow {
  lease_id: string;
  owner_token: string;
  account_id: string;
  generation_id: string | null;
  acquired_at: number;
  deadline: number;
  state: string;
  abandoned_at: number | null;
}

const LEASE_COLUMNS =
  "lease_id, owner_token, account_id, generation_id, acquired_at, deadline, " +
  "state, abandoned_at, outcome";

/** The release outcome is execution detail, not ownership state. */
const EXTRA_COLUMNS: readonly string[] = ["outcome TEXT"];

const ensuredOutcomeColumn = new WeakSet<Database.Database>();

function ensureOutcomeColumn(db: Database.Database): void {
  if (ensuredOutcomeColumn.has(db)) return;

  const columns = db.prepare("PRAGMA table_info(account_leases)").all() as Array<{
    name: string;
  }>;
  if (columns.length === 0) return; // v2 schema not installed; the first query reports it

  const known = new Set(columns.map((column) => column.name));
  for (const definition of EXTRA_COLUMNS) {
    if (!known.has(definition.split(" ")[0])) {
      db.exec(`ALTER TABLE account_leases ADD COLUMN ${definition}`);
    }
  }

  ensuredOutcomeColumn.add(db);
}

function rowToLease(row: LeaseRow | undefined): AccountLeaseRow | null {
  if (!row) return null;

  return {
    leaseId: row.lease_id,
    ownerToken: row.owner_token,
    accountId: row.account_id,
    generationId: row.generation_id,
    acquiredAt: row.acquired_at,
    deadline: row.deadline,
    state: row.state as LeaseState,
    abandonedAt: row.abandoned_at,
  };
}

export class LeaseRepository {
  private readonly insertLease: Database.Statement;
  private readonly markReleasedStmt: Database.Statement;
  private readonly markAbandonedStmt: Database.Statement;
  // idx_leases_account_active(account_id, state) serves this lookup: the durable
  // answer to "who owns this account right now".
  private readonly selectActiveForAccount: Database.Statement;
  private readonly selectAbandonedOlderThan: Database.Statement;
  private readonly countActiveStmt: Database.Statement;

  constructor(private readonly db: Database.Database = getDatabase()) {
    ensureOutcomeColumn(db);

    this.insertLease = db.prepare(
      `INSERT INTO account_leases
         (${LEASE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.markReleasedStmt = db.prepare(
      `UPDATE account_leases
         SET state = 'released', outcome = ?
       WHERE lease_id = ?`,
    );
    this.markAbandonedStmt = db.prepare(
      `UPDATE account_leases
         SET state = 'abandoned', abandoned_at = ?
       WHERE lease_id = ?`,
    );
    this.selectActiveForAccount = db.prepare(
      `SELECT ${LEASE_COLUMNS} FROM account_leases
        WHERE account_id = ? AND state = 'active'
        ORDER BY acquired_at DESC
        LIMIT 1`,
    );
    this.selectAbandonedOlderThan = db.prepare(
      `SELECT ${LEASE_COLUMNS} FROM account_leases
        WHERE state = 'abandoned'
          AND abandoned_at IS NOT NULL
          AND abandoned_at < ?
        ORDER BY abandoned_at ASC, lease_id ASC`,
    );
    this.countActiveStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM account_leases WHERE state = 'active'",
    );
  }

  /** Records an active lease; the row is the claim until it is resolved. */
  record(lease: AccountLease): void {
    this.insertLease.run(
      lease.leaseId,
      lease.ownerToken,
      lease.accountId,
      lease.generationId,
      lease.acquiredAt,
      lease.deadline,
      "active",
      null, // abandoned_at
      null, // outcome
    );
  }

  markReleased(leaseId: string, outcome: string): void {
    this.markReleasedStmt.run(outcome, leaseId);
  }

  markAbandoned(leaseId: string): void {
    this.markAbandonedStmt.run(EPOCH_MS_NOW(), leaseId);
  }

  /** Null when no live claim holds the account. */
  getActiveForAccount(accountId: string): AccountLeaseRow | null {
    return rowToLease(
      this.selectActiveForAccount.get(accountId) as LeaseRow | undefined,
    );
  }

  /** Leases abandoned before the sweep threshold; the boot-time fence sweep. */
  listAbandonedOlderThan(epochMs: number): AccountLeaseRow[] {
    const rows = this.selectAbandonedOlderThan.all(epochMs) as LeaseRow[];
    return rows
      .map((row) => rowToLease(row))
      .filter((lease): lease is AccountLeaseRow => lease !== null);
  }

  countActive(): number {
    const row = this.countActiveStmt.get() as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }
}
