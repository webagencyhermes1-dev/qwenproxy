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
import fs from "node:fs";
import path from "node:path";
import { backupDatabase } from "../../core/database.ts";
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
 * Phase-3.2 durability: pre-migration backup conventions.
 *
 * Before any migration step runs, the runner best-effort backs up to
 * `<dbdir>/pre-migrate-<timestamp>.db` via `backupDatabase` and keeps only
 * the newest 3 backups. Backup failures never block migration.
 */
export const PRE_MIGRATE_BACKUP_PREFIX = "pre-migrate-";
export const PRE_MIGRATE_BACKUP_KEEP = 3;

/** Builds `<dbdir>/pre-migrate-<timestamp>.db`. */
export function buildPreMigrationBackupPath(
  dbDir: string,
  now: number = Date.now(),
): string {
  return path.join(dbDir, `${PRE_MIGRATE_BACKUP_PREFIX}${now}.db`);
}

/** Lists pre-migration backups in `dbDir`, oldest-first (timestamp names sort). */
export function listPreMigrationBackups(dbDir: string): string[] {
  try {
    return fs
      .readdirSync(dbDir)
      .filter(
        (f) => f.startsWith(PRE_MIGRATE_BACKUP_PREFIX) && f.endsWith(".db"),
      )
      .sort()
      .map((f) => path.join(dbDir, f));
  } catch {
    return [];
  }
}

/** Keeps only the newest `keep` backups, deleting older ones best-effort. */
export function prunePreMigrationBackups(
  dbDir: string,
  keep: number = PRE_MIGRATE_BACKUP_KEEP,
): void {
  try {
    const files = listPreMigrationBackups(dbDir);
    if (files.length <= keep) return;
    for (const f of files.slice(0, files.length - keep)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best-effort per file */
      }
    }
  } catch {
    /* never block */
  }
}

function resolveDbDir(db: BetterSqlite3Database.Database): string | null {
  try {
    const name = (db as unknown as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name !== ":memory:") {
      return path.dirname(path.resolve(name));
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Best-effort pre-migration backup. Never throws and never blocks migration:
 * a synchronous file-copy snapshot is taken first for determinism, then
 * `backupDatabase` is invoked (floating promise, errors swallowed), then
 * rotation prunes to the newest 3.
 */
function ensurePreMigrationBackup(db: BetterSqlite3Database.Database): void {
  try {
    const dbDir = resolveDbDir(db);
    if (!dbDir) return;
    try {
      fs.mkdirSync(dbDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const dest = buildPreMigrationBackupPath(dbDir);
    // Synchronous snapshot of the migrating handle for determinism.
    try {
      const src = path.resolve(
        (db as unknown as { name: string }).name,
      );
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          db.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
          /* best-effort */
        }
        fs.copyFileSync(src, dest);
      }
    } catch {
      /* best-effort */
    }
    // Canonical online backup (best-effort, never blocks).
    try {
      const p = backupDatabase(dest);
      p.then(
        () => {
          try {
            prunePreMigrationBackups(dbDir);
          } catch {
            /* ignore */
          }
        },
        () => {
          try {
            prunePreMigrationBackups(dbDir);
          } catch {
            /* ignore */
          }
        },
      );
    } catch {
      /* never block */
    }
    try {
      prunePreMigrationBackups(dbDir);
    } catch {
      /* ignore */
    }
  } catch {
    /* never block */
  }
}

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

  if (current < CURRENT_SCHEMA_VERSION) {
    // Phase-3.2: best-effort pre-migration backup, never blocks migration.
    ensurePreMigrationBackup(db);
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
