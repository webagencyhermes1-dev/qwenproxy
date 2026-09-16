/**
 * Coverage for the generation/lease persistence layer against an isolated
 * in-memory SQLite database. The real repo database (data/db/qwenproxy.db) is
 * never touched: tables come straight from the exported v2 DDL.
 */
import Database from "better-sqlite3";
import assert from "node:assert";
import test from "node:test";

import type { AccountLease } from "../../domain/types.ts";
import type {
  Generation,
  GenerationAttempt,
} from "../../domain/generation.ts";
import { NEW_TABLE_DDL } from "./schema.ts";
import { GenerationRepository } from "./generation-repository.ts";
import { LeaseRepository } from "./lease-repository.ts";

let db: Database.Database;

test.beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const ddl of NEW_TABLE_DDL) db.exec(ddl);
});

test.afterEach(() => {
  db.close();
});

function createGeneration(id: string, createdAt = 1_000): Generation {
  return new GenerationRepository(db).create({
    generationId: id,
    tenantId: "tenant_a",
    sessionId: "sess_1",
    turnId: `turn_${id}`,
    sessionVersionAtStart: 3,
    deadline: 10_000,
    idempotencyKey: `key_${id}`,
    createdAt,
  });
}

function makeAttempt(generationId: string, n: number): GenerationAttempt {
  return {
    attemptId: `att_${generationId}_${n}`,
    generationId,
    attemptNumber: n,
    accountId: `acc_${n}`,
    state: "STARTING",
    startedAt: 1_000 + n,
    upstreamStartedAt: null,
    firstTokenAt: null,
    completedAt: null,
    failureCode: null,
    failureReason: null,
  };
}

function makeLease(id: string, accountId: string, generationId: string): AccountLease {
  return {
    leaseId: id,
    ownerToken: `own_${id}`,
    accountId,
    generationId,
    acquiredAt: 500,
    deadline: 9_000,
  };
}

test("GenerationRepository: create + getById roundtrip through JSON columns", () => {
  const repo = new GenerationRepository(db);

  const created = createGeneration("gen_roundtrip");
  assert.strictEqual(created.state, "QUEUED");
  assert.deepStrictEqual([...created.attemptIds], []);
  assert.deepStrictEqual([...created.attemptedAccountIds], []);
  assert.deepStrictEqual(created.sideEffects, {
    outputEmittedToClient: false,
    toolCallsExecuted: [],
    lastUpdatedAt: 0,
  });

  const read = repo.getById("gen_roundtrip");
  assert.notStrictEqual(read, null);
  assert.strictEqual(read!.generationId, "gen_roundtrip");
  assert.strictEqual(read!.tenantId, "tenant_a");
  assert.strictEqual(read!.sessionId, "sess_1");
  assert.strictEqual(read!.turnId, "turn_gen_roundtrip");
  assert.strictEqual(read!.sessionVersionAtStart, 3);
  assert.strictEqual(read!.state, "QUEUED");
  assert.strictEqual(read!.snapshotId, null);
  assert.strictEqual(read!.leaseId, null);
  assert.strictEqual(read!.deadline, 10_000);
  assert.strictEqual(read!.createdAt, 1_000);
  assert.strictEqual(read!.terminalAt, null);
  assert.strictEqual(read!.idempotencyKey, "key_gen_roundtrip");
  assert.deepStrictEqual([...read!.attemptIds], []);
  assert.deepStrictEqual([...read!.attemptedAccountIds], []);
  assert.deepStrictEqual(read!.sideEffects, created.sideEffects);

  // The JSON arrays really are stored as documents on the row.
  const row = db
    .prepare(
      "SELECT attempt_ids_json, attempted_account_ids_json, side_effects_json FROM generations WHERE generation_id = ?",
    )
    .get("gen_roundtrip") as {
    attempt_ids_json: string;
    attempted_account_ids_json: string;
    side_effects_json: string;
  };
  assert.strictEqual(row.attempt_ids_json, "[]");
  assert.strictEqual(row.attempted_account_ids_json, "[]");
  assert.strictEqual(row.side_effects_json, JSON.stringify(created.sideEffects));

  repo.setSnapshot("gen_roundtrip", "snap_1");
  repo.setLease("gen_roundtrip", "lease_1");
  const pointed = repo.getById("gen_roundtrip");
  assert.strictEqual(pointed!.snapshotId, "snap_1");
  assert.strictEqual(pointed!.leaseId, "lease_1");

  assert.strictEqual(repo.getById("gen_missing"), null);
});

