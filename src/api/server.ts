import crypto from "crypto";
import net from "node:net";
import os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../core/config.js";
import {
  claimDataDirLock,
  releaseDataDirLock,
  takeOverPortHolder,
} from "../core/data-dir-lock.ts";
import { metrics } from "../core/metrics.js";
import { performanceMetrics } from "../core/performance-metrics.ts";
import { logger, maskEmail } from "../core/logger.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { Watchdog } from "../core/watchdog.js";
import { getAccountCooldownInfo } from "../core/account-manager.js";
import { app as modelsApp } from "./models.js";
import { chatCompletions, chatCompletionsStop } from "../routes/chat.js";
import { uploadFile } from "../routes/upload.js";
import { imagesGenerations } from "../routes/images.js";
import { videosGenerations, videoTaskStatus } from "../routes/videos.js";
import { responsesApp } from "../routes/responses/index.js";
import { completionsLegacy } from "../routes/completions.js";
import { anthropicApp } from "../routes/anthropic/index.ts";
import { sendOpenAIError } from "./error-helpers.js";
import { withDeadline, FailFastTimeoutError } from "./fail-fast.js";
import { AuthError, NotFoundError } from "../core/errors.js";
import type { QwenAccount } from "../core/accounts.js";
import { isAuthMockEnabled } from "../services/auth-playwright.js";
import {
  noteAccountInitFailure,
  noteAccountInitSuccess,
} from "../core/account-health.js";
import {
  isAccountEffectivelyBroken,
  markAccountBroken,
  noteAccountRecovered,
} from "../core/account-state.ts";
import { constructRuntime } from "../runtime/construct.ts";
import type { RuntimeServices } from "../runtime/bootstrap.ts";
import { runWithRequestContext } from "../core/request-context.ts";
import {
  createRateLimiter,
  rateLimitMiddleware,
} from "../core/rate-limit.ts";

// Module-level state (initialized in startServer)
let cache: MemoryCache | undefined;
let watchdog: Watchdog | undefined;
let unsubscribeTransitionAudit: (() => void) | undefined;
let server: any;
let startPromise: Promise<StartedServerInfo> | null = null;
let stopPromise: Promise<void> | null = null;
let signalHandlersInstalled = false;
let runtimeServices: RuntimeServices | undefined;

const app = new Hono();

function formatAccountId(accountId: string): string {
  const normalized = accountId.trim();
  return normalized.length > 12 ? `${normalized.slice(0, 12)}…` : normalized;
}

/** True for wildcard binds that expose the server beyond loopback. */
function isPublicBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "::0";
}

function buildPortInUseMessage(
  port: number,
  host: string,
  listener?: { pid: number; commandLine?: string },
): string {
  const occupant = listener
    ? `\n   Occupied by pid ${listener.pid}${listener.commandLine ? ` — ${listener.commandLine}` : ""}` +
      `\n   Stop it: ${process.platform === "win32" ? `taskkill /PID ${listener.pid} /T /F` : `kill ${listener.pid}`}`
    : `\n   Another QwenProxy instance (or another program) is listening on this port.`;
  return (
    `❌ [Server] Port ${port} is already in use (${host}:${port}).` +
    occupant +
    `\n   Stop the other instance first, or start on another port: PORT=3001 npm start`
  );
}

/**
 * Pre-flight port check run BEFORE the slow account warmup so a conflicting
 * listener fails in <1s with an explanatory message instead of crashing the
 * process minutes later after the warmup completes. When the squatter is
 * itself a QwenProxy (lockfile lost to a hard kill), it is taken over instead.
 */
async function assertPortAvailable(): Promise<void> {
  const { port, host } = config.server;
  let lastError: NodeJS.ErrnoException | undefined;
  const tryBind = (): Promise<boolean> =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", (err: Error) => {
        lastError = err as NodeJS.ErrnoException;
        resolve(false);
      });
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, host);
    });

  if (await tryBind()) return;

  const { tookOver, listener } = await takeOverPortHolder({
    port,
    host,
    apiKey: process.env.API_KEY || config.apiKey || undefined,
  });
  if (tookOver && (await tryBind())) return;

  if (lastError && lastError.code !== "EADDRINUSE") throw lastError;
  throw new Error(buildPortInUseMessage(port, host, listener));
}

export function setCacheForTesting(nextCache: MemoryCache | undefined): void {
  cache = nextCache;
}

// Middleware must be registered BEFORE routes

// CORS: browser-based clients (OpenWebUI, web frontends on another origin)
// preflight before the Authorization header is sent, so OPTIONS short-circuits
// BEFORE the /v1/* auth middleware. Default is permissive (doc checklist item
// 2); set CORS_ORIGIN to lock it down.
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", corsOrigin);
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  c.header(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Request-Id, x-api-key, OpenAI-Organization, OpenAI-Project, X-Client-Request-Id",
  );
  c.header(
    "Access-Control-Expose-Headers",
    "X-Request-Id, X-Response-Time, X-Models-Source, openai-version, openai-processing-ms, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens",
  );
  if (c.req.method === "OPTIONS") {
    // Hono does not merge c.header() values into a manually constructed
    // Response, so the preflight carries its CORS headers explicitly.
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Request-Id, x-api-key, OpenAI-Organization, OpenAI-Project, X-Client-Request-Id",
        "Access-Control-Expose-Headers":
          "X-Request-Id, X-Response-Time, X-Models-Source, openai-version, openai-processing-ms, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens",
      },
    });
  }
  await next();
});

