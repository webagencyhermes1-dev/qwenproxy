# PROGRESS — authoritative work state

> Session-resilience worklog. Read this first on session start / after compaction.
> Update it after every completed step. Keep it short: status + decisions only.

Last updated: 2026-10-12

## Status

| Item | State | Notes |
| --- | --- | --- |
| Tool-loop context fix (`baseActivePrompt`, msgCount) | DONE | `src/routes/chat/context.ts`, `src/routes/chat/index.ts` |
| Session-key from `x-session-id` header | DONE | `src/routes/chat/validation.ts` — body keys still win |
| `QWEN_MAX_PROMPT_BYTES` default off (`0`) | DONE | `src/core/config.ts`, CONFIG.md, .env.example |
| Tests: header fallback + e2e thread reuse + forced byte cap | DONE | mock 1068, runtime 164, contract PASSED |
| OpenCode compaction incident (400 → plan-doc response) | DONE | root cause: no thread reuse + 200KB hard cap |
| `docs/gap-analysis-official-api-parity.md` | DONE | written, **untracked** |
| `docs/modules/` Phase 1 deliverables (overview, …) | PENDING | dir exists, empty |
| Anthropic/Responses routes: no session identity | NOT STARTED | out of scope so far |
| Empty-response guard (reasoning-only → promote to content) | DONE | `src/routes/chat/streaming.ts` both paths |
| Push all changes to `origin/feature/ultra-low-latency` | DONE | commit `f5fa1aa`; graphify-out/ untracked+gitignored |
| Restart QwenProxy + opencode to load fixes | PENDING | user action |
| Browserless-transport research (RAM 7.95GB → ~150MB) | DONE | plan written, **outside repo** (see below) |
| Warmup slowness fix (15 accts stuck "warming") | DONE | `.env` + `readiness-controller.ts` `onSettled` → immediate tick; see Decisions |
| Post-idle 503 `request_deadline_exceeded` | DONE | `4c1781b` dropped startup timers; restored + idle header refresh (see Decisions) |
| File log sink (JSON lines, rotation, TTL auto-delete) | DONE | `src/core/file-logger.ts`; `src/tests/file-logger.test.ts` 6/6 |
| TUI kill switch (`Ctrl+K`) | DONE | `src/tui/app.ts` — stop server, clear state, exit |
| TUI polish: bright purple hover, 10ms hover debounce, clean header | DONE | `theme.ts`, `screen.ts`, `app.ts` |

## Pending (continue here)

1. Restart QwenProxy (proxy code changed) and opencode (config changed).
2. Documentation task: write Phase 1 deliverables into `docs/modules/`
   (start from `docs/gap-analysis-official-api-parity.md`).
3. Offer a `docs:` commit once Phase 1 files exist.
4. Optional: session identity for Anthropic/Responses routes.

## Decisions

- Warmup slowness root causes (2026-10-12): `POOL_TARGET_READY=20` >
  context cap 14 made deficit hit 0 with STANDBY accounts → one account never
  launched; scheduling only on 30s interval with no settle wake-up; failure
  cooldown 5 min. Fixes: target=14, `POOL_RECONCILIATION_INTERVAL_MS=5000`,
  warmup concurrency/parallel-init 6, `ACCOUNT_INIT_FAILURE_COOLDOWN_MS=60000`,
  new `ReadinessDeps.onSettled` fires `requestReadinessTick("warmup-settled")`
  after settle bookkeeping; `setActiveReadiness` now set at startup (was only
  inside the interval callback). Tests: mock-relevant 55/55, runtime 164/164.
- Compaction trigger (proxy 400 at 200,000 bytes) removed; byte cap default
  is now off. Guards are 4MB body limit + model-aware token check.
- OpenCode providers `qwen/qwen3.8-max`, `ownserver/...`, `qwenproxy/...` now
  declare `limit: { context: 1048576, output: 65536 }` so auto-compact waits
  for the real 1M window instead of a guessed default.
- Global compaction config: `tail_turns: 10`, `preserve_recent_tokens: 30000`
  so recent turns survive any future compaction verbatim.
- Recovery protocol lives in `AGENTS.md` (this repo).
- Empty-completion hole FIXED: `streaming.ts` non-stream (`:621`) and stream
  (`:2637`) paths now throw a retryable `empty_response` when a turn yields no
  content, reasoning, or tool calls, instead of finishing as a clean `stop`
  that clients persist as an empty assistant message. Covered by
  `src/tests/empty-response-guard.test.ts` (5/5).
- Repo hygiene (2026-10-12): dropped tracked `test-output.txt` artifact,
  repointed `gettyuser/qwen-proxy` URLs/author to `webagencyhermes1-dev/qwenproxy`
  (ISC attribution to Pedro Farias kept), added GitHub description + 10 topics.
  CI runs on `main` only, so the `feature/ultra-low-latency` branch was never
  exercised by Actions.
- Proxy logs now on disk: `logs/qwenproxy-<ts>-pid<N>-1.log` (file logger).
- File log retention: kept until TTL (default 1h) rather than deleted on
  shutdown, so a crash or restart keeps a readable post-mortem. Keys:
  `LOG_FILE_ENABLED` (default true), `QWEN_LOG_DIR`, `LOG_FILE_TTL_MS`,
  `LOG_FILE_MAX_SIZE_MB` (10), `LOG_FILE_MAX_FILES` (5). `.env.test` sets
  `LOG_FILE_ENABLED=false` to keep the mock/runtime suites hermetic.
- TUI `Ctrl+K` is the kill switch: stops the server child (SIGTERM → SIGKILL),
  clears logs/snapshot/view state, restores the terminal, exits.
- Browserless transport verified viable from 3 sources:
  `AnonymoDGH/Qwen-Reverse` (Python, bx-ua = AES-CBC(JSON), ssxmod = LZW+custom
  base64, umidtoken = cached GET sg-wum.alibaba.com/w/wu.json, 50-concurrent
  stress test 100%), `ckcoding/QwenChat2Api` (pure Node, cookie pool +
  `GET /api/v1/auths/` JWT refresh), and this repo's own
  `requestQwenSettingsDirectFetch` (qwen.ts:1078). Keep 1 rescue browser,
  drop the other 13.
