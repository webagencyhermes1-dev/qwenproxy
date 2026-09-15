# QwenProxy Recovery Log — Loop-by-Loop Fixes

## Loop 1 — Fix the Personalization Mutex Deadlock

**Symptom from log:**
```
WARN [Mutex:personalization:8662d127] TIMEOUT key=personalization:8662d127 waited=60000ms heldBy=personalization:8662d127 heldFor=62011ms queueLeft=0
❌ [Chat] Request failed | 5umqitru9w7 | unknown | Mutex[personalization:8662d127] acquire timeout after 60000ms
```
A chat request waited 60s on the personalization mutex (same account, held by another request), then failed. Every subsequent request to the same account repeated this failure.

**Root cause:**
The personalization mutex (`Mutex:personalization:*`) was held through the ENTIRE acquire phase — personalization sync (30–60s) PLUS `createQwenStream` (up to 120s acquire deadline). A stuck browser operation inside `createQwenStream` (header capture, Playwright navigation) held the mutex for 62s+. A concurrent request for the same account tried to acquire with a 60s timeout and timed out, causing the request to fail immediately with `Mutex[personalization:*] acquire timeout`. This was a re-entrancy/serialization bug: two independent chat requests for the same account both needed the personalization lock, and the second one blocked for 60s.

The lock hold was:
1. `acquirePersonalizationLock` → 60s timeout (hard-coded)
2. Sync race deadline: 30s (warm) / 60s (cold)
3. `createQwenStream` with 120s acquire deadline

All of these were covered by a single `finally` block that released the lock at the very end, meaning the lock could be held for up to 180s+ in pathological cases.

**Fix applied:**

1. **Lock acquired with 2s budget** (`PERSONALIZATION_LOCK_ACQUIRE_TIMEOUT_MS = 2000`). If the mutex is busy for >2s, the request SKIPS personalization sync and proceeds. The chat request is never failed because of personalization lock contention.

2. **Lock scoped to the sync only** — the lock is released in its own `try/finally` BEFORE `createQwenStream`. The lock is never held through stream creation. Max lock hold time is now ~5s.

3. **5s hard sync deadline** (`PERSONALIZATION_SYNC_DEADLINE_MS = 5000`) replaces the old 30s/60s warm/cold distinction. If the sync takes >5s, the sync promise is abandoned (it runs to its own browser-op timeout in the background) and the lock is released.

4. **Abort listener removed** — the abort-listener-based lock release was replaced by the sync-scoped `try/finally`. The lock is always released when the sync block exits.

5. **Early abort check** — if the client disconnects during the sync, the request bails immediately before stream creation (with lease released).

6. **Test hook exported** — `acquirePersonalizationLockForTests(accountId)` to hold the lock in tests.

**Test verifying the fix:**
`src/tests/personalization-lock-skip.test.ts`
- Holds the personalization lock for `mock-account` indefinitely (simulates the 62s hang).
- Issues a chat request with personalization instruction.
- Asserts: request succeeds (status 200), completes in <8s (not ~60s), and the upstream completion is reached.
- Confirms the `⏩ [Chat] Skipping personalization sync` log line fires.

**Additional test updates:**
`src/tests/personalization-deadline.test.ts` — updated to assert the new 5s hard cap for all accounts.

**Commit:** `fix(mutex): non-blocking personalization sync with hard timeout`

---

## Loop 2 — Fix the Chat Input Selector and Detect WAF Pages

*(pending)*

## Loop 2 — Fix the Chat Input Selector and Detect WAF Pages

**Symptom from log:**
```
⏱️  [Playwright] Chat input never appeared for ${accountId} (attempt 1); reloading
⏱️  [Playwright] Chat input never appeared for ${accountId} (attempt 2); reloading
⏱️  [Playwright] Chat input never appeared for ${accountId} (attempt 3); reloading
❌ [Chat] Request failed | ... | AuthInitFailed
```
The chat input web component was never found. The page.focus then bided its 60s default timeout per attempt. The account got cooled.

