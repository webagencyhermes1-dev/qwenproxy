# QwenProxy Architecture

OpenAI & Anthropic compatible API gateway for Qwen (chat.qwen.ai) with multi-account rotation, intelligent failover, tool calling, Responses API, and TUI dashboard.

**Stack:** TypeScript, Hono 4.13, Patchright (Playwright fork) for Chromium automation, SQLite persistence.

**Core idea:** A single shared Chromium browser process hosts one isolated `BrowserContext` per Qwen account (~200MB RAM total). Incoming OpenAI/Anthropic requests are validated, normalized, assigned to a warmed account, and executed in-browser against chat.qwen.ai. The upstream SSE stream is parsed, tool calls reconstructed, and re-emitted as an OpenAI-compatible SSE/JSON response.

---

## 1. Request Lifecycle

```
HTTP POST /v1/chat/completions
  └─> Hono middleware (auth, CORS, rate-limit)        src/api/server.ts
        └─> chatCompletions()                          src/routes/chat/index.ts
              ├─ validate + normalize body              src/routes/chat/validation.ts
              ├─ build context (prompt, files, tools)   src/routes/chat/context.ts
              ├─ create per-request retry context       src/routes/chat/index.ts:352
              └─ attempt loop ───────────────────────┐
                    ├─ acquireUpstreamStream()        │ src/routes/chat/account.ts
                    │    └─ tryCreateStreamWithRetry()│
                    │         ├─ model metadata sync  │
                    │         ├─ truncate prompt      │
                    │         ├─ acquire account lease│
                    │         ├─ personalization sync │
                    │         └─ createQwenStream()   │ src/services/qwen.ts
                    ├─ processStreamingResponse()     │ src/routes/chat/streaming.ts
                    │    ├─ parse upstream SSE        │
                    │    ├─ reconstruct tool calls    │
                    │    ├─ auto-retry malformed tools│
                    │    └─ emit OpenAI SSE chunks    │
                    └─ on retryable error: rotate ────┘
```

### 1.1 Entry & Middleware

- **Bootstrap:** `src/index.ts` loads dotenv, installs uncaught-exception handlers for Playwright teardown, detects TUI mode.
- **Server:** `src/api/server.ts` builds the Hono app, mounts routes (`/v1/chat/completions`, `/v1/responses`, Anthropic Messages), applies auth middleware (API key), data-dir lock, watchdog, and constructs the runtime.
- **Runtime composition:** `src/runtime/construct.ts` wires `AccountResourceManager`, `GenerationCoordinator`, `EventRecorder`, `MetricsEmitter`, `ReadinessController`, `RetryCoordinator`, stream registry, and the maintenance scheduler.

### 1.2 Orchestrator

`chatCompletions()` in `src/routes/chat/index.ts` is a thin orchestrator delegating to:
- `validation.ts` — schema validation + normalization
- `context.ts` — prompt construction, topic analysis, file handling
- `account.ts` — account selection, lease, stream creation
- `streaming.ts` — SSE parsing, tool reconstruction, response emission

A single **per-request retry context** is created at `index.ts:352` and shared across ALL attempts so budget accounting is authoritative.

---

## 2. Validation & Normalization

`src/routes/chat/validation.ts`

- Validates the OpenAI request body against a schema (model, messages, tools, stream, stream_options, reasoning, files).
- Normalizes message shapes: string vs. array content parts, role coercion.
- Extracts `reasoning_mode` / thinking toggles and maps to internal reasoning flags.
- Separates media (images/files) from text content parts for downstream handling.
- Produces the canonical `messages` array + `tools` list + `allFiles` list consumed by the context builder.

---

## 3. Session & parent_id Chaining

Qwen threads are chained via `parent_id`. QwenProxy tracks this per logical session.

### 3.1 Chat modes

| Mode | Behavior |
|------|----------|
| `thread` | Native chaining — persists parent_id, appends to existing Qwen chat |
| `temp-thread` | Ephemeral with context — has history but doesn't persist as the canonical thread |
| `temp` | Stateless — no chaining, no parent_id |

### 3.2 Parent resolution

`threadParentId` is resolved at `account.ts:1755-1761`:
- `forceNewChat` or `parallelEscape` → `null` (start a fresh chat)
- thread-native with existing thread → `existingThread.parentId`
- reset upstream thread → `null`
- otherwise → `undefined`

### 3.3 Commit on success

- During streaming, each chunk may carry a new upstream response/parent id held as `pendingParentId`.
- Only when the stream completes cleanly (`upstreamDone`) is the parent committed: `rememberParent(pendingParentId)` at `streaming.ts:2591-2594`.
- Failed/aborted attempts never commit, leaving the last successful parent as the next append point.

