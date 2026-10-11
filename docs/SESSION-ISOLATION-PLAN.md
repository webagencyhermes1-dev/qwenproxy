# Session Isolation — Production Engineering Plan

**Bug class:** two sessions open; the response for session B is emitted into session A (cross-session response contamination).
**Status:** root causes verified against source; implementation plan below.
**Scope note:** every claim in §2 carries a `file:line` ref verified in the current tree. Unverified assumptions are marked.

---

## 1. Problem Statement & Core Invariant

The proxy sometimes emits a response from one logical conversation into another. This is a proxy-side correlation issue, not model behavior.

Every request must own a strict chain:

```text
HTTP request → request_id → session_key → account_id → lease_id
  → operation_id → upstream chat_id/parent_id → upstream response_id
  → SSE chunk → client response writer
```

Any chunk, event, parent commit, or writer call that cannot prove membership in the current chain must be **dropped + logged + counted** (and, in strict mode, fail the request).

---

## 2. Verified Current-State Assessment

Verdicts: DANGEROUS = can cause the reported bug today · PARTIAL = gap exists but is partially mitigated · SAFE = verified sound.

### 2.1 Session identity

| Finding | Verdict | Evidence |
|---|---|---|
| Implicit thread sessions are **content-derived**: with no `session_id`, anchor is literally `"implicit-thread" \| firstUserText` → two clients with equal (or empty) first message get the SAME `sessionId` | **DANGEROUS** | `src/utils/session-id.ts:12-23`, `src/routes/chat/context.ts:100-108` (`useThreadNative` hardcoded `true` at `:69`) |
| That shared `sessionId` keys a **process-global + SQLite thread table** → both clients reuse the same upstream `chatSessionId` → both talk to the SAME Qwen chat | **DANGEROUS** | `src/services/qwen-thread-state.ts:190-252`, `src/routes/chat/account.ts:858-875`, `:2080-2090` |
| Sticky key falls back to **unsalted prompt-content hash** → shared rolling-summary / vector-store namespace across clients | **DANGEROUS** | `src/services/session/key.ts:53-78`; consumers `src/routes/chat/index.ts:480,506-508`, `account.ts:787-789` |
| Lease label fallback: `const sessionLabel = params.sessionId ?? currentAccountEmail` → all temp sessions on an account share one label; masked local-part collides after inner account switch | **DANGEROUS** | `src/routes/chat/account.ts:1778`; switch at `:2656`; `maskEmail` at `src/core/logger.ts:8-13` |
| Client-controlled `session_id` becomes a **global key with no tenant scoping** | PARTIAL | `src/routes/chat/validation.ts:135-141`; single `DEFAULT_TENANT_ID = "default"` at `index.ts:164` |
| Header handling: only `x-session-id` exists (`index.ts:221-222`); `session_id`/`conversation_id` accepted; `user` log-only | SAFE | `validation.ts:85-89,135-141,468` |

### 2.2 Chunk ownership (the direct emission path)

| Finding | Verdict | Evidence |
|---|---|---|
| **Fast-path regex handles the majority of content bytes with ZERO ownership check** — captures `response_id` as `[^"]*` and discards it, then `emitAnswerText` unconditionally | **DANGEROUS** | `streaming.ts:1861-1896` (`continue` at `:1895`) |
| Malformed-retry read loop also unguarded | **DANGEROUS** | `streaming.ts:2447-2511` |
| Guard semantics are permissive-while-unbound: `targetResponseId === null → accept every delta`; first chunk carrying any id becomes "mine" | **DANGEROUS** | `streaming.ts:1944-1950`, `:495-501` |
| `pendingParentId` is assigned **outside** the ownership guard → a foreign `response.created` replaces the parent this session will commit | **DANGEROUS** | `streaming.ts:1927` (also `:481`, `:2433`) |
| `rememberSession(extractChatSessionId(chunk))` **rebinds** `currentUiSessionId` from ANY chunk → foreign `chat_id` rewrite of the registry entry | **DANGEROUS** | `streaming.ts:1900`, `:458`; mutator `:1322-1326`; registry `stream-registry.ts:111-116` |
| No `chat_id`/`operationId` filter anywhere in the read loop | **DANGEROUS** | grep: no `operationId` check in `streaming.ts` |
| Transport demux (browser → Node) is keyed by per-call `uuidv4()`; unknown ids dropped | SAFE | `qwen.ts:1234-1242`, `:162-189` |
| Stream-registry keys are `chatcmpl-<uuid>` per request — no key collision | SAFE | `account.ts:854`, `stream-registry.ts:21-52` |
| Client writer: single writer per request; retries reuse it intentionally; `clientDisconnected` guards buffered path | SAFE | `streaming.ts:1002,1170-1241` |
| Parser state: 100% per-instance, no module-scope mutable request state in `streaming.ts` | SAFE | `tools/parser.ts:1180-1212`; `streaming.ts` column-0 scan (only shared item is failure-timestamp map `:165`) |
| Retry context: 5 scalar fields, created once per request, no parser/parent/writer state | SAFE | `account.ts:389-424`, `index.ts:356` |

