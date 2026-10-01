# OPERATIONS.md — QwenProxy runbook (Phase 3.3)

Grounded in `src/api/server.ts`, `src/core/config.ts`, `src/core/logger.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `scripts/test-contract.mjs`.

## 1. Startup requirements

- Node >= 22 (`package.json` engines). `npm start` (`tsx src/index.ts`); dashboard `npm run tui` / `qpx`.
- Accounts: ≥1 required — `npm run login`, `QWEN_ACCOUNTS=email:pass;...`, or accounts DB — else startup throws (server.ts:864-868).
- API-key rule: public bind (`HOST` ∈ `0.0.0.0`/`::`/`::0`; default `HOST=0.0.0.0`, config.ts:15) without `API_KEY` → **refuse to start** (server.ts:848-853). Keyless is allowed only on loopback, with a warning (server.ts:854-858). Pre-validate: `npm run config:check`.
- Port: pre-flight `assertPortAvailable` fails in <1s with a fix hint (server.ts:71-86); async `EADDRINUSE` listener is the backstop (server.ts:933-944).

## 2. Liveness vs readiness

- `GET /health` — diagnostics, always 200, **API-key gated** like `/v1/*` (server.ts:251-260,301-391). Pool aggregates (ready/warming/busy/cooldown/authError/broken/...) plus per-account rows with **masked** ids; the `rawId` field exists for internal TUI use only (server.ts:345).
- `GET /readyz` — readiness, **open by design** (no auth): 200 when ≥1 account is READY, else 503 `{ready:false, readyAccounts:0, ...}`; `degraded:true` when ready < target (server.ts:399-426). Counts only, never identifiers.
- Probes both hit `http://127.0.0.1:$PORT/readyz`: Dockerfile `HEALTHCHECK` 30s interval / 5s timeout / 180s start-period / 3 retries (Dockerfile:39-40); compose `healthcheck` 30s / 5s / 3 retries / 40s `start_period` (docker-compose.yml:14-19).

## 3. Logging

- `LOG_FORMAT=json` → one JSON object per line (`timestamp/level/context/requestId/message/data`); default `pretty` (logger.ts:123-125,165-174). Debug opt-in: `LOG_LEVEL=debug`, `TOOLCALL_DEBUG=1|errors`, `UPSTREAM_DEBUG=true` (logger.ts:238-293).
- Compose caps logs: `json-file`, `10m` × 3 files (docker-compose.yml:20-24).

## 4. Dirs / volumes

- Compose mounts `./data:/app/data` (docker-compose.yml:9-10). Entrypoint ensures `/app/data`, `/app/data/db`, `/app/data/qwen_profiles`, `/tmp/playwright` are writable by `pwuser` (docker-entrypoint.sh:19-22; Dockerfile:30).
- `data/db/qwenproxy.db` (SQLite) + `.encryption_key`; `data/qwen_profiles/<account>/storage_state.json` (browser sessions). Root overridable via `QWEN_DATA_DIR`, else OS-global dir (paths.ts:79-143). `shm_size: 2gb` prevents Chromium SIGBUS tab crashes (docker-compose.yml:12).

## 5. Graceful shutdown

`SIGINT`/`SIGTERM` → `stopServer()` (server.ts:799-826): stop watchdog, close cache, stop session-keeper, optional `DELETE_ALL_CHATS_ON_SHUTDOWN` purge, **drain HTTP**, stop runtime services, stop lease sweeps, close browsers, flush thread/health state (+ durable flush when `QWEN_DURABLE_RUNTIME=true`), close DB (server.ts:680-789).

## 6. Failure modes

| Condition | Response | Client action |
|---|---|---|
| 0 ready (`/readyz`) | 503 `{ready:false, readyAccounts:0, targetReady, degraded:false}` (server.ts:399-426) | poll `/readyz` / back off |
| Chat path, no warmed account | 503 `no_hot_account`, "retry in about 3s" (`NO_HOT_ACCOUNT_RETRY_AFTER_MS=3000`, wakes readiness controller; account.ts:512-533). Hint is in the **body** — no `Retry-After` HTTP header is set (verified by search) | retry after ~3s |
| All accounts on cooldown | 429, "retry in ~Ns" (min remaining; account.ts:1307-1321; index.ts:397-405) | back off N s |
| Body > `JSON_BODY_LIMIT_BYTES` | 413 `body_too_large` (Content-Length pre-check + post-parse count; validation.ts:84-113) | shrink history/attachments |
| Prompt > `QWEN_MAX_PROMPT_BYTES` | 400 `context_length_exceeded` (validation.ts:115-123) | summarize/trim |
| Busy pool (slots full) | 429 fail-fast `account_busy`, no queue (account-concurrency.ts:493-499; account.ts:1325-1334) | retry shortly |
| Warmup timeout | terminate attempt (`terminateWarmup` closes the account browser) + exponential backoff `min(500·2ⁿ⁻¹, 300000)`; ≥`POOL_MAX_WARMUP_FAILURES` → `recoverAccount("warmup-exhausted")` (readiness-controller.ts:186-229; server.ts:910-916) | wait for backoff/reconcile |

## 7. Log redaction

Identical in `pretty` and `json` modes (logger.ts:121,160-163): credential keys (`authorization|cookie|api-key|token|password|secret|x5sec*|bx-*`, …), JWT/`sk-` shapes, embedded `x5sec/bx-*/Bearer` values → `[REDACTED]` (logger.ts:21-33); account ids masked in `/health` (server.ts:291-299).

## 8. TUI

`npm run tui` / `qpx` launches dashboard + proxy (package.json:19; bin/qwenproxy.js:78-80); `--tui` / `QWEN_TUI=true` flag (index.ts:47). It consumes `/health` pool aggregates (account-manager.ts:498) and the `rawId` field (server.ts:345) — run it with the same env/`API_KEY` as the server so gated routes stay reachable.