### 3.4 Session versioning (idempotency)

- `src/runtime/session/session-service.ts` provides CAS-style versioned generations.
- At start, `versionAtStart` is recorded; on completion `commitGeneration()` commits only if the version hasn't advanced (`streaming.ts:2694-2723`).
- On conflict the response is already sent, so it logs a warning rather than failing the client.

---

## 4. Account Acquisition, Concurrency & Stickiness

`src/routes/chat/account.ts`

### 4.1 Selection & rotation

- The attempt loop iterates candidate accounts. `acquireUpstreamStream()` picks the current account and calls `tryCreateStreamWithRetry()` (`account.ts:1165`, defined at `:1571` — full pipeline in **Appendix A**).
- **Session stickiness:** a session prefers the account that owns its thread. The owner (or last usable account) may wait for its slot without a short deadline.
- **Rotation triggers:** `account_not_hot`, `account_busy`, `switchAccount` errors push the loop to the next candidate.

### 4.2 HOT invariant

Accounts must be warmed before serving. A non-HOT account reaching the request path fails with `account_not_hot` and rotates (`account.ts:1689-1704`). Session death during `createQwenStream` is also classified as `account_not_hot` (`account.ts:2093-2109`).

### 4.3 Concurrency lease

One generation per account-slot at a time. Three acquisition paths (`account.ts:1825-1876`):

1. **`ownershipLease` present** — gateway pre-claimed the account atomically → `trackExternalLease()` (`account.ts:1825-1839`).
2. **`parallelEscape`** — fail-fast `tryAcquireAccountLease()`; busy → `account_busy` so the loop hops to a free account (`account.ts:1840-1860`).
3. **Normal** — `acquireAccountLease()` with timeout capped by the remaining create budget (`account.ts:1861-1876`).

**Wait policy:** the thread owner (or last usable account) waits indefinitely (bounded by client abort) ONLY when the slot is busy with the SAME session. If ANOTHER session holds the slot, fail fast with `account_busy` instead of waiting (`account.ts:1775-1794`).

### 4.4 Latest-wins supersede

Before leasing, `abortLeaseByLabel(accountId, sessionLabel, { onlyIfEmitted: true })` aborts a prior same-session generation — but only if it already emitted to the client (`account.ts:1803-1807`). Unemitted streams are protected; parallel requests never kill.

### 4.5 Abort signal composition

`AbortSignal.any([requestSignal, leaseAbort, acquireAbort])` at `account.ts:1818-1823`:
- `requestSignal` — client disconnect
- `leaseAbort` — superseded by a same-session retry
- `acquireAbort` — acquire deadline, kills a race-lost `createQwenStream` still queued on the account stream lock

---

## 5. Retry Policy & Failover

### 5.1 Budget

- A per-request **create budget** bounds total time across all attempts. `createBudgetViolationError()` fires before every attempt (`account.ts:1647-1653`).
- Delays (lease wait, acquire guard) are capped by remaining budget via `capDelayByCreateBudget()` so one attempt never outlives the request.

### 5.2 Acquire deadline

`createQwenStream()` races an `acquireDeadline` timer (`account.ts:2072-2113`). On expiry:
- `acquireAbort.abort()` kills the queued stream.
- Error code is `create_budget_deadline` if the request budget expired (account not at fault), else `acquire_deadline` (`account.ts:2050-2071`). This distinction prevents charging a healthy account an `AuthInitFailed` cooldown.

### 5.3 Retryable vs. terminal

- `RetryableQwenStreamError` → re-thrown to the attempt loop for rotation/retry (`streaming.ts:2035-2037`).
- `recoverFromStreamError()` attempts transparent recovery before escalation (`streaming.ts:2031-2033`).
- After client disconnect, transparent retry is suppressed to avoid burning background requests on the sticky account (`streaming.ts:2027-2029`).

### 5.4 Malformed tool-call auto-retry (mid-stream)

`streaming.ts:2211-2586`:
- Triggers when ALL tool calls are malformed and none emitted, up to `autoRetryMalformedToolsMax`.
- Builds a short `[SYSTEM CORRECTION]` repair prompt sent on the SAME thread (no full context replay) (`streaming.ts:2276`).
- Distinguishes undeclared tool names from invalid JSON in the correction message (`streaming.ts:2244-2252`).
- Re-acquires via `acquireUpstreamStream()` with same account, `forceNewChat:false` (`streaming.ts:2278`).

---

## 6. Stop / Abort Flow

