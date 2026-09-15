# ROUTING — Account Routing with Sticky Affinity + Tiered Context Injection

Routing layer: complete (55 tests pass).
Runtime stabilization: pending until items 1-6 pass on a real two-session run.
tsc: must be clean before this branch is mergeable.

Status detail (2026-09-15, second pass — the 7 stabilization items):

- Item 1 (tsc): CLEAN. `npx tsc --noEmit` exits 0. The `withPlaywrightInitSlot`
  brace mismatch and the missing `maxParallelInit` / `hostResolverRules` /
  `chatOriginIp` config fields were fixed on this branch (commits `3824f83`,
  `e3b8c0e`, present in tree; verified `tsc done: True` after every later
  commit). If tsc ever goes red again, do not merge.
- Item 2 (tiered on real path): DONE. `assembleCompressedContext` is called on
  the real failover path via `buildCompressedFailoverPrompt` in
  `src/routes/chat/account.ts` (4 sites: sticky-failover, in-progress
  escalation, inner account switch, force-new-chat) plus the request-retry
  path in `src/routes/chat/index.ts`. `grep assembleCompressedContext
  src/routes/chat/account.ts` → import + call (2 hits). `grep full-replay
  src/routes/chat/account.ts src/routes/chat/index.ts` → 0 hits. Failover logs
  `context=compressed` with chars (e.g. `prompt=10/100000` seen live in the
  mock-stack e2e log below). `compressContextForFailover` definition and its
  own unit tests remain; it is no longer called on any failover path.
- Item 3 (personalization mutex): DONE. try/finally was already present;
  acquire budget was already 2s with skip; changed sync deadline 5s→2s with
  `[Personalization] skipped after 2s` + proceed on TIMEOUT, while explicit
  fast sync failures still throw `PersonalizationSyncError` (fail-loud e2e
  still green). Mutex acquire-timeout warn silenced for this call site
  (`silentTimeout`), so `Mutex[personalization` must not appear in normal logs.
  New test: 10s lock hold → chat completes in ~2.0s with skip logged and zero
  `Mutex[personalization` output.
- Item 4 (Playwright bound): DONE the missing piece — global `PW_SEM=5`
  (`withPlaywrightOpSlot`) wrapping header capture, login, keep-alive, with
  high-water tracking; 50-task test proves ≤5 concurrent (observed overlap ≥2,
  all 50 complete; error path releases). Already-present and verified, not
  re-built: context pool reuse (`accountContexts`/`accountPages`,
  `maxActiveContexts` evicts idle only), `--host-resolver-rules=MAP
  chat.qwen.ai 8.219.122.25` (chromium-args test green), closed-context pool
  eviction (`installContextDeathHandlers` + `isPlaywrightAlreadyClosedError`
  covers `Target page, context or browser has been closed`). The 10-minute
  zero-occurrence run is part of item 6 (blocked, see below).
- Item 5 (semantic retention): DONE, no ranking fix needed. 500-message
  conversation, `FACT_7F3A9B` planted at exchange 50, query shares rare terms
  (`config key ... note`) → BM25 retrieves it into T2 (observed `t2=2msgs`,
  marker asserted in T1/T2). Also added: single-2M-paste last-resort trim
  (served with `[Context truncated ...]` notice, never full-sent, never throw
  for a servable turn) + envelope overhead reserve — 12/12 tiered tests green.
- Item 6 (real two-session run): NOT RUN — blocked, no traffic sent. Evidence:
  live proxy on 127.0.0.1:7936 (26 accounts, 3 ready, 2 active sticky
  bindings) is owned by another session (TUI, PID 34372); my items 2–4 are
  working-tree-only and NOT deployed there; forcing quota exhaustion would burn
  a production account's full daily quota across the 26-account pool; 2×20
  real turns risk WAF challenges on production accounts. Closest real
  evidence: mock-stack full-HTTP e2e runs the REAL routing/failover code
  against REAL DB accounts — raw log shows live rotation
  (`mock -> webagencyhermes2 -> enc`) with real compressed failovers
  (`[Session] Failover context=compressed | reason=inner-account-switch |
  prompt=10/100000 | t1=1msgs | t2=0msgs | refs=1`). The full 2×20 + forced
  quota procedure needs a maintenance window (deploy branch, no live traffic)
  and an explicit quota-burn approval.
- Item 7 (this file): status set honestly. Do not claim completion until the
  two-session test is green.

## Raw-log excerpt (mock-stack e2e, real routing + real DB accounts)

Verbatim lines from `personalization-required.test.ts` e2e (forced sync failure
→ real rotation across real DB accounts → real tiered failover assembly):