app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") || uuidv4();
  c.header("X-Request-Id", requestId);

  // OpenAI-shaped response headers (doc §5.2): API version, processing time,
  // and static rate-limit windows so tools that parse x-ratelimit-* don't choke.
  c.header("openai-version", "2020-10-01");
  const ratelimit = config.server.rateLimit;
  c.header("x-ratelimit-limit-requests", String(ratelimit.requests));
  c.header(
    "x-ratelimit-remaining-requests",
    String(Math.max(0, ratelimit.requests - 1)),
  );
  c.header("x-ratelimit-reset-requests", "0");
  c.header("x-ratelimit-limit-tokens", String(ratelimit.tokens));
  c.header(
    "x-ratelimit-remaining-tokens",
    String(Math.max(0, ratelimit.tokens - 1)),
  );
  c.header("x-ratelimit-reset-tokens", "0");

  metrics.increment("requests.total");
  const start = Date.now();
  // Serve the whole downstream chain inside the request context so every
  // logger.* call (route, account selection, browser ops) carries requestId.
  await runWithRequestContext(requestId, () => next());
  const duration = Date.now() - start;
  metrics.histogram("latency.request", duration);
  c.header("X-Response-Time", `${duration}ms`);
  c.header("openai-processing-ms", String(duration));
});

function constantTimeStringEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const providedHash = crypto.createHash("sha256").update(providedBuf).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedBuf).digest();

  return (
    crypto.timingSafeEqual(providedHash, expectedHash) &&
    providedBuf.length === expectedBuf.length
  );
}

/**
 * Accept OpenAI-style Bearer and x-api-key.
 * Either may authenticate when API_KEY is configured.
 */
function extractProvidedApiKeys(c: Context): string[] {
  const keys: string[] = [];
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) keys.push(token);
  }
  const xApiKey = c.req.header("x-api-key")?.trim();
  if (xApiKey) keys.push(xApiKey);
  return keys;
}

function verifyApiKey(c: Context): Response | null {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return null;

  const candidates = extractProvidedApiKeys(c);
  const isAnthropic =
    c.req.path.startsWith("/v1/messages") ||
    !!c.req.header("anthropic-version");

  if (candidates.length === 0) {
    if (isAnthropic) {
      c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Missing or invalid credentials (Authorization Bearer or x-api-key)",
          },
        },
        401,
      );
    }
    return sendOpenAIError(
      c,
      new AuthError(
        "Missing or invalid credentials (Authorization Bearer or x-api-key)",
      ),
    );
  }
  if (candidates.some((token) => constantTimeStringEqual(token, apiKey))) {
    return null;
  }
  if (isAnthropic) {
    c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
    return c.json(
      {
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      },
      401,
    );
  }
  return sendOpenAIError(c, new AuthError("Invalid API key"));
}
app.use("/v1/*", async (c, next) => {
  const error = verifyApiKey(c);
  if (error) return error;
  await next();
});

// Enforced per-key request rate (token bucket; disabled when
// RATE_LIMIT_PER_MINUTE=0). Keyed on the presented credential so one client
// cannot starve the pool; keyless localhost shares the "anon" bucket.
const requestLimiter = createRateLimiter({
  requestsPerMinute: config.server.rateLimit.perMinute,
});
function rateLimitKey(c: Context): string {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return `key:${token.slice(0, 12)}`;
  }
  const xApiKey = c.req.header("x-api-key")?.trim();
  if (xApiKey) return `key:${xApiKey.slice(0, 12)}`;
  return "anon";
}
app.use("/v1/*", rateLimitMiddleware(requestLimiter, rateLimitKey));

// Operational introspection carries account identifiers and session bindings:
// it requires the API key exactly like /v1/* (verifyApiKey stays open only
// when no key is configured — keyless localhost dev). /readyz is intentionally
// unauthenticated: orchestrators probe it without secrets and it returns
// counts only, never identifiers.
app.use("/health", async (c, next) => {
  const error = verifyApiKey(c);
  if (error) return error;
  await next();
});
app.use("/health/*", async (c, next) => {
  const error = verifyApiKey(c);
  if (error) return error;
  await next();
});

// Routes
app.route("", modelsApp);
app.post("/v1/chat/completions", chatCompletions);
app.post("/v1/chat/completions/stop", chatCompletionsStop);
app.post("/v1/completions", completionsLegacy);
app.post("/v1/upload", uploadFile);
app.post("/v1/images/generations", imagesGenerations);
app.post("/v1/videos/generations", videosGenerations);
app.get("/v1/tasks/status/:taskId", videoTaskStatus);

// OpenAI Responses API compatible routes
app.route("", responsesApp);
app.route("", anthropicApp);

// Accept paths without the /v1 prefix via a 308 redirect (method + body are
// preserved on redirect). Most clients append /v1 themselves; the redirect
// covers the rest without duplicating handlers.
const LEGACY_REDIRECTS: Array<[string, string]> = [
  ["/chat/completions", "/v1/chat/completions"],
  ["/completions", "/v1/completions"],
  ["/responses", "/v1/responses"],
  ["/models", "/v1/models"],
  ["/messages", "/v1/messages"],
  ["/messages/count_tokens", "/v1/messages/count_tokens"],
];
for (const [from, to] of LEGACY_REDIRECTS) {
  app.all(from, (c) => c.redirect(to, 308));
}

/** Mask an account id/email for /health output (never leak credentials). */
function maskPoolAccountId(idOrEmail: string): string {
  if (!idOrEmail) return "unknown";
  if (idOrEmail.includes("@")) {
    const [user, domain] = idOrEmail.split("@");
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return idOrEmail.length > 12 ? `${idOrEmail.slice(0, 12)}…` : idOrEmail;
}

/**
 * /health polls every second from the TUI and from orchestrators: report a
 * failing best-effort section loudly, but at most once per interval so a
 * persistent fault shows up in the logs instead of flooding them.
 */
const healthSectionFailureAt = new Map<string, number>();
const HEALTH_FAILURE_LOG_INTERVAL_MS = 30_000;
function reportHealthSectionFailure(section: string, error: unknown): void {
  const now = Date.now();
  const last = healthSectionFailureAt.get(section) ?? 0;
  if (now - last < HEALTH_FAILURE_LOG_INTERVAL_MS) return;
  healthSectionFailureAt.set(section, now);
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`[Health] ${section} unavailable, degrading this section`, {
    section,
    error: message,
  });
}

