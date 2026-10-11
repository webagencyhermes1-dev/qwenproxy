# QwenProxy vs Official Qwen API — Gap Analysis & Parity Roadmap

**Version:** 1.0
**Date:** 2026-10-10
**QwenProxy Version:** v1.0.21
**Scope:** Comparison of QwenProxy's public-facing API surface against the official Qwen / Alibaba Cloud Model Studio (DashScope) API, with a prioritized plan to close all gaps.

---

## 1. Executive Summary

QwenProxy is a **web-client proxy** — it automates the Qwen web chat client (`chat.qwen.ai`) via Patchright (a Playwright fork), issuing in-browser `fetch` calls to `chat.qwen.ai/api/v2/chat/completions` and `/api/v2/chats/new` with WAF bypass. It is **not** a client of the official DashScope/Model Studio API.

The official API offers four interfaces:

| # | Interface | Endpoint Base | Feature Coverage |
|---|-----------|---------------|------------------|
| 1 | OpenAI-compatible Chat Completions | `POST /compatible-mode/v1/chat/completions` | Standard sampling, tools, streaming, usage |
| 2 | OpenAI-compatible Responses API | `POST /compatible-mode/v1/responses` | Built-in web search, code interpreter, web extractor; server-managed history |
| 3 | Anthropic-compatible Messages | `POST /compatible-mode/v1/messages` | Anthropic schema translation |
| 4 | DashScope native | `POST /api/v1/services/aigc/text-generation/generation` | Most complete, all features |

**Overall parity score: ~45%** (weighted by feature importance and usage frequency). QwenProxy excels at enterprise resilience and multi-account management — areas where it *exceeds* the official API — but has critical gaps in parameter forwarding, native tool calling, structured outputs, and built-in tool support.

**Best solution:** A **hybrid upstream architecture** that adds an official DashScope provider alongside the existing web provider, with configurable routing (`auto | dashscope | web`). This delivers full official-API parity when `DASHSCOPE_API_KEY` is set while preserving the free web-client fallback.

---

## 2. Architectural Comparison

### 2.1 QwenProxy Current Architecture

```
Client (OpenAI SDK / curl / any HTTP client)
  │
  ▼
Hono HTTP Server (src/api/server.ts)
  │
  ├── /v1/chat/completions   → src/routes/chat/
  ├── /v1/responses          → src/routes/responses/
  ├── /v1/messages           → src/routes/anthropic/
  ├── /v1/completions        → src/routes/completions.ts
  └── /v1/models             → src/api/models.ts
  │
  ▼
Validation & Prompt Engineering Layer
  • ChatBodySchema validation (no sampling params)
  • Reasoning mode injection (suffixes + feature_config)
  • Tool instruction injection (XML prompt-based)
  • Structured output instruction injection
  │
  ▼
Generation State Machine (src/domain/generation.ts)
  • MAX_GENERATION_ATTEMPTS = 4
  • Tool loop: model → tool calls → tool results → model
  • Retry coordination, account rotation
  │
  ▼
QwenService (src/services/qwen.ts)
  • Patchright browser automation
  • In-browser fetch to chat.qwen.ai/api/v2/chat/completions
  • Session management via /api/v2/chats/new
  • WAF bypass, captcha handling
  • Multi-account pool with health tracking
  │
  ▼
chat.qwen.ai (Qwen Web Client Backend)
```

### 2.2 Official API Architecture

```
Client (OpenAI SDK / DashScope SDK / curl)
  │
  ▼
DashScope / Model Studio API Gateway
  │
  ├── /compatible-mode/v1/chat/completions
  ├── /compatible-mode/v1/responses
  ├── /compatible-mode/v1/messages
  └── /api/v1/services/aigc/text-generation/generation
  │
  ▼
Qwen Model Inference (Alibaba Cloud)
  • Native function calling
  • Constrained decoding (JSON schema)
  • Built-in tools (web search, code interpreter, web extractor)
  • Server-side token accounting
  • Rate limiting / quota management
```

### 2.3 Key Architectural Differences