- **Client disconnect** → `requestSignal` aborts the combined signal → lease released, stream cancelled, returns `ClientAbortedError`.
- **Same-session retry supersedes** → `leaseAbort` via `abortLeaseByLabel()`.
- **Tool-call cap** → `stoppedByToolCap` at `streaming.ts:2015-2019`; closes turn cleanly with `finish_reason:"tool_calls"` + `[DONE]`, cancels reader so Qwen stops generating (`streaming.ts:2057-2067`). Sets `setToolCapNotice()` for the next turn. This is a SUCCESS path, never a retry.
- **Stream cancel hygiene:** a created stream is never dropped without `cancel()` — dropping leaks the per-account stream lock and causes phantom waits (`account.ts:2167-2182`).

### 6.1 Error classification

`handleChatCompletionsError()` at `streaming.ts:2950` (full branch detail in **Appendix C**):
- `ClientAbortedError` → silent HTTP 499, no metric, no error log (`streaming.ts:2956-2963`).
- 5xx → increments `requests.errors` metric (`streaming.ts:2965-2967`).
- Permanent upstream 401 → distinct `upstream_unauthorized` code, HTTP 502 (`streaming.ts:2976-2980`).
- Default → `sendOpenAIError(c, err)` (`streaming.ts:3025`).

---

## 7. Media Handling

- Media (images/files) is separated from text during validation.
- `allFiles` is threaded through the context builder into `acquireUpstreamStream()` params and passed to `createQwenStream()` (`account.ts:2073`).
- Files are uploaded/attached to the upstream Qwen chat as part of the generation payload.
- Context meter accounts for `filesCount` in token estimation (`account.ts:2138`).

---

## 8. Streaming Internals

`processStreamingResponse()` in `src/routes/chat/streaming.ts`

### 8.1 Read loop & incremental deltas

- Reads upstream SSE line-by-line; filters chunks by `targetResponseId` (`streaming.ts:1944-1950`).
- **Incremental extraction:** Qwen sends cumulative content; `getIncrementalDelta()` computes the new suffix for both `thinking_summary` and `answer` phases (`streaming.ts:1963-2003`).
- `thinking_summary` → `reasoning_content` deltas buffered into `reasoningBuffer` (`streaming.ts:2009-2012`).
- `answer` → fed to `emitAnswerText()` and the tool parser (`streaming.ts:2013-2020`).

### 8.2 Termination

- `answer` + `status:"finished"` delta is treated as terminal even without `[DONE]`, avoiding a wait on the keep-alive connection idle timeout (`streaming.ts:1957-1961`).
- `upstreamDone` / `stoppedByToolCap` break the loop without re-reading (`streaming.ts:2046-2047`).

### 8.3 Tool-call reconstruction

- A streaming tool parser accumulates argument fragments into complete tool calls.
- On flush, remaining text + tool-call deltas + complete tool calls are emitted (`streaming.ts:2100-2206`).
- `finish_reason` = `"tool_calls"` if any emitted, else `"stop"` (`streaming.ts:2601-2604`).
- Malformed/capped calls that weren't retried are logged, never surfaced as text to the client (`streaming.ts:2619-2644`).

### 8.4 Finalization

- Emit finish chunk, optional usage event (`include_usage`), single `[DONE]` (`streaming.ts:2646-2689`).
- Batch mode accumulates events into `flushBuffer` and writes once with the `[DONE]` sentinel — exactly-once guard for the generation commit (`streaming.ts:2673-2689`).
- `commitGeneration()` CAS + `scheduleAssistantComplete()` callback (`streaming.ts:2694-2737`). Full finalization order in **Appendix B**.

---

## 9. Browser & Chromium Management

### 9.1 Launch

- `src/services/playwright.ts` uses **patchright** (Playwright fork) via `launchPersistentContext` + `buildChromiumLaunchArgs`.
- Single shared browser process; per-account context slots provide isolation.

### 9.2 Session management

- `src/runtime/browser/browser-session-manager.ts` is the browser lifecycle boundary: composes Playwright slot/page helpers and owns operation identity, deadline, and `AbortSignal`.
- Warmup/readiness lifecycle managed by `src/runtime/readiness/readiness-controller.ts`.

### 9.3 Upstream execution

- `src/services/qwen.ts` exports `createQwenStream`, `requestQwenTextInBrowser`, `buildCompletionHeaders`, `fetchQwenModels`, `deleteAllQwenChats`, etc.
- `createQwenStream()` performs the in-browser request against chat.qwen.ai and returns a readable upstream stream + token estimation context.

### 9.4 Anti-detection & CAPTCHA

