/**
 * Daily Limit Stress Test
 *
 * Sends growing-context requests to a single account via the proxy until the
 * daily model cap is hit (extra.update_member: true → model_daily_limit error
 * or the quota-limit message). Tracks cumulative input/output tokens.
 *
 * Usage: npx tsx src/benchmarks/stress-daily-limit.ts [--model qwen3.8-max] [--proxy http://127.0.0.1:7936]
 */

import crypto from "crypto";
import fs from "fs";

const PROXY_URL = process.argv.includes("--proxy")
  ? process.argv[process.argv.indexOf("--proxy") + 1]
  : "http://127.0.0.1:7936";

const MODEL = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "qwen3.8-max";

const MAX_REQUESTS = 500;
const RESULTS_FILE = "stress-test-results.json";

interface RequestResult {
  requestNumber: number;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  contentLength: number;
  reasoningLength: number;
  finishReason: string;
  sessionId: string;
  error?: string;
}

interface StressTestState {
  model: string;
  sessionId: string;
  startedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  requestCount: number;
  results: RequestResult[];
  status: "running" | "limit_hit" | "error" | "completed";
  limitDetectedAt?: string;
  limitMessage?: string;
}

function saveState(state: StressTestState): void {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(state, null, 2));
}

async function sendRequest(
  messages: Array<{ role: string; content: string }>,
  sessionId: string,
): Promise<{
  content: string;
  reasoning: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finishReason: string;
  durationMs: number;
  error?: string;
}> {
  const startedAt = Date.now();

  const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": sessionId,
      "x-qwenproxy-chat-mode": "thread",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    const errorText = await response.text();
    return {
      content: "",
      reasoning: "",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      finishReason: "error",
      durationMs,
      error: `HTTP ${response.status}: ${errorText.substring(0, 500)}`,
    };
  }

  const data = await response.json() as any;

  if (data.error) {
    return {
      content: "",
      reasoning: "",
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      finishReason: "error",
      durationMs,
      error: data.error.message || JSON.stringify(data.error).substring(0, 500),
    };
  }

  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";

  return {
    content,
    reasoning,
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    finishReason: choice?.finish_reason || "unknown",
    durationMs,
  };
}

function isDailyLimitHit(content: string, error?: string): { hit: boolean; message: string } {
  const combined = (content + " " + (error || "")).toLowerCase();

  const limitPatterns = [
    "you've reached today's limit",
    "you have reached today's limit",
    "reached today's limit",
    "daily limit",
    "daily usage limit",
    "usage limit reached",
    "limit for today",
    "allocated quota exceeded",
    "quota exceeded",
    "model_daily_limit",
    "update_member",
    "maximum usage",
    "max usage",
  ];

  for (const pattern of limitPatterns) {
    if (combined.includes(pattern)) {
      return { hit: true, message: content || error || pattern };
    }
  }

  return { hit: false, message: "" };
}

