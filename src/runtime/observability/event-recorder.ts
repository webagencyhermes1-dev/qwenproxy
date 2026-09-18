import {
  SENSITIVE_ATTRIBUTE_KEYS,
  isSensitiveAttributeKey,
  runtimeEvent,
} from "../../domain/events.ts";
import type {
  RuntimeEvent,
  RuntimeEventIdentity,
  RuntimeEventName,
} from "../../domain/events.ts";

export interface EventSink {
  record(event: RuntimeEvent): void | Promise<void>;
}

export type EventAttributeValue = string | number | boolean | null;
export type EventAttributes = Record<string, EventAttributeValue>;

const RING_CAPACITY = 500;
const MAX_ATTRIBUTE_VALUE_LENGTH = 128;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk[-_]/,
  /^pk[-_]/,
  /^Bearer\s+/i,
  /^Basic\s+/i,
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
];

const LIFECYCLE_STAGE_EVENTS: Record<string, RuntimeEventName> = {
  created: "GENERATION_CREATED",
  reserved: "GENERATION_RESERVED",
  started: "GENERATION_STARTED",
  firstToken: "GENERATION_FIRST_TOKEN",
  toolCall: "GENERATION_TOOL_CALL",
  toolResult: "GENERATION_TOOL_RESULT",
  failover: "GENERATION_FAILOVER",
  completed: "GENERATION_COMPLETED",
  failed: "GENERATION_FAILED",
  cancelled: "GENERATION_CANCELLED",
  abandoned: "GENERATION_ABANDONED",
};

function isSensitiveKey(key: string): boolean {
  if (isSensitiveAttributeKey(key)) return true;
  const normalized = key.toLowerCase();
  return (SENSITIVE_ATTRIBUTE_KEYS as readonly string[]).some((forbidden) => {
    const f = forbidden.toLowerCase();
    return normalized.startsWith(f) || normalized.endsWith(f);
  });
}

function sanitizeValue(value: EventAttributeValue): EventAttributeValue {
  if (typeof value !== "string") return value;
  if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) return "[redacted]";
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return "[redacted]";
  }
  return value;
}

function sanitizeAttributes(attributes: EventAttributes): EventAttributes {
  const sanitized: EventAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isSensitiveKey(key)) continue;
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

export class EventRecorder {
  private readonly ring: RuntimeEvent[] = [];
  private writeIndex = 0;
  private totalWritten = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly sink?: EventSink) {}

  record(
    name: RuntimeEventName,
    identity: RuntimeEventIdentity,
    attributes?: EventAttributes,
  ): RuntimeEvent {
    const sanitized = attributes ? sanitizeAttributes(attributes) : undefined;
    const event = runtimeEvent(name, identity, sanitized);
    this.push(event);
    this.deliver(event);
    return event;
  }

  recordGenerationLifecycle(
    stage: string,
    identity: RuntimeEventIdentity,
    attributes?: EventAttributes,
  ): RuntimeEvent {
    const name = LIFECYCLE_STAGE_EVENTS[stage] ?? "GENERATION_CREATED";
    return this.record(name, identity, attributes);
  }

  recentEvents(filter?: (event: RuntimeEvent) => boolean): RuntimeEvent[] {
    const size = Math.min(this.totalWritten, RING_CAPACITY);
    const start =
      this.totalWritten <= RING_CAPACITY ? 0 : this.writeIndex;
    const events: RuntimeEvent[] = [];
    for (let i = 0; i < size; i++) {
      events.push(this.ring[(start + i) % RING_CAPACITY]);
    }
    return filter ? events.filter(filter) : events;
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private push(event: RuntimeEvent): void {
    if (this.totalWritten < RING_CAPACITY) {
      this.ring.push(event);
    } else {
      this.ring[this.writeIndex] = event;
    }
    this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY;
    this.totalWritten++;
  }

  private deliver(event: RuntimeEvent): void {
    if (!this.sink) return;
    let result: void | Promise<void>;
    try {
      result = this.sink.record(event);
    } catch {
      return;
    }
    if (
      result != null &&
      typeof (result as Promise<void>).then === "function"
    ) {
      const p = result as Promise<void>;
      this.pending = this.pending.then(() => p).then(undefined, () => {});
    }
  }
}
