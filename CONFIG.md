# CONFIG.md — every runtime env var (Phase 3.3)

Source of truth: `src/core/config.ts` `envSchema` (+ `src/utils/egress.ts`, `src/core/logger.ts` `LOG_FORMAT`, `RATE_LIMIT_*`). Marks: **(2)** Phase-2 SSRF hardening (basis: `scripts/test-contract.mjs:9` "+16 egress tests"); **(3)** Phase-3 pool/readiness ops (basis: "Pool 2.0" in `server.ts`). Stock config (`HOST=0.0.0.0`, empty `API_KEY`) refuses to start — set `API_KEY` or `HOST=127.0.0.1`.

## Server & API

| Var | Default | Effect |
|---|---|---|
| `PORT` | `7936` | listen port (1–65535, zod-validated; config.ts:7-14) |
| `HOST` | `0.0.0.0` | bind host; public values require `API_KEY` (server.ts:848-853) |
| `INTERNAL_HOST` | `127.0.0.1` | reserved internal host (`config.server.internalHost`) |
| `API_KEY` | `""` | proxy key (`Bearer` or `x-api-key`); empty = dev-open (server.ts:192-244) |
| `CORS_ORIGIN` | `*` | allowed browser origin; set to lock down (server.ts:98) |
| `JSON_BODY_LIMIT_BYTES` | `4194304` | inbound JSON cap, floor `65536`; over → 413 (config.ts:195,242-245) |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_TOKENS` | `5000` / `200000` | static `x-ratelimit-*` headers only, no enforcement (server.ts:139-151) |
| `QWEN_DATA_DIR` | unset | data-root override (paths.ts:81); else local `data/` or OS-global dir |
| `QWEN_DURABLE_RUNTIME` | unset | `true` = persist terminal runtime state on shutdown (server.ts:774) |
| `QWEN_TUI` | unset | `true` = launch TUI (index.ts:47) |

## Accounts & secrets (read outside schema)

| Var | Default | Effect |
|---|---|---|
| `QWEN_ACCOUNTS` | unset | `email:pass;...` seed accounts (.env.example:11) |
| `ENCRYPTION_KEY` | unset | master key; else generated `data/db/.encryption_key` 0600 (crypto-utils.ts:15-37) |
| `QWEN_FORGE_ACCOUNTS_PATH` | `~/qwen-forge/data/accounts.json` | forge import default (config.ts:475-480) |

## Browser / Playwright

| Var | Default | Effect |
|---|---|---|
| `PLAYWRIGHT_HEADLESS` | `true` | invisible browser (less RAM); `false` = debug |
| `PLAYWRIGHT_BROWSER` | `chromium` | `chromium`\|`chrome`\|`edge` |
| `PLAYWRIGHT_INIT_BATCH_SIZE` | `1` | startup init batch (≥1) |
| `PLAYWRIGHT_CONTEXT_CLOSE_TIMEOUT_MS` | `10000` | context close budget (≥1000) |
| `PLAYWRIGHT_IDLE_CONTEXT_TTL_MS` | `60000` | idle-context eviction age |
| `PLAYWRIGHT_JS_HEAP_MB` | `256` | JS heap budget (≥64) |
| `PLAYWRIGHT_LOW_MEMORY_FLAGS` | `true` | Chromium low-memory flags |
| `PLAYWRIGHT_MAX_ACTIVE_CONTEXTS` | `25` | warm-context cap; idles evicted (example suggests lower) |
| `PLAYWRIGHT_MAX_PARALLEL_INIT` | `20` | concurrent account inits (≥1) |
| `QWEN_HOST_RESOLVER_RULES` | `true` | pin Qwen origin IP in Chromium; `false` = normal DNS |
| `QWEN_CHAT_ORIGIN_IP` | `8.219.122.25` | pinned upstream IP |
| `PLAYWRIGHT_STORAGE_STATE_TTL_MS` | `21600000` | max age of reused `storage_state.json` (6h) |

## Session keep-alive / captcha / uploads

| Var | Default | Effect |
|---|---|---|
| `SESSION_KEEP_ALIVE_ENABLED` | `true` | idle page activity vs WAF trust |
| `SESSION_KEEP_ALIVE_INTERVAL_MS` / `_IDLE_MS` / `_NAVIGATION_INTERVAL_MS` | `180000` / `120000` / `480000` | keeper cadence / idle floor / nav cadence |
| `CAPTCHA_SOLVER_ENABLED` | `true` | Baxia/TMD solver |
| `CAPTCHA_SOLVER_MAX_ATTEMPTS` / `_TIMEOUT_MS` / `_RETRY_DELAY_MS` / `_SETTLE_MS` | `3` / `15000` / `1000` / `2000` | solver budget/timing |
| `CAPTCHA_ACCOUNT_COOLDOWN_MS` / `CAPTCHA_HARD_BLOCK_MAX_COOLDOWN_MS` | `120000` / `3600000` | rest after unsolved challenge; escalating-quarantine cap |
| `OSS_MULTIPART_THRESHOLD_MB` | `5` | multipart threshold, floor 1 MB |

## Timeouts (budgets; first-chunk/reasoning fail fast)

`HTTP_TIMEOUT=15000`, `CHAT_TIMEOUT=180000`, `NAVIGATION_TIMEOUT=60000`, `PAGE_TIMEOUT=60000`, `HEADERS_TIMEOUT=90000`, `TIME_TO_FIRST_BYTE=60000`, `IDLE_STREAM_TIMEOUT=300000`, `QWEN_FIRST_CHUNK_TIMEOUT=60000`, `TOTAL_REQUEST_TIMEOUT=900000`, `REASONING_MODEL_TIMEOUT=180000` (config.ts:91-107).

## Retry & failover

| Var | Default | Effect |
|---|---|---|
| `RETRY_BASE_DELAY_MS` / `RETRY_MAX_DELAY_MS` | `1000` / `10000` (`50`/`200` under `TEST_MOCK_QWEN_AUTH=true`) | backoff window |
| `RETRY_MAX_ATTEMPTS` / `RETRY_MAX_ACCOUNT_SWITCHES` | `3` / `2` | attempt / rotation budget |
| `RETRY_ON_UNKNOWN_UPSTREAM` / `RETRY_AUTO_MALFORMED_TOOLS` / `RETRY_AUTO_MALFORMED_TOOLS_MAX` | `true` / `true` / `2` | unknown-upstream retry; auto-fix malformed tool calls |
| `MAX_TOOL_CALLS_PER_TURN` | `24` (`0` = no cap) | loop-hallucination guard |
| `QWEN_REPEATED_TOOL_CALL_WARN` | `2` (`1` = off) | repeat-call reminder threshold |
| `CHAT_IN_PROGRESS_RETRY_DELAY_MS` / `_BUSY_MS` / `_MAX_RETRIES` | `2000` / `4000` / `6` | same-chat settle retries, never escalate to replay |
| `MID_STREAM_FAILOVER_THRESHOLD` / `_BUSY_MS` | `2` / `60000` | mid-stream failover sensitivity |

## Concurrency & leases

| Var | Default | Effect |
|---|---|---|
| `ACCOUNT_MAX_CONCURRENT_STREAMS` | `2` | streams per account (≥1) |
| `ACCOUNT_BUSY_WAIT_MS` | `30000` | short busy wait before fail-fast |
| `ACCOUNT_QUEUE_WAIT_FOREVER_CAP_MS` | `120000` | bound on unbounded lease queue |
| `ACQUIRE_DEADLINE_MS` | `120000` | one acquire-attempt deadline |
| `ACCOUNT_LEASE_MAX_DURATION_MS` | `900000` | force-release safety net |
| `ACCOUNT_INIT_FAILURE_COOLDOWN_MS` | `300000` (floor 30000) | post-failure account rest |
| `CHAT_LOCK_TIMEOUT_MS` | `180000` | per-chat lock wait (covers long turns) |
| `STREAM_DISCONNECT_GRACE_MS` | `60000` | upstream continues after client drop |

## Pool / readiness (3)

| Var | Default | Effect |
|---|---|---|
| `POOL_TARGET_READY` (3) | `20` | desired READY accounts (`/readyz` falls back to `2` when unset; server.ts:404) |
| `POOL_RESERVE_READY` (3) | `5` | reserve margin |
| `POOL_WARMUP_CONCURRENCY` (3) | `20` | parallel warmups |
| `POOL_RECONCILIATION_INTERVAL_MS` (3) | `30000` | controller tick |
| `POOL_WARMUP_TIMEOUT_MS` (3) | `90000` | per-account warmup deadline → terminate + backoff |
| `POOL_WARMUP_BACKOFF_BASE_MS` / `_MAX_MS` (3) | `500` / `300000` | exponential backoff window |
| `POOL_MAX_WARMUP_FAILURES` (3) | `3` | failures before `warmup-exhausted` recovery |

## Inbound caps & context

| Var | Default | Effect |
|---|---|---|
| `QWEN_MAX_PROMPT_BYTES` | `200000` | prompt budget; `0` disables; over → 400 |
| `QWEN_MAX_PERSONALIZATION_BYTES` | `200000` | personalization budget |
| `CONTEXT_METER_ENABLED` / `_WINDOW_TOKENS` / `_REPORT_USAGE` | `true` / `0` / `true` | metering + usage reporting |
| `CONTEXT_COMPRESSION_ENABLED` / `_THRESHOLD` / `_BUDGET` | `true` / `200000` / `200000` | tiered failover-replay compression (floors 10000) |
| `CONTEXT_COMPRESSION_RECENT_EXCHANGES` / `_CHUNK_SIZE` / `_MAX_CHUNKS` | `3` / `500` / `8` | verbatim tail / BM25 chunking |
| `ENABLE_HEDGING` / `HEDGE_TTFB_THRESHOLD_MS` / `HEDGE_MIN_ELIGIBLE_ACCOUNTS` | `false` / `30000` / `3` | opt-in duplicate request on degraded pool (costs 2× quota) |

## Upstream Qwen

| Var | Default | Effect |
|---|---|---|
| `QWEN_BASE_URL` | `https://chat.qwen.ai` | upstream origin |
| `QWEN_BX_V` / `QWEN_WEB_VERSION` | `2.5.37` / `0.2.91` | WAF/version headers (override when Qwen ships new bundle) |
| `QWEN_SEND_BX_UA` | `false` | inject bx tokens on general paths (completions always includes them) |
| `QWEN_CHAT_MODE` | `thread` | `thread`\|`temp`\|`temp-thread`; per-request `X-QwenProxy-Chat-Mode` |
| `QWEN_CHAT_POOL_SIZE` / `QWEN_CHAT_POOL_MODELS` | `1` / `qwen3.7-plus` | chat pre-warm size/models (csv) |
| `QWEN_PERSONALIZATION_FROM_REQUEST` / `_VERIFY_GET` | `true` / `true` | personalization source/verify |
| `QWEN_BROWSER_ONLY_FETCH` / `QWEN_MAP_OPENAI_MODELS` | `true` / `true` | route via browser page; map OpenAI model names |
| `DELETE_ALL_CHATS_ON_SHUTDOWN` | `false` | purge created chats on exit |
| `USER_AGENT` | Chrome 149 string | upstream UA |