- `src/services/captcha-solver.ts` + `captcha-coordinator.ts` — CAPTCHA detection/resolution in-browser.
- `src/services/human-behavior.ts` — human-like interaction simulation.

---

## 10. Key Files

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Entry point, env loading, global error handlers |
| `src/api/server.ts` | Hono server, middleware, route mounting, auth, runtime bootstrap |
| `src/runtime/construct.ts` | Runtime composition (all managers wired together) |
| `src/routes/chat/index.ts` | Chat orchestrator (validation→context→account→streaming) |
| `src/routes/chat/validation.ts` | Schema validation + normalization |
| `src/routes/chat/context.ts` | Prompt building, topic analysis, file handling |
| `src/routes/chat/account.ts` | `acquireUpstreamStream`, `tryCreateStreamWithRetry`, failover, lease |
| `src/routes/chat/streaming.ts` | SSE parsing, tool reconstruction, emission, error handling |
| `src/services/qwen.ts` | Upstream Qwen interaction (createQwenStream, headers, models) |
| `src/services/playwright.ts` | Chromium launch, context slots, patchright integration |
| `src/runtime/browser/browser-session-manager.ts` | Browser operation boundary (identity/deadline/abort) |
| `src/runtime/readiness/readiness-controller.ts` | Account warmup/readiness lifecycle |
| `src/runtime/session/session-service.ts` | Session versioning, idempotency (CAS commit) |
| `src/services/captcha-solver.ts` | CAPTCHA handling in browser |
| `src/services/human-behavior.ts` | Human-like interaction simulation |
| `src/core/config.ts` | Env schema (zod-validated), config defaults |
| `CONFIG.md` | Human-readable env var reference |

---

## 11. Configuration

See `CONFIG.md`. Key env vars: `PORT`, `HOST`, `API_KEY`, `CORS`, rate limits, data dirs, account secrets. Retry/concurrency tuning lives in `config.retry.*` and `config.concurrency.*` (e.g. `queueWaitForeverCapMs`, `busyWaitMs`, `acquireDeadlineMs`, `maxToolCallsPerTurn`, `autoRetryMalformedToolsMax`, `repeatedToolCallWarnThreshold`).

---

## Appendix A. `tryCreateStreamWithRetry` Internals

- Defined `src/routes/chat/account.ts:1571`; called by `acquireUpstreamStream()` at `src/routes/chat/account.ts:1165`. Owns ONE account's inner attempt loop; account rotation across the pool is the caller's outer loop.
- Returns `CreateStreamSuccess` (carrying `releaseAccountLease`) or `CreateStreamFailure`; internal errors are caught, never rethrown.

### A.1 Attempt pipeline (per attempt, execution order)

1. **Create-budget gate** — `createBudgetViolationError()` before any work (`account.ts:1653`, helper `:453`) → typed `RequestCreateBudgetError`; then `retryContext.createAttempts++` (`:1657`).
2. **Client-abort check** — `requestSignal.aborted` → `ClientAbortedError`, no spend (`:1674-1681`).
3. **HOT invariant** — non-HOT account → throw `account_not_hot` + `switchAccount` before any expensive work (`:1689-1704`).
4. **Model metadata sync** — `withDeadline(…, MODEL_METADATA_SYNC_BUDGET_MS=2000, fetchQwenModels)` (`:1711-1716`, constant `:261`); failure is only logged → registry fallback, never fails the attempt (`:1717-1725`).
5. **Prompt shaping** — `truncatePromptToIntelligentLimit()` against the real context window (`:1730-1746`), repeated-tool-call reminder (`:1747-1753`), `assertPromptWithinLimits()` (`:1755-1759`).
6. **Wait policy** — `hasFreeAlternateAccount` + `isAccountSlotHeldByOtherSession` + `shouldWaitQueueForever()` (`:1775-1794`, `:1563`).
7. **Latest-wins supersede** — `abortLeaseByLabel(…, { onlyIfEmitted: true })`, never on `parallelEscape` (`:1803-1807`).
8. **Signal composition** — `AbortSignal.any([requestSignal, leaseAbort, acquireAbort])` (`:1818-1823`).
9. **Lease acquisition (3 paths)** — gateway `ownershipLease` → `trackExternalLease()` (`:1825-1839`); `parallelEscape` → non-blocking `tryAcquireAccountLease()`, busy → throw `account_busy` (`:1840-1860`); normal → `acquireAccountLease()` with `capDelayByCreateBudget(waitQueueForever ? queueWaitForeverCapMs : busyWaitMs)` (`:1861-1876`).
10. **Post-lease abort** — release lease, return `ClientAbortedError` (`:1880-1888`).
11. **Personalization sync** — 2s lock acquire, contention = skip (`:1916-1925`, `:252`); sync raced against a 2s deadline (`:1938-1977`): timeout → skip + warn (`:1989-1993`), explicit failure → throw `PersonalizationSyncError` (`:1994-1997`); lock always released in `finally`, never held across `createQwenStream` (`:1999-2006`).
12. **Post-sync abort** — release lease, return (`:2018-2026`).
13. **Acquire deadline** — `acquireDeadlineMs = capDelayByCreateBudget(config.concurrency.acquireDeadlineMs)` (`:2040-2043`); timer aborts `acquireAbort` and rejects with `create_budget_deadline` when the timer was shortened by the REQUEST budget, else `acquire_deadline` (`:2050-2071`).
14. **Stream create** — `Promise.race(createQwenStream(…), acquireDeadline)` (`:2072-2113`); Playwright session death inside create is re-thrown as `account_not_hot` (`:2093-2109`); timer cleared when create wins (`:2116`).
15. **Post-create** — context-meter snapshot attached (`:2124-2162`); if aborted → `stream.cancel()` FIRST, then lease release, then return (`:2167-2182`); thread binding via `updateLogicalThreadState()` (`:2184-2217`).
16. **Success** — `noteWafRecovery` / `markAccountSuccessful` / `noteAccountInitSuccess` + recovered + session-expired clear (`:2230-2241`), `markLeaseCompletion` (`:2242-2248`), return with `releaseAccountLease` (`:2249-2254`).