app.get("/health", async (c) => {
  const status = await watchdog?.getStatus();
  // Pool 2.0 observability: aggregated counts + per-account rows. All
  // identifiers masked; no passwords, cookies or tokens are ever included.
  //
  // The two blocks below are deliberately independent: they used to share one
  // try/catch, so a throw while building the account rows (locked DB, failed
  // import, ...) returned 200 with `accounts: []` and made the TUI report "No
  // accounts configured" even though the pool still had rows.
  let pool: Record<string, unknown> | null = null;
  let poolAccounts: Array<Record<string, unknown>> = [];
  let accountStates: Record<string, string> = {};
  let activeStreams = 0;
  let waitingStreams = 0;
  // Resolved once and reused by the cap-aware readiness block below, so the
  // capacity view and the `ready` count are computed from the same snapshot
  // instead of racing each other.
  let capObservability: Awaited<ReturnType<typeof buildModelCapObservability>> = {
    degraded: false,
    anyServable: true,
    models: [],
  };
  try {
    const manager = await import("../core/account-manager.js");
    const stats = manager.getPoolStats();
    const readinessTarget = config.pool?.targetReady ?? 2;
    const readinessDeficit = Math.max(0, readinessTarget - stats.ready);
    // Cap-aware readiness: `ready` counts LANES, not servability. An account
    // capped for a model stays READY (it is fine for every other model) but
    // cannot serve THAT model, so the raw deficit understates real capacity
    // pressure — this deployment reached ready 14/14 with readyUncapped 1.
    // `usableDeficit` / `degraded` are the model-aware view to alert on.
    capObservability = await buildModelCapObservability(stats.ready);
    const worstUsable = capObservability.models.length
      ? Math.min(...capObservability.models.map((m) => m.readyUncapped))
      : stats.ready;
    const usableDeficit = Math.max(0, readinessTarget - worstUsable);
    pool = {
      total: stats.total,
      ready: stats.ready,
      warming: stats.warming,
      busy: stats.busy,
      cooldown: stats.cooldown,
      authError: stats.authError,
      broken: stats.broken,
      disabled: stats.disabled,
      sessionExpired: stats.sessionExpired,
      activeStreams: stats.totalActiveStreams,
      queued: stats.queuedRequests,
      successRate: Number(stats.successRate.toFixed(4)),
      failureRate: Number(stats.failureRate.toFixed(4)),
      averageLatencyMs: stats.averageLatencyMs,
      averageHealth: stats.averageHealth,
      readinessTarget,
      readinessDeficit,
      usableDeficit,
      degraded: capObservability.degraded,
    };
    accountStates = stats.states;
    activeStreams = stats.totalActiveStreams;
    waitingStreams = stats.queuedRequests;
    // Prometheus pool gauges (Phase 3 observability).
    metrics.gauge("pool.ready", stats.ready);
    metrics.gauge("pool.warming", stats.warming);
    metrics.gauge("pool.deficit", readinessDeficit);
    metrics.gauge("pool.usable_deficit", usableDeficit);
  } catch (error) {
    reportHealthSectionFailure("pool stats", error);
    pool = null;
  }
  try {
    const manager = await import("../core/account-manager.js");
    const { loadAccounts } = await import("../core/accounts.js");
    const accounts = loadAccounts();
    const candidates = manager.buildSchedulerCandidates(accounts);
    const readyAccountIds = manager.getHeadersReadyAccountIds();
    const activeAccountIds = (await import("../services/playwright.js")).getActivePlaywrightAccountIds();
    poolAccounts = candidates.map((cand) => {
      const cd = manager.getAccountCooldownInfo(cand.account.id);
      const isReady = readyAccountIds.includes(cand.account.id);
      const isActive = activeAccountIds.includes(cand.account.id);
      const cooldownUntil = cd ? Date.now() + cd.remainingMs : null;
      return {
        // Opaque prefix only — never the full id or email.
        id: maskPoolAccountId(cand.account.id),
        account: maskPoolAccountId(cand.account.email || cand.account.id),
        // Raw ID for internal TUI use (not masked)
        rawId: cand.account.id,
        state: accountStates[cand.account.id] ?? "WARMING",
        health: cand.health.healthScore,
        activeStreams: cand.activeStreams,
        queued: cand.queuedRequests,
        requests: cand.health.successCount + cand.health.failureCount,
        success: cand.health.successCount,
        failure: cand.health.failureCount,
        averageLatencyMs: cand.health.averageLatencyMs,
        lastUsed: cand.health.lastRequestAt,
        lastSuccess: cand.health.lastSuccessAt,
        lastFailure: cand.health.lastFailureAt,
        cooldownRemainingMs: cd?.remainingMs ?? 0,
        cooldownReason: cd?.reason ?? cand.account.cooldown_reason ?? null,
        cooldownUntil,
        onCooldown: cd ? cd.onCooldown : false,
        headersReady: isReady,
        isInitialized: isActive,
      };
    });
  } catch (error) {
    reportHealthSectionFailure("account list", error);
  }
  const rss = process.memoryUsage().rss;
  const totalMem = os.totalmem();
  const mem = process.memoryUsage();
  const uptimeSeconds = Math.floor(process.uptime());
  const systemMemoryPct =
    Number.isFinite(totalMem) && totalMem > 0
      ? Number(((mem.rss / totalMem) * 100).toFixed(1))
      : 0;

  return c.json({
    status: status?.overall || "unknown",
    ram: status?.ram || "unknown",
    streams: status?.streams || "unknown",
    uptimeSeconds,
    rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
    systemMemoryPct,
    activeStreams,
    waitingStreams,
    heap: status?.heap
      ? {
          used: status.heap.heapUsed,
          total: status.heap.heapTotal,
          limit: status.heap.heapSizeLimit,
          rss: status.heap.rss,
          usagePercent: Number(status.heap.usagePercent.toFixed(2)),
        }
      : undefined,
    timestamp: Date.now(),
    readyAccounts: (await import("../core/account-manager.js")).getHeadersReadyAccountIds(),
    activeAccounts: (await import("../services/playwright.js")).getActivePlaywrightAccountIds(),
    pool,
    accounts: poolAccounts,
    // Accounts that hit Qwen's per-account DAILY allowance for a given model.
    // They stay in the pool for every other model — this is model-scoped.
    // `readyUncapped` answers the operator question "can this model run right
    // now?" in one field: READY accounts minus the ones capped for it. Zero
    // with ready>0 is the exact condition that used to surface as the
    // misleading "no hot accounts" error.
    modelDailyCaps: capObservability,
    // Pool-wide WAF challenge pressure (decayed EWMA) and the hottest lanes.
    // Used to size adaptive backoff and to explain a rising challenge rate.
    wafPressure: (await import("../core/waf-isolation.js")).getWafIsolationStats(),
    performance: performanceMetrics.getSnapshot(),
    metrics: {
      cache: await cache?.getStats(),
    },
  });
});

