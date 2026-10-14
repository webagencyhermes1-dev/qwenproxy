# Project: QwenProxy Upstream Empty Turn Resolution & Resilient Streaming Recovery

## Architecture
- **Context & Session Management (`src/routes/chat/context.ts`, `src/services/qwen-thread-state.ts`)**:
  - Responsible for mapping incoming client requests (session ID / `x-session-id`) to logical thread states.
  - Ensures prompt is only stripped to delta (`currentPrompt`) if a verified `chatSessionId` AND valid `parentId` exist.
  - Maintains SQLite persistence via `logical_thread_states` with debounced write flush. Provides atomic invalidation (`invalidateLogicalThreadParent`) and purging (`purgeLogicalThreadState`).
- **Account & Routing Management (`src/routes/chat/account.ts`, `src/routes/chat/retry-policy.ts`)**:
  - Manages upstream Qwen account selection, lease acquisition, and session continuity.
  - Controls `canReuseUpstreamChat` and `threadMissingParent` evaluation.
  - Classifies retry actions for `empty_response` with `switchAccount: true, forceNewChat: true, retryWithFullPrompt: true`.
- **Streaming Pipeline & Recovery (`src/routes/chat/streaming.ts`, `src/routes/chat/index.ts`)**:
  - SSE generation, tool call parsing, and chunk emission.
  - `emittedModelOutput` lifecycle tracking.
  - Reader loop wrapped in `streamReadLoop: while (true)` with mid-stream transparent failover via `recoverFromStreamError`.
  - Strict ordering: model output verification -> transparent recovery -> ghost parent prevention -> commit parent ONLY on valid output.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Safe Context Prompt Slicing | Only use delta `currentPrompt` if `existingThread.parentId` is non-null; full `prompt` otherwise | M1 (DONE) | Survey (R1) |
| 2 | Thread State Purge & Invalidation | Add `purgeLogicalThreadState`, harden `invalidateLogicalThreadParent` in SQLite, wire into retry policies | M1 (DONE) | Survey (R1) |
| 3 | Retry Policy for Empty Response | Update `classifyRetryAction` to handle `empty_response` with account switch, fresh chat, full prompt | M1 (DONE) | Survey (R1) |
| 4 | Ghost Parent Prevention in Streaming | Move `rememberParent` after output validation; discard `pendingParentId` on empty/failed turns | M2 (DONE) | Survey (R2) |
| 5 | Ghost Parent Prevention in Non-Streaming | Invalidate thread parent and discard pending parent on empty turn in `processNonStreamingResponse` | M2 (DONE) | Survey (R2) |
| 6 | Transparent Streaming Recovery | Wire empty turn detection into `recoverFromStreamError` inside `streamReadLoop` when `emittedModelOutput === false` | M2 (DONE) | Survey (R3) |
| 7 | Account Rotation & Fresh Chat Replay on Empty Turn | Ensure `recoverFromStreamError` switches to another hot account, forces fresh chat, and replays full prompt | M2 (DONE) | Survey (R3) |
| 8 | Verification & Integration Test Suite | Integration tests for zero-token persistence prevention, simulated empty-stream transparent recovery, and full regression | M3 | Survey (AC) |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Thread State, Context & Retry Policy | `src/services/qwen-thread-state.ts`, `src/routes/chat/context.ts`, `src/routes/chat/retry-policy.ts` | none | DONE |
| M2 | Streaming Engine, Ghost Parent Prevention & Transparent Failover | `src/routes/chat/streaming.ts`, `src/routes/chat/index.ts` | M1 | DONE |
| M3 | Integration Test Suite & System Verification | `src/tests/empty-response-guard.test.ts`, `src/tests/transparent-stream-recovery.test.ts`, `src/tests/advanced.test.ts`, `npm run typecheck`, `npm run test:mock` | M2 | IN_PROGRESS |

## Interface Contracts
### `qwen-thread-state.ts` ↔ `context.ts` / `streaming.ts`
- `purgeLogicalThreadState(logicalSessionId: string): void`
  - Deletes session from in-memory cache, dirty queue, and SQLite `logical_thread_states`.
- `invalidateLogicalThreadParent(logicalSessionId: string): void`
  - Sets `parentId: null` in-memory and in SQLite while retaining `accountId` and `chatSessionId`.
- `canReuseThreadDelta`:
  - `Boolean(existingThread?.chatSessionId && existingThread?.parentId)`
  - If false, `baseActivePrompt` MUST default to full `prompt`.

### `streaming.ts` ↔ `recoverFromStreamError`
- On `isEmptyTurn` (`!finalContent && !hasEmittedToolCalls && !reasoningBuffer`):
  - Invariant: `pendingParentId = null`.
  - Condition: `!clientDisconnected && !c.req.raw.signal.aborted && !emittedModelOutput`.
  - Action: `await recoverFromStreamError(emptyTurnError)`.
  - If `true`: reset attempt buffers and `continue streamReadLoop`.
  - If `false`: `invalidateLogicalThreadParent(logicalSessionId)` and `throw emptyTurnError`.

## Code Layout
- `src/services/qwen-thread-state.ts`: Thread state persistence and invalidation logic (M1).
- `src/routes/chat/context.ts`: Context building and prompt delta selection (M1).
- `src/routes/chat/retry-policy.ts`: Error classification and retry action definitions (M1).
- `src/routes/chat/streaming.ts`: Streaming and non-streaming response processing, reader loop, failover (M2).
- `src/routes/chat/index.ts`: Chat route outer loop and error handling (M2).
- `src/tests/`: Integration and unit test suites (M3).