async function main(): Promise<void> {
  const sessionId = `stress-${crypto.randomUUID().substring(0, 8)}`;

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       Daily Limit Stress Test                       ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Proxy:     ${PROXY_URL}`);
  console.log(`  Model:     ${MODEL}`);
  console.log(`  Session:   ${sessionId}`);
  console.log(`  Mode:      thread (sticky to one account)`);
  console.log(`  Max reqs:  ${MAX_REQUESTS}`);
  console.log("");

  const state: StressTestState = {
    model: MODEL,
    sessionId,
    startedAt: new Date().toISOString(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    results: [],
    status: "running",
  };

  const messages: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Provide detailed, comprehensive answers. When asked to write code, write complete, working code with explanations.",
    },
  ];

  const prompts = [
    "Explain how garbage collection works in Java, C#, and Go. Compare their approaches.",
    "Write a complete implementation of a thread-safe LRU cache in TypeScript with TTL support.",
    "Explain the CAP theorem and how it applies to distributed databases like Cassandra, MongoDB, and CockroachDB.",
    "Write a complete REST API in Node.js with Express that handles user authentication with JWT, including middleware, routes, and error handling.",
    "Explain how the Linux kernel scheduler works, including CFS, real-time scheduling, and cgroups.",
    "Write a complete implementation of a lock-free concurrent queue in C++ using atomics.",
    "Explain the differences between SQL and NoSQL databases, including ACID vs BASE, and when to use each.",
    "Write a complete microservice in Go with gRPC, including protobuf definitions, server, client, and health checks.",
    "Explain how TLS 1.3 handshake works step by step, including key exchange and cipher suites.",
    "Write a complete implementation of a distributed consensus algorithm (Raft) in Python.",
  ];

  let promptIndex = 0;

  for (let i = 0; i < MAX_REQUESTS; i++) {
    const userPrompt = prompts[promptIndex % prompts.length];
    promptIndex++;

    messages.push({ role: "user", content: userPrompt });

    console.log(
      `\n📤 Request ${i + 1} | prompt: ${userPrompt.substring(0, 60)}...`,
    );
    console.log(
      `   Context: ${messages.length} messages | cumulative: ${state.totalInputTokens} in / ${state.totalOutputTokens} out`,
    );

    try {
      const result = await sendRequest(messages, sessionId);

      if (result.error) {
        const limitCheck = isDailyLimitHit("", result.error);
        if (limitCheck.hit) {
          console.log(`\n⚠️  DAILY LIMIT DETECTED (error): ${limitCheck.message}`);
          state.status = "limit_hit";
          state.limitDetectedAt = new Date().toISOString();
          state.limitMessage = limitCheck.message;
          state.requestCount = i + 1;
          await saveState(state);
          break;
        }

        console.log(`   ❌ Error: ${result.error.substring(0, 200)}`);

        if (
          result.error.includes("quota_limit") ||
          result.error.includes("high demand") ||
          result.error.includes("no_hot_account") ||
          result.error.includes("No warmed accounts")
        ) {
          console.log("   ⏳ Waiting 10s before retry...");
          await new Promise((r) => setTimeout(r, 10000));
          messages.pop();
          i--;
          continue;
        }

        if (result.error.includes("rate_limit") || result.error.includes("429")) {
          console.log("   ⏳ Rate limited. Waiting 30s...");
          await new Promise((r) => setTimeout(r, 30000));
          messages.pop();
          i--;
          continue;
        }

        state.status = "error";
        state.limitMessage = result.error;
        state.requestCount = i + 1;
        await saveState(state);
        break;
      }

      const limitCheck = isDailyLimitHit(result.content);
      if (limitCheck.hit) {
        console.log(`\n⚠️  DAILY LIMIT DETECTED: ${limitCheck.message.substring(0, 200)}`);
        state.status = "limit_hit";
        state.limitDetectedAt = new Date().toISOString();
        state.limitMessage = limitCheck.message;
        state.requestCount = i + 1;

        state.results.push({
          requestNumber: i + 1,
          timestamp: new Date().toISOString(),
          inputTokens: result.usage.prompt_tokens,
          outputTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens,
          durationMs: result.durationMs,
          contentLength: result.content.length,
          reasoningLength: result.reasoning.length,
          finishReason: result.finishReason,
          sessionId,
        });

        state.totalInputTokens += result.usage.prompt_tokens;
        state.totalOutputTokens += result.usage.completion_tokens;
        state.totalTokens += result.usage.total_tokens;

        await saveState(state);
        break;
      }

      state.totalInputTokens += result.usage.prompt_tokens;
      state.totalOutputTokens += result.usage.completion_tokens;
      state.totalTokens += result.usage.total_tokens;

      state.results.push({
        requestNumber: i + 1,
        timestamp: new Date().toISOString(),
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
        durationMs: result.durationMs,
        contentLength: result.content.length,
        reasoningLength: result.reasoning.length,
        finishReason: result.finishReason,
        sessionId,
      });

      console.log(
        `   ✅ ${result.durationMs}ms | in: ${result.usage.prompt_tokens} | out: ${result.usage.completion_tokens} | content: ${result.content.length} chars`,
      );
      console.log(
        `   📊 Cumulative: ${state.totalInputTokens} in / ${state.totalOutputTokens} out / ${state.totalTokens} total`,
      );

      messages.push({
        role: "assistant",
        content: result.reasoning
          ? `${result.reasoning}\n\n${result.content}`
          : result.content,
      });

      if (messages.length > 20) {
        const systemMsg = messages[0];
        const recent = messages.slice(-10);
        messages.length = 0;
        messages.push(systemMsg, ...recent);
        console.log("   ✂️  Trimmed context to last 10 messages");
      }

      state.requestCount = i + 1;
      await saveState(state);
    } catch (err: any) {
      console.log(`   ❌ Network error: ${err.message}`);
      const limitCheck = isDailyLimitHit("", err.message);
      if (limitCheck.hit) {
        state.status = "limit_hit";
        state.limitDetectedAt = new Date().toISOString();
        state.limitMessage = limitCheck.message;
        state.requestCount = i + 1;
        await saveState(state);
        break;
      }

      console.log("   ⏳ Waiting 5s before retry...");
      await new Promise((r) => setTimeout(r, 5000));
      messages.pop();
      i--;
    }
  }

  if (state.status === "running") {
    state.status = "completed";
  }

  await saveState(state);

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║              STRESS TEST RESULTS                    ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Status:          ${state.status}`);
  console.log(`  Model:           ${state.model}`);
  console.log(`  Requests:        ${state.requestCount}`);
  console.log(`  Total input:     ${state.totalInputTokens.toLocaleString()} tokens`);
  console.log(`  Total output:    ${state.totalOutputTokens.toLocaleString()} tokens`);
  console.log(`  Total tokens:    ${state.totalTokens.toLocaleString()} tokens`);
  console.log(`  Started:         ${state.startedAt}`);
  if (state.limitDetectedAt) {
    console.log(`  Limit hit at:    ${state.limitDetectedAt}`);
  }
  if (state.limitMessage) {
    console.log(`  Limit message:   ${state.limitMessage.substring(0, 200)}`);
  }
  console.log(`  Results saved:   ${RESULTS_FILE}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