### A.2 Error paths

- **Catch** — record error, release lease, `attemptsLeft--` (`:2255-2263`); client already gone → return, no rotation (`:2275-2277`).
- **Retryable vs terminal** — `classifyRetryAction()` (`:2449`, `retry-policy.ts:584`) yields `retryable` / `switchAccount` / `forceNewChat` / `retryWithFullPrompt` / `dropFiles` / `retryAfterMs` / `accountCooldownMs+Reason`. Terminal: `client_abort`, `terminal_local`, `RequestCreateBudgetError`, `content_moderation`, `model_not_found`, `upstream_unauthorized`, `unknown_not_retryable` (`retry-policy.ts:602-831`).
- **`account_not_hot`** — `switchAccount:true`, delay ≤1s, NO cooldown (readiness race, not health) (`retry-policy.ts:624-628`); health debit also skipped (`account.ts:47`).
- **`account_busy`** — thrown by the `parallelEscape` fast path (`:1851-1859`) or lease-queue timeout (`account-concurrency.ts:385`); classified `switchAccount:true`, delay ≤1s (`retry-policy.ts:658-667`).
- **`acquire_deadline` vs `create_budget_deadline`** — `acquire_deadline` matches `isAccountInitializationError` (`retry-policy.ts:330`) → `account_initialization_failed`: `markAccountFailed` + `AuthInitFailed` cooldown + `noteAccountInitFailure` (+ `markAccountBroken`) + terminal return (`account.ts:2596-2615`). `create_budget_deadline` deliberately matches nothing → NO cooldown; the next gate yields `RequestCreateBudgetError` (`:1653`, `retry-policy.ts:606`).
- **Quota/rate-limit** — `isAccountUnavailableError` branch (`:2343`): `RateLimitTemporary` → same-account retry, delay ≤3s (`:2350-2366`); single-account pool → one retry (`:2389-2402`); real quota → `markAccountRateLimited(silent)` + `recordAccountFailure` + tried-set attach + terminal return (`:2404-2447`).
- **`anti_bot`** — quarantine once (`quarantineChallengedAccountOnce`), attach tried set, return for OUTER rotation (`:2468-2479`).
- **`chat_in_progress`** — origin account remembered; `markAccountTemporarilyBusy` (`:2520-2531`); settle retries keep their own budget (`attemptsLeft = max(attemptsLeft,1)`) with jittered context-scaled delays from attempt 2 (`:2572-2592`); past `chatInProgressMaxAttempts` ONE escalation to a fresh chat with compressed context (`:2533-2564`); a second escalation failure is terminal (`:2565-2571`) — outer loop also terminal (`:1320-1333`).
- **Other** — `invalid_input`: one same-account rebuild before rotating (`:2491-2500`); `corrupted_chat_history` purges the parent (`:2484-2486`); session-expired → `attemptRelogin`, success = `continue`, failure = terminal (`:2305-2333`).
- **Account switch** — `retryable && switchAccount && !isSingleAccount && accountSwitches < maxAccountSwitches` → `pickNextHotCandidate` / `getNextFreeAccountForParallel` (`:2623-2631`); charges policy cooldown (`:2636-2642`), health debit (`:2645-2653`), rebuilds compressed failover prompt + `forceNewChat` (`:2663-2678`), delay ≤1s and budget-capped (`:2680-2689`); no candidate → same-account retry (`:2692-2694`).
- **Give-up** — `!retryable || attemptsLeft<=0` (`:2735`): cooldown charged as `RetryExhausted` (`:2736-2742`), health debit only when retryable (`:2745-2755`), `clearAllSessionsForAccount(origin)` for `RetryableQwenStreamError`/`chat_in_progress` (`:2757-2777`), tried set attached for outer layers (`:2783`).
- **Backoff / exit** — delay = `policy.retryAfterMs` else exponential, always `capDelayByCreateBudget` (`:2788-2816`); loop exit returns `lastAttemptError` + tried set (`:2819-2829`).