| Dimension | QwenProxy | Official API |
|-----------|-----------|--------------|
| Transport | Browser-automated web client | Direct HTTPS to API gateway |
| Auth | Qwen web session cookies + WAF bypass | `Authorization: Bearer $DASHSCOPE_API_KEY` |
| Tool calling | XML prompt injection + parser | Native `tools` / `function_call` parameter |
| Structured output | Prompt instruction only | Constrained decoding (`json_schema`) |
| Sampling params | Ignored (accepted but dropped) | Fully honored |
| Context management | Client-side tiered (T0-T3) | Server-managed or client-managed |
| Token counting | Heuristic estimation | Official tokenizer |
| Built-in tools | Hard-disabled via settings patch | Native support |
| Cost | Free (web client) | Pay-per-token |
| Rate limits | Web client limits + account rotation | Tiered API quotas |

---

## 3. Feature Parity Matrix

Legend: ✅ Full parity · ⚠️ Partial parity · ❌ Missing / not forwarded · ➕ QwenProxy exceeds official API

### 3.1 Chat Completions (`/v1/chat/completions`)

| Feature | Official API | QwenProxy | Status | Evidence |
|---------|-------------|-----------|--------|----------|
| `model` | Required, Model Studio names | Required, web client catalog names | ⚠️ | `src/core/model-alias.ts:68-96`, `src/api/models.ts:72-76` |
| `messages` | Array of role/content objects | Accepted, forwarded | ✅ | `src/routes/chat/validation.ts:78-90` |
| `messages[].role` | system/user/assistant/tool | Accepted | ✅ | validation.ts |
| `messages[].content` | string or array of parts | Accepted | ✅ | validation.ts |
| `messages[].tool_calls` | Array of tool call objects | Accepted (for tool loop) | ✅ | `src/domain/generation.ts` |
| `messages[].tool_call_id` | String correlating tool result | Accepted | ✅ | generation.ts |
| `temperature` | 0.0–2.0 (model-dependent) | **Accepted but NOT forwarded** | ❌ | `src/routes/completions.ts:26-31`; 0 matches in chat route |
| `top_p` | 0.0–1.0 | **Accepted but NOT forwarded** | ❌ | completions.ts; 0 matches in chat route |
| `top_k` | Integer | Not accepted | ❌ | No matches in any route |
| `max_tokens` / `max_completion_tokens` | Integer | **Accepted but NOT forwarded** | ❌ | completions.ts:89-94; not in `QwenPayload` |
| `n` | Number of completions | Not accepted | ❌ | No matches |
| `stream` | Boolean | Accepted, fully supported | ✅ | `src/routes/chat/streaming.ts` |
| `stream_options.include_usage` | Boolean | Accepted | ✅ | `src/benchmarks/proxy-baseline.ts:458` |
| `stop` | String or array | **Accepted but NOT forwarded** | ❌ | completions.ts; not forwarded |
| `seed` | Integer for reproducibility | Not accepted | ❌ | No matches |
| `frequency_penalty` | -2.0 to 2.0 | **Accepted but NOT forwarded** | ❌ | completions.ts; not forwarded |
| `presence_penalty` | -2.0 to 2.0 | **Accepted but NOT forwarded** | ❌ | completions.ts; not forwarded |
| `logprobs` | Boolean | Not accepted | ❌ | No matches |
| `top_logprobs` | Integer 0–20 | Not accepted | ❌ | No matches |
| `logit_bias` | Object | Not accepted | ❌ | No matches |
| `user` | String | Not accepted | ❌ | No matches |
| `response_format` | `text` / `json_object` / `json_schema` | ⚠️ Prompt injection only | ⚠️ | `src/routes/chat/validation.ts:552-590` |
| `tools` | Array of function definitions | ⚠️ XML prompt injection | ⚠️ | `src/tools/instructions.ts`, `src/tools/parser.ts` |
| `tool_choice` | `none`/`auto`/`required`/specific function | ⚠️ Partial (validated in Responses, not in chat) | ⚠️ | `src/routes/responses/validation.ts:97-99` |
| `parallel_tool_calls` | Boolean | ⚠️ Accepted in Responses, prompt guidance in chat | ⚠️ | `src/tools/instructions.ts:107` |
| `reasoning_effort` | low/medium/high (Qwen3 models) | Accepted + mapped to web feature_config | ✅ | `src/routes/chat/validation.ts:161-179`, `src/services/qwen.ts:2970-2988` |
| Thinking/reasoning mode | Model suffix or parameter | Supported via model suffixes + feature_config | ✅ | validation.ts, qwen.ts |
| `enable_search` / web search | DashScope parameter | ❌ Not supported | ❌ | 15 grep matches, no forwarding |
| `code_interpreter` | DashScope parameter | ❌ Not supported | ❌ | grep matches only in benchmarks |

