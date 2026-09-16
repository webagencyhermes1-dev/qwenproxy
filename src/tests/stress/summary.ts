/**
 * Appendix-G stress harness summary registry. Every scenario records a
 * machine-readable result here; printStressSummary() renders the eight
 * invariants with their measured counts (all must be zero).
 */

export type InvariantName =
  | "duplicateAccountGeneration"
  | "duplicateLeaseOwner"
  | "orphanLease"
  | "detachedBrowserGeneration"
  | "duplicateWarmup"
  | "invalidToolRound"
  | "oversizedPayloadSent"
  | "unboundedCompactionLoop";

export type InvariantCounts = Record<InvariantName, number>;

export const INVARIANT_LABELS: Readonly<Record<InvariantName, string>> = {
  duplicateAccountGeneration: "duplicate account generation",
  duplicateLeaseOwner: "duplicate lease owner",
  orphanLease: "orphan lease",
  detachedBrowserGeneration: "detached browser generation",
  duplicateWarmup: "duplicate warmup",
  invalidToolRound: "invalid tool round",
  oversizedPayloadSent: "oversized payload sent",
  unboundedCompactionLoop: "unbounded compaction loop",
};

export const INVARIANT_NAMES: readonly InvariantName[] = [
  "duplicateAccountGeneration",
  "duplicateLeaseOwner",
  "orphanLease",
  "detachedBrowserGeneration",
  "duplicateWarmup",
  "invalidToolRound",
  "oversizedPayloadSent",
  "unboundedCompactionLoop",
];

export interface ScenarioResult {
  readonly scenario: string;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly invariants: InvariantCounts;
  readonly metrics: Readonly<Record<string, number>>;
}

const registry: ScenarioResult[] = [];

export function registerScenarioResult(result: ScenarioResult): void {
  registry.push(result);
}

export function getStressRegistry(): readonly ScenarioResult[] {
  return registry;
}

export function zeroInvariantCounts(): InvariantCounts {
  return {
    duplicateAccountGeneration: 0,
    duplicateLeaseOwner: 0,
    orphanLease: 0,
    detachedBrowserGeneration: 0,
    duplicateWarmup: 0,
    invalidToolRound: 0,
    oversizedPayloadSent: 0,
    unboundedCompactionLoop: 0,
  };
}

export function addInvariantCounts(
  into: InvariantCounts,
  add: Readonly<InvariantCounts>,
): InvariantCounts {
  for (const name of INVARIANT_NAMES) {
    into[name] = into[name] + (add[name] ?? 0);
  }
  return into;
}

/**
 * Per-scenario recorder: scenarios wrap every sub-test body in `track` so the
 * machine-readable summary carries pass/fail counts alongside the invariants.
 */
export interface ScenarioRecorder {
  readonly name: string;
  track(name: string, fn: () => void | Promise<void>): () => Promise<void>;
  finalize(): ScenarioResult;
}

export function newScenarioRecorder(
  name: string,
  counters: { counts: InvariantCounts; metrics: Readonly<Record<string, number>> },
): ScenarioRecorder {
  const startedAt = Date.now();
  let passed = 0;
  let failed = 0;
  return {
    name,
    track: (_name, fn) => async () => {
      try {
        await fn();
        passed += 1;
      } catch (err) {
        failed += 1;
        throw err;
      }
    },
    finalize: () => ({
      scenario: name,
      passed,
      failed,
      durationMs: Date.now() - startedAt,
      invariants: { ...counters.counts },
      metrics: { ...counters.metrics },
    }),
  };
}

export function printStressSummary(): void {
  const rows = getStressRegistry();
  if (rows.length === 0) return;
  const line = "-".repeat(118);
  console.log(line);
  console.log("Appendix G stress summary");
  console.log(line);
  const totals: InvariantCounts = zeroInvariantCounts();
  let passed = 0;
  let failed = 0;
  for (const r of rows) {
    passed += r.passed;
    failed += r.failed;
    addInvariantCounts(totals, r.invariants);
  }
  const head = [
    "scenario".padEnd(26),
    "pass".padStart(5),
    "fail".padStart(5),
    ...INVARIANT_NAMES.map((n) => INVARIANT_LABELS[n].slice(0, 12).padStart(13)),
  ].join("");
  console.log(head);
  console.log(line);
  for (const r of rows) {
    console.log(
      [
        r.scenario.slice(0, 26).padEnd(26),
        String(r.passed).padStart(5),
        String(r.failed).padStart(5),
        ...INVARIANT_NAMES.map((n) => String(r.invariants[n] ?? 0).padStart(13)),
      ].join(""),
    );
  }
  console.log(line);
  console.log(
    [
      "TOTAL".padEnd(26),
      String(passed).padStart(5),
      String(failed).padStart(5),
      ...INVARIANT_NAMES.map((n) => String(totals[n]).padStart(13)),
    ].join(""),
  );
  const allZero = INVARIANT_NAMES.every((n) => totals[n] === 0);
  console.log(`ALL INVARIANTS ZERO: ${allZero}`);
  for (const r of rows) {
    const entries = Object.entries(r.metrics);
    if (entries.length > 0) {
      console.log(
        `  metrics[${r.scenario}]: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`,
      );
    }
  }
  console.log(line);
}
