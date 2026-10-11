# PROGRESS — authoritative work state

> Session-resilience worklog. Read this first on session start / after compaction.
> Update it after every completed step. Keep it short: status + decisions only.

Last updated: 2026-10-11

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
| Restart QwenProxy + opencode to load fixes | PENDING | user action |

## Pending (continue here)

1. Restart QwenProxy (proxy code changed) and opencode (config changed).
2. Documentation task: write Phase 1 deliverables into `docs/modules/`
   (start from `docs/gap-analysis-official-api-parity.md`).
3. Offer a `docs:` commit once Phase 1 files exist.
4. Optional: session identity for Anthropic/Responses routes.

## Decisions

- Compaction trigger (proxy 400 at 200,000 bytes) removed; byte cap default
  is now off. Guards are 4MB body limit + model-aware token check.
- OpenCode providers `qwen/qwen3.8-max`, `ownserver/...`, `qwenproxy/...` now
  declare `limit: { context: 1048576, output: 65536 }` so auto-compact waits
  for the real 1M window instead of a guessed default.
- Global compaction config: `tail_turns: 10`, `preserve_recent_tokens: 30000`
  so recent turns survive any future compaction verbatim.
- Recovery protocol lives in `AGENTS.md` (this repo).