### 3.2 Streaming (SSE)

| Feature | Official API | QwenProxy | Status | Evidence |
|---------|-------------|-----------|--------|----------|
| SSE `data:` chunks | Standard | Standard | ✅ | `src/routes/chat/streaming.ts` |
| `chat.completion.chunk` object | Standard | Standard | ✅ | streaming.ts |
| Delta content | Standard | Standard | ✅ | streaming.ts |
| Delta reasoning/thinking content | Standard (Qwen3) | Supported via `thinking_summary`/`answer` phases | ✅ | streaming.ts:490-569 |
| Delta tool_calls | Standard | Supported (XML parser reconstructs) | ⚠️ | `src/tools/parser.ts` |
| `finish_reason` | stop/length/tool_calls/content_filter | Supported | ✅ | streaming.ts:918 |
| Usage in final chunk | With `include_usage` | Supported | ✅ | `src/routes/chat/helpers.ts:182-267` |
| `x-dashscope-*` headers | Present | Not present | ❌ | N/A |

### 3.3 Reasoning / Thinking

| Feature | Official API | QwenProxy | Status |
|---------|-------------|-----------|--------|
| Qwen3 thinking mode | Model suffix or `enable_thinking` | Model suffixes + `feature_config` | ✅ |
| `reasoning_effort` | low/medium/high | Mapped to web client settings | ✅ |
| `thinking_summary` phase | SSE phase | SSE phase | ✅ |
| `answer` phase | SSE phase | SSE phase | ✅ |
| Reasoning token accounting | In usage | In usage (`reasoning_tokens` in `completion_tokens_details`) | ✅ |

### 3.4 Usage & Token Accounting

| Feature | Official API | QwenProxy | Status | Evidence |
|---------|-------------|-----------|--------|----------|
| `prompt_tokens` | Exact (official tokenizer) | Heuristic estimation | ⚠️ | `src/utils/context-truncation.ts` |
| `completion_tokens` | Exact | Estimated | ⚠️ | context-truncation.ts |
| `total_tokens` | Sum | Sum | ✅ | helpers.ts |
| `prompt_tokens_details.cached_tokens` | Present | Present | ✅ | helpers.ts:182-267 |
| `completion_tokens_details.reasoning_tokens` | Present (thinking models) | Present | ✅ | helpers.ts |
| `completion_tokens_details.accepted_prediction_tokens` | Present | Not present | ❌ | N/A |

### 3.5 Responses API (`/v1/responses`)

| Feature | Official API | QwenProxy | Status | Evidence |
|---------|-------------|-----------|--------|----------|
| Basic input/output | Standard | Supported | ✅ | `src/routes/responses/` |
| `model` | Model Studio names | Web client names | ⚠️ | adapter.ts |
| `instructions` | System prompt equivalent | Supported | ✅ | validation.ts |
| `input` (message array) | Standard | Supported | ✅ | validation.ts |
| `previous_response_id` | Server-managed history | Not supported (client-side) | ❌ | No server-side session |
| `tool_choice` | none/auto/required/specific | Supported (converted to prompt) | ⚠️ | adapter.ts:237-268 |
| `parallel_tool_calls` | Boolean | Accepted, prompt guidance | ⚠️ | validation.ts:115 |
| `tools[].type = "web_search"` | Built-in web search | **Silently dropped** | ❌ | adapter.ts:218 |
| `tools[].type = "code_interpreter"` | Built-in code interpreter | **Silently dropped** | ❌ | adapter.ts:218 |
| `tools[].type = "web_extractor"` | Built-in web extractor | **Silently dropped** | ❌ | adapter.ts:218 |
| `tools[].type = "function"` | Function calling | XML prompt injection | ⚠️ | adapter.ts |
| `text.format` (json_schema) | Constrained decoding | Prompt injection | ⚠️ | adapter.ts:276-296 |
| `temperature`, `top_p`, `max_output_tokens` | Standard | Accepted, **NOT forwarded** | ❌ | validation.ts:109-111, adapter.ts:269-272 |
| `truncation` | auto/disabled | Not supported | ❌ | No matches |
| `store` | Boolean | Not supported | ❌ | No matches |
| `background` | Boolean | Not supported | ❌ | No matches |
| Streaming events | response.created, response.output_item.added, etc. | Supported | ✅ | `src/routes/responses/streaming.ts` |
| Usage in response | Standard | Supported | ✅ | streaming.ts:99-124 |

