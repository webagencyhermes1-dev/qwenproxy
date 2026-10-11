/**
 * QwenProxy TUI - Proxy Data Provider & Live State Client
 * Uses HTTP API for status - no direct DB access
 */

import { config, type ChatMode } from "../core/config.ts";

/**
 * Auth headers for TUI→server calls (health polls, control endpoints).
 * Attaches the configured API key when one exists; without a key the server
 * leaves operational routes open (keyless localhost dev) so nothing is sent.
 */
export function tuiAuthHeaders(): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
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

export function maskAccountIdentifier(idOrEmail: string): string {
  if (!idOrEmail) return "unknown";
  if (idOrEmail.includes("@")) {
    const [user, domain] = idOrEmail.split("@");
    const visible = user.slice(0, 2);
    return `${visible}***@${domain}`;
  }

  if (idOrEmail.length > 8) {
    return `${idOrEmail.slice(0, 3)}***${idOrEmail.slice(-3)}`;
  }
  return idOrEmail;
}

export function formatUptime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  if (hrs > 0) {
    return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}`;
  }
  return `${pad2(mins)}:${pad2(secs)}`;
}

let pollInFlight: Promise<void> | null = null;
let lastPollStartedAt = 0;
let cachedStatus: ProxyStatusSnapshot | null = null;
let lastStatusTime = 0;

/** Minimum spacing between two /health polls (the app polls every second). */
const POLL_MIN_INTERVAL_MS = 1000;
/**
 * Budget for a /health round-trip. The old 350ms budget was tighter than a
 * busy server can reliably meet, so a loaded instance looked "dead" and the
 * TUI dropped back to an empty account list while it was serving fine.
 */
const HEALTH_TIMEOUT_MS = 1000;
/**
 * How long the last successful snapshot is served as-is. Beyond it the data is
 * still returned (marked offline) instead of being replaced by an empty list —
 * losing the account rows is what made the Accounts tab flicker to "No
 * accounts configured" whenever the server was restarting or momentarily slow.
 */
const LAST_KNOWN_MAX_AGE_MS = 15000;

async function fetchHealth(): Promise<any> {
  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const resp = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
      headers: tuiAuthHeaders(),
    });
    clearTimeout(timeout);

    if (resp.ok) {
      return await resp.json();
    }
  } catch {
    clearTimeout(timeout);
  }

  return null;
}

function offlineSnapshot(): ProxyStatusSnapshot {
  return {
    online: false,
    port: config.server?.port || 7936,
    host: config.server?.host || "127.0.0.1",
    overallStatus: "offline",
    uptimeSeconds: process.uptime(),
    rssMb: 0,
    systemMemoryPct: 0,
    activeStreams: 0,
    waitingStreams: 0,
    accounts: [],
    pool: null,
    performance: null,
  };
}

/**
 * Maps one `/health` payload onto a snapshot, using `previous` to survive a
 * degraded read: /health builds its account rows inside a best-effort block,
 * so it can answer 200 with `accounts: []` while the pool still reports rows.
 * Reporting that as "no accounts" is what made the Accounts tab flicker, so a
 * contradictory payload keeps the rows we already had.
 */
export function buildStatusSnapshot(
  healthData: any,
  previous: ProxyStatusSnapshot | null,
): ProxyStatusSnapshot {
  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";

  const reported = Array.isArray(healthData?.accounts) ? healthData.accounts : [];
  const poolTotal = Number(healthData?.pool?.total ?? 0);
  const keepLastAccounts =
    reported.length === 0 &&
    previous !== null &&
    previous.accounts.length > 0 &&
    (poolTotal > 0 || !healthData?.pool);

  const accounts = keepLastAccounts
    ? previous!.accounts
    : reported.map((acc: any) => {
        // Use rawId if available, otherwise use id (masked)
        const accountId = acc.rawId || acc.id || "";
        // Use account field for email, or fall back to email field
        const emailOrName = maskAccountIdentifier(acc.account || acc.email || accountId || "");

        return {
          id: accountId,
          emailOrName,
          priority: 1,
          cooldownUntil: acc.cooldownUntil || null,
          onCooldown: Boolean(acc.onCooldown),
          remainingCooldownMs: acc.cooldownRemainingMs || acc.remainingCooldownMs || 0,
          cooldownReason: acc.cooldownReason || null,
          headersReady: Boolean(acc.headersReady),
          isInitialized: Boolean(acc.isInitialized),
          state: acc.state || "READY",
          health: acc.health || 100,
          activeStreams: acc.activeStreams || 0,
          requests: acc.requests || 0,
          success: acc.success || 0,
          failure: acc.failure || 0,
          lastUsed: acc.lastUsed || null,
        };
      });

  return {
    online: true,
    port,
    host,
    overallStatus: healthData?.status || "healthy",
    uptimeSeconds: healthData?.uptimeSeconds,
    rssMb: healthData?.rssMb,
    systemMemoryPct: healthData?.systemMemoryPct,
    activeStreams: healthData?.activeStreams,
    waitingStreams: healthData?.waitingStreams,
    accounts,
    pool: healthData?.pool ? {
      total: healthData.pool.total,
      ready: healthData.pool.ready,
      warming: healthData.pool.warming,
      busy: healthData.pool.busy,
      cooldown: healthData.pool.cooldown,
      authError: healthData.pool.authError,
      broken: healthData.pool.broken,
      disabled: healthData.pool.disabled,
      activeStreams: healthData.pool.activeStreams,
      queued: healthData.pool.queued,
      successRate: healthData.pool.successRate,
      averageHealth: healthData.pool.averageHealth,
    } : null,
    performance: healthData?.performance || null,
  };
}

/** One poll. Never throws; failures simply leave the previous snapshot alone. */
async function pollHealth(): Promise<void> {
  try {
    const healthData = await fetchHealth();
    if (!healthData) return;

    cachedStatus = buildStatusSnapshot(healthData, cachedStatus);
    lastStatusTime = Date.now();
  } catch {}
}

export async function fetchProxyStatus(): Promise<ProxyStatusSnapshot> {
  const now = Date.now();

  // Single-flight polling: callers coalesce onto one in-flight request instead
  // of stacking overlapping ones (the old mutex let a second poll start while
  // the first was still running).
  let startedHere = false;
  if (!pollInFlight && now - lastPollStartedAt >= POLL_MIN_INTERVAL_MS) {
    lastPollStartedAt = now;
    pollInFlight = pollHealth().finally(() => {
      pollInFlight = null;
    });
    startedHere = true;
  }

  // Only the caller that starts a poll waits for it (the periodic status
  // poller, which should paint fresh data). Keypress-driven refreshes reuse
  // the cache instead of stalling on a slow server; with no cache yet every
  // caller waits so the first frame is not drawn as "offline".
  if ((startedHere || !cachedStatus) && pollInFlight) {
    await pollInFlight;
  }

  if (!cachedStatus) {
    return offlineSnapshot();
  }

  if (Date.now() - lastStatusTime <= LAST_KNOWN_MAX_AGE_MS) {
    return cachedStatus;
  }

  // Server stopped answering: keep the last-known accounts/pool, only flag the
  // snapshot as offline so views can show the state without losing the list.
  return { ...cachedStatus, online: false, overallStatus: "offline" };
}

export interface StreamChatOptions {
  model: string;
  reasoning_effort?: "low" | "medium" | "high";
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  chatMode?: ChatMode;
  onToken: (text: string) => void;
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}

export async function streamChatCompletions(
  options: StreamChatOptions,
): Promise<{ totalTimeMs: number; ttfbMs: number }> {
  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";
  const apiKey = config.apiKey || "sk-qwenproxy-local";

  const startTime = Date.now();
  let ttfbMs = 0;

  let resp: Response;
  try {
    const chatMode = options.chatMode ?? "temp-thread";
    resp = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-qwenproxy-chat-mode": chatMode,
      },
      body: JSON.stringify({
        model: options.model,
        reasoning_effort: options.reasoning_effort,
        messages: options.messages,
        stream: true,
      }),
      signal: options.signal,
    });
  } catch (fetchErr: any) {
    if (fetchErr?.name === "AbortError" || options.signal?.aborted) {
      throw fetchErr;
    }
    throw new Error(
      `QwenProxy server is starting or unavailable (:7936). Check status or the [6] Logs tab.`,
    );
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${errText}`);
  }

  if (!resp.body) {
    throw new Error("No response body received from proxy");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (ttfbMs === 0) {
      ttfbMs = Date.now() - startTime;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.replace(/^data:\s*/, "").trim();
      if (dataStr === "[DONE]") break;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.reasoning_content && options.onReasoning) {
          options.onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          options.onToken(delta.content);
        }
      } catch {}
    }
  }

  return {
    totalTimeMs: Date.now() - startTime,
    ttfbMs: ttfbMs || Date.now() - startTime,
  };
}