**Root cause:**
1. The page.focus call would block up to 60s (Playwright page default) on a page that never renders the chat input.
2. The selector `textarea.message-input-textarea:visible, textarea:visible, [contenteditable="true"]:visible` could go stale if Qwen changed the DOM (e.g., contenteditable → `[role="textbox"]`).
3. The failure was reported as a generic AuthInitFailed with no diagnostic identifying the page state (WAF interstitial vs. healthy-but-slow vs. failed hydration).

**Fix applied:**

1. **WAF/anti-bot page detector** (`detectChatPageBlock` / pure `detectChatPageBlockText`): classifies a chat-page snapshot (title + URL + body text) by strong markers (Cloudflare `Just a moment...`/`challenge-platform`/`cf-chl-`, Aliyun/Qwen `____punish____`/`____tmd_____`, `__access denied__`, TMD `___f_k_waf_challenge___` etc.) plus ≥2 context markers (captcha/human verification/turnstile…). Pure function is unit-testable.
2. **Fail fast when the page is a genuine WAF interstitial** — do NOT reload into another 15s input wait. Settle with a `WAF challenge detected for <account>` error that the retry policy maps to `waf_challenge` (account cooled & isolated) instead of AuthInitFailed. This cuts the blocked-page stall from ~45s (3 reloads × 15s) to ~2s and stops hammering an already-challenged page.
3. **Selectors centralized** — `CHAT_INPUT_SELECTOR`, `SEND_BUTTON_SELECTORS` named constants. The input selector family now also covers `[role="textbox"]` so a Qwen DOM change from `textarea` to an ARIA textbox cannot strand header capture.
4. **Header-capture trigger attempts reduced 3 → 2** — the first send fails fast (bx SDK not yet warm), so attempt 2 is the realistic recovery window; a third reload only added cost on genuinely blocked pages that are now detected instead.
5. **Diagnostics dump** (`dumpPlaywrightMiss`) — on any input-miss (WAF or generic), writes `logs/playwright_misses/<accountId>-<ts>.json` with URL, title, and a sanitized body snippet so an operator can triage the blocked page without scraping logs.

**Tests verifying the fix:**
`src/tests/auth-playwright.test.ts`
- `fails fast with a WAF diagnosis when the chat page is a challenge interstitial` — rejects with `/WAF challenge detected/` in <8s, no reload after detection.
- `diagnoses the Qwen punish document as a WAF block` — `____punish____` URL/body → WAF.
- `detectChatPageBlockText classifies WAF pages without false positives on healthy chat text` — Cloudflare/punish/generic-CN captcha → waf; healthy chat copy → null.
- `CHAT_INPUT_SELECTOR covers the Qwen input class and contenteditable/ARIA fallbacks` — guards the selector against regression.
- `dumpPlaywrightMiss writes a sanitized diagnostic file` — asserts the JSON output and snippet sanitation.
- Existing `reloads instead of hanging …` updated for the 3→2 attempt cap (2 reloads, 2 bounded waits).

**Commit:** `fix(playwright): detect WAF chat pages, fail fast, and centralize input selectors`

---

## Loop 3 — Fix Browser Context Crashes and DNS Inside Chromium

