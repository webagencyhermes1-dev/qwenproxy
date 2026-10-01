# SECURITY.md — threat model & controls (Phase 3.3)

Grounded in `src/api/server.ts`, `src/utils/egress.ts`, `src/core/config.ts`, `src/core/logger.ts`, `src/core/crypto-utils.ts`, `src/core/database.ts`, `src/services/playwright.ts`.

## 1. Threat model

- Open-proxy default **eliminated by refusal**: stock config (`HOST=0.0.0.0`, empty `API_KEY`) fails startup instead of serving accounts to the LAN (server.ts:848-853). Keyless mode exists only for loopback dev, with a warning (server.ts:854-858).
- Surface: LAN/internet clients → Hono routes; browser automation → `chat.qwen.ai`; user-supplied media URLs → SSRF egress guard; logs/metrics/diagnostics → secret leakage.

## 2. Auth

- Key accepted as `Authorization: Bearer <key>` or `x-api-key`, constant-time compare (server.ts:164-239).
- Gated when a key is set: `/v1/*`, `/health`, `/health/*`, `/diagnostics/tokens`, `/metrics` (server.ts:240-260,501-526). With no key configured these stay open (dev only).
- `/readyz` is open **by design**: secretless orchestrator probes; returns counts only, never identifiers (server.ts:246-250,399-426).
- CORS defaults to `*`; set `CORS_ORIGIN` to lock down browser clients (server.ts:94-130).

## 3. SSRF egress (`src/utils/egress.ts`)

| Var | Default | Effect |
|---|---|---|
| `EGRESS_MEDIA_ALLOWLIST` | `""` (any public host) | comma-separated allowed hosts; private/loopback always blocked even when set (egress.ts:39-44,208-213) |
| `EGRESS_FETCH_TIMEOUT_MS` | `10000` | remote-media fetch budget (egress.ts:25-28) |
| `EGRESS_MAX_BYTES` | `26214400` (25 MB) | upfront content-length + streamed byte cap (egress.ts:30-33,294-331) |
| `EGRESS_ALLOW_HTTP` | `false` | `true` permits `http://`; other schemes always rejected (egress.ts:35-37,194-206) |

Enforcement: literal-IP block (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0/8`, `::`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped, numeric-bypass forms; unparseable IPv6 fails closed), DNS resolution validated per host, **re-validated on every redirect hop** (max 2 redirects), failures → 400 `ValidationError` (egress.ts:96-238,245-292).

## 4. Inbound caps

- `JSON_BODY_LIMIT_BYTES` default `4194304`, floor `65536` enforced in config (config.ts:195,242-245) → 413 `body_too_large` (validation.ts:84-113; errors.ts:61-64).
- `QWEN_MAX_PROMPT_BYTES` default `200000`; `0` disables the check (config.ts:191,434) → 400 `context_length_exceeded` (validation.ts:115-123; errors.ts:51-58).
- Structural caps: `messages` ≤ 500, `tools` ≤ 100, model/session ids ≤ 200 chars (validation.ts:69-81).
- `RATE_LIMIT_REQUESTS`/`RATE_LIMIT_TOKENS` (`5000`/`200000`) only set **static response headers** for SDK parsing — no quota is enforced (server.ts:139-151; config.ts:210-213).

## 5. Secrets handling

- `QWEN_ACCOUNTS=email:pass;...` (semicolon-separated; .env.example:11). Passwords containing `;` break env parsing — use `npm run login`/DB instead (import-accounts.ts:75).
- At rest: passwords AES-256-GCM encrypted in SQLite `data/db/qwenproxy.db` (database.ts:1-33; crypto-utils.ts:9-37).
- Master key: `ENCRYPTION_KEY` env, else generated `data/db/.encryption_key` (mode `0600`), scrypt-derived (crypto-utils.ts:15-37). Whoever holds key + DB owns all accounts.
- Browser sessions: `data/qwen_profiles/<account>/storage_state.json`, reused only if newer than `PLAYWRIGHT_STORAGE_STATE_TTL_MS` (6h; config.ts:73-78; playwright.ts:373,410-448).
- Never commit `.env`, `data/`, `*.db*` (gitignored, .gitignore:13-17).

## 6. Log redaction

Same as OPERATIONS §7: credential keys, JWT/`sk-` shapes, embedded `x5sec/bx-*/Bearer` values → `[REDACTED]` in both log formats (logger.ts:21-33,121); `/health` masks account ids (server.ts:291-299).

## 7. Residual risks

- Keyless loopback: **any local process** can call the proxy — set `API_KEY` on shared machines (server.ts:854-858).
- Single master key: no rotation helper; rotate by changing passwords + fresh login.
- No per-tenant quotas or per-client throttling yet — one `API_KEY`, cosmetic rate-limit headers.
- `CORS_ORIGIN=*` default lets any browser origin attempt calls (key still required when set).
- `QWEN_ACCOUNTS` in env/shell history leaks credentials; prefer `npm run login` (DB). Tests blank it for hermeticity (.env.test:20-25).
