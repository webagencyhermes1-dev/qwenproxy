/**
 * QwenProxy runtime mode configuration.
 *
 * Three modes:
 * - legacy  : all legacy authorities (legacy behavior, byte-for-byte)
 * - shadow  : new runtime observes/validates but legacy executes
 * - runtime : new runtime is authoritative (default after flip)
 *
 * Granular flags remain as internal migration switches but their effective
 * value is derived from the mode to prevent nonsensical combinations.
 */
export type RuntimeMode = "legacy" | "shadow" | "runtime";

const MODE_ENV = "QWEN_RUNTIME_MODE";

/** Effective mode: env override > explicit mode > default legacy. */
export function getRuntimeMode(): RuntimeMode {
  const env = process.env[MODE_ENV];
  if (env === "legacy" || env === "shadow" || env === "runtime") return env;
  return "legacy";
}

const GRANULAR_FLAGS = [
  "QWEN_RUNTIME_LEASE_AUTHORITY",
  "QWEN_BROWSER_OWNERSHIP",
  "QWEN_DURABLE_RUNTIME",
  "QWEN_READINESS_CONTROLLER",
  "QWEN_SESSION_VERSIONING",
] as const;

/**
 * Effective granular flag value (mode overrides individual env vars when set).
 * Precedence: explicit env var > mode default > legacy default (OFF).
 */
export function isFlagEnabled(flag: (typeof GRANULAR_FLAGS)[number]): boolean {
  const env = process.env[flag];
  if (env === "true" || env === "false") return env === "true";

  const mode = getRuntimeMode();
  if (mode === "runtime") return true;
  if (mode === "shadow") return true;
  return false;
}

/**
 * Validate that the effective flag combination is safe for production.
 * Throws with a clear message if an unsafe combination is detected.
 */
export function validateRuntimeFlags(): void {
  const lease = isFlagEnabled("QWEN_RUNTIME_LEASE_AUTHORITY");
  const browser = isFlagEnabled("QWEN_BROWSER_OWNERSHIP");
  const durable = isFlagEnabled("QWEN_DURABLE_RUNTIME");
  const readiness = isFlagEnabled("QWEN_READINESS_CONTROLLER");
  const sessionVersioning = isFlagEnabled("QWEN_SESSION_VERSIONING");

  const errors: string[] = [];

  // Session versioning without durable runtime: in-memory map lost on restart
  if (sessionVersioning && !durable) {
    errors.push(
      "SESSION_VERSIONING requires DURABLE_RUNTIME (in-memory activeGenerations map lost on restart; durable findActiveGenerationBySession needed)",
    );
  }

  // Readiness controller needs lease authority to gate warmups
  if (readiness && !lease) {
    errors.push(
      "READINESS_CONTROLLER requires RUNTIME_LEASE_AUTHORITY (warmup gating needs authoritative ownership)",
    );
  }

  // Browser ownership without lease authority: untracked ops
  if (browser && !lease) {
    errors.push(
      "BROWSER_OWNERSHIP requires RUNTIME_LEASE_AUTHORITY (operation registry needs authoritative lease for generation-scoped cancellation)",
    );
  }

  // Durable runtime without lease authority: leases not authoritative
  if (durable && !lease) {
    errors.push(
      "DURABLE_RUNTIME requires RUNTIME_LEASE_AUTHORITY (crash recovery needs authoritative lease ownership)",
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid QWEN_RUNTIME_MODE flag combination:\n  - ${errors.join("\n  - ")}`,
    );
  }
}

export function getEffectiveFlags(): Record<string, boolean> {
  return Object.fromEntries(
    GRANULAR_FLAGS.map((f) => [f, isFlagEnabled(f)]),
  );
}

/** Check if runtime mode is authoritative (not legacy). */
export function isRuntimeMode(): boolean {
  return getRuntimeMode() === "runtime";
}

/** Check if shadow mode (observes but doesn't execute). */
export function isShadowMode(): boolean {
  return getRuntimeMode() === "shadow";
}

/** Check if legacy mode. */
export function isLegacyMode(): boolean {
  return getRuntimeMode() === "legacy";
}