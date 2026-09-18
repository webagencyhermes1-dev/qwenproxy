import type Database from "better-sqlite3";

import { getDatabase } from "../../core/database.ts";
import { GenerationRepository } from "./generation-repository.ts";
import { LeaseRepository } from "./lease-repository.ts";
import { EPOCH_MS_NOW } from "./migrations.ts";

export interface RecoveryReport {
  abandonedGenerations: number;
  fencedLeases: number;
}

export function recoverCrashedState(
  bootTime: number,
  db: Database.Database,
): RecoveryReport {
  const generations = new GenerationRepository(db);
  const leases = new LeaseRepository(db);

  const sweep = db.transaction(() => {
    let abandonedGenerations = 0;
    for (const generation of generations.listNonterminal()) {
      const result = generations.updateState(
        {
          generationId: generation.generationId,
          to: "ABANDONED",
          terminalAt: EPOCH_MS_NOW(),
          failureCode: "CRASH_RECOVERY",
          failureReason: "generation orphaned by process crash",
        },
        { expectedState: generation.state },
      );
      if (result.updated) abandonedGenerations++;
    }

    let fencedLeases = 0;
    for (const lease of generations.listActiveLeasesForRecovery()) {
      leases.markAbandoned(lease.leaseId);
      fencedLeases++;
    }

    return { abandonedGenerations, fencedLeases };
  });

  return sweep();
}

export async function flushRuntimeTerminalState(
  db: Database.Database = getDatabase(),
): Promise<void> {
  const generations = new GenerationRepository(db);

  const activeLeaseGenerations = new Set(
    generations.listActiveLeasesForRecovery().map((lease) => lease.generationId),
  );

  for (const generation of generations.listNonterminal()) {
    if (!generation.leaseId || activeLeaseGenerations.has(generation.generationId)) {
      continue;
    }
    generations.updateState(
      {
        generationId: generation.generationId,
        to: "ABANDONED",
        terminalAt: EPOCH_MS_NOW(),
        failureCode: "LEASE_FENCED",
        failureReason: "lease fenced while generation was nonterminal",
      },
      { expectedState: generation.state },
    );
  }
}
