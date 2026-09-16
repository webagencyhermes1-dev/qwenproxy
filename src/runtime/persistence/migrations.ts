/**
 * Versioned migration runner for the durable runtime persistence layer.
 *
 * Deliberately NOT wired into core/database.ts's boot path yet; that happens in
 * a later phase. The runner mirrors database.ts's existing behavior of
 * re-running idempotent DDL on every boot without touching data.
 *
 * Timestamp convention: new tables store INTEGER epoch-milliseconds. Use
 * EPOCH_MS_NOW() so every writer agrees on the clock.
 */

import type BetterSqlite3Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, NEW_TABLE_DDL } from "./schema.ts";

/**
 * Single clock for the persistence layer so timestamps stay epoch-milliseconds
 * and remain mockable in tests.
 */
export const EPOCH_MS_NOW = (): number => Date.now();

/**
 * Raised when an on-disk database reports a schema version newer than this
 * build understands. Fail fast rather than silently mangle rows written by a
 * future schema.
 */
export class UnsupportedSchemaVersionError extends Error {
  public readonly dbVersion: number;
  public readonly currentVersion: number;

  constructor(dbVersion: number, currentVersion: number = CURRENT_SCHEMA_VERSION) {
    super(
      `Database schema version ${dbVersion} is newer than this build supports ` +
        `(current ${currentVersion}); refusing to migrate. Upgrade QwenProxy before opening this database.`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.dbVersion = dbVersion;
    this.currentVersion = currentVersion;
  }
}

/** Raised when the versioned runner cannot find the step for an expected target. */
export class MissingMigrationStepError extends Error {
  public readonly targetVersion: number;

  constructor(targetVersion: number) {
    super(`No migration step registered to reach schema version ${targetVersion}.`);
    this.name = "MissingMigrationStepError";
    this.targetVersion = targetVersion;
  }
}

type MigrationStep = (db: BetterSqlite3Database.Database) => void;

/**
 * Steps keyed by the version they produce. Each step must be idempotent and
 * must not touch legacy data.
 */
const MIGRATIONS: ReadonlyMap<number, MigrationStep> = new Map<
  number,
  MigrationStep
>([
  [
    1,
    // Legacy unversioned baseline: the accounts-family tables plus the four
    // runtime-created tables (rolling_summaries, vector_chunks,
    // responses_store, sticky_bindings). They may or may not exist yet
    // depending on which code paths ran, so they are adopted as-is — never
    // dropped or recreated. Recording user_version = 1 merely marks the
    // baseline so subsequent steps can chain from a known point.
    () => {
      /* no schema changes */
    },
  ],
  [
    2,
    (db: BetterSqlite3Database.Database) => {
      for (const ddl of NEW_TABLE_DDL) {
        db.exec(ddl);
      }
    },
  ],
]);

/**
 * Reads `PRAGMA user_version`. Fresh and legacy databases report 0.
 */
export function getSchemaVersion(db: BetterSqlite3Database.Database): number {
  const result = db.pragma("user_version", { simple: true });
  if (typeof result === "number") return result;

  // Defensive: non-simple shape would be [{ user_version: n }].
  const rows = Array.isArray(result) ? (result as Array<{ user_version?: unknown }>) : [];
  const raw = rows.length > 0 ? rows[0].user_version : undefined;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(parsed) ? (parsed as number) : 0;
}

/**
 * Applies every outstanding migration step in order, each inside its own
 * transaction, bumping `PRAGMA user_version` as it goes. Safe to call on every
 * boot: fresh, legacy, partially-migrated, and current databases all converge
 * on CURRENT_SCHEMA_VERSION without data loss.
 *
 * Returns the resulting schema version.
 */
export function runVersionedMigrations(
  db: BetterSqlite3Database.Database,
): number {
  let current = getSchemaVersion(db);

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(current, CURRENT_SCHEMA_VERSION);
  }

  while (current < CURRENT_SCHEMA_VERSION) {
    const target = current + 1;
    const step = MIGRATIONS.get(target);
    if (!step) {
      throw new MissingMigrationStepError(target);
    }

    // DDL and the version bump commit atomically, so a crash mid-migration can
    // never leave new tables behind with a stale user_version. (PRAGMA
    // user_version writes the DB header and is transaction-safe here.)
    const apply = db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${target}`);
    });
    apply();

    current = target;
  }

  return current;
}

/**
 * Throws if the database is not at CURRENT_SCHEMA_VERSION (e.g. a newer-schema
 * DB was opened by this build, or migrations were never run).
 */
export function assertSchemaCurrent(db: BetterSqlite3Database.Database): void {
  const version = getSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version, CURRENT_SCHEMA_VERSION);
  }
  if (version < CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${version} is behind this build ` +
        `(current ${CURRENT_SCHEMA_VERSION}); runVersionedMigrations was not applied.`,
    );
  }
}