/**
 * Per-model cap + availability snapshot, plus pool-wide WAF challenge pressure.
 *
 * `ready` alone is a misleading health signal: a model-daily cap removes an
 * account from service for that model while leaving the lane READY, so a pool
 * can report `ready 14/14` and still be unable to serve a single request (this
 * deployment hit exactly that at capped=13 / readyUncapped=1). The `degraded`
 * flag below is the operator-facing consequence — it turns "structurally full"
 * into "cannot serve right now", which is what actually pages someone.
 *
 * Read-only; every import is guarded so a missing module degrades the field
 * instead of failing /health.
 */
async function buildModelCapObservability(
  ready: number,
): Promise<{
  degraded: boolean;
  anyServable: boolean;
  models: Array<{
    model: string;
    capped: number;
    readyUncapped: number;
    accounts: string[];
  }>;
}> {
  try {
    const capMod = await import("../services/model-daily-limit.js");
    const gwMod = await import("../runtime/gateway.js");
    const stats = capMod.getModelCapStats();
    const models = stats.models.map((m) => {
      let readyUncapped = 0;
      try {
        // peekReadyAccountIds returns READY minus the excluded set; excluding
        // the capped accounts for this model yields the servable-now count.
        readyUncapped = gwMod.peekReadyAccountIds(
          new Set(capMod.cappedAccountsForModel(m.model)),
        ).length;
      } catch {
        // Gateway unbound (pre-startup / hermetic tests): report capped only.
      }
      return {
        model: m.model,
        capped: m.capped,
        readyUncapped,
        accounts: m.accounts,
      };
    });
    // Degraded only when a model is tracked as capped AND the pool has warm
    // lanes: that is the case where `ready` overstates real capacity. With no
    // caps at all the pool is not degraded by this axis.
    const anyServable = models.length === 0 || models.some((m) => m.readyUncapped > 0);
    const degraded = models.length > 0 && !anyServable && ready > 0;
    return { degraded, anyServable, models };
  } catch {
    return { degraded: false, anyServable: true, models: [] };
  }
}

