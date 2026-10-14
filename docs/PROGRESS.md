# PROGRESS — authoritative work state

> Session-resilience worklog. Read this first on session start / after compaction.
> Update it after every completed step. Keep it short: status + decisions only.

Last updated: 2026-10-13

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
| Restart QwenProxy + opencode to load fixes | DONE | restarted repeatedly; live on current build |
| Warmup circuit breaker (stop wasting browsers on dead accounts) | DONE | park after N failed eras; `POOL_MAX_FAILED_WARMUP_ERAS` |
| Token writes batched off the request hot path | DONE | coalesced in memory, 1s flush, `exit` flush |
| Anti-bot rotation budget decoupled from failover budget | DONE | `RETRY_MAX_ANTIBOT_ROTATIONS=6` (was capped at 2) |
| Warmup captcha recovery wired into `prepareQwenRuntime` | DONE | solve once + retry once; guarded, non-permanent failures only |
| Stale readiness tests (bound mode now needs a live page) | FIXED | `account-readiness-unified` + `account-pool-readiness.integration` register a live page |
| Cap-aware readiness accounting (`readyUncapped` per model) | DONE | `/health` + `/health/recovery`; readiness no longer cap-blind |
| WAF challenge pressure: routing-aware backoff | DONE | leaf `waf-pressure.ts`; scheduler deprioritises flagged lanes; `wafPressure` on `/health` |
| Browserless-transport research (RAM 7.95GB → ~150MB) | DONE | plan written, **outside repo** (see below) |
| Warmup slowness fix (15 accts stuck "warming") | DONE | `.env` + `readiness-controller.ts` `onSettled` → immediate tick; see Decisions |
| Phantom-busy / stuck-warming (15 BUSY + 53 WARMING, only 2 streams) | FIXED | NaN config disabled the sweep; ownership lease leak on outer-loop break; see Decisions |
| Warmup freeze below target (ready stuck at 8/14, 62 "warming") | FIXED | in-flight warmups double-counted in the readiness deficit → halved concurrency; regression test added |
| `no hot accounts` while free accounts existed | FIXED | model daily-cap exclusion masqueraded as capacity error; caps now persist + a bounded wait rides out warmup |
| Token totals ignored OpenAI-shaped upstream usage | FIXED | `applyUpstreamUsage` read only `input_tokens`/`output_tokens`; totals fell back to the estimate |
| Persistent token totals (survive restart) | DONE | `usage_totals`/`usage_daily` tables; `/health/usage` endpoint |
| Warmup circuit breaker (stop wasting browsers on dead accounts) | DONE | park after N failed eras; `POOL_MAX_FAILED_WARMUP_ERAS` |
| Token writes batched off the request hot path | DONE | coalesced in memory, 1s flush, `exit` flush |
| Post-idle 503 `request_deadline_exceeded` | DONE | `4c1781b` dropped startup timers; restored + idle header refresh (see Decisions) |
| File log sink (JSON lines, rotation, TTL auto-delete) | DONE | `src/core/file-logger.ts`; `src/tests/file-logger.test.ts` 6/6 |
| TUI kill switch (`Ctrl+K`) | DONE | `src/tui/app.ts` — stop server, clear state, exit |
| TUI polish: bright purple hover, 10ms hover debounce, clean header | DONE | `theme.ts`, `screen.ts`, `app.ts` |
| `empty_response` guard: content dropped by phase filter | FIXED | `streaming.ts` main loop took `phase === "answer"` only |
| `empty_response` guard: no transparent recovery | FIXED | guard now recovers in place before failing |
| `empty_response` guard: ghost parent committed pre-validation | FIXED | commit moved after the zero-token check |
| `empty_response` unclassified in retry policy | FIXED | `reason: "empty_response"` → fresh chat + full prompt |
| `canReuseThreadDelta` never implemented | FIXED | `context.ts` sliced on thread-record truthiness |
| `invalidateLogicalThreadParent` debounced | FIXED | persists `parent_id = null` immediately |
| `purgeLogicalThreadState` missing | FIXED | `qwen-thread-state.ts` (was referenced, never existed) |
| `advanced.test.ts` 7/11 failing on empty fixtures | FIXED | bare `[DONE]` filler replaced with a real answer delta |

## Pending (continue here)

1. **Restart QwenProxy** (proxy code changed) and opencode (config changed).
   After restart, verify the warmup fix: `GET /health` should show `ready`
   climbing toward `readinessTarget` (was frozen at 8/14), and
   `GET /health/recovery` `inFlight` should stay ≤ `POOL_WARMUP_CONCURRENCY`
   while `ready` rises — that is the double-count regression check.
2. Re-check `logs/qwenproxy-*.log` after the restart: an `empty completion —
   failing retryably` line now carries `ignoredChunks` / `lastIgnoredReason`.
   Non-zero `ignoredChunks` means content arrived but was dropped by the
   `response_id` ownership filter, not that Qwen answered with nothing.
