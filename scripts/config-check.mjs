#!/usr/bin/env node
// Phase-3.3 config validator (no dependencies).
// Parses ./.env (simple KEY=VALUE, no dotenv import) + process.env
// (process.env wins), using built-in defaults mirroring
// src/core/config.ts envSchema + src/utils/egress.ts.
// Exit 0 = clean (warnings allowed, listed); exit 1 = errors.

import fs from "node:fs";
import path from "node:path";

// Defaults mirroring config.ts envSchema / egress.ts (NOT imported).
const DEFAULTS = {
  PORT: "7936",
  HOST: "0.0.0.0",
  JSON_BODY_LIMIT_BYTES: "4194304", // floor 65536 (config.ts)
  QWEN_MAX_PROMPT_BYTES: "200000", // 0 disables (config.ts)
  POOL_TARGET_READY: "20", // floor 1 (config.ts)
  EGRESS_FETCH_TIMEOUT_MS: "10000", // egress.ts
  EGRESS_MAX_BYTES: "26214400", // egress.ts
  EGRESS_ALLOW_HTTP: "false", // egress.ts
  EGRESS_MEDIA_ALLOWLIST: "", // egress.ts
};

const PUBLIC_HOSTS = new Set(["0.0.0.0", "::", "::0"]); // server.ts isPublicBind
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// Every recognized key: all envSchema keys + operational extras read
// outside the schema (paths/crypto/accounts/egress/logger/server).
const KNOWN = new Set([
  ...Object.keys(DEFAULTS),
  "INTERNAL_HOST", "USER_AGENT", "QWEN_BX_V", "QWEN_WEB_VERSION",
  "QWEN_SEND_BX_UA", "QWEN_CHAT_MODE", "PLAYWRIGHT_HEADLESS",
  "PLAYWRIGHT_BROWSER", "PLAYWRIGHT_INIT_BATCH_SIZE",
  "PLAYWRIGHT_CONTEXT_CLOSE_TIMEOUT_MS", "PLAYWRIGHT_IDLE_CONTEXT_TTL_MS",
  "PLAYWRIGHT_JS_HEAP_MB", "PLAYWRIGHT_LOW_MEMORY_FLAGS",
  "PLAYWRIGHT_MAX_ACTIVE_CONTEXTS", "PLAYWRIGHT_MAX_PARALLEL_INIT",
  "QWEN_HOST_RESOLVER_RULES", "QWEN_CHAT_ORIGIN_IP",
  "PLAYWRIGHT_STORAGE_STATE_TTL_MS", "CAPTCHA_SOLVER_ENABLED",
  "CAPTCHA_SOLVER_MAX_ATTEMPTS", "CAPTCHA_SOLVER_TIMEOUT_MS",
  "CAPTCHA_SOLVER_RETRY_DELAY_MS", "CAPTCHA_SOLVER_SETTLE_MS",
  "CAPTCHA_ACCOUNT_COOLDOWN_MS", "CAPTCHA_HARD_BLOCK_MAX_COOLDOWN_MS",
  "OSS_MULTIPART_THRESHOLD_MB", "CHAT_REQUEST_LOG", "HTTP_TIMEOUT",
  "CHAT_TIMEOUT", "NAVIGATION_TIMEOUT", "PAGE_TIMEOUT", "HEADERS_TIMEOUT",
  "TIME_TO_FIRST_BYTE", "IDLE_STREAM_TIMEOUT", "QWEN_FIRST_CHUNK_TIMEOUT",
  "TOTAL_REQUEST_TIMEOUT", "REASONING_MODEL_TIMEOUT", "CACHE_TTL",
  "RESPONSE_TTL", "CACHE_COMPRESSION_ENABLED", "CACHE_COMPRESSION_THRESHOLD",
  "CACHE_COMPRESSION_LEVEL", "METRICS_INTERVAL", "WATCHDOG_INTERVAL",
  "WATCHDOG_FAILURES", "RAM_WARNING", "RAM_CRITICAL", "WS_WARNING",
  "WS_CRITICAL", "RETRY_BASE_DELAY_MS", "RETRY_MAX_DELAY_MS",
  "RETRY_MAX_ATTEMPTS", "RETRY_MAX_ACCOUNT_SWITCHES",
  "RETRY_ON_UNKNOWN_UPSTREAM", "RETRY_AUTO_MALFORMED_TOOLS",
  "RETRY_AUTO_MALFORMED_TOOLS_MAX", "MAX_TOOL_CALLS_PER_TURN",
  "QWEN_REPEATED_TOOL_CALL_WARN", "ACCOUNT_MAX_CONCURRENT_STREAMS",
  "ACCOUNT_BUSY_WAIT_MS", "ACCOUNT_QUEUE_WAIT_FOREVER_CAP_MS",
  "ACQUIRE_DEADLINE_MS", "ACCOUNT_LEASE_MAX_DURATION_MS",
  "ACCOUNT_INIT_FAILURE_COOLDOWN_MS", "CHAT_LOCK_TIMEOUT_MS",
  "STREAM_DISCONNECT_GRACE_MS", "CHAT_IN_PROGRESS_RETRY_DELAY_MS",
  "CHAT_IN_PROGRESS_BUSY_MS", "CHAT_IN_PROGRESS_MAX_RETRIES",
  "MID_STREAM_FAILOVER_THRESHOLD", "MID_STREAM_FAILOVER_BUSY_MS",
  "POOL_RESERVE_READY", "POOL_WARMUP_CONCURRENCY",
  "POOL_RECONCILIATION_INTERVAL_MS", "POOL_WARMUP_TIMEOUT_MS",
  "POOL_MAX_WARMUP_FAILURES", "POOL_WARMUP_BACKOFF_BASE_MS",
  "POOL_WARMUP_BACKOFF_MAX_MS", "QWEN_BASE_URL", "QWEN_CHAT_POOL_SIZE",
  "QWEN_CHAT_POOL_MODELS", "QWEN_PERSONALIZATION_FROM_REQUEST",
  "QWEN_PERSONALIZATION_VERIFY_GET", "QWEN_BROWSER_ONLY_FETCH",
  "QWEN_MAP_OPENAI_MODELS", "QWEN_MAX_PERSONALIZATION_BYTES",
  "CONTEXT_METER_ENABLED", "CONTEXT_METER_WINDOW_TOKENS",
  "CONTEXT_METER_REPORT_USAGE", "DELETE_ALL_CHATS_ON_SHUTDOWN",
  "SESSION_KEEP_ALIVE_ENABLED", "SESSION_KEEP_ALIVE_INTERVAL_MS",
  "SESSION_KEEP_ALIVE_IDLE_MS", "SESSION_KEEP_ALIVE_NAVIGATION_INTERVAL_MS",
  "API_KEY", "RATE_LIMIT_REQUESTS", "RATE_LIMIT_TOKENS",
  "CONTEXT_COMPRESSION_ENABLED", "CONTEXT_COMPRESSION_THRESHOLD",
  "CONTEXT_COMPRESSION_BUDGET", "CONTEXT_COMPRESSION_RECENT_EXCHANGES",
  "CONTEXT_COMPRESSION_CHUNK_SIZE", "CONTEXT_COMPRESSION_MAX_CHUNKS",
  "ENABLE_HEDGING", "HEDGE_TTFB_THRESHOLD_MS", "HEDGE_MIN_ELIGIBLE_ACCOUNTS",
  "QWEN_ACCOUNTS", "ENCRYPTION_KEY", "QWEN_DATA_DIR",
  "QWEN_FORGE_ACCOUNTS_PATH", "QWEN_DURABLE_RUNTIME", "QWEN_TUI",
  "TEST_MOCK_QWEN_AUTH", "LOG_LEVEL", "LOG_FORMAT", "TOOLCALL_DEBUG",
  "UPSTREAM_DEBUG", "REQUEST_DEBUG", "CORS_ORIGIN", "NODE_ENV",
]);