### 2.3 Parent commit & session versioning (CAS)

| Finding | Verdict | Evidence |
|---|---|---|
| `pendingParentId` scope is function-local (not shared) | SAFE | `streaming.ts:342` (non-stream), `:1320` (stream closure) |
| Commit guard is only `pendingParentId && upstreamDone` — no abort/superseded/ownership check | PARTIAL | `streaming.ts:2588-2594` |
| **Non-stream commit has NO completeness/abort guard and runs BEFORE the CAS** → diverges on conflict; aborted client still commits | **DANGEROUS** | `streaming.ts:862-865`, CAS at `:881-906` |
| `rememberParent` writes to a target chosen from **mutable, chunk-rebindable** `currentUiSessionId` | **DANGEROUS** | `streaming.ts:1328-1337`; rebinds at `:1710`, `:2373` |
| CAS conflict: logged at call site only, **never metered**; no committer liveness check; `updateState({expectedState:"QUEUED"})` result ignored | PARTIAL | `session-service.ts:169-217`, `streaming.ts:2704-2713`; no `metrics.increment` for session conflicts anywhere |
| **Grace-disconnect leaves the generation stuck `QUEUED`** (parent committed, versioned commit skipped, teardown timer cleared in `finally`) → permanent `SESSION_BUSY` until restart | **DANGEROUS** | `streaming.ts:2591` (outside `:2668` guard), `:2859-2862`, fail path only via `:1036-1039` |
| `versionAtStart` is per-request | SAFE | `context.ts:32-34`, `index.ts:207-212` |
| Busy flag + idempotency map are **process-local** while CAS is DB-wide (multi-process hazard) | PARTIAL | `session-service.ts:81-82` vs `session-repository.ts:217-230`; deadline written but never swept (`:11`, no caller) |

### 2.4 Lease, supersede, wait policy

Two regimes exist. Production always binds the authority (`construct.ts:159`, `account.ts:905` → `useGateway = true`), so `params.ownershipLease` is always set and the legacy queue path (`account.ts:1840-1876`) is unreachable.

| Finding | Verdict | Evidence |
|---|---|---|
| **Inner account switch never releases/re-claims the authority lease** → new account served with a FREE authority slot (second session can be claimed concurrently); old account reserved only until request end | **DANGEROUS** | switch at `account.ts:2654-2657` + `continue :2689`; no `acquireGenerationAccount` in `tryCreateStreamWithRetry`; outer loop is correct (`:1145-1164`) |
| `abortLeaseByLabel` matches bare `l.label === label`; returns boolean only; shared defaults `"unlabeled"`/`"try-acquire"` | PARTIAL | `account-concurrency.ts:612-621`, `:42-59`, `:308`, `:288` |
| Wait-policy "same session" = label string equality; **`!label → false` (fail-open toward unbounded wait)**; capacity gate `< maxStreamsPerAccount → false` | **DANGEROUS** | `account-concurrency.ts:114-126`, `account.ts:1563-1569` |
| **`account_busy` is never thrown on the production path** — authority rejects with `ACCOUNT_UNAVAILABLE` → no rotation branch matches → bare 503 | **DANGEROUS** | `resource-manager.ts:377-387`, `account.ts:919-937`; `retry-policy.ts:658-667` matches only legacy messages; `index.ts:415` |
| Outer `catch`/`finally` in the route releases the chat lock but **never the account lease** | PARTIAL | `index.ts:1012-1015`, `:1050-1052` |
| `acquireDeadlineTimer` not cleared on race failure; lease sweep timer defined but production never starts it | PARTIAL | `account.ts:2255` catch; `account-concurrency.ts:879` (test-only caller) |
| Release paths otherwise complete and idempotent; stream lock released on every outcome | SAFE | `account.ts:1881,2019,2172,2258,2253`; `qwen.ts:2792-2823,3394` |
| `priorParent` unguarded fallback can bind another account's `parentId` under this account during a first-turn race | **DANGEROUS** | `account.ts:2196-2205` (fallback `getLogicalThreadState(...)?.parentId`); first turn takes no chat lock (`index.ts:347-349`) |