3. Documentation task: write Phase 1 deliverables into `docs/modules/`
   (start from `docs/gap-analysis-official-api-parity.md`).
4. Offer a `docs:` commit once Phase 1 files exist.
5. Optional: session identity for Anthropic/Responses routes.

## Decisions

- **Capacity accounting was structurally cap-blind (2026-10-14).** With
  `qwen3.8-max` at `capped=13 / readyUncapped=1`, `/health` still reported
  `ready 14/14, deficit 0` — a pool that is FULL and simultaneously unable to
  serve a single request. A daily cap removes an account from service for that
  model while the lane stays READY (it is still fine for every other model), so
  `ready`/`readinessDeficit` count LANES, not servability. `/health` now also
  publishes `usableDeficit` (target minus the WORST model's `readyUncapped`),
  a `degraded` boolean, and `pool.usable_deficit` as a Prometheus gauge. Live
  proof after the change: `deficit=0, usableDeficit=13`. This is the signal an
  operator should alert on.
- **Challenge pressure steers routing; it does NOT inflate cooldowns.** First
  attempt multiplied the WAF quarantine by pool pressure under challenge load.
  Reverted: lengthening quarantines when accounts are being challenged shrinks
  the very capacity you need, and it made a lane's return time depend on
  unrelated pool state (breaking deterministic cooldown assertions). Pressure is
  now a decayed EWMA in the leaf module `core/waf-pressure.ts`, used only to
  (a) apply a soft 0.5..1 routing penalty in `rankSchedulerCandidates`, so
  recently-flagged lanes are rested instead of hammered, and (b) surface
  `wafPressure` + hottest lanes on `/health`. A successful generation
  (`noteWafSuccess`) clears both the streak and the penalty immediately.
  `waf-pressure.ts` is deliberately import-free because importing
  `waf-isolation` from the scheduler would close
  `account-manager -> account-scheduler -> waf-isolation -> account-manager` and
  risk a TDZ `ReferenceError` depending on module entry order — the same class
  of cycle that motivated extracting `playwright-page-state.ts`.
- **Measured RAM reality (2026-10-14) — supersedes the old estimate.** Live
  measurement on this host: total 15.65 GB; non-proxy apps ~8.6 GB (msedge
  3.7, msedgewebview2 1.8, OpenCode 0.77, svchost 0.87, Defender 0.5, misc);
  QwenProxy node ~0.97 GB; **14 Chromium contexts = 6.40 GB across 84
  processes**. That is **~457 MB per warm account** (~526 MB all-in including
  its share of the node process). Available for the proxy ~7.05 GB / 0.526 =
  **13.4 accounts**, so `PLAYWRIGHT_MAX_ACTIVE_CONTEXTS=14` is already exactly
  right for this box. The historical "11.1 GB" figure was correct but was for
  the DEFAULT cap of 25 contexts (25 x ~450 MB), not 14. Consequence: the RAM
  ceiling is a property of the host, not a misconfiguration — 14 accounts x
  `ACCOUNT_MAX_CONCURRENT_STREAMS=2` = **28 concurrent requests, ever**.
  Operator decision: browser-only is FINAL (no TLS-impersonation browserless
  gamble) and the pool can be grown to hundreds of accounts, so the binding
  constraints are (a) account survival and (b) per-account daily model caps,
  not RAM.
- **Warmup circuit breaker.** `recordWafHardBlock` was reachable from exactly
  ONE site (`routes/chat/account.ts:241`, the served-request path); the warmup
  path had no WAF awareness at all, so a WAF-blocked account got a plain 60s
  `AuthInitFailed` cooldown and was re-warmed forever — launching a ~457 MB
  Chromium context every cycle for nothing. The existing bounds
  (`maxWarmupFailures` -> FAILED, `POOL_BROKEN_RECOVERY_AGE_MS` -> re-arm)
  only slow that loop down, they do not stop it. Added a
  failure-reason-agnostic breaker: after `POOL_MAX_FAILED_WARMUP_ERAS`
  (default 3) *exhausted eras* an account is parked for
  `POOL_FAILED_ERA_SKIP_BASE_MS`, doubling up to
  `POOL_FAILED_ERA_SKIP_MAX_MS`, and cleared ONLY by a real successful warmup
  (so BROKEN-recovery's fresh budget cannot silently un-park it). Parking is a
  window, never terminal — `0` restores the old behaviour. Exposed as
  `readiness.warmupParked` on `/health/recovery`.
- **Token accounting no longer writes on the hot path.** `recordUsagePersist`
  previously issued two synchronous SQLite statements per request; invisible at
  a trickle, an event-loop stall at sustained throughput. It now accumulates a
  coalesced in-memory delta (four integer adds) flushed by one 1s timer inside a
  single transaction, with an `exit` flush so nothing is lost on shutdown. The
  SUM is identical — batching changes WHEN the write happens, never WHAT is
  recorded — and a failed write keeps the delta for retry (both statements are
  additive, so a retry cannot double-count).
- Verification: `npm run typecheck` clean; `npm run test:runtime` 167/167;
  `npm run test:mock` 1081 pass / 0 fail / 1 skipped — the skip is
  `server-lifecycle` reporting "port 7936 is not available" because the live
  proxy is running, not a regression (it passes when the port is free).
- **Phantom-busy / stuck-warming incident (2026-10-14).** `/health` showed
  `busy:15, warming:53, ready:1` while only 2 streams were active and
  `/health/recovery` showed a single tracked lease. Three compounding defects:
  1. `concurrency.leaseMaxDurationMs` had no default: `ACCOUNT_LEASE_MAX_DURATION_MS`
     unset → `Math.max(0, parseInt(undefined))` = **NaN**. Every sweep guard
     `heldMs > maxDuration` evaluates `heldMs > NaN` = false, so the 30s
     stale-lease sweep was silently disabled. Fixed with a 900 000 ms fallback
     (`config.ts`); also hardened `chatInProgressDelayMs` / `chatInProgressBusyMs` /
     `chatInProgressMaxAttempts` / `midStreamFailoverThreshold` /
     `midStreamFailoverBusyMs` with `Number.isFinite` fallbacks.
  2. No ownership-level deadline enforcement. `AccountResourceManager.acquire()`
     stores a `deadline` on the lease but nothing ever checked it, and
     `markStaleAndFence` is only called from tests. A lease that outlives its
     tracking entry (error path skips release, restart loses the slot map)
     pinned the account in RESERVED/GENERATING forever, and `isAccountBusy()`
     in bound mode reports BUSY on `lease !== null`. Fixed:
     `sweepExpiredLeases()` on the manager (RESERVED→READY, GENERATING→RECOVERING,
     bumps fencingEpoch), wired into the existing 30s sweep timer
     (`account-concurrency.ts:startLeaseSweepTimer`); added to `IAccountOwnership`.
  3. Ownership-lease leak in the outer rotation loop (`routes/chat/account.ts`).
     The lease is claimed before the loop (line ~1001) but released only inside
     `tryCreateStreamWithRetry`. A budget-violation `break` at the top of the
     loop left `ownershipLease` claimed and never tracked/released → the account
     stayed BUSY with zero streams. Fixed: release any residual ownership lease
     immediately after the outer loop exits (before the post-loop error mapping).
  Tests: `npm run typecheck` clean; runtime suite 164/164;
  resource-manager + readiness-controller 24/24.

- **Warmup freeze + "no hot accounts" (2026-10-14).** The pool sat at
  `ready 8 / target 14` with 62 accounts displayed as "warming" while
  requests failed with `no_hot_account`. Four distinct defects, all fixed:
  1. **Readiness double-count (the "stops midway" freeze).**
     `readiness-controller.ts` computed
     `warming = snapshot.warming + recovering + inFlight.size`. In-flight
     warmups are ALREADY in `snapshot.warming` because `warmAccount`
     transitions the account to WARMING synchronously before its first await
     (`construct.ts`). Adding `inFlight.size` again halved effective
     concurrency: with 4 in-flight the controller computed deficit 0 and
     refused to fill free slots, so `ready` never climbed to target. The
     clamp `warmupConcurrency - inFlight.size` already enforces concurrency
     exactly once, so the redundant term was dropped. Locked by a regression
     test whose fake mimics production (launched accounts hold WARMING
     status); it fails on the old expression.
  2. **Model daily-cap masqueraded as "no hot accounts".** The selection
     boundary excluded capped-for-model accounts, so when every READY account
     was capped for `qwen3.8-max` the lease authority returned
     `NO_CANDIDATES` and the caller reported `no_hot_account` — while
     `/health` showed ready accounts. The "everything capped" guard checked
     ALL accounts while the candidate filter checked READY-minus-capped, so
     the two disagreed.
  3. **Caps were not persisted, so every restart re-drained the pool.**
     `model-daily-limit.ts` deliberately kept caps in memory only; a restart
     forgot them, re-probed exhausted accounts, re-drained the warm pool for
     that model and burned the create budget (`8/8 attempts`). Caps are now
     persisted in `model_daily_caps` with `resets_at` = next UTC midnight,
     restored before the first warmup tick, and swept on the reconciliation
     interval.
  4. **Waits instead of failing blind, and says the truth.** After (3), a
     `NO_CANDIDATES` caused by caps waits up to `POOL_MODEL_CAP_WAIT_MS`
     (default 8s; `0` restores the exact fail-fast contract) for an uncapped
     account to come hot — bounded by the per-request create deadline,
     abort-aware, and a no-op with no model. Same-model rotation is preserved
     (no model substitution, per operator decision). `/health` now reports
     `readyUncapped` per capped model — the exact condition that used to be
     invisible.
- **Token accounting could silently under-report.** `applyUpstreamUsage`
  read only `input_tokens`/`output_tokens` (and `output_tokens_details`), so
  an OpenAI-shaped upstream payload (`prompt_tokens`/`completion_tokens`) was
  ignored and the accumulator kept the LOCAL ESTIMATE — the reported totals,
  including the new persisted `usage_totals`, would not match what upstream
  actually billed. Both shapes are now accepted, Qwen names keeping priority.
  This is the "tokens must add up" invariant, not a cosmetic fix.
- **Second pre-existing test failure (environmental, not this work).**
  `utils-logger-full` asserted `UPSTREAM_DEBUG` is unset, but the developer's
  `.env` sets `UPSTREAM_DEBUG=true` and it leaks through `dotenv/config`;
  pinned `UPSTREAM_DEBUG=` in `.env.test` per that file's stated purpose.
- **Upstream reality (2026-10-14, not a proxy defect).** The remaining stuck
  "warming" accounts are WAF-blocked at Qwen: the live log shows
  `[Qwen] Completion returned an HTML or anti-bot challenge body` during
  header capture, followed by `[WafIsolation] Hard WAF block … quarantined`.
  Much of the 72-account pool is burned upstream (pending activation,
  email-not-found, WAF), so `ready` cannot reach 14 from healthy accounts
  alone. Permanent-auth accounts are already quarantined by the existing
  `AuthPermanentFailure` → `hasPermanentInitEvidence` path and the transient
  cohort is bounded by `POOL_MAX_WARMUP_FAILURES` +
  `POOL_BROKEN_RECOVERY_AGE_MS`; deliberately NO new quarantine logic was
  added, to avoid stranding recoverable accounts.
- Verification: `npm run typecheck` clean; `npm run test:mock` 1082/1082;
  `npm run test:runtime` 165/165.

- **empty-response guard incident (2026-10-13).** `[chat] stream: empty
  completion — failing retryably` reaching the client was five defects, not one:
  1. `streaming.ts` main SSE loop accepted answer text ONLY when
     `delta.phase === "answer"`. The malformed-tool retry channel two hundred
     lines below already keyed off `delta.content !== undefined`. Any delta
     tagged differently (or untagged — which the fast-path regex at the top of
     the same loop already handles) was parsed and silently discarded, so a turn
     where the model DID answer ended as zero tokens. Fixed to the retry
     channel's rule.
  2. The guard threw straight out of the stream handler. The SSE response is
     committed before the first upstream byte, so the request-level retry loop
     can never run again — but the transparent in-stream recovery can, and it
     was never called. Fixed: the empty turn now recovers in place (inside the
     read loop, where the swapped reader can be drained) and only fails once
     that budget is gone.
  3. `rememberParent(pendingParentId)` ran BEFORE the zero-token check, so an
     empty turn persisted a parent describing a response the client never saw.
     Fixed: commit moved after the check; the empty path also nulls
     `pendingParentId` and calls `invalidateLogicalThreadParent`.
  4. `empty_response` had no branch in `classifyRetryAction`, so it fell through
     to `explicit_retryable` with `forceNewChat: false` and
     `retryWithFullPrompt: false` — a replay identical to the one that just
     failed. Fixed with a dedicated branch (fresh chat + full context, 0 ms).
     `toRetryableStreamError` also coerced an explicit `retryAfterMs: 0` into
     `baseDelayMs` via `||`; now `??`.
  5. `context.ts` sliced the prompt to `currentPrompt` on the truthiness of the
     thread RECORD, but `invalidateLogicalThreadParent` deliberately keeps that
     record and clears only `parentId`. A dirty thread therefore sent a delta
     onto nothing. Fixed to `chatSessionId && parentId`, matching
     `acquireUpstreamStream`'s `canReuseUpstreamChat`.
  Supporting fixes: `invalidateLogicalThreadParent` now writes `parent_id = null`
  straight to SQLite instead of joining the 300 ms debounce (a stale parent
  surviving a restart is the exact ghost this prevents); `purgeLogicalThreadState`
  added (PROJECT.md's M1 contract referenced a function that never existed, which
  is why three untracked suites could not even import).
- **Log evidence.** `logs/qwenproxy-2026-10-12T16-55-56*.log` is from a build
  that logged `empty completion — attempting recovery` and did rotate accounts
  (2–4 attempts per request) before dying; `logs/qwenproxy-2026-10-12T17-07-29*.log`
  is the committed build that never attempted recovery at all. Same upstream,
  same accounts, opposite client outcome — the missing recovery call was the
  difference.

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