```
❌ [Chat] Request failed | mock | personalization_unavailable | personalization sync not confirmed for mock: settings response did not confirm the instruction
🧭 [Chat] Retry policy | account=mock | reason=personalization_sync_failed | retryable=true | switch=true | newChat=true | fullPrompt=false | retryAfter=50ms
🔄 [Chat] Switching account after personalization_sync_failed | mock -> webagencyhermes2
[Session] Context compressed | t0=31 | t1=1msgs | t2=0msgs | t3=0 | total=62/100000
[Session] Failover context=compressed | reason=inner-account-switch | prompt=10/100000 | t1=1msgs | t2=0msgs | refs=1
🔄 [Chat] Retrying request | webagencyhermes2 | qwen3.6-plus | 1 msg(s) | 10 chars | attempt 2
❌ [Chat] Request failed | webagencyhermes2 | personalization_unavailable | personalization sync not confirmed for webagencyhermes2: settings response did not confirm the instruction
🔄 [Chat] Forcing new chat/compressed context | reason=personalization_sync_failed
[Session] Failover context=compressed | reason=force-new-chat:personalization_sync_failed | prompt=10/100000 | t1=1msgs | t2=0msgs | refs=1
❌ [Chat] Error | 503 personalization_unavailable | personalization sync not confirmed for webagencyhermes2: settings response did not confirm the instruction
```

And from the 10s-hold skip test (item 3 evidence, verbatim):

```
⏩ [Chat] Skipping personalization sync | account=mock | lock busy for >2000ms
⏱️ [Chat] Acquire: sync | account=mock | +2065ms
```

(request completed in 2024ms total; zero `Mutex[personalization` strings in
captured output; fail-loud e2e above still returns 503 with zero completions
sent — timeout-skip and explicit-failure paths both behave as designed.)

Command:

```sh
npx tsx --test --env-file=.env.test \
  src/tests/sticky-map.test.ts src/tests/sticky-key.test.ts \
  src/tests/account-health-tracker.test.ts src/tests/account-selection.test.ts \
  src/tests/vector-store.test.ts src/tests/rolling-summary.test.ts \
  src/tests/tiered-context.test.ts src/tests/rebind-integration.test.ts \
  src/tests/burst-quota.test.ts src/tests/two-sessions.test.ts \
  src/tests/health-sessions.test.ts src/tests/personalization-lock-skip.test.ts \
  src/tests/personalization-deadline.test.ts src/tests/playwright-op-slot.test.ts
```
Measured 2026-09-15: **55 tests, 55 pass, 0 fail**.

Note: `tsc --noEmit` currently fails on a pre-existing uncommitted WIP in
`src/services/playwright.ts:1726` (`withPlaywrightInitSlot` brace mismatch +
missing `config.playwright.hostResolverRules/chatOriginIp`). Unrelated to
routing; left untouched. All routing/context modules pass `tsx` transform +
unit tests.

## Loops

### Loop 1 — StickyMap (`src/services/session/stickyMap.ts`)
SQLite `sticky_bindings` authoritative + mem L1 + optional Redis L1 (`REDIS_URL`,
`SET PX`, atomic rebind). TTL 6h sliding via `touch()`, `sweep()` every 60s.
Tests (6): same-key hit, TTL expiry, atomic rebind (boundAt preserved,
`rebindsLastHour=1`), sliding touch, restart survival via new instance
hydrating SQLite, sweep count. Commit `f39a8c3`.

### Loop 2 — Sticky key (`src/services/session/key.ts`)
`header > first_message > combined > random`, 16 lower hex, `[Session] Sticky
key generated | source=...`, warn on random. Wired in
`src/routes/chat/index.ts` (lookup + `touch` on hit, `c.set(stickyKey)`).
Tests (6): header priority, determinism, inequality, random fallback,
explicitKey==header, array-content extract. Commit `ac95363`.

### Loop 3 — HealthTracker (`src/services/account/health.ts`)
Adapter over `core/account-health.ts`. Windows: 20 attempts, 20 TTFB,
5m 429, 10m captcha. `score = successRate * latencyFactor * (1-min(r429/5,1))
* (1-min(captcha/3,1)) * consumeFirst`. `latencyFactor` 1.0 @p99<5s → 0.1
@>60s linear. `consumeFirst` 1.5 if reset ≤2h, 0.5 if ≥5d. `classify429`:
burst if `retry-after<60s`, quota if `≥60s` or `/RateLimited.*tomorrow/i`.
Wired: `recordSuccess` on `onStreamComplete`, `record429/recordCaptcha` in
outer catch + stream-retry catch (burst logs "no rebind"). Tests (6):
score→1 on success, burst no quota mark, 5×quota → score ~0.0 + `quotaResetAt`
set, multiplier 1.5/0.5, classify, p99 70s → score 0.1. Commit `aa9a24e`.