// Cumulative token/request usage: all-time totals, today, and a daily
// breakdown. Backed by SQLite (usage_totals + usage_daily) so the numbers
// survive restarts and accumulate across sessions instead of resetting per
// process. Auth-gated like the other /health probes.
app.get("/health/usage", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  try {
    const tracker = await import("../core/usage-tracker.js");
    const daysParam = c.req.query("days");
    const parsedDays = daysParam != null ? parseInt(daysParam) : NaN;
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(parsedDays, 365) : 30;
    return c.json({
      allTime: tracker.loadUsageTotals(),
      today: tracker.getTodayUsage(),
      daily: tracker.getDailyUsage(days),
      timestamp: Date.now(),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// Deep readiness probe for orchestrators (k8s readinessProbe, Docker
// HEALTHCHECK). Unlike /health (always 200, diagnostics), /readyz answers
// the single serving question: can this instance accept traffic RIGHT NOW?
// 200 when >= 1 account is READY, 503 otherwise (startup warmup, full
// cooldown, zero pool). Unauthenticated by design; returns counts only,
// never identifiers. `degraded` flags ready-below-target (still serving).
app.get("/readyz", async (c) => {
  try {
    const { getHeadersReadyAccountIds } =
      await import("../core/account-manager.js");
    const ready = getHeadersReadyAccountIds().length;
    const target = config.pool?.targetReady ?? 2;
    const body = {
      ready: ready > 0,
      readyAccounts: ready,
      targetReady: target,
      degraded: ready > 0 && ready < target,
      timestamp: Date.now(),
    };
    return ready > 0 ? c.json(body) : c.json(body, 503);
  } catch (err) {
    return c.json(
      {
        ready: false,
        readyAccounts: 0,
        targetReady: config.pool?.targetReady ?? 2,
        degraded: false,
        timestamp: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
});

// Sticky session observability: size, active bindings, rebinds last hour.
app.get("/health/sessions", async (c) => {
  try {
    const { getStickyMap } = await import("../services/session/stickyMap.ts");
    const sm = getStickyMap();
    const entries = sm.entries();
    return c.json({
      size: sm.size(),
      activeBindings: entries.length,
      rebindsLastHour: sm.rebindsLastHour(),
      bindings: entries.map((e) => ({
        key: e.key,
        accountId: e.binding.accountId,
        lastUsedAt: e.binding.lastUsedAt,
        ageMs: Date.now() - e.binding.lastUsedAt,
      })),
      timestamp: Date.now(),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// Recovery observability: readiness controller in-flight warmups,
// per-account lease load and the pool aggregates. No request queue exists
// (admission is fail-fast), so queuedLeaseCount is always 0.
app.get("/health/recovery", async (c) => {
  try {
    const { getAccountConcurrencySnapshot } = await import(
      "../core/account-concurrency.js"
    );
    const { getPoolStats, getHeadersReadyAccountIds } = await import(
      "../core/account-manager.js"
    );
    const leases = getAccountConcurrencySnapshot();
    const poolStats = getPoolStats();
    const targetReady = config.pool?.targetReady ?? 2;
    const readyCount = getHeadersReadyAccountIds().length;
    return c.json({
      readiness: {
        inFlight: runtimeServices?.readiness.getInFlight() ?? [],
        // Accounts parked by the warmup circuit breaker: burned several whole
        // warmup eras without ever succeeding, so no browser is launched for
        // them. This is the "dead upstream account" cohort made visible.
        warmupParked: runtimeServices?.readiness.getWarmupCircuitBreakers() ?? [],
        targetReady,
        readyCount,
        deficit: Math.max(0, targetReady - readyCount),
      },
      leases,
      activeLeaseCount: leases.reduce((n, s) => n + s.active, 0),
      queuedLeaseCount: 0,
      pool: {
        ready: poolStats.ready,
        warming: poolStats.warming,
        cooldown: poolStats.cooldown,
        broken: poolStats.broken,
      },
      warmingAccounts: poolStats.warmingAccounts,
      targetReady,
      readyCount,
      deficit: Math.max(0, targetReady - readyCount),
      timestamp: Date.now(),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// Token TTL diagnostics: inspect real cookie/header lifetimes
app.get("/diagnostics/tokens", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;

  const { getTokenDiagnostics } = await import("../services/playwright.ts");
  const accountId = c.req.query("accountId");

  try {
    // Bound the CDP cookie/header reads: a wedged browser context must not
    // hang a diagnostics request behind an unbounded await.
    const diagnostics = await withDeadline(
      "token diagnostics",
      5_000,
      () => getTokenDiagnostics(accountId),
    );
    return c.json(diagnostics);
  } catch (err) {
    const status = err instanceof FailFastTimeoutError ? 503 : 500;
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      status,
    );
  }
});

app.get("/metrics", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.text(metrics.formatPrometheus(), {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

function isLoopbackConnection(c: Context): boolean {
  try {
    const { remote } = getConnInfo(c);
    const address = remote?.address?.replace(/^::ffff:/, "");
    if (!address) return false;
    return address === "::1" || address.startsWith("127.");
  } catch {
    return false;
  }
}

/**
 * Loopback handover endpoint: a second instance starting on this data dir
 * asks this one to exit through its own clean shutdown path (flush SQLite,
 * close browsers) instead of being hard-killed mid-write. When API_KEY is set
 * it is required like everywhere else; without one, only loopback callers are
 * accepted so a keyless local dev server cannot be stopped from the LAN.
 */
app.post("/-/shutdown", async (c) => {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey && !isLoopbackConnection(c)) {
    return c.json({ error: "Loopback only" }, 403);
  }
  const error = verifyApiKey(c);
  if (error) return error;

  setTimeout(() => {
    void stopServer().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }, 50);
  return c.json({ ok: true, pid: process.pid }, 202);
});

app.onError((err, c) => {
  const requestId = c.req.header("X-Request-Id") || "unknown";
  metrics.increment("requests.errors");
  logger.error("API Error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return sendOpenAIError(c, err);
});

app.notFound((c) => sendOpenAIError(c, new NotFoundError("Not found")));

export interface StartedServerInfo {
  host: string;
  port: number;
  url: string;
}

function buildStartedServerInfo(): StartedServerInfo {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return {
    host,
    port: config.server.port,
    url: `http://${host}:${config.server.port}`,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function warmConfiguredChatPools(
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
  accountId?: string,
): Promise<void> {
  await Promise.all(
    config.qwen.chatPoolModels.map((model) =>
      warmQwenChatPool(accountId, model).catch(() => {}),
    ),
  );
}

export async function prepareQwenRuntime(params: {
  accountId?: string;
  successMessage: string;
  failureMessage: string;
  initAuth: () => Promise<void>;
disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
  /**
   * Internal: a post-captcha-solve retry has already been spent for this
   * attempt, so the recovery below can never recurse more than once.
   */
  captchaRetrySpent?: boolean;
}): Promise<boolean> {
  if (params.accountId) {
    const { getAccountCooldownInfo } =
      await import("../core/account-manager.ts");
    const cooldownInfo = getAccountCooldownInfo(params.accountId);
    if (cooldownInfo) {
      console.warn(
        `⚠️ [Server] Account not ready | account=${formatAccountId(params.accountId)} | cooldown=${Math.ceil(cooldownInfo.remainingMs / 1000)}s | reason=${cooldownInfo.reason}`,
      );
      return false;
    }
  }

  try {
    await params.initAuth();
    await params.disableNativeTools(params.accountId).catch(() => {});
    await warmConfiguredChatPools(params.warmQwenChatPool, params.accountId);
    if (params.accountId) {
      const { getAccountCooldownInfo } =
        await import("../core/account-manager.ts");
      const cooldownInfo = getAccountCooldownInfo(params.accountId);
      if (cooldownInfo) {
        console.warn(
          `⚠️ [Server] Account not ready | account=${formatAccountId(params.accountId)} | cooldown=${Math.ceil(cooldownInfo.remainingMs / 1000)}s | reason=${cooldownInfo.reason}`,
        );
        return false;
      }
    }
    if (params.accountId) {
      try {
        noteAccountInitSuccess(params.accountId);
        noteAccountRecovered(params.accountId);
      } catch {
        // Best-effort.
      }
    }
    return true;
  } catch (error) {
    console.warn(`❌ ${params.failureMessage}`, getErrorMessage(error));
    if (params.accountId) {
      const { markAccountRateLimited, getAccountCooldownInfo } =
        await import("../core/account-manager.ts");
      const { isPermanentInitFailure, PERMANENT_INIT_COOLDOWN_MS } =
        await import("../services/playwright.ts");
      const permanentFailure = isPermanentInitFailure(error);
      const alreadyParkedPermanently =
        !permanentFailure &&
        (getAccountCooldownInfo(params.accountId)?.reason ?? "").startsWith(
          "AuthPermanentFailure",
        );

      // Baxia challenge recovery on the WARMUP path. `recoverBaxiaCaptcha` was
      // only reachable from the served-request and media-generation paths, so
      // an account challenged during header capture was never solved — it just
      // failed as a generic `AuthInitFailed` and sat in the cooldown/retry loop
      // until the readiness controller gave up on it.
      //
      // A challenge during header capture does NOT surface as an explicit WAF
      // error: the punish document replaces the completion request, so the
      // capture reports "no completion request". Classifying the error text is
      // therefore unreliable, and the solver doubles as the detector — it
      // returns false fast when there is no captcha on the page, which keeps
      // genuinely-dead accounts (pending activation, wrong credentials) cheap.
      // Permanent-auth failures are skipped: a slider cannot fix those.
      if (params.accountId && !permanentFailure && !params.captchaRetrySpent) {
        try {
          const { recoverBaxiaCaptcha } = await import(
            "../services/captcha-coordinator.ts"
          );
          const solved = await recoverBaxiaCaptcha(
            params.accountId,
            "warmup-init",
          );
          if (solved) {
            const { clearAccountCooldown } = await import(
              "../core/account-manager.ts"
            );
            // Drop anything initAuth parked while failing so the retry is not
            // rejected by the cooldown guard at the top of this function.
            clearAccountCooldown(params.accountId);
            console.log(
              `🛡️ [Server] Solved WAF challenge during init | account=${formatAccountId(params.accountId)} | retrying warmup once`,
            );
            return prepareQwenRuntime({ ...params, captchaRetrySpent: true });
          }
        } catch {
          // Solver unavailable or wedged: fall through to the normal
          // cooldown path so the account stays in the bounded retry loop.
        }
      }

      if (permanentFailure) {
        markAccountRateLimited(
          params.accountId,
          PERMANENT_INIT_COOLDOWN_MS,
          `AuthPermanentFailure: ${getErrorMessage(error)}`,
        );
      } else if (!alreadyParkedPermanently) {
        markAccountRateLimited(
          params.accountId,
          config.concurrency.initFailureCooldownMs,
          "AuthInitFailed",
        );
      }
      // Pool 2.0: repeated init failures escalate WARMING → BROKEN.
      try {
        noteAccountInitFailure(params.accountId);
        if (isAccountEffectivelyBroken(params.accountId)) {
          markAccountBroken(params.accountId);
        }
      } catch {
        // Best-effort.
      }
    }
    return false;
  }
}

async function prepareAccountRuntime(
  account: QwenAccount,
  getAccountCredentials: (accountId: string) => QwenAccount | undefined,
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>,
  disableNativeTools: (accountId?: string) => Promise<void>,
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
): Promise<boolean> {
  return prepareQwenRuntime({
    accountId: account.id,
    successMessage: `[Server] Account ready: ${maskEmail(account.email)}`,
    failureMessage: `[Server] Account init failed ${maskEmail(account.email)}:`,
    initAuth: () => {
      const credentials = getAccountCredentials(account.id);
      if (!credentials) {
        throw new Error(`Account ${account.id} credentials not found`);
      }
      return initPlaywrightForAccount(
        credentials,
        config.playwright.headless,
        config.playwright.browser,
      );
    },
    disableNativeTools,
    warmQwenChatPool,
  });
}

async function cleanupServerResources(): Promise<void> {
  watchdog?.stop();
  watchdog = undefined;
  metrics.stopCollection();

  try {
    const { stopStreamSweepTimer } = await import("../core/stream-registry.ts");
    stopStreamSweepTimer();
  } catch {
    // Stream sweep may not have been started.
  }
  try {
    unsubscribeTransitionAudit?.();
  } catch {
    // Audit subscription is best-effort.
  } finally {
    unsubscribeTransitionAudit = undefined;
  }
  await releaseDataDirLock();

  try {
    await cache?.close();
  } finally {
    cache = undefined;
  }

  try {
    const { stopSessionKeeper } = await import("../services/session-keeper.ts");
    stopSessionKeeper();
  } catch {
    // Session keeper may not have been initialized.
  }

  if (config.qwen.deleteAllChatsOnShutdown) {
    try {
      const { deleteChatsForConfiguredAccounts } =
        await import("../services/chat-cleanup.ts");
      const result = await deleteChatsForConfiguredAccounts();
      console.log(
        `🗑️  [Server] Deleted Qwen chats on shutdown: ${result.succeeded}/${result.attempted} scope(s)`,
      );
    } catch (error) {
      console.error(
        `❌ [Server] Failed to delete Qwen chats on shutdown:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const activeServer = server;
  server = undefined;
  if (activeServer?.close) {
    // Drain in-flight requests BEFORE flushing: a request finishing during the
    // drain can still call updateLogicalThreadState, and its debounced write
    // must land in SQLite while the DB is still open.
    await new Promise<void>((resolve) => {
      try {
        if (activeServer.close.length > 0) {
          activeServer.close(() => resolve());
        } else {
          activeServer.close();
          resolve();
        }
      } catch {
        resolve();
      }
    });
  }

  // Stop runtime services (readiness controller + maintenance scheduler)
  // before closing browsers and DB
  try {
    const { stopRuntimeServices } = await import("../runtime/bootstrap.ts");
    if (runtimeServices) {
      await stopRuntimeServices(runtimeServices);
    }
  } catch {
    // Runtime services may not be initialized.
  }

  // Matching stop for the lease sweep timer started by the runtime branch
  // (idempotent: safe when the timer was never started).
  try {
    const { stopLeaseSweepTimer } = await import("../core/account-concurrency.ts");
    stopLeaseSweepTimer();
  } catch {
    // Lease sweep timer may not have been started.
  }

  // Close browser contexts AFTER HTTP drain and runtime services stop
  const { closeAllPlaywright } = await import("../services/playwright.ts");
  await closeAllPlaywright();

  const { flushLogicalThreadState } = await import("../services/qwen.ts");
  try {
    // Debounced logical-thread upserts must land before the DB closes.
    flushLogicalThreadState();
  } catch {
    // Persistence is best-effort; the in-memory cache already served this run.
  }

  try {
    // Pool 2.0: debounced health counters must land before the DB closes.
    const { flushAccountHealth } = await import("../core/account-health.ts");
    flushAccountHealth();
  } catch {
    // Best-effort.
  }

  if (process.env.QWEN_DURABLE_RUNTIME === "true") {
    try {
      // Durable runtime: persist terminal state for in-flight work so a
      // shutdown cannot strand a generation, then flush debounced writers.
      const { flushRuntimeTerminalState } = await import(
        "../runtime/persistence/recovery.ts"
      );
      await flushRuntimeTerminalState();
    } catch {
      // Best-effort: a shutdown failure must not block the DB close.
    }
  }

  const { closeDatabase } = await import("../core/database.ts");
  closeDatabase();

  try {
    // Flush and close the file log sink LAST so the whole shutdown sequence
    // is captured. Files remain on disk until their TTL expires.
    const { stopFileLogger } = await import("../core/file-logger.ts");
    await stopFileLogger();
  } catch {
    // File logging is best-effort; never block shutdown on it.
  }
}

async function handleSignal(signal: string): Promise<never> {
  console.log(
    `🛑 [Server] Shutdown | ${signal}`,
  );
  await stopServer();
  process.exit(0);
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
  // Windows Ctrl+Break: without a listener the process dies without running
  // cleanup, which used to leave the data dir lock behind for the next start.
  process.on("SIGBREAK", () => {
    void handleSignal("SIGBREAK");
  });
  signalHandlersInstalled = true;
}

export async function stopServer(): Promise<void> {
  if (stopPromise) {
    await stopPromise;
    return;
  }

  stopPromise = (async () => {
    if (!server && !cache && !watchdog) return;
    await cleanupServerResources();
  })();

  try {
    await stopPromise;
  } finally {
    stopPromise = null;
  }
}

export async function startServer(options?: {
  installSignalHandlers?: boolean;
  showBanner?: boolean;
}): Promise<StartedServerInfo> {
  if (server) {
    if (options?.installSignalHandlers !== false) installSignalHandlers();
    return buildStartedServerInfo();
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    cache = new MemoryCache();
    await cache.connect();

    // File log sink (JSON lines, size rotation, TTL auto-delete). Started
    // before anything else logs so the whole startup is captured; failure
    // degrades to console-only output.
    if (config.logging.file.enabled) {
      const { initFileLogger } = await import("../core/file-logger.ts");
      const logFile = initFileLogger({
        dir: config.logging.file.dir || undefined,
        ttlMs: config.logging.file.ttlMs,
        maxSizeBytes: config.logging.file.maxSizeBytes,
        maxRotatedFiles: config.logging.file.maxRotatedFiles,
      });
      if (logFile) {
        console.log(`📄 [Server] File logging active → ${logFile}`);
      }
    }

    // Open-proxy guard: binding a public interface without an API key exposes
    // every configured Qwen account to the LAN. Fail fast with a fix; bind
    // HOST=127.0.0.1 for keyless local-only use.
    if (!config.apiKey && isPublicBind(config.server.host)) {
      throw new Error(
        `❌ [Server] Refusing to bind ${config.server.host}:${config.server.port} without API_KEY (open proxy).` +
          ` Set API_KEY, or bind HOST=127.0.0.1 for local-only use.`,
      );
    }
    if (!config.apiKey) {
      console.warn(
        `⚠️  [Server] Running without API_KEY on ${config.server.host} — any local process can call this proxy. Set API_KEY for shared machines.`,
      );
    }

    // Single-replica guard: two live servers on one data dir double-book
    // accounts (module-level leases are per-process) and race SQLite writers.
    // Claimed BEFORE anything reads or writes the database: a verified live
    // predecessor is taken over (QWEN_LOCK_TAKEOVER=false keeps the old
    // refusal), a recycled or dead pid is reclaimed.
    await claimDataDirLock({
      port: config.server.port,
      host: config.server.host,
      apiKey: process.env.API_KEY || config.apiKey || undefined,
    });

    const { loadAccounts, getAccountCredentials } =
      await import("../core/accounts.ts");
    const accounts = loadAccounts();

    if (accounts.length === 0 && !isAuthMockEnabled()) {
      throw new Error(
        "❌ [Server] No Qwen accounts configured. Configure an account with `npm run login`, the QWEN_ACCOUNTS environment variable, or the accounts database before starting the server.",
      );
    }

    // Orphaned-stream sweep (crash-leaked removeStream misses) + account
    // transition audit trail (debug-gated inside the listener).
    const { startStreamSweepTimer } = await import("../core/stream-registry.ts");
    startStreamSweepTimer();
    const { onTransition } = await import("../runtime/account/resource-manager.ts");
    unsubscribeTransitionAudit = onTransition((e) => {
      if (logger.isLevelEnabled("debug")) {
        logger.debug("[audit] account transition", {
          accountId: e.accountId,
          from: e.from,
          to: e.to,
          reason: e.reason,
        });
      }
    });

    // Fail fast on a taken port (the most common startup crash) BEFORE the
    // slow account warmup — the previous behavior bound only after warmup and
    // then crashed with a raw Node stack trace minutes into startup.
    await assertPortAvailable();

    // Restore persisted cooldowns (e.g. daily quota windows) from the database
    // instead of wiping them on restart — retrying a still-rate-limited account
    // wastes a request and immediately re-trips the same limit. Expired
    // entries are dropped lazily by the cooldown lookup.
    const { syncCooldownsFromDb } =
      await import("../core/account-manager.ts");
    syncCooldownsFromDb(accounts);

    const { disableNativeTools, warmQwenChatPool } =
      await import("../services/qwen.ts");
    const { initPlaywrightForAccount } =
      await import("../services/playwright.ts");

    // The ReadinessController (constructed runtime below) is the SOLE warmup
    // authority. No reserve warmups, no standby validation sweeps, no legacy
    // guard timers — those doubled browser concurrency and raced the
    // controller over account mutexes.

    if (accounts.length > 0) {
      // Construct the single runtime container: crash recovery, account
      // registration, readiness controller, maintenance scheduler, and warmup
      // via the bounded controller.
      const { runtimeServices: rs } = await constructRuntime(accounts, {
        warmupExecutor: async (accountId: string) => {
          const account = accounts.find((a) => a.id === accountId);
          if (!account) return false;
          return prepareAccountRuntime(
            account,
            getAccountCredentials,
            initPlaywrightForAccount,
            disableNativeTools,
            warmQwenChatPool,
          );
        },
        keepAliveExecutor: undefined,
        terminateWarmup: async (accountId: string) => {
          const { closePlaywrightForAccount } = await import(
            "../services/playwright.ts"
          );
          await closePlaywrightForAccount(accountId).catch(() => {});
        },
      });
      runtimeServices = rs;
      console.log(
        `[Server] Pool controller owns all warmup (${accounts.length} accounts registered)`,
      );
    }

    const { startSessionKeeper } = await import(
      "../services/session-keeper.ts"
    );
    startSessionKeeper();

    const { startLeaseSweepTimer } = await import(
      "../core/account-concurrency.ts"
    );
    startLeaseSweepTimer();

    const serverInstance = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });
    // Node's http.Server emits 'error' (EADDRINUSE and friends) asynchronously,
    // AFTER serve() returns — with no listener the process crashes with a raw
    // stack trace. The pre-flight check above catches the common case before
    // warmup; this listener is the safety net for the rare race where the port
    // is taken between the check and the bind.
    serverInstance.on("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        console.error(
          buildPortInUseMessage(config.server.port, config.server.host),
        );
      } else {
        console.error(`❌ [Server] Listen failed: ${err.message}`);
      }
      process.exit(1);
    });
    server = serverInstance;

    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    const started = buildStartedServerInfo();
    const accountCount = accounts.length;
    // Single readiness definition: an account is warm only when its anti-bot
    // headers were captured (headers-ready), not merely when a browser page
    // exists. Matches the HOT gate on the request path.
    const { isAccountHeadersReady } = await import("../core/account-manager.ts");
    const warmCount = accounts.filter((account) =>
      isAccountHeadersReady(account.id),
    ).length;

    // API key display: just show if it's set or not
    const apiKey = process.env.API_KEY || config.apiKey;
    const apiKeyDisplay = apiKey ? "Set" : "Not set";

    // Use only fixed-width chars (ASCII + ●) to guarantee perfect alignment
    // across all terminals (emojis vary between 1-2 cell widths unpredictably)
    const W = 58; // inner width (60 minus 2 border chars)
    const center = (text: string): string => {
      const padLeft = Math.floor((W - text.length) / 2);
      const padRight = W - text.length - padLeft;
      return " ".repeat(padLeft) + text + " ".repeat(padRight);
    };
    const blank = () => " ".repeat(W);
    const row = (label: string, value: string): string => {
      const labelCol = (label + " ".repeat(Math.max(0, 12 - label.length)));
      const valCol = value + " ".repeat(Math.max(0, W - 14 - value.length));
      return "  " + labelCol + valCol;
    };

    const endpoint = `${started.url}/v1`;

    if (options?.showBanner !== false) {
      console.log(`
+${"-".repeat(W)}+
|${blank()}|
|${center("QwenProxy")}|
|${center("OpenAI & Anthropic Compatible API")}|
|${blank()}|
+${"-".repeat(W)}+
|${blank()}|
|${row("Endpoint", endpoint)}|
|${row("Port", String(started.port))}|
|${row("Accounts", `${warmCount}/${accountCount} warm`)}|
|${row("API Key", apiKeyDisplay)}|
|${row("Status", "● Online")}|
|${blank()}|
+${"-".repeat(W)}+
`);
    }
    return started;
  })();

  try {
    return await startPromise;
  } catch (error) {
    await cleanupServerResources().catch(() => {});
    throw error;
  } finally {
    startPromise = null;
  }
}

export { app };