## Observability / cache / watchdog

| Var | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `warn` | `debug`\|`info`\|`warn`\|`error` (logger.ts:249-257) |
| `LOG_FORMAT` | `pretty` | `json` = one object/line for Loki/ELK (logger.ts:123-125) |
| `TOOLCALL_DEBUG` | `errors` | `1` = full, `0` = off |
| `UPSTREAM_DEBUG` / `REQUEST_DEBUG` / `CHAT_REQUEST_LOG` | unset / unset / `false` | raw SSE chunks / full body / debug request details |
| `CACHE_TTL` / `RESPONSE_TTL` | `3600` / `1800` | cache entry TTLs |
| `CACHE_COMPRESSION_ENABLED` / `_THRESHOLD` / `_LEVEL` | `true` / `1024` / `6` | cache value compression |
| `METRICS_INTERVAL` / `WATCHDOG_INTERVAL` / `WATCHDOG_FAILURES` | `10000` / `5000` / `3` | collection/probe cadence |
| `RAM_WARNING` / `RAM_CRITICAL` / `WS_WARNING` / `WS_CRITICAL` | `80` / `95` / `50` / `100` | watchdog thresholds |

## Egress SSRF (2)

| Var | Default | Effect |
|---|---|---|
| `EGRESS_MEDIA_ALLOWLIST` (2) | `""` | allowed media hosts (csv); private IPs always blocked |
| `EGRESS_FETCH_TIMEOUT_MS` (2) | `10000` | remote fetch budget |
| `EGRESS_MAX_BYTES` (2) | `26214400` | byte cap (declared + streamed) |
| `EGRESS_ALLOW_HTTP` (2) | `false` | allow `http://` media |