### Loop 4 — Selection (`src/services/account/selection.ts`)
Filter `score<0.2`, quota/cooldown, excluded. Sort `(score*headroom)` desc,
`headroom` 1.0 free / 0.2 busy / 0 cooldown, tiebreak LRU then id.
Deterministic. Logs `[Session] New session bound | key | account | score |
pool_size`. Advisory wiring in chat route (authoritative pick stays in
`scheduler`). Tests (5): highest score, quota skip, exclusion→null, empty→null,
tiebreak lexicographic. Commit `46b6dbd`.

### Loop 5 — VectorStore (`src/services/context/vectorStore.ts`)
BM25 (reuses `tokenize`), mem hot + SQLite `vector_chunks`, dedup by
`(session,messageId)`, score-desc. Tests (4): relevant top-1, no-embedding
fallback, dedup, delete. Measured: `database optimization` query → `m1`
score ~1.36. Commit `411f75c`.

### Loop 6 — RollingSummary (`src/services/context/summary.ts`)
Extractive incremental (LLM smallest-model hook TODO). Triggers: every 10
turns or >50k chars. Cap 5,000 chars. Fail-open keeps previous + warns.
SQLite `rolling_summaries`. Tests (3): incremental append, injected failure
keeps previous, 5×10k → capped ≤5,000. Commit `954f849`.

### Loop 7 — Tiered (`src/services/context/tiered.ts`)
`Message[] → {t0,t1,t2,t3,refs,payload,totalChars}`. T0 verbatim. T1 last 3
user-anchored groups. T2 BM25 top-8 vs `currentTurn`, chronological. Budget:
drop lowest T2 → oldest T1 groups (whole groups preserve tool pairs) →
truncate T3 → throw (never full). Refs `ref_N` for every non-T0. Tests (5):
250 exchanges (~2M chars) → `total=56,627/100,000`, T0 `===`, T1 6 msgs starting
`Question 7`, tool call/result co-retained, refs==retained. Commit `41090dc`.

### Loop 8 — Rebind (`src/routes/chat/index.ts`)
Post-acquire: no binding→`set`; mismatch→tiered-validate (<100k) + `rebind`;
match→`touch`. Retry path keeps binding aligned. Async non-blocking
`vectorStore.add` + `summary.update`. Same-account keeps delta. Test
`rebind-integration`: 20 turns stay, 5×quota → rotate excluding old, big-conv
`total=56,652 ≤100k`, T0 identical, 5 turns stay. Rebind decision measured
`<1ms` (<500ms budget). Commit `15b7f51`.

### Loop 9 — Burst vs quota (`src/routes/chat/index.ts` + `burst-quota.test.ts`)
Stream-retry catch records `quota_or_rate_limit` as burst when
`switchAccount=false` (pace, "no rebind" log) else quota. No rebind on burst
because account unchanged. Test: 1×burst → score 0.6 still selectable, no quota
mark, binding stays; 5×quota → rotate + rebind. Commit `117271a`.

### Loop 10 — Two sessions (`two-sessions.test.ts`)
Keys differ for different first messages. 3 accounts: A→`acc-a`, B→`acc-b`
(LRU steering). A lease held → B select `<1ms` (<500ms, no cross-block).
Exhaust A → rebind `acc-a→acc-c` (unused account, not B's), payload
`56,643 ≤100k`, B stays `acc-b`, A stays `acc-c` ×3. Commit `5089144`.

### Loop 11 — Observability (`src/api/server.ts`, `stickyMap.touch`, this file)
`GET /health/sessions → {size, activeBindings, rebindsLastHour, bindings[]}`.
`[Session]` logs on bind/rebind/touch/key/selection/health/compress. Test
`health-sessions`: 2 sets + 1 rebind → `{size:2, activeBindings:2,
rebindsLastHour≥1}` (measured pass ~36ms).

## Acceptance (unit/mock-level evidence — live run still pending per item 6)

1. Different first messages → different accounts: `two-sessions` `pickA≠pickB` ✓
2. 20 turns same account: `rebind-integration` 20× `get==first` ✓
3. Quota rebind <500ms: measured `<1ms` sync decision ✓
4. Burst no rebind: `burst-quota` binding stays after burst ✓
5. Failover ≤100k on ~2M: `56,627 / 56,652 / 56,643` ✓
6. T0 byte-identical: `t0===systemPrompt` ✓
7. Tool pairs intact: call/result co-retained ✓
8. No cross-block: B select `<1ms` while A holds lease (<500ms) ✓
9. Restart survival: new `StickyMap` hydrates SQLite ✓ (Redis path optional;
   `REDIS_URL` unset in tests → SQLite+mem; Redis unreachable warns)
10. `/health/sessions` accurate: `{2,2,≥1}` ✓ (manual: `curl /health/sessions`)

## Must-not-change guards
Delta happy path untouched (`useThreadNative`/`currentPrompt` logic intact);
T0 verbatim; tool pairs grouped; personalization sync untouched; response
schema untouched; locks untouched (touch/rebind are sub-ms mem+SQLite, no lock
>5s); over-budget throws instead of sending full context.