### 2.5 Retry / failover / writer / browser relay

| Finding | Verdict | Evidence |
|---|---|---|
| Sequential cross-account failover is triple-guarded (fresh chat + full replay + ownership gate) | SAFE | `account.ts:1114-1118`, `:1177-1182`, `:1761-1767`; `streaming.ts:1676-1678` |
| In-stream emission gate blocks reroute after first token | SAFE | `streaming.ts:1309`, `:1504-1513`, `:1490-1502` |
| Route-level `canRetry` has **no emission gate** (mostly unreachable for streams — Hono detaches the callback) | PARTIAL | `index.ts:670-674` |
| Malformed-tool retry has **no emission gate** and can continue on another account mid-response | PARTIAL | `streaming.ts:2211-2216` |
| Malformed retry resets parser/`targetResponseId`/`pendingParentId`/`upstreamDone` but **NOT `usageAccumulator` nor `retryContext.activeAccountId`** (account-switch path resets both) | PARTIAL | reset `streaming.ts:2357-2365` vs `:1715-1730`; stale use `:1495-1500`, `:2445` |
| Malformed-retry acquires omit `retryContext` → shared create budget not enforced there | PARTIAL | `streaming.ts:2278-2308`, `:701-730` vs `:1696`, `index.ts:882` |
| Writer gaps: unguarded direct write `:2087`; `markStreamEmitted` fires even when bytes were dropped `:1261`; abort listener registered without already-aborted check `:1165` | PARTIAL | `streaming.ts:2070-2092`, `:1258-1261`, `:1142-1165` |
| Heartbeat + disconnect-grace are bounded and self-terminating | SAFE | `streaming.ts:1202-1216`, `:1142-1163`, `:2859-2862` |
| Browser relay: **no `operationId`/`accountId` check** in either binding; state object doesn't record them; transport itself is uuid-keyed and late events dropped | PARTIAL | `qwen.ts:139-144`, `:198-203`, `:162-189`, `:121-127` |
| `stop.ts` session-scan can target a wrong stream: `?? chat_id` fallback can never match real keys; `targetResponseId === ""` window skips the response check | PARTIAL | `stop.ts:41-70`; registry `targetResponseId: ""` at `account.ts:1220` |
| Responses API adapter applies no ownership filter at all | PARTIAL | `routes/responses/streaming.ts:93` (zero `response_id` matches) |

---

## 3. Root Causes, Ranked

| Rank | Root cause | Explains symptom | Fix phase |
|---|---|---|---|
| 1 | **Implicit session identity collision** — two clients → one `sessionId` → one upstream Qwen chat → literal response mixing | ✅ direct | P0 |
| 2 | **Chunk ownership not enforced** — fast path + retry loop bypass; first-chunk-wins binding; foreign `response.created` accepted | ✅ direct | P1 |
| 3 | **Parent commit not correlation-guarded** — rebinding target, weak `upstreamDone` guard, pre-CAS non-stream commit | thread continuation leak | P2 |
| 4 | **Lease label too broad + authority not re-claimed on inner switch** — wrong-session supersede/wait; concurrent claims | aborts / concurrency | P0+P3 |
| 5 | **Retry state not fully reset** — usage accumulator, account attribution, missing emission gates | mixing after retry | P0 |
| 6 | **CAS conflicts silent + grace-disconnect strands generations** | stuck sessions, hidden races | P2 |
| 7 | **Writer lifecycle gaps** — one unguarded write, false `emitted` flag, missed pre-aborted signal | late-writer mixing | P0 |
| 8 | **`account_busy` never fires in production** — busy = bare 503, no rotation | wrong wait/fail behavior | P3 |
| 9 | **Browser relay unprovenanced** (defense-in-depth; transport already uuid-keyed) | latent | P4 |