### A.3 Resource hygiene

- **Lease** — released on every failure (`:2260`) and every abort (`:1881`, `:2019`, `:2175`); on success it is handed to the caller via `releaseAccountLease` (`:2253`) and the caller drops its `ownershipLease` reference (`:1211-1213`).
- **Stream** — a post-create abort must `cancel()` BEFORE releasing the lease: the wrapped stream's `cancel()` is what releases the per-account stream lock (`account.ts:2167-2174`; `services/qwen.ts:2792-2825`); dropping it silently leaks the lock (observed 150s phantom wait).
- **Stream lock** — `createQwenStream` takes `acquireAccountStreamLock(accountId)` (`qwen.ts:2638-2651`), re-checks the signal after the queue (`qwen.ts:2658-2661`), releases exactly once on success/error/cancel (`qwen.ts:2646-2679`).
- **Race-lost create** — `acquireAbort` fires from the deadline timer so a create still queued on the lock dies instead of winning it later and burning an upstream request (`:2054-2059`).
- **Deadline timer** — unref'd (`:2070`) and cleared when the acquire wins (`:2116`) so it can never abort an unobserved signal.

*Runtime values of `config.retry.*` / `config.concurrency.*` are env-overridable; `classifyRetryAction` has additional branches beyond those enumerated above.*

---

## Appendix B. Streaming Completion Tail

Tail of `processStreamingResponse()` after the read loop breaks (`upstreamDone` / `stoppedByToolCap`, `streaming.ts:2046-2047`). Line refs are `src/routes/chat/streaming.ts` unless noted.

**Execution order (success tail)**

- **Tool-cap stop** (pre-tail): warn + `setToolCapNotice()` + `reader.cancel()` — success path, never a mid-stream retry (`streaming.ts:2057-2067`).
- **Upstream error payload** in the trailing buffer: content chunk + `stop` chunk + `[DONE]` + `failVersionedGeneration()` + `return` — skips everything below (`streaming.ts:2070-2093`).
- **Batch arm**: `flushBuffer = []`; from here `writeEvent`/`writeDeltaEvent` accumulate into it instead of the 8KB/3ms coalescing writer (`streaming.ts:2096`, `1170-1187`, `1234-1241`, `1277-1283`).
- **Parser flush**: remaining text + tool-call deltas + complete tool calls → batch (`streaming.ts:2100-2206`); a malformed-retry flush appends the same way (`streaming.ts:2529-2571`).
- **Malformed auto-retry** runs before finish reason so no premature `finish_reason`/`[DONE]` precedes retry chunks; gated by `!clientDisconnected && midStreamRetry && toolParser` (`streaming.ts:2208-2216`).
- **`pendingParentId` commit**: `rememberParent()` → `updateSessionParent` + `updateLogicalThreadParent`, then `pendingParentId = null` (`streaming.ts:2591-2594`, helper `1328-1337`).
  - Guard: only when `pendingParentId && upstreamDone`. Disconnect without grace breaks the loop at `streaming.ts:1804-1809` leaving `upstreamDone = false` → never committed; last successful parent stays the append point.
  - Disconnect **with** grace: upstream may still finish → parent commits anyway (`streaming.ts:1025-1031`); the disconnect teardown separately fails the versioned generation (`streaming.ts:1036-1039`).