### 3.6 Anthropic Messages API (`/v1/messages`)

| Feature | Official API | QwenProxy | Status | Evidence |
|---------|-------------|-----------|--------|----------|
| `model` | Model Studio names | Web client names | ⚠️ | `src/routes/anthropic/` |
| `messages` | Anthropic format | Translated to OpenAI format | ✅ | `src/routes/anthropic/translate.ts` |
| `max_tokens` | Required | Required, **NOT forwarded** | ❌ | validation.ts:21-27, translate.ts:237-238 |
| `temperature` | 0.0–1.0 | Accepted, **NOT forwarded** | ❌ | validation.ts:129-138 |
| `tools` | Anthropic tool schema | Translated, XML prompt injection | ⚠️ | translate.ts |
| `tool_choice` | auto/any/tool/none | Translated | ⚠️ | validation.ts:98-119 |
| `system` | System prompt | Translated | ✅ | translate.ts |
| `stop_reason` | end_turn/stop_sequence/max_tokens/tool_use | Mapped from finish_reason | ✅ | translate.ts:312-321 |
| Streaming SSE | Anthropic SSE format | Supported | ✅ | anthropic route |
| Usage | input_tokens/output_tokens | Supported | ✅ | translate.ts |

### 3.7 Models Endpoint (`/v1/models`)

| Feature | Official API | QwenProxy | Status | Evidence |
|---------|-------------|-----------|--------|----------|
| Model listing | Model Studio catalog | Web client catalog | ⚠️ | `src/api/models.ts:72-76` |
| Model naming | Official names (e.g., `qwen-plus`, `qwen-max`) | Web client names | ⚠️ | `src/core/model-alias.ts:68-96` |
| Model metadata | capabilities, context window | Partial (code_interpreter detection) | ⚠️ | `src/core/model-registry.ts:309-313` |

### 3.8 Areas Where QwenProxy EXCEEDS Official API

| Feature | QwenProxy | Official API | Status |
|---------|-----------|--------------|--------|
| Multi-account rotation | Round-robin, sticky, HOT pool | Single API key | ➕ |
| Broken-account recovery | Automatic detection + recovery | N/A | ➕ |
| Crash recovery | Persistent state, resume | N/A | ➕ |
| Watchdog | Process health monitoring | N/A | ➕ |
| 4-tier retry coordination | Exponential backoff + account rotation | Basic rate limiting | ➕ |
| Rate limit management | Per-account tracking, backoff | Tiered quotas | ➕ |
| WAF bypass | DNS pinning, fingerprint rotation | N/A | ➕ |
| Tiered context management | T0-T3 with rolling summary + BM25 retrieval | Client responsibility | ➕ |
| Free usage | No per-token cost | Pay-per-token | ➕ |

---

## 4. Detailed Gap Analysis

### Gap 1: Sampling Parameters Not Forwarded (CRITICAL)

**Severity:** Critical — violates OpenAI API contract

**Description:** QwenProxy accepts `temperature`, `top_p`, `max_tokens`, `stop`, `frequency_penalty`, and `presence_penalty` in `/v1/completions` but **silently discards all of them**. The `/v1/chat/completions` route doesn't even accept them in its schema (`ChatBodySchema` at `src/routes/chat/validation.ts:78-90`). The `QwenPayload` interface (`src/services/qwen.ts:447-460`) has no fields for sampling parameters, and they are not included in the payload construction (`qwen.ts:2943-3000`).

**Impact:** Clients relying on deterministic or tuned generation get default web-client behavior regardless of parameters. This is the single largest API contract violation.

**Root cause:** The Qwen web client API (`/api/v2/chat/completions`) may not expose sampling parameters, or they haven't been reverse-engineered yet.

### Gap 2: Tool Calling via Prompt Injection (HIGH)

**Severity:** High — functional but fragile

**Description:** Tool calling is implemented by injecting XML-formatted tool descriptions into the system prompt (`src/tools/instructions.ts`) and parsing XML tool calls from the model's response (`src/tools/parser.ts`). The official API supports native `tools` and `function_call` parameters with structured JSON responses.

**Impact:**
- Tool call parsing can fail if the model doesn't produce well-formed XML
- No `tool_call_id` correlation at the transport level
- `tool_choice` constraints (force specific function, disable tools) are approximated via prompt wording
- Parallel tool calls are "suggested" via prompt guidance rather than enforced
- Higher token overhead from XML instructions