---

## 4. Design: StreamCorrelation Contract

New module: **`src/runtime/correlation/stream-correlation.ts`**

```ts
export interface StreamCorrelation {
  requestId: string;            // completionId (chatcmpl-uuid) — per attempt
  sessionKey: string;           // explicit session id, else `req:${requestId}` — NEVER content-derived
  conversationMode: "thread" | "temp-thread" | "temp";
  accountId: string;
  leaseId: string | null;
  operationId: string | null;

  boundChatId: string | null;       // bound once (stream create / first response.created)
  targetResponseId: string | null;  // bound once, enforced forever
  attempt: number;

  clientEmitted: boolean;
  upstreamDone: boolean;
  aborted: boolean;
  superseded: boolean;
}
```

Rules:
- Created once per request in `index.ts`; **cloned** per attempt (`attempt++`, `targetResponseId/boundChatId` reset).
- No function infers identity from globals, account email, or prompt content.
- Chunk acceptance lives in one exported function used by all four read loops:

```ts
export function acceptChunk(c: StreamCorrelation, chunk: {
  response_id?: string; chat_id?: string; operationId?: string;
}): boolean
```

Because the existing streaming state is function-local, P1 wires `acceptChunk` over the existing locals (`targetResponseId`, `currentUiSessionId`, `emittedModelOutput`) rather than restructuring the 3,000-line function in one move; the formal object replaces them incrementally (P4).

---

## 5. Implementation Phases

Each phase is independently shippable, tested, and revertible.

### Phase 0 — Immediate mitigations (highest value / lowest risk)

| # | Change | File:line |
|---|---|---|
| 0.1 | **Kill implicit-thread identity collision.** When no explicit `session_id`/`conversation_id`/`x-session-id`: mint `sessionId = \`sess_eph_${randomUUID()}\`` instead of `deriveSessionId(..., "implicit-thread", ...)`; set `allowThreadReuse = false` for that request so no logical-thread row is persisted/reused | `context.ts:100-108`, flag read from `validation.ts:185` (`hasExplicitConversationKey`) |
| 0.2 | **Salt the sticky key** with a client-unique component (API-key hash) when falling back to content hash; never let two clients collide | `key.ts:53-78`, call site `index.ts:218-227` |
| 0.3 | **Fix lease label:** `const sessionLabel = params.sessionId ?? \`req:${params.completionId}\`` — never account-scoped data | `account.ts:1778` |
| 0.4 | **Writer guards:** gate `:2087` on `!clientDisconnected`; move `markStreamEmitted` behind `!clientDisconnected && !signal.aborted`; call `abortHandler()` immediately if signal already aborted | `streaming.ts:2087`, `:1258-1261`, after `:1165` |
| 0.5 | **Malformed-retry reset:** reset `usageAccumulator`, sync `retryContext.activeAccountId/Label`, pass `retryContext` into both malformed-retry acquires | `streaming.ts:2357-2365`, `:2278-2308`, `:701-730` |
| 0.6 | **Lease release in route finally:** `releaseAccountLease?.()` alongside chat-lock release; clear `acquireDeadlineTimer` in the create catch | `index.ts:1012-1015`, `:1050-1052`; `account.ts:2255` |
| 0.7 | **Gate `priorParent`:** only carry `existingThread.parentId` when `existingThread.accountId === result.accountId`, else `null` | `account.ts:2196-2205` |

### Phase 1 — Chunk ownership enforcement

| # | Change | File:line |
|---|---|---|
| 1.1 | Fast path: capture `"response_id":"([^"]*)"` in the regex; apply bind/compare; `continue` (drop + metric) on mismatch | `streaming.ts:1861-1896` |
| 1.2 | Guard semantics: bind once from first id-bearing chunk, then reject all mismatches; while unbound, accept only id-bearing or id-less **control** deltas (no content) | `streaming.ts:1944-1950`, `:495-501` |
| 1.3 | Gate `pendingParentId` assignment on ownership (all 3 sites) | `streaming.ts:1927`, `:481`, `:2433` |
| 1.4 | Move `chunk.error` handling + `applyUpstreamUsage` under the ownership check (foreign errors must not fail this request) | `streaming.ts:1903-1910`, `:1938` |
| 1.5 | **Freeze session rebinding:** once `boundChatId` set, `rememberSession` ignores differing ids (log + metric instead of rebinding) | `streaming.ts:1322-1326`, fed at `:1900`, `:458` |
| 1.6 | Malformed-retry loop ownership check | `streaming.ts:2447-2511` |
| 1.7 | Responses adapter: same ownership check in `processChatChunk` | `routes/responses/streaming.ts:93` |

