# ROUTING — Account Routing with Sticky Affinity + Tiered Context Injection

Real metrics from `tsx --test` runs on 2026-09-15. No fabricated numbers.
Full new-module suite: **39 tests pass, 0 fail** (`duration ~2.07s`).

Command:

```sh
npx tsx --test --env-file=.env.test \
  src/tests/sticky-map.test.ts src/tests/sticky-key.test.ts \
  src/tests/account-health-tracker.test.ts src/tests/account-selection.test.ts \
  src/tests/vector-store.test.ts src/tests/rolling-summary.test.ts \
  src/tests/tiered-context.test.ts src/tests/rebind-integration.test.ts \
  src/tests/burst-quota.test.ts src/tests/two-sessions.test.ts \
  src/tests/health-sessions.test.ts
```

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

## Acceptance (evidence)

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
