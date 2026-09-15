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

*(pending)*

## Loop 5 — Fix the 2M Character Full Replay

*(pending)*

## Loop 6 — Fix ReadinessGuard Thundering Herd

*(pending)*

## Loop 7 — Integration Test: Two Concurrent Coding Sessions

*(pending)*

## Loop 8 — Recovery Metrics and Logging

*(pending)*