### Phase 2 — Parent commit & CAS hardening

| # | Change | File:line |
|---|---|---|
| 2.1 | Streaming commit guard: require `upstreamDone && !clientDisconnected && !aborted && targetResponseId-bound && pendingParentId` | `streaming.ts:2588-2594` |
| 2.2 | Non-streaming: add completeness/abort guard **and move the sticky commit AFTER a successful CAS** (or settle both together) | `streaming.ts:862-865`, `:881-906` |
| 2.3 | `rememberParent`: verify target chat still equals the attempt's bound chat (or an explicit same-request rebind generation) before writing | `streaming.ts:1328-1337` |
| 2.4 | **Grace-disconnect settlement:** track `generationSettled`; in `finally`, if unsettled → `failVersionedGeneration()` (disconnected & incomplete) or commit; never strand `QUEUED` | `streaming.ts:2668-2723`, `:2859-2862` |
| 2.5 | `commitGeneration`: reject when `activeGenerations.get(sessionId) !== generationId` or generation state ∉ {QUEUED, STREAMING}; meter conflicts `session.commit_conflict`; honor `updateState` result | `session-service.ts:169-217` |
| 2.6 | Strict mode: `config.session.strictIsolation` → throw `SessionCommitConflictError` on conflict / on ownership violation | §6 |

### Phase 3 — Lease & rotation correctness

| # | Change | File:line |
|---|---|---|
| 3.1 | **Inner switch:** release current authority lease, `acquireGenerationAccount({candidates:[next]})`, assign `params.ownershipLease`; claim failure → typed `switchAccount` error | `account.ts:2654-2657` |
| 3.2 | Map authority busy rejection (`ACCOUNT_UNAVAILABLE` + `busy:owned-by`) → `account_busy` so `switchAccount: true` rotation runs instead of bare 503 | `account.ts:919-937`, `retry-policy.ts:658-667` |
| 3.3 | Wait policy: unknown/absent label ⇒ treat as **other session** (fail fast), not ours | `account-concurrency.ts:114-126` |
| 3.4 | `abortLeaseByLabel`: match on composite `{sessionKey, requestId}` (label back-compat), return `{leaseId, completionId} \| null`, log supersede with both ids | `account-concurrency.ts:612-681`, `ActiveLeaseInfo :42-59` |
| 3.5 | `stop.ts`: remove impossible `?? chat_id` key fallback; verify `stream.uiSessionId === chat_id`; refuse lookup while `targetResponseId` unbound unless exact response match | `stop.ts:41-70` |
| 3.6 | Registry: init `targetResponseId` as `null` (unbound sentinel), set it in non-streaming path too | `account.ts:1220`, `stream-registry.ts:21-32`, `streaming.ts:477-501` |
| 3.7 | Start the lease sweep timer in production; sweep stale `QUEUED` generations past deadline | `account-concurrency.ts:879`, `session-service.ts:11` |

### Phase 4 — Defense-in-depth

| # | Change | File:line |
|---|---|---|
| 4.1 | Record `accountId` (+ `operationId`) on `BrowserStreamState`; relay handler rejects mismatched source account | `qwen.ts:121-127`, `:1235-1242`, `:162-189`, `:191-207` |
| 4.2 | Route-level emission gate on `canRetry` | `index.ts:670-674` |
| 4.3 | Malformed-tool retry: require `!emittedModelOutput` **or** assert `newStreamResult.activeAccountId === midStreamRetry.activeAccountId` | `streaming.ts:2211-2216` |
| 4.4 | Introduce formal `StreamCorrelation` module; migrate streaming locals onto it | `src/runtime/correlation/stream-correlation.ts` (new) |
| 4.5 | Namespace client-supplied `session_id` with a per-caller prefix so two API clients cannot collide by choosing `"1"` | `validation.ts:135-141` or `context.ts:100` |

### Phase 5 — Observability & strict mode

