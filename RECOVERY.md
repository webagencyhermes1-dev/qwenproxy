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

## Loop 3 — Fix Browser Context Crashes and DNS Inside Chromium

*(pending)*

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
