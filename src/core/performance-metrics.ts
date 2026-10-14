import { EventEmitter } from "events";
import { loadUsageTotals, recordUsagePersist } from "./usage-tracker.ts";

interface RequestMetrics {
  timestamp: number;
  durationMs: number;
  ttfbMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface RollingStats {
  avgLatencyMs: number;
  avgTtfbMs: number;
  tokensPerSecond: number;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

export class PerformanceMetrics extends EventEmitter {
  private requestHistory: RequestMetrics[] = [];
  private readonly maxHistorySize = 100;
  private totalRequests = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;

  constructor() {
    super();
    // Durable totals: the cumulative counters must survive a restart, so the
    // all-time baseline is restored from SQLite before this process records
    // anything. The DB write itself is coalesced (see usage-tracker) so the
    // request path never blocks on it.
    const persisted = loadUsageTotals();
    this.totalRequests = persisted.totalRequests;
    this.totalPromptTokens = persisted.totalPromptTokens;
    this.totalCompletionTokens = persisted.totalCompletionTokens;
    this.totalTokens = persisted.totalTokens;
  }

  recordRequest(metrics: RequestMetrics): void {
    this.requestHistory.push(metrics);
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }

    this.totalRequests++;
    this.totalPromptTokens += metrics.promptTokens;
    this.totalCompletionTokens += metrics.completionTokens;
    this.totalTokens += metrics.totalTokens;

    recordUsagePersist(
      metrics.promptTokens,
      metrics.completionTokens,
      metrics.totalTokens,
    );

    this.emit("update", this.getSnapshot());
  }

  getSnapshot(): RollingStats & {
    uptimeSeconds: number;
    recentRequests: number;
  } {
    const now = Date.now();
    const recent = this.requestHistory.filter(
      (r) => now - r.timestamp < 60000
    );

    const recentCount = recent.length;
    const recentDurationMs = recent.reduce((sum, r) => sum + r.durationMs, 0);
    const recentTtfbMs = recent.reduce((sum, r) => sum + r.ttfbMs, 0);
    const recentCompletionTokens = recent.reduce(
      (sum, r) => sum + r.completionTokens,
      0
    );

    const avgLatencyMs = recentCount > 0 ? recentDurationMs / recentCount : 0;
    const avgTtfbMs = recentCount > 0 ? recentTtfbMs / recentCount : 0;
    const tokensPerSecond =
      recentDurationMs > 0
        ? (recentCompletionTokens / recentDurationMs) * 1000
        : 0;

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      recentRequests: recentCount,
      avgLatencyMs: Math.round(avgLatencyMs * 10) / 10,
      avgTtfbMs: Math.round(avgTtfbMs * 10) / 10,
      tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
      totalRequests: this.totalRequests,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
    };
  }

  reset(): void {
    this.requestHistory = [];
    this.totalRequests = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalTokens = 0;
    this.emit("reset", {});
  }
}

export const performanceMetrics = new PerformanceMetrics();