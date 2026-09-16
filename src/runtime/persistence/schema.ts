/**
 * Versioned schema definition for the durable runtime persistence layer.
 *
 * Timestamp convention: every timestamp column in the tables introduced by this
 * module is an INTEGER of epoch-milliseconds (see EPOCH_MS_NOW in migrations.ts).
 * The legacy tables created ad-hoc at runtime elsewhere in the repo mix TEXT
 * ISO-8601 and INTEGER; the new tables set the correct convention going forward.
 *
 * Nothing here is wired into a boot path yet; see migrations.ts.
 */

/**
 * Describes one step in the schema's evolution. Kept as a constant registry so
 * the migration runner and any operator-facing reporting stay in sync.
 */
export interface DbSchemaVersion {
  /** The `PRAGMA user_version` value once this step has been applied. */
  readonly version: number;
  /** Human-readable summary of what this step introduces. */
  readonly description: string;
  /** Tables this step owns (empty for the legacy baseline, which we adopted as-is). */
  readonly tables: readonly string[];
}

/**
 * v1 is the pre-existing unversioned baseline: the accounts-family tables in
 * core/database.ts plus the four runtime-created tables (rolling_summaries,
 * vector_chunks, responses_store, sticky_bindings) created ad-hoc by the
 * context/session services. A legacy database carries user_version = 0.
 * v2 adds the durable stateful-runtime tables below.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export const SCHEMA_HISTORY: readonly DbSchemaVersion[] = [
  {
    version: 1,
    description:
      "Legacy unversioned baseline: accounts, qwen_auth_sessions, logical_thread_states, personalization_cache, account_health, rolling_summaries, vector_chunks, responses_store, sticky_bindings. Adopted as-is; not created or modified by the versioned runner.",
    tables: [],
  },
  {
    version: 2,
    description:
      "Durable stateful inference runtime: tenants, sessions, branches, messages, generations, generation_attempts, account_leases, runtime_events, context_snapshots, idempotency_keys.",
    tables: [
      "tenants",
      "sessions",
      "branches",
      "messages",
      "generations",
      "generation_attempts",
      "account_leases",
      "runtime_events",
      "context_snapshots",
      "idempotency_keys",
    ],
  },
];

/**
 * DDL for schema v2. Every statement is idempotent (`IF NOT EXISTS`) so the
 * runner is safe to call on every boot and resilient to a partially-applied
 * previous run. Timestamps are INTEGER epoch-milliseconds throughout.
 */
export const NEW_TABLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tenants (
     tenant_id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     max_concurrent_generations INTEGER NOT NULL DEFAULT 1,
     max_queue_depth INTEGER NOT NULL DEFAULT 0,
     max_request_bytes INTEGER,
     max_session_bytes INTEGER
   );`,

  `CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     model_id TEXT,
     version INTEGER NOT NULL DEFAULT 1,
     current_branch_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );

   CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);`,

  `CREATE TABLE IF NOT EXISTS messages (
     message_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     role TEXT NOT NULL,
     content TEXT,
     sequence_number INTEGER NOT NULL,
     parent_message_id TEXT,
     branch_id TEXT,
     created_at INTEGER NOT NULL,
     tool_calls_json TEXT,
     tool_call_id TEXT
   );

   CREATE INDEX IF NOT EXISTS idx_messages_session_sequence
     ON messages(session_id, sequence_number);`,

  `CREATE TABLE IF NOT EXISTS branches (
     branch_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     parent_branch_id TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );

   CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id);`,

  `CREATE TABLE IF NOT EXISTS generations (
     generation_id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     turn_id TEXT,
     session_version_at_start INTEGER NOT NULL,
     state TEXT NOT NULL,
     snapshot_id TEXT,
     lease_id TEXT,
     deadline INTEGER,
     idempotency_key TEXT,
     created_at INTEGER NOT NULL,
     terminal_at INTEGER
   );

   CREATE INDEX IF NOT EXISTS idx_generations_session ON generations(session_id);
   CREATE INDEX IF NOT EXISTS idx_generations_state ON generations(state);
   CREATE INDEX IF NOT EXISTS idx_generations_idempotency
     ON generations(tenant_id, idempotency_key);`,

  `CREATE TABLE IF NOT EXISTS generation_attempts (
     attempt_id TEXT PRIMARY KEY,
     generation_id TEXT NOT NULL,
     attempt_number INTEGER NOT NULL,
     account_id TEXT,
     state TEXT,
     started_at INTEGER NOT NULL,
     upstream_started_at INTEGER,
     first_token_at INTEGER,
     completed_at INTEGER,
     failure_code TEXT,
     failure_reason TEXT
   );

   CREATE INDEX IF NOT EXISTS idx_attempts_generation
     ON generation_attempts(generation_id);`,

  `CREATE TABLE IF NOT EXISTS account_leases (
     lease_id TEXT PRIMARY KEY,
     owner_token TEXT NOT NULL,
     account_id TEXT NOT NULL,
     generation_id TEXT,
     acquired_at INTEGER NOT NULL,
     deadline INTEGER NOT NULL,
     state TEXT NOT NULL DEFAULT 'active',
     abandoned_at INTEGER
   );

   CREATE INDEX IF NOT EXISTS idx_leases_account_active
     ON account_leases(account_id, state);
   CREATE INDEX IF NOT EXISTS idx_leases_generation
     ON account_leases(generation_id);`,

  `CREATE TABLE IF NOT EXISTS runtime_events (
     event_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     at INTEGER NOT NULL,
     request_id TEXT,
     tenant_id TEXT,
     session_id TEXT,
     generation_id TEXT,
     attempt_id TEXT,
     account_id TEXT,
     lease_id TEXT,
     attributes_json TEXT
   );

   CREATE INDEX IF NOT EXISTS idx_events_generation ON runtime_events(generation_id);
   CREATE INDEX IF NOT EXISTS idx_events_account ON runtime_events(account_id);
   CREATE INDEX IF NOT EXISTS idx_events_at ON runtime_events(at);`,

  `CREATE TABLE IF NOT EXISTS context_snapshots (
     snapshot_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     session_version INTEGER NOT NULL,
     branch_id TEXT,
     config_identity_json TEXT,
     budget_json TEXT,
     created_at INTEGER NOT NULL,
     summary_ref TEXT,
     retained_message_ids_json TEXT,
     excluded_unit_ids_json TEXT
   );

   CREATE INDEX IF NOT EXISTS idx_snapshots_session_version
     ON context_snapshots(session_id, session_version);`,

  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     tenant_id TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     generation_id TEXT,
     created_at INTEGER NOT NULL,
     status TEXT,
     PRIMARY KEY (tenant_id, idempotency_key)
   );

   CREATE INDEX IF NOT EXISTS idx_idempotency_keys_generation
     ON idempotency_keys(generation_id);`,
];
