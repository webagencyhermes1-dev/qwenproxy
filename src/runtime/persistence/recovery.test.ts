import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { NEW_TABLE_DDL } from "./schema.ts";
import { runVersionedMigrations } from "./migrations.ts";
import { recoverCrashedState, flushRuntimeTerminalState } from "./recovery.ts";
import { GenerationRepository } from "./generation-repository.ts";
import { LeaseRepository } from "./lease-repository.ts";
import { newGenerationId, newLeaseId, newOwnerToken } from "../../domain/ids.ts";

function mkDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  for (const ddl of NEW_TABLE_DDL) db.exec(ddl);
  return db;
}

function seedOrphan(
  db: Database.Database,
  state: "QUEUED" | "RESERVING" | "STREAMING" = "STREAMING",
): { generationId: string; leaseId: string; accountId: string } {
  const generations = new GenerationRepository(db);
  const leases = new LeaseRepository(db);
  const generationId = newGenerationId();
  const leaseId = newLeaseId();
  const accountId = "acct-orphan";
  generations.create({
    generationId,
    tenantId: "tenant",
    sessionId: "sess",
    turnId: "turn",
    sessionVersionAtStart: 1,
    deadline: Date.now() + 60_000,
  });
  generations.updateState(
    { generationId, to: state },
    { expectedState: "QUEUED" },
  );
  generations.setLease(generationId, leaseId);
  leases.record({
    leaseId,
    ownerToken: newOwnerToken(),
    accountId,
    generationId,
    acquiredAt: Date.now(),
    deadline: Date.now() + 60_000,
  });
  return { generationId, leaseId, accountId };
}

test("recoverCrashedState abandons orphaned generations and fences their leases", () => {
  const db = mkDb();
  runVersionedMigrations(db);
  const orphan = seedOrphan(db, "STREAMING");

  const report = recoverCrashedState.call(null, 0, db);

  assert.equal(report.abandonedGenerations, 1);
  assert.equal(report.fencedLeases, 1);

  const gens = new GenerationRepository(db);
  const after = gens.getById(orphan.generationId);
  assert.equal(after?.state, "ABANDONED");
  assert.ok(
    typeof after?.terminalAt === "number" && after.terminalAt > 0,
    "terminalAt must be recorded",
  );

  const leases = new LeaseRepository(db);
  assert.equal(leases.getActiveForAccount(orphan.accountId), null);
});

test("recoverCrashedState is idempotent: a second run finds nothing to do", () => {
  const db = mkDb();
  runVersionedMigrations(db);
  seedOrphan(db, "STREAMING");

  const first = recoverCrashedState.call(null, 0, db);
  assert.equal(first.abandonedGenerations, 1);
  const second = recoverCrashedState.call(null, 0, db);
  assert.equal(second.abandonedGenerations, 0);
  assert.equal(second.fencedLeases, 0);
});

test("recoverCrashedState leaves terminal generations untouched", () => {
  const db = mkDb();
  runVersionedMigrations(db);
  const generations = new GenerationRepository(db);
  const generationId = newGenerationId();
  generations.create({
    generationId,
    tenantId: "tenant",
    sessionId: "sess",
    turnId: "turn",
    sessionVersionAtStart: 1,
    deadline: Date.now() + 60_000,
  });
  generations.updateState(
    { generationId, to: "COMPLETED", terminalAt: Date.now() },
    { expectedState: "QUEUED" },
  );

  const report = recoverCrashedState.call(null, 0, db);
  assert.equal(report.abandonedGenerations, 0);
  const after = generations.getById(generationId);
  assert.equal(after?.state, "COMPLETED");
});

test("flushRuntimeTerminalState finalizes generations whose lease was fenced", async () => {
  const db = mkDb();
  runVersionedMigrations(db);
  const orphan = seedOrphan(db, "STREAMING");
  const leases = new LeaseRepository(db);
  leases.markAbandoned(orphan.leaseId);

  await flushRuntimeTerminalState.call(null, db);

  const gens = new GenerationRepository(db);
  assert.equal(gens.getById(orphan.generationId)?.state, "ABANDONED");
});

test("flushRuntimeTerminalState keeps a generation whose lease is still active", async () => {
  const db = mkDb();
  runVersionedMigrations(db);
  const orphan = seedOrphan(db, "STREAMING");

  await flushRuntimeTerminalState.call(null, db);

  const gens = new GenerationRepository(db);
  assert.equal(gens.getById(orphan.generationId)?.state, "STREAMING");
});
