# E2E Test Infra: QwenProxy Upstream Empty Turn & Failover

## Test Philosophy
- Opaque-box and component integration tests derived from user acceptance criteria.
- Invariant verification: Zero-token upstream turns must NEVER persist a `response_id` into SQLite.
- Resilience verification: In streaming mode, an upstream empty turn with zero emitted output must transparently switch accounts and complete cleanly without exposing error chunks to the downstream client.

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1 | Safe Context Prompt Slicing | R1 | ✓ | ✓ | ✓ |
| 2 | Thread State Purge & Invalidation | R1 | ✓ | ✓ | ✓ |
| 3 | Ghost Parent Prevention (Streaming) | R2 | ✓ | ✓ | ✓ |
| 4 | Ghost Parent Prevention (Non-Streaming) | R2 | ✓ | ✓ | ✓ |
| 5 | Transparent Streaming Recovery | R3 | ✓ | ✓ | ✓ |
| 6 | Terminal Error on Exhausted Retries | R3 | ✓ | ✓ | ✓ |

## Test Scenarios
1. **Zero-Token Turn SQLite Invariant**:
   - Upstream mock delivers `response.created` with `response_id: "resp-ghost"` followed immediately by `[DONE]`.
   - Streaming request is sent.
   - Assert: After stream completes (or fails), SQLite `logical_thread_states` has `parent_id` as `NULL` or row does not contain `"resp-ghost"`.
2. **Transparent Streaming Failover**:
   - Account 1 returns an empty response (0 tokens).
   - Account 2 returns a valid streaming completion (`"hello world"`).
   - Downstream client receives HTTP 200, role chunk, answer chunk, and `[DONE]`. Zero error chunks are received.
   - Assert: Total completion calls >= 2, and result contains `"hello world"`.
3. **Exhausted Retries Terminal Error**:
   - All accounts in pool return empty responses.
   - Downstream client receives SSE error event with `code: "empty_response"`.
   - Assert: `logical_thread_states` is invalidated (`parent_id: null`).
4. **Context Prompt Full Replay on Invalidated Parent**:
   - Given a session with `parentId: null` in `logical_thread_states`, verify that `buildFinalContext` uses the full conversation prompt, not delta `currentPrompt`.

## Test Commands
- Typecheck: `npm run typecheck`
- Mock Test Suite: `npm run test:mock`
- Dedicated Guard Suite: `npx tsx --test --test-concurrency=1 --env-file=.env.test src/tests/empty-response-guard.test.ts`
