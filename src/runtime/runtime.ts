import type { AccountResourceManager } from "./account/resource-manager.ts";
import type { GenerationCoordinator } from "./generation/generation-coordinator.ts";
import type { GenerationRepository } from "./persistence/generation-repository.ts";
import type { RetryCoordinator } from "./retry/retry-coordinator.ts";
import type { MetricsEmitter } from "./observability/metrics-emitter.ts";
import type { EventRecorder } from "./observability/event-recorder.ts";
import type { StreamRegistry } from "./stream/stream-manager.ts";

export interface QwenRuntime {
  ownership: AccountResourceManager;
  retry: RetryCoordinator;
  generations: GenerationCoordinator;
  repository: GenerationRepository;
  streams: StreamRegistry;
  metrics: MetricsEmitter;
  events: EventRecorder;
}