- **Usage**: `buildUsage(usageAccumulator)` + `enrichUsageWithContextMeter(...contextMeter)` (`streaming.ts:2597-2600`).
- **`finalFinishReason`**: `"tool_calls"` if `toolParser.getEmittedToolCallCount() > 0`, else `"stop"` (`streaming.ts:2601-2604`).
- **Unrecovered malformed/capped calls**: one `logger.warn` only — never surfaced as text; whole block skipped when `clientDisconnected` (`streaming.ts:2619-2644`).
- **Finish chunk** (`choices[0].finish_reason`) → batch (`streaming.ts:2646-2652`).
- **Usage chunk** only when `body.stream_options?.include_usage`; emitted with `choices: []` (`streaming.ts:2654-2666`).
- **Terminal block** gated by `if (!clientDisconnected)` (`streaming.ts:2668`); else branch only logs `skipped [DONE]` (`streaming.ts:2768-2774`):
  - `toolParser.clearMalformedToolCalls()` (`streaming.ts:2669-2671`).
  - Single write: `flushBuffer.join("") + "data: [DONE]\n\n"` → `flushWrites()` (drains non-batch residue) then `await streamWriter.write(payload)` (`streaming.ts:2673-2687`).
  - **Exactly-once**: `flushBuffer = null` + `streamCompletedOk = true` right after that one write (`streaming.ts:2688-2689`); the payload holds the only `[DONE]`, so commit/callback below run once per generation.
  - **`commitGeneration()` CAS**: `readSessionCommit()` requires `sessionCommit` + `isSessionVersioningEnabled()` (`streaming.ts:86-92`); commits `versionAtStart` with `userMessage`/`assistantMessage`; conflict (`!commit.committed`) or throw → `logger.warn` only, response already sent (`streaming.ts:2694-2723`).
  - **`scheduleAssistantComplete()`**: fire-and-forget; handler errors logged, never rethrown (`streaming.ts:2725-2737`, helper `285-300`).
  - `logTokenEstimationSample()` + `performanceMetrics.recordRequest()` (TTFB/tail) (`streaming.ts:2749-2767`).

**Error tail (`catch`, `streaming.ts:2775-2821`)**

- `!streamCompletedOk` → `failVersionedGeneration()`; a stream that already wrote `[DONE]` cannot fail its committed generation (`streaming.ts:2776-2781`).
- Abort + (`clientDisconnected` | request aborted | stream deregistered) → suppressed, `return` (`streaming.ts:2782-2802`, `helpers.ts:133-143`).
- Abort with client connected → `toRetryableStreamError("stream_aborted", { switchAccount, forceNewChat })`; otherwise rethrow → error callback writes `finish_reason:"error"` + error event + `[DONE]` (`streaming.ts:2804-2821`, `2924-2940`).

**Teardown (`finally`, `streaming.ts:2822-2879`) — always runs**

- Timing log; `recovered` only if `streamCompletedOk && retriesLeft < initialRetries` (`streaming.ts:2830-2841`).
- `flushWrites()` (drops pending bytes if disconnected), then `void activeReader.cancel()` — releases the per-account upstream stream lock, since the loop exits on the terminal event without the wrapper's `pull()` resolving (`streaming.ts:2843-2853`).
- Remove `abort` listener; clear heartbeat + disconnect-grace timers (`streaming.ts:2855-2862`).
- `removeStream(completionId)` — deregisters; also an input to abort suppression (`streaming.ts:2863`).
- `onStreamComplete()` → chat lock release + health success + `releaseAccountLease()` (`streaming.ts:2872`; `index.ts:588-604`).
- `retryContext.releaseAccountLease()` if a transparent retry still holds one, then null it (`streaming.ts:2875-2878`).

*Race behavior between a grace-window disconnect and the tail commit is inferred from code plus the comment at `streaming.ts:1025-1039`; not covered by a test.*

---

## Appendix C. Chat Error Handler

- **Entry:** `handleChatCompletionsError(c, err)` — `src/routes/chat/streaming.ts:2950-3026`. Sole caller: chat route catch at `index.ts:1049`; the route's own pre-response abort guard (`index.ts:1042-1047`) returns a bare 499 before this function is ever reached.
- **Classification first:** `classifyError(err)` (`streaming.ts:2951`) → `src/api/error-classifier.ts:27-179` → `QwenProxyError` (`src/core/errors.ts:21-42`), carrying `statusCode` / `type` / `code` / optional `param`.
  - Notable mappings: account-not-warmed → 503 `no_hot_account` (`error-classifier.ts:33-38`); network/upstream-unavailable → 502 `upstream_unavailable` (`:43-48`); moderation → 400 `content_policy_violation` (`:56-66`); quota/rate-limit sniffing → 429 `rate_limit_exceeded` (`:68-86`); mutex acquire timeout → 503 (`:128-136`); `upstreamStatus` hint 429/502/503/504 (`:138-158`); `ZodError` → 400; unclassified → `InternalError` 500 plus `logger.warn("Unclassified error mapped to InternalError")` (`:174-178`).
  - Abort recognition: `QwenProxyError` passthrough (`:96-98`), or any `Error` whose message contains `"client aborted"` (`:103-105`).