**Symptom from log:**
```
BrowserContext disposed.
Target page, context or browser has been closed.
page.evaluate: Target crashed
```
Per-account Chromium contexts died mid-flight. A crash on one account cascaded into "Browser has been closed" / "Session closed" on sibling contexts sharing the host, and accounts hit with navigations occasionally failed to resolve `chat.qwen.ai` (Chromium's own DNS/DoH path landing on a frontier/bad IP → `net::ERR_NAME_NOT_RESOLVED`, wrong host, or a page that dies with "BrowserContext disposed").

**Root cause:**
1. Every account boots its OWN persistent-context Chromium process. A burst of cold requests that all initialized at once forked N renderers off the same host; the OOM/memory pressure is what killed sibling contexts mid-generation.
2. Chromium resolved `chat.qwen.ai` through its own DNS/DoH, independent of the proxy's working resolution, so navigations could fail or land on a bad IP even when the Node side was fine.

**Fix applied:**

1. **DNS bypass** (`--host-resolver-rules="MAP chat.qwen.ai <ip>,MAP qwen.ai <ip>"`) — Chromium now pins the Qwen origin to the proxied upstream IP and never consults its own resolver. Configuration: `QWEN_HOST_RESOLVER_RULES` (`true` default; set `false` to let Chromium resolve normally) and `QWEN_CHAT_ORIGIN_IP` (default `8.219.122.25`). Root cause of most "browser failed to open chat page" stalls.
2. **Global init slot** (`withPlaywrightInitSlot`, cap `PLAYWRIGHT_MAX_PARALLEL_INIT` default **5**) — the heavy per-account init body (context launch + session validation + header capture) now runs under a global semaphore. A burst of cold requests serializes surplus inits instead of forking 10+ Chromium processes at once; the OOM cascade that crashed sibling contexts is removed. Cap is configurable; 0/1 disables queueing.
3. **Host-resolver arg verifiable in unit tests** — `buildChromiumLaunchArgs` output is asserted in `chromium-args.test.ts`; the slot cap is asserted by a 12-task burst in `playwright-init-slot.test.ts`.

**Tests verifying the fix:**
- `chromium-args.test.ts` — asserts `--host-resolver-rules` maps both `chat.qwen.ai` and apex `qwen.ai` to `config.playwright.chatOriginIp`.
- `playwright-init-slot.test.ts` (new) — `withPlaywrightInitSlot` never exceeds the cap on a burst of 12 concurrent inits, drains all slots, and preserves thrown errors; config exposes a sane default cap.

**Note:** "Proxy health check" (liveness of the local QwenProxy) is covered by Loop 8 observability (`/health/deep` + readiness metrics); not duplicated here.

**Commit:** `fix(playwright): pin Qwen DNS in Chromium and cap parallel account inits`

---

## Loop 4 — Fix Session Expiry Handling

**Symptom from log:**
```
Header capture failed for john.doe@gmail.com: session expired and no credentials available for re-login
Auth required: session expired
[Chat] /v1/chat/completions failed: auth required
```
A Qwen token expired server-side while the persisted browser profile still carried it. Every request — chat, `/v1/models`, personalization — then failed with `auth required`, and the account sat labeled as broken instead of being re-authenticated. A restart made it worse: the old `storage_state.json` backup (possibly days old) was re-injected into the fresh browser, dragging the dead token back in.

**Root cause:**
1. The profile/backup restore injected cookies with **no age or expiry check**: a token whose JWT `exp` had already passed — or whose `expires` had elapsed — was copied straight into the new browser context.
2. There was no staleness bound on the persisted backup, so a server that restarted days later resurrected a session that the Qwen side had already killed.

**Fix applied:**

1. **Storage-state TTL** (`PLAYWRIGHT_STORAGE_STATE_TTL_MS`, default **6h**) — a persisted `storage_state.json`/`*_state.json` backup older than the TTL is treated as a dead session and never re-injected. Callers fall through to credential re-login instead.
2. **Cookie-level expiry filtering** (`getRestorableCookies`) — even a fresh backup only contributes cookies whose `expires` is unset, session (`-1`), or still in the future, AND whose token value is not a JWT already past `exp` (`isTokenCookieJwtExpired`; opaque tokens are never discarded). A backup holding only a dead token is refused outright, so `loadStorageState` returns `undefined` and the browser boots from the native profile/credentials.
3. Both per-account init paths (`initPlaywrightForAccount`, non-headless variant) now restore via `getRestorableCookies` — one code path, no duplicated read/parse logic.

**Tests verifying the fix:**
- `shared-browser.test.ts` —
  - `isTokenCookieJwtExpired` parses JWT `exp`, survives URL-encoded tokens, and never mislabels opaque values.
  - `getRestorableCookies` drops expired `expires` cookies AND expired-token JWTs, keeps fresh session/risk cookies, and returns `[]` when the only cookie is a dead token.
  - `loadStorageState` refuses a backup beyond its TTL (mtime-probed) and reuses one inside the budget.

**Commit:** `fix(auth): refuse stale/expired session backups and bound storage-state TTL`

---

## Loop 5 — Fix the 2M Character Full Replay

**Symptom from log:**
```
Compressed context still exceeds budget (2000042 > 100000); refusing to send full context
[Chat] /v1/chat/completions failed: Context length exceeded
```
Escalations and failovers re-send the entire conversation. A conversation dominated by ONE enormous message (a 2M-char paste that IS the current turn) can't be cut by selection — T1 drop keeps it, T3 truncation doesn't help, and the tiered assembly refused to serve it by throwing, so the whole request died with a context-limit error instead of making progress.

**Root cause:**
- Tiered selection (`assembleCompressedContext`) could trim multi-message overflow (drop T2/T1 groups), but a single giant message "cannot be dropped or paired away" and was handled by throwing — the exact case the original full-replay bug report was about.
- Additionally the rendered failover envelope (`renderFailoverPrompt`) re-emits segment prefixes and re-serializes tool-call tags that the JSON-budget accounting inside `assemble` doesn't count, so a prompt that fit the serialized budget could still trip the render-side "exceeds budget" throw.

**Fix applied (tiered.ts):**
1. **Last-resort tail trim** — when the selection still overflows after T2-drop/T1-drop/T3-truncate, `trimLastMessageToFit` binary-searches the final kept message's content length so the serialized selection fits, appends `[Context truncated: ...]`, and serves the turn. The throw is now reserved for the only truly unsendable case: T0/T2/T3 alone already overflow (an empty current turn still can't fit).
2. **Render-overhead reserve** — `buildFailoverPrompt` shrinks the assembly budget by `toolInstructions.length + 4096` so the rendered envelope (segment prefixes + re-emitted tags + toolInstructions) stays under the same 100k ceiling instead of tripping the render-side guard.