test("GenerationRepository: terminal-uniqueness race — exactly one transition wins", () => {
  const repo = new GenerationRepository(db);
  createGeneration("gen_race");

  // Both callbacks believe the generation is still QUEUED. The atomic UPDATE is
  // the whole critical section, so the loser's predicate cannot still match.
  const success = repo.updateState(
    { generationId: "gen_race", to: "COMPLETED", terminalAt: 7_000 },
    { expectedState: "QUEUED" },
  );
  const timeout = repo.updateState(
    {
      generationId: "gen_race",
      to: "FAILED",
      failureCode: "TIMEOUT",
      failureReason: "deadline passed",
    },
    { expectedState: "QUEUED" },
  );

  assert.strictEqual(success.updated, true);
  assert.strictEqual(success.from, "QUEUED");
  assert.strictEqual(timeout.updated, false);
  assert.strictEqual(timeout.from, "COMPLETED");
  assert.strictEqual(
    [success.updated, timeout.updated].filter(Boolean).length,
    1,
    "exactly one racer may terminalize the generation",
  );

  const final = repo.getById("gen_race");
  assert.notStrictEqual(final, null);
  assert.strictEqual(final!.state, "COMPLETED");
  assert.strictEqual(final!.terminalAt, 7_000);

  // The losing UPDATE must not have written its failure detail.
  const failure = db
    .prepare("SELECT failure_code, failure_reason FROM generations WHERE generation_id = ?")
    .get("gen_race") as { failure_code: string | null; failure_reason: string | null };
  assert.strictEqual(failure.failure_code, null);
  assert.strictEqual(failure.failure_reason, null);
});

test("GenerationRepository: updateState reports missing rows and stays non-terminal forward", () => {
  const repo = new GenerationRepository(db);
  createGeneration("gen_fence");

  const absent = repo.updateState(
    { generationId: "gen_ghost", to: "FAILED" },
    { expectedState: "QUEUED" },
  );
  assert.strictEqual(absent.updated, false);
  assert.strictEqual(absent.from, null);

  const stale = repo.updateState(
    { generationId: "gen_fence", to: "FAILED" },
    { expectedState: "STREAMING" },
  );
  assert.strictEqual(stale.updated, false);
  assert.strictEqual(stale.from, "QUEUED");

  const forward = repo.updateState(
    { generationId: "gen_fence", to: "RESERVING" },
    { expectedState: "QUEUED" },
  );
  assert.strictEqual(forward.updated, true);
  assert.strictEqual(repo.getById("gen_fence")!.terminalAt, null);
});

test("GenerationRepository: appendAttempt preserves order, addAttemptedAccount is idempotent", () => {
  const repo = new GenerationRepository(db);
  createGeneration("gen_attempts");

  repo.appendAttempt("gen_attempts", makeAttempt("gen_attempts", 3));
  repo.appendAttempt("gen_attempts", makeAttempt("gen_attempts", 1));
  repo.appendAttempt("gen_attempts", makeAttempt("gen_attempts", 2));
  // Re-appending a known attempt id must not duplicate it.
  repo.appendAttempt("gen_attempts", makeAttempt("gen_attempts", 1));

  repo.addAttemptedAccount("gen_attempts", "acc_3");
  repo.addAttemptedAccount("gen_attempts", "acc_1");
  repo.addAttemptedAccount("gen_attempts", "acc_3");

  const read = repo.getById("gen_attempts");
  assert.notStrictEqual(read, null);
  assert.deepStrictEqual(
    [...read!.attemptIds],
    ["att_gen_attempts_3", "att_gen_attempts_1", "att_gen_attempts_2"],
  );
  assert.deepStrictEqual([...read!.attemptedAccountIds], ["acc_3", "acc_1"]);

  // The attempt rows landed with their ordinals.
  const rows = db
    .prepare(
      "SELECT attempt_number, account_id FROM generation_attempts WHERE generation_id = ? ORDER BY attempt_number ASC",
    )
    .all("gen_attempts") as Array<{ attempt_number: number; account_id: string }>;
  assert.deepStrictEqual(
    rows.map((row) => [row.attempt_number, row.account_id]),
    [
      [1, "acc_1"],
      [2, "acc_2"],
      [3, "acc_3"],
    ],
  );
});