### Gap 3: Structured Outputs Are Prompt-Only (HIGH)

**Severity:** High — no guarantee of schema compliance

**Description:** `response_format: { type: "json_schema", json_schema: {...} }` is handled by injecting schema instructions into the prompt (`src/routes/chat/validation.ts:552-590`). There is no constrained decoding or post-generation validation against the schema. The official API supports `json_schema` with guaranteed schema compliance via constrained decoding.

**Impact:** JSON output may violate the specified schema, especially for complex schemas with nested objects, enums, or required fields.

### Gap 4: Built-in Tools Hard-Disabled (HIGH)

**Severity:** High — advertised features unavailable

**Description:** `QWEN_SAFE_SETTINGS_PATCH` (`src/services/qwen.ts:690-700`) hard-disables all native Qwen web tools (web search, code interpreter, image generation, etc.). The Responses API adapter silently drops built-in tool definitions (`src/routes/responses/adapter.ts:218`). The live settings schema probe (`src/benchmarks/live-settings-schema-probe.ts:36`) confirms the tool names exist in the web client.

**Impact:** Clients requesting web search, code execution, or other built-in tools get no functionality and no error message.

### Gap 5: Token Estimation Is Heuristic (MEDIUM)

**Severity:** Medium — inaccurate usage reporting

**Description:** Token counting uses character-based heuristics (`src/utils/context-truncation.ts`) rather than the official Qwen tokenizer. This affects usage reporting accuracy and context window management decisions.

**Impact:** `usage` object may be off by 10-30% for non-English text. Context truncation decisions may be suboptimal.

### Gap 6: Context Management Is Client-Side (MEDIUM)

**Severity:** Medium — architectural difference, not a bug

**Description:** QwenProxy implements T0-T3 tiered context management with rolling summaries (`src/services/context/tiered.ts`, `summary.ts`) and BM25 vector retrieval (`vectorStore.ts`). The official Responses API offers server-managed history via `previous_response_id`. These are fundamentally different approaches.

**Impact:** Not a defect per se, but means QwenProxy cannot offer `previous_response_id` or `store` semantics.

### Gap 7: Model Catalog Mismatch (MEDIUM)

**Severity:** Medium — confusing for API consumers

**Description:** QwenProxy exposes web-client model names via `/v1/models` (`src/api/models.ts:72-76`) with alias mapping (`src/core/model-alias.ts:68-96`). Official Model Studio uses different naming conventions (e.g., `qwen-plus`, `qwen-max`, `qwen-turbo` vs web client names). The code_interpreter capability is detected (`src/core/model-registry.ts:309-313`) but not actionable.

**Impact:** Clients using official model names may get unexpected results or errors.

### Gap 8: Missing Response Fields (LOW)

**Severity:** Low — minor contract deviations

**Missing fields:**
- `logprobs`, `top_logprobs` — not supported
- `n` (multiple completions) — not supported
- `seed` — not supported
- `logit_bias` — not supported
- `user` — not supported
- `completion_tokens_details.accepted_prediction_tokens` — not present
- `x-dashscope-*` response headers — not present
- `system_fingerprint` — not present

---

## 5. Best Solution: Hybrid Upstream Architecture

### 5.1 Concept

Add an **official DashScope/Model Studio provider** as a first-class upstream alongside the existing Qwen web provider. A configuration switch determines routing:

```
upstream.mode = "auto" | "dashscope" | "web"

"dashscope" → Always route to official API (requires DASHSCOPE_API_KEY)
"web"       → Always route to web client automation (current behavior)
"auto"      → Use DashScope if DASHSCOPE_API_KEY is set, else web
```

### 5.2 Architecture

