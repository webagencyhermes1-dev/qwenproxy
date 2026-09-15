<p align="center">
  <img src="docs/banner.webp" alt="QwenProxy" width="100%">
</p>

# QwenProxy

High-performance **OpenAI & Anthropic compatible API gateway** for [Qwen](https://chat.qwen.ai) with multi-account rotation, intelligent failover, robust tool calling, Responses API with persistent memory, and a full TUI dashboard.

[![CI](https://github.com/gettyuser/qwen-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/gettyuser/qwen-proxy/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.13-green)](https://hono.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

## Features

- **OpenAI & Anthropic Compatible** — `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/messages` (Anthropic Messages API), `/v1/messages/count_tokens`, and **Responses API** `/v1/responses`
- **Responses API** — SSE with `sequence_number`, persistent memory via `previous_response_id` (SQLite), reasoning effort normalization, multimodal support, and real usage tracking
- **Thread-native** — Reuses upstream sessions via `parent_id` with context preservation between turns
- **Three chat modes** — `thread` (default, native chaining), `temp-thread` (ephemeral with continuous context), `temp` (stateless, new chat per request)
- **Ultra-light shared Chromium** — Single browser process with isolated `BrowserContext` per account (~200MB RAM total)
- **Full TUI Dashboard** — Interactive terminal UI (`qpx`) with real-time monitoring, chat, agent sync, storage diagnostics, account management, and logs
- **Smart updater** — `qpx update` auto-detects your package manager and updates
- **On-demand startup** — First account ready instantly; standby accounts initialize on demand
- **Resilient retries** — 502/503/504, network errors, anti-bot, quota, and `invalid_input` with chat recreation
- **Robust tool parser** — Fragmented streams, malformed JSON, fuzzy name matching, double-escaped JSON, and case-insensitive `<tool_call>` tags
- **Personalization sync** — System + tools synced via `/settings/personalization` with content-based cache
- **Encrypted passwords** — Account passwords stored encrypted at-rest in SQLite
- **Multimodal uploads** — Images, video, audio, and documents via Qwen OSS
- **Live model catalog** — Auto-synced from Qwen with `qwen3.x` family, synthetic `-fast`/`-thinking` variants, and capability registry
- **Native thinking** — Reasoning via `phase: thinking_summary` from upstream
- **Observability** — `/health`, `/metrics` (Prometheus), watchdog, and structured logs
- **Media generation** — `/v1/images/generations` and `/v1/videos/generations`
- **Docker support** — One-command deployment

## Quick Start

### Prerequisites

| Dependency | Min Version | Notes |
|-----------|------------|-------|
| Node.js | 22+ | Per `engines` in package.json |
| npm | 9+ | Bundled with Node |
| Playwright | - | `npx playwright install chromium` |

### Installation

```bash
# Global install (recommended)
npm install -g qwenproxy-cli

# Or run instantly
npx qwenproxy-cli

# Or clone and develop
git clone https://github.com/gettyuser/qwen-proxy.git
cd qwen-proxy
npm install
npm run tui  # Interactive TUI dashboard
```

### Configuration

Create a `.env` file (see `.env.example`):

```env
QWEN_ACCOUNTS=user1@example.com:pass1;user2@example.com:pass2
API_KEY=your-api-key
HOST=127.0.0.1
```

### Start

```bash
npm start  # Headless server
npm run tui  # Interactive TUI
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `qpx` | Open interactive TUI dashboard with built-in proxy |
| `qpx start` | Start HTTP/SSE server in headless mode |
| `qpx update` | Auto-update QwenProxy |
| `qpx login` | Add/authenticate new accounts |
| `qpx sync` | Sync clients (Claude Code, Codex, OpenCode, OMP) |
| `qpx clean` | Clean Chromium profile caches |
| `qpx clean:all` | Clean caches + remove orphaned browsers |
| `qpx purge` | Delete remote chat history |
| `qpx reset` | Reset cooldowns and rate limits |

## API Endpoints

### OpenAI Compatible

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (stream + non-stream) |
| `/v1/completions` | POST | Legacy completions (adapter over chat) |
| `/v1/chat/completions/stop` | POST | Abort generation |
| `/v1/models` | GET | List models |
| `/v1/models/:id` | GET | Get specific model |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/responses/:id` | GET | Get stored response |
| `/v1/responses/:id` | DELETE | Delete response |

### Anthropic Compatible

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API (stream, thinking, tools) |
| `/v1/messages/count_tokens` | POST | Token counting |

### Media Generation

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/images/generations` | POST | Image generation |
| `/v1/videos/generations` | POST | Video generation |
| `/v1/tasks/status/:taskId` | GET | Video task status |

### Utilities

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus metrics |
| `/v1/upload` | POST | Multimodal upload |

## Usage Examples

### OpenAI SDK (Node.js)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:7936/v1",
  apiKey: "your-api-key",
});

const completion = await client.chat.completions.create({
  model: "qwen3.7-plus",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(completion.choices[0].message.content);
```

### Anthropic SDK / Claude Code CLI

```bash
export ANTHROPIC_BASE_URL="http://localhost:7936"
export ANTHROPIC_API_KEY="your-api-key"
claude
```

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  baseURL: "http://localhost:7936",
  apiKey: "your-api-key",
});

const message = await anthropic.messages.create({
  model: "claude-3-7-sonnet-20250219",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### cURL

```bash
curl http://localhost:7936/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Environment Variables

### Network & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7936` | HTTP port |
| `HOST` | `0.0.0.0` | Bind host |
| `API_KEY` | empty | Protect `/v1/*` with Bearer token |

### Accounts & Session

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_ACCOUNTS` | empty | `email1:pass1;email2:pass2` |
| `QWEN_CHAT_MODE` | `thread` | `thread`, `temp-thread`, or `temp` |
| `DELETE_ALL_CHATS_ON_SHUTDOWN` | `false` | Clean chats on shutdown |

### Playwright

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYWRIGHT_HEADLESS` | `true` | Headless browser |
| `PLAYWRIGHT_BROWSER` | `chromium` | Browser type |
| `PLAYWRIGHT_MAX_ACTIVE_CONTEXTS` | `2` | Max active browser contexts |

### Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_TIMEOUT` | `10000` | Generic HTTP timeout |
| `CHAT_TIMEOUT` | `120000` | Chat timeout |
| `TOTAL_REQUEST_TIMEOUT` | `600000` | Max generation time |

### Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `warn` | Logger level |
| `METRICS_INTERVAL` | `10000` | Metrics interval |

## Testing

```bash
npm test           # Mock + live tests
npm run test:mock  # Mock suite (no real browser)
npm run test:live  # Stress/concurrency tests
npm run typecheck  # Type checking
```

## Docker

```yaml
services:
  qwenproxy:
    build: .
    container_name: qwenproxy
    ports:
      - "${PORT:-7936}:7936"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

## Project Structure

```
QwenProxy/
├── src/
│   ├── api/              # Hono server, models, errors
│   ├── core/             # Config, accounts, DB, metrics, model-registry
│   ├── routes/
│   │   ├── chat/         # Completions, streaming, retry-policy
│   │   └── responses/    # OpenAI Responses API
│   ├── services/
│   │   ├── playwright.ts # Browser + headers + cleanup
│   │   ├── qwen.ts       # Upstream Qwen + personalization
│   │   └── ...
│   ├── tools/            # Tool parser and instructions
│   ├── tui/              # Interactive terminal UI
│   └── utils/
├── data/                 # SQLite, keys, profiles (gitignored)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Credits

Built by **gettyuser**, based on original open-source work by **Pedro Farias** under the [ISC License](LICENSE).

## Disclaimer

**Software provided "as is" without warranty.** Not affiliated with Alibaba/Qwen, OpenAI, or Anthropic. Use at your own risk. You are responsible for compliance with upstream Terms of Service.

## License

[ISC](LICENSE)