test("GenerationRepository: listNonterminal excludes the terminal set", () => {
  const repo = new GenerationRepository(db);
  createGeneration("gen_open", 1_000);
  createGeneration("gen_mid", 2_000);
  createGeneration("gen_done", 3_000);
  createGeneration("gen_dead", 4_000);

  assert.ok(
    repo
      .updateState(
        { generationId: "gen_mid", to: "STREAMING" },
        { expectedState: "QUEUED" },
      )
      .updated,
  );
  assert.ok(
    repo
      .updateState(
        { generationId: "gen_done", to: "COMPLETED" },
        { expectedState: "QUEUED" },
      )
      .updated,
  );
  assert.ok(
    repo
      .updateState(
        { generationId: "gen_dead", to: "ABANDONED" },
        { expectedState: "QUEUED" },
      )
      .updated,
  );

  const open = repo.listNonterminal().map((generation) => generation.generationId);
  assert.deepStrictEqual(open, ["gen_open", "gen_mid"]);
});

test("GenerationRepository: recordSideEffects merges partial patches", () => {
  const repo = new GenerationRepository(db);
  createGeneration("gen_effects");

  repo.recordSideEffects("gen_effects", { outputEmittedToClient: true });
  repo.recordSideEffects("gen_effects", { toolCallsExecuted: ["tc_1"] });
  repo.recordSideEffects("gen_effects", {
    toolCallsExecuted: ["tc_1", "tc_2"],
    lastUpdatedAt: 5_000,
  });

  const effects = repo.getById("gen_effects")!.sideEffects;
  assert.strictEqual(effects.outputEmittedToClient, true);
  assert.deepStrictEqual([...effects.toolCallsExecuted], ["tc_1", "tc_2"]);
  assert.ok(effects.lastUpdatedAt >= 5_000);

  // A patch cannot retract what an earlier patch latched in.
  repo.recordSideEffects("gen_effects", { outputEmittedToClient: false });
  assert.strictEqual(
    repo.getById("gen_effects")!.sideEffects.outputEmittedToClient,
    true,
  );
});

test("GenerationRepository: idempotency claim rejects a duplicate without error", () => {
  const repo = new GenerationRepository(db);
  createGeneration("gen_idem");

  const first = repo.insertIdempotencyClaim({
    tenantId: "tenant_a",
    key: "key_gen_idem",
    generationId: "gen_idem",
    status: "running",
  });
  const second = repo.insertIdempotencyClaim({
    tenantId: "tenant_a",
    key: "key_gen_idem",
    generationId: "gen_idem",
    status: "running",
  });

  assert.strictEqual(first.inserted, true);
  assert.strictEqual(second.inserted, false);

  const hit = repo.findByIdempotencyKey("tenant_a", "key_gen_idem");
  assert.notStrictEqual(hit, null);
  assert.strictEqual(hit!.generationId, "gen_idem");
  assert.strictEqual(repo.findByIdempotencyKey("tenant_a", "key_other"), null);

  // A different tenant may hold the same key.
  const other = repo.insertIdempotencyClaim({
    tenantId: "tenant_b",
    key: "key_gen_idem",
    generationId: "gen_idem",
    status: "running",
  });
  assert.strictEqual(other.inserted, true);
});