- **Branch 1 — `ClientAbortedError` → silent HTTP 499** (`streaming.ts:2956-2963`)
  - `logger.debug("[chat] client aborted during stream creation (silent)")` (`:2957-2959`) — suppressed at default `LOG_LEVEL=warn` (`src/core/logger.ts:249-257`); no error line, no metric, no body.
  - Returns `new Response(null, { status: 499 })` (`:2960-2962`) — 499 is outside Hono's `StatusCode` union, hence the plain `Response`.
  - Regression guard: `src/tests/abort-silent-t4.test.ts:59-78` asserts 499, no JSON body, `requests.errors` stays 0; `:80-86` asserts plain `Error` → 500.
- **Branch 2 — 5xx metric increment** (`streaming.ts:2965-2967`)
  - `classified.statusCode >= 500` → `metrics.increment("requests.errors")`, no labels; counter registered at `src/core/metrics.ts:34`, `increment()` at `:167-184`.
  - 4xx and 499 do not count (abort branch already returned at `:2962`).
- **Code/status resolution** (`streaming.ts:2969-2981`)
  - `message` = `err.message ?? String(err)` (`:2969`) — untruncated.
  - `upstreamAuthRejected` = `statusCode === 502 && isPermanentUpstreamAuthError(err)` (`:2976-2977`) → `code = "upstream_unauthorized"`, else `classified.code || "unknown"` (`:2978-2980`); `status = classified.statusCode` (`:2981`).
  - `isPermanentUpstreamAuthError` (`src/routes/chat/retry-policy.ts:161-175`): excludes `QwenSessionExpiredError` and local `AuthError` (`:163-165` — local-proxy 401s stay on the `AuthError` path); accepts codes `unauthorized|unauthorized_request|invalid_token|token_expired|access_denied` (`:137-143`), `statusOf(err) === 401` (`:170`), or message matching `/\bunauthorized\b/` / `"não autorizado"` (`:171-174`).
- **Logging (every non-abort error)**
  - Unconditional `console.error` one-liner: `❌ [Chat] Error | <status> <code> | <message>` (`streaming.ts:2982`).
  - Structured detail, gated on `logger.isLevelEnabled("info")` but written via `console.log` (`streaming.ts:2987-3016`, emit at `:3013-3015`): `status`, `code`, `type`, `message`, full `stack` (only if `err instanceof Error`, `:2994-2996`), `quota` from `err.quotaInfo` → email/cooldownSeconds/until/message (`:2997-3005`), `createdNewChat` + `chatId` truncated to 12 chars + `accountId` (`:3006-3012`).
  - Both raw `console.*` lines bypass the logger's credential redaction and JSON formatting (`logger.ts:162-173`); only the branch-1 debug line goes through `logger`.
- **Branch 3 — permanent upstream 401 → 502** (`streaming.ts:3018-3023`)
  - `c.json({ error: { message, type: "upstream_error", code: "upstream_unauthorized", param: null } }, 502)` — distinct, alertable code instead of the evergreen `upstream_unavailable`.
  - No dedicated metric; it still lands in `requests.errors` because 502 ≥ 500 and branch 2 already ran at `:2966`.
- **Branch 4 — default → `sendOpenAIError(c, err)`** (`streaming.ts:3025`)
  - `src/api/error-helpers.ts:63-112`: re-derives the `QwenProxyError` from the raw `err` (`:74-91`) — the `classified` computed at `streaming.ts:2951` is used only for status/code/metric decisions, not reused for the body.
  - Body from `toOpenAI()` (`core/errors.ts:32-41`) reshaped to `{ error: { message, type, code, param: param ?? null } }` (`error-helpers.ts:93-101`), then `c.json(body, statusCode)` (`:111`); 499 would be built as a raw `Response` (`:105-110`) — unreachable here, branch 1 intercepts first.
  - Field examples: 400 `invalid_request_error`/`bad_request`; 401 `authentication_error`/`invalid_api_key`; 403 `permission_error`/`insufficient_quota`; 429 `rate_limit_error`/`rate_limit_exceeded`; 500 `internal_error`/`internal_server_error`; 502 `upstream_error`/`upstream_unavailable`; 503 `service_unavailable`/`no_hot_account|service_degraded`; 504 `timeout_error`/`upstream_timeout`.

*Not verified: whether the raw `console.error`/`console.log` lines at `streaming.ts:2982`/`:3013` are captured by any structured log sink outside `src/` (no console patching found in `src/core/logger.ts`); `src/domain/errors.ts` `TypedRuntimeError` is not referenced by this function.*
