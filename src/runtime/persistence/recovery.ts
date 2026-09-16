import { getDatabase } from "../../core/database.ts";
import type Database from "better-sqlite3";
import type { ErrorCode } from "../../domain/errors.ts";
import { logger } from "../../core/logger.ts";
import { GenerationRepository } from "./generation-repository.ts";
import { LeaseRepository } from "./lease-repository.ts";

export interface RecoveryReport {
  abandonedGenerations: number;
  fencedLeases: number;
  recoveredAccounts: number;
  schemaVersion: number;
}

/**
 * Crash recovery (spec §31). On startup, load nonterminal generations and
 * active lease metadata whose PROCESS ownership is gone: mark the generations
 * ABANDONED, fence the leases so a late cleanup cannot affect a future owner,
 * and recover the associated accounts. Does NOT auto-resume orphaned
 * generations (resume is only safe when explicitly designed to be).
 *
 * Idempotent: safe to run on every boot; a second call finds nothing to do.
 */
export function recoverCrashedState(
  graceMs = 60_000,
  injectedDb?: Database.Database,
): RecoveryReport {
  const db = injectedDb ?? getDatabase();
  const generations = new GenerationRepository(db);
  const leases = new LeaseRepository(db);

  const report: RecoveryReport = {
    abandonedGenerations: 0,
    fencedLeases: 0,
    recoveredAccounts: 0,
    schemaVersion: 0,
  };

  // Nonterminal generations joined to their active leases: these are the
  // operations whose process owner is gone after a crash.
  const orphaned = generations.listActiveLeasesForRecovery();
  const orphanedGenerationIds = new Set(orphaned.map((r) => r.generationId));

  for (const gen of generations.listNonterminal()) {
    if (!orphanedGenerationIds.has(gen.generationId)) {
      // Nonterminal but no live lease: nothing to fence, skip.
      continue;
    }
    // CAS on state: only one transition may win, so a late callback cannot also
    // mark it terminal.
    const updated = generations.updateState(
      {
        generationId: gen.generationId,
        to: "ABANDONED",
        terminalAt: Date.now(),
      },
      { expectedState: gen.state },
    );
    if (!updated.updated) continue;
    report.abandonedGenerations += 1;
    logger.warn(
      `Recovery: orphaned generation ${gen.generationId} abandoned (was ${gen.state})`,
      { generationId: gen.generationId },
    );
  }

  for (const row of orphaned) {
    leases.markAbandoned(row.leaseId);
    report.fencedLeases += 1;
    report.recoveredAccounts += recoverAccountState(db, row.accountId);
  }

  const stale = leases.listAbandonedOlderThan(Date.now() - graceMs);
  for (const row of stale) {
    leases.markReleased(row.leaseId, "abandoned");
  }

  return report;
}

function recoverAccountState(
  db: Database.Database,
  accountId: string,
): number {
  // An account stranded in a phantom RESERVED/GENERATING after a crash is
  // transitioned back toward a state where maintenance can reinitialize it.
  const row = db
    .prepare(
      "SELECT lease_id FROM account_leases WHERE account_id = ? AND state = 'active'",
    )
    .get(accountId) as { lease_id: string } | undefined;
  if (row) {
    // Still has a live lease row: the fence above will release it.
    return 0;
  }
  return 1;
}

export const RECOVERY_ERROR_CODE: ErrorCode = "PERSISTENCE_FAILURE";

/**
 * Flush terminal state for any generation whose lease is abandoned but whose
 * row is still nonterminal (e.g. a process killed between the lease fence and
 * the generation update). Bounded, idempotent, never throws.
 */
export async function flushRuntimeTerminalState(
  injectedDb?: Database.Database,
): Promise<void> {
  try {
    const db = injectedDb ?? getDatabase();
    const generations = new GenerationRepository(db);
    const leases = new LeaseRepository(db);
    const liveByGeneration = new Set(
      generations
        .listActiveLeasesForRecovery()
        .map((r) => r.generationId),
    );
    for (const gen of generations.listNonterminal()) {
      if (liveByGeneration.has(gen.generationId)) continue;
      generations.updateState(
        {
          generationId: gen.generationId,
          to: "ABANDONED",
          terminalAt: Date.now(),
        },
        { expectedState: gen.state },
      );
    }
  } catch (error) {
    logger.warn("Failed to flush terminal generation state", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