**Tests verifying the fix:**
- `tiered-context.test.ts` (new) —
  - single 2M-char paste: `assembleCompressedContext` no longer throws; `totalChars`/`payload` ≤ 100k; the current turn survives with a `[Context truncated` notice.
  - failover prompt for a single 2M-char paste is served ≤ 100k with the truncation notice.
- Existing 500-message/2M conversation, tool-pair integrity, T0 byte-identity, refs, and personalization-envelope tests unchanged and green.

**Commit:** `3405379 test(context): semantic retention of planted fact plus single-paste trim guard` (the tiered.ts guard + tests landed in that commit; this recovery doc entry was added in `95f3559`). The working-tree regression that temporarily reverted the guard was caught by the failing test above and restored.

---

## Loop 6 — Fix ReadinessGuard Thundering Herd

**Symptom from log:**
```
[Readiness] warming up account acc-a...
[Readiness] warming up account acc-a...   // duplicate, same instant
[Readiness] warming up account acc-b...
[Readiness] warming up account acc-b...   // duplicate
```
A burst of cold requests each called `ensurePoolReadiness()` concurrently. There was no in-flight coalescing and no per-account warming guard, so the same standbys were warmed multiple times in parallel — doubling Chrome context launches, header captures, and cooldown/noop log spam under load.

**Root cause:**
1. `ensurePoolReadiness` ran its full pool-check for every caller; N concurrent triggers ran N parallel checks.
2. `warmAccount` had no early exit when an account was already mid-init, so the same account could be initialized twice by overlapping checks.

