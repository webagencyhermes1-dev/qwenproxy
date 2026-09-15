import type { KeyEvent } from "./screen.ts";

export interface TuiView {
  readonly id: string;
  readonly title: string;
  readonly tabNumber: number;
  render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[];
  handleKey(key: KeyEvent): Promise<boolean | void> | boolean | void;
  onActivate?(): void;
  onDeactivate?(): void;
  getShortcuts?(): Array<{ key: string; label: string }>;
}

export interface ProxyStatusSnapshot {
  online: boolean;
  port: number;
  host: string;
  overallStatus?: string;
  uptimeSeconds?: number;
  rssMb?: number;
  systemMemoryPct?: number;
  activeStreams?: number;
  waitingStreams?: number;
  accounts: Array<{
    id: string;
    emailOrName: string;
    priority: number;
    cooldownUntil: number | null;
    onCooldown: boolean;
    remainingCooldownMs: number;
    cooldownReason?: string | null;
    headersReady: boolean;
    isInitialized?: boolean;
    /** Pool 2.0 lifecycle state (derived, never a credential). */
    state?: string;
    health?: number;
    activeStreams?: number;
    requests?: number;
    success?: number;
    failure?: number;
    lastUsed?: number | null;
  }>;
  pool?: {
    total: number;
    ready: number;
    warming: number;
    busy: number;
    cooldown: number;
    authError: number;
    broken: number;
    disabled: number;
    activeStreams: number;
    queued: number;
    successRate: number;
    averageHealth: number;
  } | null;
  performance?: {
    avgLatencyMs: number;
    avgTtfbMs: number;
    tokensPerSecond: number;
    totalRequests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    recentRequests: number;
  } | null;
}
