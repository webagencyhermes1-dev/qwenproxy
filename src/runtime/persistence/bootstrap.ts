import { getDatabase } from "../../core/database.ts";
import {
  CURRENT_SCHEMA_VERSION,
  NEW_TABLE_DDL,
} from "./schema.ts";
import {
  assertSchemaCurrent,
  getSchemaVersion,
  runVersionedMigrations,
} from "./migrations.ts";

export interface BootResult {
  schemaVersion: number;
  freshInstall: boolean;
}

/**
 * Versioned schema bootstrap for the durable runtime layer. Runs the migration
 * runner (idempotent, safe on every boot) and FAILS FAST on a schema problem
 * rather than silently continuing into an inconsistent state.
 */
export function bootPersistence(): BootResult {
  const before = getSchemaVersion(getDatabase());
  const freshInstall = before === 0 && !tablesPresent();
  const schemaVersion = runVersionedMigrations(getDatabase());
  assertSchemaCurrent(getDatabase());
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unexpected schema version after migration: ${schemaVersion} (expected ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  return { schemaVersion, freshInstall };
}

function tablesPresent(): boolean {
  const row = getDatabase().prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
  ).get("accounts") as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

export { NEW_TABLE_DDL };