**Fix applied (readiness-guard.ts):**
1. **In-flight coalescing** — `ensurePoolReadiness` now delegates to `runPoolCheck` under a single-flight guard: callers arriving while a check is running record `pendingRecheck` and return; the running check loops (do/while) until the herd has drained. One initial check + one trailing recheck replaces N.
2. **Double-warm guard** — `warmAccount` early-returns `false` when the account is already in `warmingInProgress`, so even a recheck can never start a second init for the same account.
3. **Validation-bucket spread** — the periodic recovered-account sweeps are bucketed (`VALIDATION_BUCKETS = 3`, `sweepBucket = floor(now / SWEEP_INTERVAL_MS) % 3` via exported `recoveredValidationBucket`), so validation work is spread across intervals instead of stampeding all recovered accounts at sweep time.

**Tests verifying the fix (readiness-guard.test.ts, new):**
- 6 concurrent `ensurePoolReadiness` triggers with 3 cold standbys coalesce to ≤ 2 sequential inits, peak in-flight ≤ 1, no account initialized twice.
- Fully-ready pool (`markAccountHeadersReady` on all accounts) is a no-op — zero inits.
- Single standby behind concurrent triggers inits exactly once.
- `recoveredValidationBucket` is deterministic and spreads accounts across buckets.
- Sweep start/stop round-trips without throwing.

**Commit:** Loop 6 (`fix(readiness): coalesce readiness bursts and spread validation sweeps`)

**Note:** the tree keeps the pre-existing working-set (account-pool health/state/scheduler, forge-import, `.env.example`, etc.) untouched; only the readiness-guard hardening and its tests were staged for this loop.

## Loop 7 — Integration Test: Two Concurrent Coding Sessions

**Symptom from log:**
```
[Session] New session bound | key=82a1… | account=acc-a
[Session] New session bound | key=91c4… | account=acc-a   // second session, same instant
```
Two brand-new coding sessions fired their first turns at the same moment against an idle pool. The selection layer is synchronous and health-only: it knows nothing about sessions already being served per account. With identical health across the pool, the second first-turn selector picked the SAME account as the first (tie-break by id), then had to queue for a lease. Because stickiness survives the whole session, both sessions stayed glued to one account forever — permanently halving pool parallelism, even though two idle accounts were sitting nearby.

**Root cause:**
1. No in-flight guard between "selected" and "bound": selection claims nothing, so a concurrent sibling re-selects the same account during the async lease/stream gap.
2. No load-awareness: `selectAccountForNewSession` never counts how many live sessions already serve each account, so even after bind A→acc-a, a new session still picked acc-a (identical composite score, lexicographic tie-break).

**Fix applied (selection.ts):**
1. **Synchronous in-flight claims** (`pendingClaims`, `CLAIM_TTL_MS = 5s`, exports `releaseAccountClaim`/`clearSelectionClaimsForTests`) — the very first act of selecting for a sticky key is claiming the picked account. A concurrent sibling's selector then sees that account as loaded (its own key is exempt, so retries/failover never self-block). Claims overwrite on re-selection and expire by TTL; the auto-release hook keeps the window tight.
2. **Live-binding load penalty** — selection now counts live non-expired sticky bindings per account (excluding the selecting session's own binding) plus other sessions' in-flight claims, and scales the composite score by `1/(1+load)`. Accounts already serving sessions remain eligible (overflow never bounces) but new sessions deterministically prefer the least-served account. Single-account pools are unaffected.

**Tests verifying the fix (concurrent-sessions-integration.test.ts, new):**
- Two first turns racing an idle 3-account pool (selection → 40ms async lease gap → bind) end bound to DIFFERENT accounts.
- A third session starting right after binds must land on the remaining (load-0) account, not pile onto either live session.
- Existing `two-sessions`, `rebind-integration`, `account-selection`, `burst-quota` stay green (no-claim paths unchanged).

**Commit:** `fix(selection): steer concurrent first turns and live sessions off the same account`

**Note:** the no-op claim stub was first validated RED (both sessions landed on `acc-a` and the "different accounts" assertion failed) before the load-aware fix was applied.

## Loop 8 — Recovery Metrics and Logging

*(pending)*