test("GenerationRepository + LeaseRepository: active lease recovery view", () => {
  const generations = new GenerationRepository(db);
  const leases = new LeaseRepository(db);
  createGeneration("gen_rec");
  createGeneration("gen_rec_done");

  leases.record(makeLease("lease_live", "acc_1", "gen_rec"));
  leases.record(makeLease("lease_stale", "acc_2", "gen_rec_done"));
  generations.setLease("gen_rec", "lease_live");
  generations.setLease("gen_rec_done", "lease_stale");

  const live = generations.listActiveLeasesForRecovery();
  assert.strictEqual(live.length, 2);
  const byLease = new Map(live.map((row) => [row.leaseId, row]));
  assert.strictEqual(byLease.get("lease_live")!.generationId, "gen_rec");
  assert.strictEqual(byLease.get("lease_live")!.accountId, "acc_1");
  assert.strictEqual(byLease.get("lease_live")!.ownerToken, "own_lease_live");
  assert.strictEqual(byLease.get("lease_live")!.deadline, 9_000);
  assert.strictEqual(byLease.get("lease_stale")!.generationId, "gen_rec_done");

  // A released lease drops out of the recovery inbox.
  leases.markReleased("lease_stale", "completed");
  assert.deepStrictEqual(
    generations.listActiveLeasesForRecovery().map((row) => row.leaseId),
    ["lease_live"],
  );
});

test("LeaseRepository: active-for-account oracle and counts", () => {
  const repo = new LeaseRepository(db);

  assert.strictEqual(repo.getActiveForAccount("acc_1"), null);
  assert.strictEqual(repo.countActive(), 0);

  repo.record(makeLease("lease_1", "acc_1", "gen_x"));
  assert.strictEqual(repo.countActive(), 1);

  const active = repo.getActiveForAccount("acc_1");
  assert.notStrictEqual(active, null);
  assert.strictEqual(active!.leaseId, "lease_1");
  assert.strictEqual(active!.ownerToken, "own_lease_1");
  assert.strictEqual(active!.accountId, "acc_1");
  assert.strictEqual(active!.generationId, "gen_x");
  assert.strictEqual(active!.acquiredAt, 500);
  assert.strictEqual(active!.deadline, 9_000);
  assert.strictEqual(active!.state, "active");
  assert.strictEqual(active!.abandonedAt, null);

  repo.markReleased("lease_1", "completed");
  assert.strictEqual(repo.getActiveForAccount("acc_1"), null);
  assert.strictEqual(repo.countActive(), 0);

  // The outcome is execution detail, not ownership: it survives the release.
  const row = db
    .prepare("SELECT state, outcome FROM account_leases WHERE lease_id = ?")
    .get("lease_1") as { state: string; outcome: string | null };
  assert.strictEqual(row.state, "released");
  assert.strictEqual(row.outcome, "completed");
});

test("LeaseRepository: abandoned leases surface to the boot-time sweep", () => {
  const repo = new LeaseRepository(db);

  repo.record(makeLease("lease_old", "acc_1", "gen_x"));
  repo.record(makeLease("lease_new", "acc_2", "gen_y"));

  // Nothing has been abandoned yet, so no sweep threshold finds anything.
  assert.deepStrictEqual(repo.listAbandonedOlderThan(Number.MAX_SAFE_INTEGER), []);

  repo.markAbandoned("lease_old");
  repo.markAbandoned("lease_new");

  // An abandoned account is no longer actively owned.
  assert.strictEqual(repo.getActiveForAccount("acc_1"), null);
  assert.strictEqual(repo.countActive(), 0);

  // Ordered by abandonment time then lease id, so the sweep is deterministic.
  const swept = repo
    .listAbandonedOlderThan(Number.MAX_SAFE_INTEGER)
    .map((lease) => lease.leaseId);
  assert.deepStrictEqual(swept, ["lease_new", "lease_old"]);

  // A threshold in the past sees nothing; the sweep only fences what is already
  // abandoned.
  assert.deepStrictEqual(repo.listAbandonedOlderThan(0), []);
});
