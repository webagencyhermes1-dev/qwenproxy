import {
  ACCOUNT_STATE_METRICS,
  METRIC_DEFINITION,
  assertBoundedDimensions,
} from "../../domain/metrics.ts";
import type { MetricKind, MetricName } from "../../domain/metrics.ts";
import type { AccountStatus } from "../../domain/types.ts";
import { logger } from "../../core/logger.ts";

const HIGH_CARDINALITY_DIMENSIONS = [
  "accountId",
  "generationId",
  "requestId",
  "sessionId",
  "attemptId",
  "leaseId",
  "messageId",
] as const;

export type MetricSink = (
  name: MetricName,
  value: number,
  dimensions?: Record<string, string>,
) => void;

export interface MetricsEmitterOptions {
  onMetric?: MetricSink;
  strictDimensions?: boolean;
}

export class MetricsEmitter {
  private readonly sink?: MetricSink;
  private readonly strictDimensions: boolean;

  constructor(options: MetricsEmitterOptions = {}) {
    this.sink = options.onMetric;
    this.strictDimensions = options.strictDimensions ?? process.env.NODE_ENV === "test";
  }

  incrementCounter(
    name: MetricName,
    value = 1,
    dimensions?: Record<string, string>,
  ): void {
    this.emit(name, "counter", value, dimensions);
  }

  setGauge(
    name: MetricName,
    value: number,
    dimensions?: Record<string, string>,
  ): void {
    this.emit(name, "gauge", value, dimensions);
  }

  observeHistogram(
    name: MetricName,
    value: number,
    dimensions?: Record<string, string>,
  ): void {
    this.emit(name, "histogram", value, dimensions);
  }

  recordTimingMs(
    name: MetricName,
    ms: number,
    dimensions?: Record<string, string>,
  ): void {
    this.emit(name, "histogram", ms, dimensions);
  }

  accountStateGauge(accountStatus: AccountStatus, count: number): void {
    const metric = ACCOUNT_STATE_METRICS[accountStatus];
    if (metric === null || metric === undefined) return;
    this.setGauge(metric, count);
  }

  private emit(
    name: MetricName,
    kind: MetricKind,
    value: number,
    dimensions?: Record<string, string>,
  ): void {
    const definition = METRIC_DEFINITION[name];
    if (definition.kind !== kind) {
      throw new Error(`Metric "${name}" is a ${definition.kind}, not a ${kind}`);
    }

    const rejected = (dimensions ? Object.keys(dimensions) : []).filter((key) =>
      (HIGH_CARDINALITY_DIMENSIONS as readonly string[]).includes(key),
    );
    if (rejected.length > 0) {
      const message =
        `High-cardinality dimension(s) rejected for metric "${name}": ` +
        `${rejected.join(", ")}`;
      if (this.strictDimensions) {
        throw new Error(message);
      }
      logger.warn(message);
      dimensions = filterKeys(dimensions, rejected);
    }

    assertBoundedDimensions(name, dimensions ? Object.keys(dimensions) : []);

    if (this.sink) {
      this.sink(name, value, dimensions);
    } else {
      logger.debug(`metric ${name}`, { value, dimensions });
    }
  }
}

function filterKeys(
  dimensions: Record<string, string> | undefined,
  drop: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (dimensions) {
    for (const [key, value] of Object.entries(dimensions)) {
      if (!drop.includes(key)) {
        out[key] = value;
      }
    }
  }
  return out;
}
