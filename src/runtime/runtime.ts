/**
 * QwenProxy runtime composition root.
 *
 * Single authoritative container holding all 9 runtime components.
 * Exactly one instance per process; lazy-initialized on first access.
 */
import { config } from "../core/config.ts";
import type { IAccountOwnership } from "./contracts.ts";
import { AccountResourceManager } from "./account/resource-manager.ts";
import { SessionService } from "./session/session-service.ts";
import { GenerationCoordinator } from "./generation/generation-coordinator.ts";
import { ContextService } from "./context/context-service.ts";
import { RetryCoordinator } from "./retry/retry-coordinator.ts";
import { StreamManager } from "./stream/stream-manager.ts";
import { ReadinessController } from "./readiness/readiness-controller.ts";
import { MaintenanceScheduler } from "./maintenance/maintenance-scheduler.ts";
import { OperationRegistry } from "./browser/operation-registry.ts";
import { EventRecorder } from "./observability/event-recorder.ts";
import { getRuntimeMode, validateRuntimeFlags } from "./runtime-mode.ts";

/**
 * Immutable runtime container holding all 9 authoritative components.
 * All components are constructed exactly once per process.
 */
export interface QwenRuntime {
  readonly accountOwnership: IAccountOwnership;
  readonly sessions: SessionService;
  readonly generations: GenerationCoordinator;
  readonly retry: RetryCoordinator;
  readonly context: ContextService;
  readonly streams: StreamManager;
  readonly readiness: ReadinessController;
  readonly maintenance: MaintenanceScheduler;
  readonly browser: OperationRegistry;
  readonly events: EventRecorder;
}

/** Internal mutable state during bootstrap (not exported). */
interface RuntimeState {
  runtime: QwenRuntime | null;
  initialized: boolean;
}

const state: RuntimeState = {
  runtime: null,
  initialized: false,
};

/**
 * Construct the single runtime container with all 9 components.
 * Validates flag combinations and constructs exactly once.
 */
function buildRuntime(): QwenRuntime {
  const mode = getRuntimeMode();
  validateRuntimeFlags();

  // 1. Account ownership authority (singleton)
  const accountOwnership = new AccountResourceManager({
    capabilityResolver: config.qwen.capabilityResolver,
    targetReady: config.playwright.maxActiveContexts + 1,
  });

  // 2. Session service (singleton, shares active-generation map)
  const sessions = new SessionService();

  // 3. Generation coordinator (singleton)
  const generations = new GenerationCoordinator();

  // 4. Retry coordinator (singleton)
  const retry = new RetryCoordinator();

  // 4. Context service (stateless, can be shared)
  const context = new ContextService();

  // 5. Stream manager (factory for bounded streams)
  const streams = new StreamManager();

  // 5. Readiness controller (singleton)
  const readiness = new ReadinessController();

  // 6. Maintenance scheduler (singleton)
  const maintenance = new MaintenanceScheduler();

  // 7. Browser operation registry (singleton)
  const browser = new OperationRegistry();

  // 6. Event recorder (singleton)
  const events = new EventRecorder();

  return {
    accountOwnership,
    sessions,
    generations,
    retry,
    context,
    streams,
    readiness,
    maintenance,
    browser,
    events,
  };
}

/** Lazy-initialized singleton runtime. */
let runtimeInstance: QwenRuntime | null = null;

/**
 * Get the singleton runtime instance. Constructs on first access.
 * In production, called once during server startup via startRuntime().
 */
export function getQwenRuntime(): QwenRuntime {
  if (!runtimeInstance) {
    runtimeInstance = buildRuntime();
  }
  return runtimeInstance;
}

/** Get the runtime mode (for logging/debugging). */
export function getMode(): string {
  return getRuntimeMode();
}

/** Get effective granular flags (for logging/debugging). */
export function getFlags(): Record<string, boolean> {
  const mode = getRuntimeMode();
  return {
    QWEN_RUNTIME_LEASE_AUTHORITY: isFlagEnabled("QWEN_RUNTIME_LEASE_AUTHORITY"),
    QWEN_BROWSER_OWNERSHIP: isFlagEnabled("QWEN_BROWSER_OWNERSHIP"),
    QWEN_DURABLE_RUNTIME: isFlagEnabled("QWEN_DURABLE_RUNTIME"),
    QWEN_READINESS_CONTROLLER: isFlagEnabled("QWEN_READINESS_CONTROLLER"),
    QWEN_SESSION_VERSIONING: isFlagEnabled("QWEN_SESSION_VERSIONING"),
  };
}

/** Check if runtime mode is authoritative. */
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

// Re-export for convenience
export { getRuntimeMode, isFlagEnabled, validateRuntimeFlags, getEffectiveFlags } from "./runtime-mode.ts";

/**
 * Internal reset for tests only. Do not call in production.
 */
export function resetRuntimeForTests(): void {
  // Note: this doesn't reset component singletons, just allows rebuild
  runtimeInstance = null;
}