Config (`src/core/config.ts` zod `envSchema` + mapping, model on `RETRY_AUTO_MALFORMED_TOOLS` at `:131`/`:459`):

```env
STRICT_SESSION_ISOLATION=false   # master: violations fail the request
FAIL_ON_STREAM_MISMATCH=false    # drop→throw on chunk ownership violation
FAIL_ON_CAS_CONFLICT=false       # throw on session commit conflict
DISABLE_IMPLICIT_THREAD=true     # force temp/ephemeral when no explicit session key (P0 default)
```

Metrics — **must be appended to the static whitelist in `src/core/metrics.ts:31-151`** (unknown keys silently no-op at `:172-173`), dot-hierarchy naming:

```text
stream.cross_session_chunk_rejected
stream.parent_commit_blocked
stream.operation_id_mismatch
session.commit_conflict
session.generation_stranded
lease.wrong_session_wait
lease.released_after_abort
supersede.same_session
browser.cross_operation_event_rejected
retry.after_emission
```

Logging (message-first API: `logger.warn(msg, data?)`, no `.child()`): every rejection logs
`{ requestId, sessionKey, accountId, leaseId, operationId, expectedChatId, expectedResponseId, receivedChatId, receivedResponseId, attempt }`.

### Phase 6 — Tests

Runner: `tsx --test` (node:test), `--env-file=.env.test`, **test files listed explicitly in `package.json` `test:mock` — new files must be appended there.**
Models: `src/tests/concurrency-latest-wins.test.ts` (lease/emitted semantics), `src/tests/stream-retry.test.ts` (fake-SSE harness `sseResponse`, `setupQwenFetchMock`, `postChat`).

| Test | Asserts |
|---|---|
| 9.1 Two sessions, same account, concurrent prompts | A contains `ALPHA_SESSION_A` only; B contains `BRAVO_SESSION_B` only |
| 9.2 Two sessions, different accounts | same, plus no shared thread row |
| 9.3 Same session, second request | supersede-with-emit OR `session_busy`; never A receiving B chunks |
| 9.4 Retry before first token | exactly one complete response, no duplicate start chunks, one parent commit |
| 9.5 Retry after first token | clean error or same-account continuation; never new-account chunks appended |
| 9.6 Client disconnect | stream cancelled, lease released, no parent commit if incomplete, no late writes |
| 9.7 Malformed tool retry | parser reset, old `response_id` rejected, no cross-session commit, usage not double-counted |
| 9.8 Implicit identity | two clients with identical first prompt → distinct `sessionId`, distinct threads, no supersede cross-fire |
| 9.9 Fast-path ownership | injected foreign `response_id` on fast-path frame → dropped + `stream.cross_session_chunk_rejected` |
| 9.10 Grace-disconnect settlement | generation never stuck `QUEUED`; `SESSION_BUSY` self-heals |

---

## 6. Acceptance Criteria

1. A chunk from one upstream response can never be emitted to a different request (incl. fast path).
2. A parent ID from one session can never be committed to another session.
3. A browser event from one operation/account can never be accepted by another.
4. A lease held by one session cannot be waited on or superseded by another.
5. An aborted/superseded/disconnected request cannot commit session state; no generation is ever stranded `QUEUED`.
6. A retry cannot reuse parser/stream/parent/usage state from an unrelated attempt.
7. Two concurrent sessions with unique keys never mix content (9.1/9.2 pass repeatedly under load).
8. Every violation produces a metric + structured log.
9. Strict mode fails the request on any violation.
10. `npm run typecheck` clean; `npm run test:mock` green.

---

## 7. Rollout

1. **P0 + P1** ship together (they are the direct fix); guarded by `DISABLE_IMPLICIT_THREAD` default-on with an env off-switch for rollback.
2. **P2 + P3** immediately after (correctness of commit/lease under the new identity).
3. **P5** observability first-in-prod: run one release in warn-and-drop mode, watch `stream.cross_session_chunk_rejected` / `session.commit_conflict` — nonzero means active contamination attempts.
4. **Strict mode** enabled in staging; production opt-in after a clean observation window.
5. **P4** defense-in-depth last.

**Immediate mitigation if a fix is delayed:** `DISABLE_IMPLICIT_THREAD=true` (0.1) alone removes the most likely direct cause — two no-`session_id` clients sharing one upstream Qwen chat.
