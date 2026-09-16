import type { AccountStatus } from "./types.ts";

export type MetricName =
  | "requests_total"
  | "requests_success_total"
  | "requests_failed_total"
  | "queue_depth"
  | "queue_wait_ms"
  | "account_reservation_wait_ms"
  | "generation_active"
  | "generation_queued"
  | "generation_duration_ms"
  | "generation_first_token_ms"
  | "account_ready"
  | "account_warming"
  | "account_reserved"
  | "account_generating"
  | "account_cooldown"
  | "account_failed"
  | "failover_total"
  | "retry_total"
  | "retry_escalation_total"
  | "context_compaction_total"
  | "context_compaction_failure_total"
  | "context_estimated_tokens"
  | "browser_startup_ms"
  | "browser_timeout_total"
  | "header_capture_timeout_total"
  | "warmup_duration_ms"
  | "warmup_failure_total";

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  kind: MetricKind;
  help: string;
  boundedDimensions: readonly string[];
}

export const METRIC_DEFINITION: Record<MetricName, MetricDefinition> = {
  requests_total: {
    kind: "counter",
    help: "Total API requests received by the gateway",
    boundedDimensions: ["model", "outcome", "error_code"],
  },
  requests_success_total: {
    kind: "counter",
    help: "Requests completed successfully",
    boundedDimensions: ["model"],
  },
  requests_failed_total: {
    kind: "counter",
    help: "Requests that failed before a successful response",
    boundedDimensions: ["model", "error_code"],
  },
  queue_depth: {
    kind: "gauge",
    help: "Requests currently waiting in the admission queue",
    boundedDimensions: ["model"],
  },
  queue_wait_ms: {
    kind: "histogram",
    help: "Time spent waiting in the admission queue (ms)",
    boundedDimensions: ["model"],
  },
  account_reservation_wait_ms: {
    kind: "histogram",
    help: "Time spent waiting for an account reservation (ms)",
    boundedDimensions: ["account_state"],
  },
  generation_active: {
    kind: "gauge",
    help: "In-flight generation streams",
    boundedDimensions: ["model"],
  },
  generation_queued: {
    kind: "gauge",
    help: "Generations queued behind concurrency limits",
    boundedDimensions: ["model"],
  },
  generation_duration_ms: {
    kind: "histogram",
    help: "End-to-end generation duration (ms)",
    boundedDimensions: ["model"],
  },
  generation_first_token_ms: {
    kind: "histogram",
    help: "Time to first token for generation streams (ms)",
    boundedDimensions: ["model"],
  },
  account_ready: {
    kind: "gauge",
    help: "Accounts currently in READY state",
    boundedDimensions: [],
  },
  account_warming: {
    kind: "gauge",
    help: "Accounts currently in WARMING state",
    boundedDimensions: [],
  },
  account_reserved: {
    kind: "gauge",
    help: "Accounts currently in RESERVED state",
    boundedDimensions: [],
  },
  account_generating: {
    kind: "gauge",
    help: "Accounts currently in GENERATING state",
    boundedDimensions: [],
  },
  account_cooldown: {
    kind: "gauge",
    help: "Accounts currently in COOLDOWN state",
    boundedDimensions: [],
  },
  account_failed: {
    kind: "gauge",
    help: "Accounts currently in FAILED state",
    boundedDimensions: [],
  },
  failover_total: {
    kind: "counter",
    help: "Account failovers triggered by upstream failure",
    boundedDimensions: ["error_code"],
  },
  retry_total: {
    kind: "counter",
    help: "Request retries attempted",
    boundedDimensions: ["error_code"],
  },
  retry_escalation_total: {
    kind: "counter",
    help: "Retries escalated across accounts or models",
    boundedDimensions: ["error_code", "phase"],
  },
  context_compaction_total: {
    kind: "counter",
    help: "Context compaction (truncation or summarization) runs",
    boundedDimensions: ["model"],
  },
  context_compaction_failure_total: {
    kind: "counter",
    help: "Context compaction runs that failed",
    boundedDimensions: ["error_code"],
  },
  context_estimated_tokens: {
    kind: "gauge",
    help: "Estimated token usage of the active request context",
    boundedDimensions: ["model", "measurement_source"],
  },
  browser_startup_ms: {
    kind: "histogram",
    help: "Browser cold-start duration (ms)",
    boundedDimensions: ["measurement_source"],
  },
  browser_timeout_total: {
    kind: "counter",
    help: "Browser session timeouts",
    boundedDimensions: ["error_code"],
  },
  header_capture_timeout_total: {
    kind: "counter",
    help: "Header capture (session bootstrap) timeouts",
    boundedDimensions: ["error_code"],
  },
  warmup_duration_ms: {
    kind: "histogram",
    help: "Account warm-up cycle duration (ms)",
    boundedDimensions: ["measurement_source"],
  },
  warmup_failure_total: {
    kind: "counter",
    help: "Account warm-up cycles that failed",
    boundedDimensions: ["error_code"],
  },
};

export function isAllowedDimension(
  metric: MetricName,
  dimension: string,
): boolean {
  return METRIC_DEFINITION[metric].boundedDimensions.includes(dimension);
}

export function assertBoundedDimensions(
  metric: MetricName,
  dimensions: string[],
): void {
  for (const dimension of dimensions) {
    if (!isAllowedDimension(metric, dimension)) {
      const allowed = METRIC_DEFINITION[metric].boundedDimensions.join(", ");
      throw new Error(
        `Dimension "${dimension}" is not allowed for metric "${metric}"; allowed dimensions: ${allowed}`,
      );
    }
  }
}

export const ACCOUNT_STATE_METRICS: Readonly<Record<AccountStatus, MetricName | null>> = {
  DISABLED: null,
  STANDBY: null,
  WARMING: "account_warming",
  READY: "account_ready",
  RESERVED: "account_reserved",
  GENERATING: "account_generating",
  DRAINING: null,
  RECOVERING: null,
  COOLDOWN: "account_cooldown",
  FAILED: "account_failed",
};
