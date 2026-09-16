import { SENSITIVE_ATTRIBUTE_KEYS, runtimeEvent } from "../../domain/events.ts";
import type {
  RuntimeEvent,
  RuntimeEventIdentity,
  RuntimeEventName,
} from "../../domain/events.ts";
import { logger } from "../../core/logger.ts";

export interface EventSink {
  record(event: RuntimeEvent): void | Promise<void>;
}

type AttributeValue = string | number | boolean | null;
type Attributes = Record<string, AttributeValue>;

const REDACTED = "[redacted]";
const MAX_ATTRIBUTE_VALUE_LENGTH = 120;
const RING_BUFFER_SIZE = 500;
const SECRET_VALUE_PATTERN = /^(bearer|sk-|eyJ|session-)/i;

const SAFE_SIZED_KEYS: ReadonlySet<string> = new Set([
  "estimatedTokens",
  "durationMs",
  "firstTokenMs",
  "errorName",
  "model",
]);

const INFO_LEVEL_EVENTS: ReadonlySet<RuntimeEventName> = new Set([
  "GENERATION_COMPLETED",
  "GENERATION_FAILED",
  "GENERATION_CANCELLED",
  "GENERATION_ABANDONED",
  "ACCOUNT_STATE_CHANGED",
  "ACCOUNT_RECOVERY_COMPLETED",
  "WARMUP_COMPLETED",
  "WARMUP_FAILED",
  "CONTEXT_COMPACTED_FAILED",
  "BROWSER_OPERATION_ABORTED",
  "BROWSER_OPERATION_TIMEOUT",
]);

const GENERATION_LIFECYCLE_NAMES: Readonly<
  Record<"created" | "started" | "firstToken" | "completed" | "failed", RuntimeEventName>
> = {
  created: "GENERATION_CREATED",
  started: "GENERATION_STARTED",
  firstToken: "GENERATION_FIRST_TOKEN",
  completed: "GENERATION_COMPLETED",
  failed: "GENERATION_FAILED",
};

export interface GenerationLifecycleAttributes {
  estimatedTokens?: number;
  durationMs?: number;
  firstTokenMs?: number;
  errorName?: string;
  model?: string;
}

function isSensitiveKey(key: string): boolean {
  // Sized diagnostics emitted by recordGenerationLifecycle are a closed,
  // reviewed set: "token" appears in "estimatedTokens" incidentally. Values
  // still pass through the secret-value heuristic below.
  if (SAFE_SIZED_KEYS.has(key) || SAFE_SIZED_KEYS.has(key.toLowerCase())) {
    return false;
  }
  const normalized = key.toLowerCase();
  return (SENSITIVE_ATTRIBUTE_KEYS as readonly string[]).some((forbidden) =>
    normalized.includes(forbidden),
  );
}

function looksLikeSecret(value: string): boolean {
  return (
    value.length > MAX_ATTRIBUTE_VALUE_LENGTH || SECRET_VALUE_PATTERN.test(value)
  );
}

const defaultEventSink: EventSink = {
  record(event: RuntimeEvent): void {
    const payload: Record<string, unknown> = { ...event };
    if (INFO_LEVEL_EVENTS.has(event.name)) {
      logger.info(`event ${event.name}`, payload);
    } else {
      logger.debug(`event ${event.name}`, payload);
    }
  },
};

export class EventRecorder {
  private readonly sink: EventSink;
  private readonly ringBuffer: RuntimeEvent[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(sink?: EventSink) {
    this.sink = sink ?? defaultEventSink;
  }

  record(
    name: RuntimeEventName,
    identity: RuntimeEventIdentity,
    attributes?: Attributes,
  ): RuntimeEvent {
    const sanitized = this.sanitizeAttributes(name, attributes);
    const event = runtimeEvent(name, identity, sanitized);
    this.pushBuffer(event);
    this.dispatch(event);
    return event;
  }

  recordGenerationLifecycle(
    stage: "created" | "started" | "firstToken" | "completed" | "failed",
    identity: RuntimeEventIdentity,
    attributes?: GenerationLifecycleAttributes,
  ): RuntimeEvent {
    const sized: Attributes = {};
    if (attributes) {
      if (attributes.estimatedTokens !== undefined) {
        sized.estimatedTokens = attributes.estimatedTokens;
      }
      if (attributes.durationMs !== undefined) {
        sized.durationMs = attributes.durationMs;
      }
      if (attributes.firstTokenMs !== undefined) {
        sized.firstTokenMs = attributes.firstTokenMs;
      }
      if (attributes.errorName !== undefined) {
        sized.errorName = attributes.errorName;
      }
      if (attributes.model !== undefined) {
        sized.model = attributes.model;
      }
    }
    return this.record(GENERATION_LIFECYCLE_NAMES[stage], identity, sized);
  }

  recentEvents(filter?: (event: RuntimeEvent) => boolean): RuntimeEvent[] {
    return filter ? this.ringBuffer.filter(filter) : [...this.ringBuffer];
  }

  async flush(): Promise<void> {
    const pending = [...this.pending];
    this.pending.clear();
    await Promise.allSettled(pending);
  }

  private sanitizeAttributes(
    name: RuntimeEventName,
    attributes?: Attributes,
  ): Attributes | undefined {
    if (!attributes) return undefined;
    const sanitized: Attributes = {};
    let stripped = 0;
    let redacted = 0;
    for (const [key, value] of Object.entries(attributes)) {
      if (isSensitiveKey(key)) {
        stripped++;
        continue;
      }
      if (typeof value === "string" && looksLikeSecret(value)) {
        sanitized[key] = REDACTED;
        redacted++;
        continue;
      }
      sanitized[key] = value;
    }
    if (stripped > 0) {
      logger.warn(`Sensitive attribute key(s) stripped from event "${name}"`, {
        stripped,
      });
    }
    if (redacted > 0) {
      logger.warn(`Secret-looking attribute value(s) redacted in event "${name}"`, {
        redacted,
      });
    }
    return sanitized;
  }

  private pushBuffer(event: RuntimeEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > RING_BUFFER_SIZE) {
      this.ringBuffer.shift();
    }
  }

  private dispatch(event: RuntimeEvent): void {
    let result: void | Promise<void>;
    try {
      result = this.sink.record(event);
    } catch (error) {
      this.logSinkFailure(event.name, error);
      return;
    }
    if (result !== null && typeof result === "object" && "then" in result) {
      const tracked = result.then(undefined, (error: unknown) =>
        this.logSinkFailure(event.name, error),
      );
      this.pending.add(tracked);
      void tracked.finally(() => this.pending.delete(tracked));
    }
  }

  private logSinkFailure(name: RuntimeEventName, error: unknown): void {
    logger.error(`Event sink failed to record event "${name}"`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