```
Client Request
  │
  ▼
Hono HTTP Server (existing)
  │
  ▼
Route Layer (existing: chat, responses, anthropic, completions)
  │
  ▼
┌─────────────────────────────────┐
│   Upstream Router (NEW)         │
│   src/upstream/router.ts        │
│                                 │
│   mode: auto | dashscope | web  │
│   • Check DASHSCOPE_API_KEY     │
│   • Check feature requirements  │
│   • Route to provider           │
└────────┬──────────────┬─────────┘
         │              │
         ▼              ▼
┌────────────────┐  ┌──────────────────┐
│ DashScope      │  │ Qwen Web         │
│ Provider (NEW) │  │ Provider (EXIST) │
│                │  │                  │
│ src/upstream/  │  │ src/services/    │
│ dashscope.ts   │  │ qwen.ts          │
│                │  │                  │
│ • Native tools │  │ • Browser auto   │
│ • Sampling     │  │ • XML tools      │
│ • JSON schema  │  │ • Prompt JSON    │
│ • Built-in     │  │ • Tiered context │
│   tools        │  │ • Multi-account  │
│ • Official     │  │ • Free           │
│   tokenizer    │  │                  │
└────────────────┘  └──────────────────┘
```

### 5.3 Key Design Decisions

1. **Provider interface:** Define a common `UpstreamProvider` interface that both DashScope and web providers implement. This allows the route layer to remain provider-agnostic.

2. **Parameter passthrough:** When routing to DashScope, forward ALL OpenAI-compatible parameters (`temperature`, `top_p`, `max_tokens`, `seed`, `stop`, `frequency_penalty`, `presence_penalty`, `n`, `logprobs`, `top_logprobs`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `stream_options`).

3. **Feature-based routing:** In `auto` mode, if a request uses features only the official API supports (e.g., `json_schema` strict mode, built-in tools, `seed`), route to DashScope. If DashScope is unavailable, either degrade gracefully or return a clear error.

4. **Model name mapping:** Maintain a bidirectional mapping between web client model names and official Model Studio names. When routing to DashScope, translate model names automatically.

5. **Usage normalization:** Both providers produce usage in the same normalized format. DashScope provides exact token counts; web provider continues heuristic estimation.

6. **No regression:** The web provider continues to work exactly as it does today. The DashScope provider is purely additive.

### 5.4 DashScope Provider Implementation Outline

```typescript
// src/upstream/dashscope.ts

interface DashScopeConfig {
  apiKey: string;
  baseUrl: string;  // https://dashscope.aliyuncs.com/compatible-mode/v1
}

class DashScopeProvider implements UpstreamProvider {
  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    // Direct HTTPS POST to DashScope OpenAI-compatible endpoint
    // Forward all sampling params, tools, response_format natively
    // Return normalized response
  }

  async streamChatCompletion(params: ChatCompletionParams): Promise<AsyncIterable<SSEChunk>> {
    // SSE streaming from DashScope
    // Yield normalized chunks
  }

  async responses(params: ResponsesParams): Promise<ResponsesResult> {
    // Forward to DashScope Responses endpoint
    // Native built-in tools (web_search, code_interpreter, web_extractor)
    // previous_response_id support
  }
}
```

### 5.5 Benefits

| Benefit | Description |
|---------|-------------|
| Full parameter fidelity | All OpenAI-compatible params forwarded natively |
| Native tool calling | No XML parsing fragility |
| Guaranteed structured output | Constrained decoding for JSON schema |
| Built-in tools | Web search, code interpreter, web extractor |
| Accurate token counts | Official tokenizer |
| Model name parity | Official Model Studio names |
| Previous response chaining | Server-managed history via Responses API |
| Free fallback | Web provider for cost-sensitive usage |
| No breaking changes | Existing web behavior preserved |

### 5.6 Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| DashScope API key cost | `auto` mode only uses it when key is present; web remains default |
| DashScope rate limits | Reuse existing retry coordinator and rate limiter |
| Model availability differences | Maintain capability matrix per model per provider |
| Response format differences | Normalization layer ensures identical output schema |
| Two codepaths to maintain | Common interface minimizes divergence |

---

## 6. Prioritized Implementation Roadmap

### P0: Official DashScope Provider (Week 1-2)

**Goal:** Route requests to official API when `DASHSCOPE_API_KEY` is set.

- [ ] Define `UpstreamProvider` interface (`src/upstream/types.ts`)
- [ ] Implement `DashScopeProvider` (`src/upstream/dashscope.ts`)
  - [ ] Chat Completions (streaming + non-streaming)
  - [ ] Full sampling parameter forwarding
  - [ ] Native `tools` / `tool_choice` / `parallel_tool_calls`
  - [ ] `response_format` with `json_schema` (constrained decoding)
  - [ ] Usage passthrough (exact token counts)