const WARN_KEY_RE = /^(QWEN_[A-Z0-9_]+|PORT($|_)|HOST($|_))$/;

function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7).trim() : t;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    let key = body.slice(0, eq).trim();
    let val = body.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') ||
        (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const errors = [];
const warnings = [];

const envPath = path.resolve(process.cwd(), ".env");
let fileVars = {};
if (fs.existsSync(envPath)) {
  try {
    fileVars = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  } catch (e) {
    errors.push(`cannot read .env: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// process.env wins over .env (mirrors dotenv behavior).
const get = (k) =>
  process.env[k] !== undefined ? process.env[k] : (fileVars[k] ?? DEFAULTS[k]);
const isSet = (k) => process.env[k] !== undefined || fileVars[k] !== undefined;

function checkInt(name, { min, floorNote }) {
  const raw = get(name);
  if (!/^-?\d+$/.test(String(raw).trim())) {
    errors.push(`${name}=${raw} is not an integer${floorNote ? ` (${floorNote})` : ""}`);
    return null;
  }
  const n = Number(raw);
  if (n < min) {
    errors.push(`${name}=${n} below minimum ${min}${floorNote ? ` (${floorNote})` : ""}`);
    return null;
  }
  return n;
}

// 1. Public bind requires API_KEY (server.ts refuses otherwise).
const host = String(get("HOST")).trim();
const hostExplicit = isSet("HOST");
const apiKey = String(get("API_KEY") ?? "").trim();
if (PUBLIC_HOSTS.has(host) && !apiKey) {
  if (hostExplicit) {
    errors.push(`HOST=${host} is public but API_KEY is empty (server refuses to start; set API_KEY or HOST=127.0.0.1)`);
  } else {
    warnings.push(`HOST unset (defaults to public ${DEFAULTS.HOST}) and API_KEY is empty: server will refuse public bind; set API_KEY or HOST=127.0.0.1`);
  }
} else if (!apiKey && LOOPBACK_HOSTS.has(host)) {
  warnings.push(`keyless-localhost bind (${host}): any local process can call this proxy; set API_KEY on shared machines`);
} else if (!apiKey && !PUBLIC_HOSTS.has(host)) {
  warnings.push(`no API_KEY on HOST=${host}: operable but unauthenticated; set API_KEY for shared/LAN use`);
}

// 2. PORT valid (config.ts: 1-65535).
checkInt("PORT", { min: 1 });

// 3. Inbound caps (config.ts floors).
checkInt("JSON_BODY_LIMIT_BYTES", { min: 65536, floorNote: "config floors at 65536" });
checkInt("QWEN_MAX_PROMPT_BYTES", { min: 0, floorNote: "0 disables the check" });

// 4. Pool readiness target.
checkInt("POOL_TARGET_READY", { min: 1, floorNote: "config floors at 1" });

// 5. Egress sanity (egress.ts defaults).
for (const [k, what] of [["EGRESS_FETCH_TIMEOUT_MS", "timeout"], ["EGRESS_MAX_BYTES", "byte cap"]]) {
  if (isSet(k)) {
    const raw = String(get(k)).trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      errors.push(`${k}=${raw} must be a positive integer (${what})`);
    }
  }
}
if (isSet("EGRESS_ALLOW_HTTP")) {
  const v = String(get("EGRESS_ALLOW_HTTP")).trim();
  if (v !== "true" && v !== "false") errors.push(`EGRESS_ALLOW_HTTP=${v} must be true/false`);
}

// 6. Unknown QWEN_*/PORT/HOST keys (non-fatal).
{
  const seen = new Set([...Object.keys(fileVars), ...Object.keys(process.env)]);
  const unknown = [...seen].filter((k) => WARN_KEY_RE.test(k) && !KNOWN.has(k)).sort();
  for (const k of unknown) warnings.push(`unknown key ${k} (QWEN_*/PORT/HOST pattern, not recognized; ignored at runtime)`);
}

for (const e of errors) console.error(`ERROR ${e}`);
for (const w of warnings) console.log(`WARN ${w}`);
console.log(`config-check: ${errors.length} error(s), ${warnings.length} warning(s)${fs.existsSync(envPath) ? ` (.env loaded)` : " (no .env)"}`);
process.exit(errors.length > 0 ? 1 : 0);