let cachedLiveModels: string[] | null = null;
let liveModelsPromise: Promise<string[]> | null = null;

const DEFAULT_FALLBACK_MODELS = [
  "qwen3.8-max",
  "qwen3.7-plus",
  "qwen3.7-max",
  "z-image-turbo",
  "qwen-image-3.0-pro",
  "qwen-image-3.0",
  "wan2.7-image-pro",
  "wan2.7-image",
  "wan3.0-video",
  "wan2.7-t2v",
];

export async function fetchLiveModels(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh && cachedLiveModels && cachedLiveModels.length > 0) {
    return cachedLiveModels;
  }

  if (liveModelsPromise) {
    return liveModelsPromise;
  }

  const port = config.server?.port || 7936;
  const configuredHost = config.server?.host;
  const host = configuredHost && configuredHost !== "0.0.0.0" ? configuredHost : "127.0.0.1";
  const apiKey = config.apiKey || "sk-qwenproxy-local";

  liveModelsPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const resp = await fetch(`http://${host}:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (resp.ok) {
        const json = (await resp.json()) as any;
        if (Array.isArray(json?.data)) {
          const models = json.data
            .map((m: any) => m.id)
            .filter((id: any): id is string => typeof id === "string" && id.trim().length > 0)
            .filter(
              (id: string) =>
                !id.endsWith("-fast") &&
                !id.endsWith("-thinking") &&
                !id.endsWith("-no-thinking"),
            );
          if (models.length > 0) {
            cachedLiveModels = Array.from(new Set(models));
            return cachedLiveModels;
          }
        }
      }
    } catch {} finally {
      clearTimeout(timeout);
      liveModelsPromise = null;
    }
    return cachedLiveModels || DEFAULT_FALLBACK_MODELS;
  })();

  return liveModelsPromise;
}

export function resetAllCooldowns(): number {
  return 0;
}

export function resetAccountCooldownById(accountId: string): void {
  // Server-side operation only
}