- [ ] Implement upstream router (`src/upstream/router.ts`)
- [ ] Add `DASHSCOPE_API_KEY` and `QWENPROXY_UPSTREAM` to config (`src/core/config.ts`)
- [ ] Update `.env.example`
- [ ] Model name mapping table (web ↔ official)
- [ ] Integration tests against DashScope sandbox

### P1: Parameter Forwarding in Web Provider (Week 2-3)

**Goal:** Forward sampling parameters to the web client API where possible.

- [ ] Investigate whether `chat.qwen.ai/api/v2/chat/completions` accepts sampling parameters (probe with live benchmarks)
- [ ] If accepted: add fields to `QwenPayload`, forward from route
- [ ] If not accepted: document limitation, return 400 with clear message in strict mode
- [ ] Add `temperature`, `top_p`, `max_tokens`, `seed`, `stop`, `frequency_penalty`, `presence_penalty`, `n` to `ChatBodySchema`
- [ ] Forward accepted params through generation state machine

### P2: Tool Call Parity (Week 3-4)

**Goal:** Improve XML tool calling reliability and add native tool_choice semantics.

- [ ] Harden XML parser (`src/tools/parser.ts`) against malformed output
- [ ] Implement `tool_choice: "required"` enforcement (retry with stronger prompt if model doesn't call tools)
- [ ] Implement `tool_choice: { type: "function", function: { name } }` targeting
- [ ] Add `parallel_tool_calls: false` enforcement (reject parallel XML blocks)
- [ ] Add `tool_call_id` generation and correlation
- [ ] When DashScope provider is active, use native tool calling instead

### P3: Structured Output Validation (Week 4-5)

**Goal:** Guarantee schema compliance for `json_schema` responses.

- [ ] Add post-generation JSON schema validation (e.g., Ajv)
- [ ] On validation failure: retry with error feedback (up to 2 retries)
- [ ] When DashScope provider is active, use native constrained decoding
- [ ] Add `response_format: { type: "json_object" }` basic support

### P4: Built-in Tool Support (Week 5-6)

**Goal:** Enable web search, code interpreter via DashScope provider.

- [ ] DashScope provider: forward `web_search` tool natively
- [ ] DashScope provider: forward `code_interpreter` tool natively
- [ ] DashScope provider: forward `web_extractor` tool natively
- [ ] Web provider: return clear 501 for built-in tools (instead of silent drop)
- [ ] Remove or make configurable `QWEN_SAFE_SETTINGS_PATCH` tool disabling

### P5: Token & Context Improvements (Week 6-7)

**Goal:** Improve token counting accuracy and context management.

- [ ] Integrate official Qwen tokenizer (if available as npm package or WASM)
- [ ] Calibrate heuristic estimator against tokenizer for common languages
- [ ] Add `system_fingerprint` to responses
- [ ] Add `completion_tokens_details.accepted_prediction_tokens`
- [ ] Document context management differences (tiered vs server-managed)

### P6: Model Catalog Alignment (Week 7)

**Goal:** Align model naming with official Model Studio.

- [ ] Add official Model Studio names to `/v1/models` alongside web names
- [ ] Maintain alias mapping for backward compatibility
- [ ] Document model name differences
- [ ] Add capability metadata (context window, modalities, tool support)

---

## 7. Summary of Gaps by Severity

| Severity | Gap | Count |
|----------|-----|-------|
| Critical | Sampling params not forwarded | 1 |
| High | Tool calling via prompt injection | 1 |
| High | Structured outputs prompt-only | 1 |
| High | Built-in tools hard-disabled | 1 |
| Medium | Heuristic token estimation | 1 |
| Medium | Client-side context management | 1 |
| Medium | Model catalog mismatch | 1 |
| Low | Missing response fields | 1 |
| **Total** | | **8** |

---

## 8. Conclusion

QwenProxy has built exceptional infrastructure around multi-account management, resilience, and API compatibility — areas where it arguably *exceeds* what the official API offers. However, its fundamental limitation as a web-client automation means it cannot natively support sampling parameters, native function calling, constrained decoding, or built-in tools.

The **hybrid upstream architecture** is the optimal path forward: it preserves QwenProxy's unique value (free web-client access, multi-account rotation, enterprise resilience) while adding a full-fidelity official API path for users who have a DashScope API key. The `auto` mode provides a seamless experience — official API when available, web fallback when not.

The estimated total effort is **5-7 weeks** for full implementation across all priorities, with P0 (DashScope provider) delivering the largest parity improvement in the shortest time.
