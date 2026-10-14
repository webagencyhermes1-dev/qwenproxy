#!/usr/bin/env tsx
/**
 * QwenProxy Daily Limit Stress Test
 *
 * Exhausts a single account's daily token limit for qwen3.8-max
 * by sending growing-context requests with large codebase-level prompts.
 *
 * Tracks tokens accurately using the proxy's estimateTokenCount + response usage.
 * Detects daily limit via `extra.update_member: true` in SSE stream.
 * Saves progress to JSON for resumability.
 */

import "dotenv/config";
import { spawn, ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { estimateTokenCount } from "../utils/context-truncation.ts";

interface ProgressData {
  accountEmail: string;
  accountId: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  messages: Array<{ role: string; content: string }>;
  startedAt: number;
  lastUpdatedAt: number;
  completed: boolean;
  limitHitAt?: number;
  limitHitResponse?: string;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      phase?: string;
      status?: string;
      extra?: { update_member?: boolean };
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  response_id?: string;
  chat_id?: string;
  error?: { code: string; message: string; details?: string };
}

interface ProxyConfig {
  url: string;
  apiKey?: string;
  model: string;
  maxRequests: number;
  progressFile: string;
  promptStrategy: "growing" | "fixed";
  initialPrompt: string;
  codebasePrompt: string;
}

const DEFAULT_CONFIG: ProxyConfig = {
  url: "http://127.0.0.1:7936",
  apiKey: process.env.API_KEY,
  model: "qwen3.8-max",
  maxRequests: 500,
  progressFile: "stress-test-progress.json",
  promptStrategy: "growing",
  initialPrompt: "Hello! Please analyze this codebase and provide a comprehensive overview.",
  codebasePrompt: `
You are a senior software architect. Analyze the following TypeScript codebase and provide:

1. **Architecture Overview**: High-level component diagram and data flow
2. **Key Design Patterns**: Identify patterns used (factory, observer, strategy, etc.)
3. **Critical Paths**: Request lifecycle from HTTP ingress to upstream Qwen API
4. **Concurrency Model**: How the proxy handles multiple simultaneous requests
5. **Error Handling & Retry Strategy**: Circuit breakers, fallbacks, account rotation
6. **Memory Management**: Browser context pooling, stream buffering, cleanup
7. **Security Considerations**: SSRF protection, credential handling, rate limiting
8. **Scalability Bottlenecks**: What would break at 10x/100x load
9. **Testing Strategy**: Unit, integration, stress test coverage gaps
10. **Improvement Recommendations**: Concrete, prioritized refactoring suggestions

CODEBASE:
`.trim(),
};

let proxyProcess: ChildProcess | null = null;
let config = { ...DEFAULT_CONFIG };
let progress: ProgressData;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProgress(): ProgressData | null {
  try {
    if (existsSync(config.progressFile)) {
      const data = JSON.parse(readFileSync(config.progressFile, "utf8"));
      console.log(`📂 Loaded progress: ${data.requestCount} requests, ${data.totalInputTokens} input / ${data.totalOutputTokens} output tokens`);
      return data;
    }
  } catch (e) {
    console.warn("⚠️  Could not load progress file:", e);
  }
  return null;
}

function saveProgress(): void {
  try {
    progress.lastUpdatedAt = Date.now();
    writeFileSync(config.progressFile, JSON.stringify(progress, null, 2));
  } catch (e) {
    console.error("❌ Failed to save progress:", e);
  }
}

async function startProxy(): Promise<void> {
  console.log("🚀 Starting QwenProxy server...");
  const isWindows = process.platform === "win32";
  proxyProcess = spawn(isWindows ? "npx.cmd" : "npx", ["tsx", "src/index.ts"], {
    cwd: "C:\\Users\\kshre\\QwenProxy",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
    shell: isWindows,
  });

  proxyProcess.stdout?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg.includes("Server listening") || msg.includes("listening on") || msg.includes("Ready")) {
      console.log(`📡 Proxy: ${msg}`);
    }
  });

  proxyProcess.stderr?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes("⚠️") && !msg.includes("ExperimentalWarning")) {
      console.error(`❌ Proxy stderr: ${msg}`);
    }
  });

  proxyProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`❌ Proxy exited with code ${code}`);
    }
  });

  // Wait for proxy to be ready
  for (let i = 0; i < 60; i++) {
    try {
      const resp = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        console.log("✅ Proxy is ready");
        return;
      }
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error("Proxy failed to start within 60 seconds");
}

async function stopProxy(): Promise<void> {
  if (proxyProcess) {
    console.log("🛑 Stopping proxy...");
    proxyProcess.kill("SIGTERM");
    await sleep(1000);
    if (!proxyProcess.killed) {
      proxyProcess.kill("SIGKILL");
    }
    proxyProcess = null;
  }
}

async function sendRequest(messages: Array<{ role: string; content: string }>): Promise<{
  inputTokens: number;
  outputTokens: number;
  content: string;
  reasoningContent: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  limitHit: boolean;
  limitResponse?: string;
  error?: string;
}> {
  const promptText = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  const estimatedInputTokens = estimateTokenCount(promptText);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };

  const body = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.3,
    max_tokens: 8192,
  };

  console.log(`\n📤 Request #${progress.requestCount + 1} | Est. input tokens: ${estimatedInputTokens} | Messages: ${messages.length}`);

  const response = await fetch(`${config.url}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000), // 5 min timeout
  });

  if (!response.ok) {
    const errText = await response.text();
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      content: "",
      reasoningContent: "",
      error: `HTTP ${response.status}: ${errText}`,
      limitHit: false,
    };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      content: "",
      reasoningContent: "",
      error: "No response body",
      limitHit: false,
    };
  }

  const decoder = new TextDecoder();
  let fullContent = "";
  let fullReasoning = "";
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined = undefined;
  let limitHit = false;
  let limitResponse = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf("\n");

      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf("\n");

        if (!line || !line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const chunk: StreamChunk = JSON.parse(dataStr);

          // Check for daily limit marker
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.extra?.update_member === true) {
            limitHit = true;
            limitResponse = delta.content || "Daily limit reached";
            console.log(`\n🛑 DAILY LIMIT HIT: ${limitResponse}`);
          }

          // Accumulate content
          if (delta?.content) {
            fullContent += delta.content;
          }
          if (delta?.reasoning_content) {
            fullReasoning += delta.reasoning_content;
          }

          // Capture usage
          if (chunk.usage && typeof chunk.usage.prompt_tokens === "number" && typeof chunk.usage.completion_tokens === "number") {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens + chunk.usage.completion_tokens),
            };
          }
        } catch {
          // Ignore parse errors for partial chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Use actual usage from response if available, otherwise estimate
  const actualOutputTokens = usage?.completion_tokens ?? estimateTokenCount(fullContent + fullReasoning);
  const actualInputTokens = usage?.prompt_tokens ?? estimatedInputTokens;

  return {
    inputTokens: actualInputTokens,
    outputTokens: actualOutputTokens,
    content: fullContent,
    reasoningContent: fullReasoning,
    usage,
    limitHit,
    limitResponse,
  };
}

function buildNextPrompt(): string {
  if (config.promptStrategy === "fixed") {
    return config.initialPrompt;
  }

  // Growing context: use codebase prompt + previous responses
  if (progress.messages.length === 0) {
    return config.codebasePrompt;
  }

  // Build a follow-up prompt that references previous analysis
  const followUps = [
    "Now dive deeper into the browser context management and stream multiplexing. How does the proxy handle concurrent streams on a single browser page?",
    "Explain the retry policy in detail. How does it decide between same-account retry vs account switch vs new chat?",
    "Analyze the token estimation and context compression pipeline. How accurate is estimateTokenCount vs actual usage?",
    "Detail the WAF/captcha handling flow. What happens when Baxia challenges an account mid-stream?",
    "Describe the session persistence and thread reuse mechanism. How does parent_id tracking work across account failovers?",
    "What are the exact conditions that trigger 'chat_in_progress' and how does the proxy settle it?",
    "How does the proxy handle tool calls? Explain the streaming tool parser and malformed tool retry logic.",
    "Analyze the account health tracking and pool readiness system. What metrics determine READY vs STANDBY?",
  ];

  const nextFollowUp = followUps[progress.requestCount % followUps.length];
  return `${config.codebasePrompt}\n\n---\n\nFOLLOW-UP (${progress.requestCount + 1}): ${nextFollowUp}`;
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  QwenProxy Daily Limit Stress Test");
  console.log("  Model: qwen3.8-max | Strategy: Growing Context");
  console.log("═══════════════════════════════════════════\n");

  // Load or initialize progress
  const saved = loadProgress();
  if (saved) {
    progress = saved;
    config.model = progress.model;
  } else {
    // Get account info from env
    const accounts = process.env.QWEN_ACCOUNTS?.split(";")[0]?.split(":") || [];
    const accountEmail = accounts[0] || "unknown";
    // Generate deterministic account ID (same logic as accounts.ts)
    const accountId = createHash("md5")
      .update(accountEmail)
      .digest("hex")
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

    progress = {
      accountEmail,
      accountId,
      model: config.model,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      requestCount: 0,
      messages: [],
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      completed: false,
    };
  }

  console.log(`Account: ${progress.accountEmail} (${progress.accountId.slice(0, 12)}...)`);
  console.log(`Model: ${progress.model}`);
  console.log(`Max requests: ${config.maxRequests}`);
  console.log(`Progress file: ${config.progressFile}`);
  console.log(`Prompt strategy: ${config.promptStrategy}\n`);

  if (progress.completed) {
    console.log("✅ Test already completed (daily limit hit)");
    printSummary();
    return;
  }

  // Start proxy
  await startProxy();

  try {
    // Main request loop
    while (progress.requestCount < config.maxRequests && !progress.completed) {
      const prompt = buildNextPrompt();

      // Add user message
      progress.messages.push({ role: "user", content: prompt });

      const result = await sendRequest(progress.messages);

      if (result.error) {
        console.error(`❌ Request failed: ${result.error}`);
        // Don't count failed requests toward token totals
        progress.messages.pop(); // Remove the failed user message
        await sleep(5000);
        continue;
      }

      // Add assistant response to conversation
      const assistantContent = result.content + (result.reasoningContent ? `\n\n[Reasoning]\n${result.reasoningContent}` : "");
      progress.messages.push({ role: "assistant", content: assistantContent });

      // Update totals
      progress.totalInputTokens += result.inputTokens;
      progress.totalOutputTokens += result.outputTokens;
      progress.requestCount++;

      console.log(`📥 Response | Input: ${result.inputTokens} | Output: ${result.outputTokens} | Total: ${result.inputTokens + result.outputTokens}`);
      console.log(`📊 Cumulative | Input: ${progress.totalInputTokens} | Output: ${progress.totalOutputTokens} | Total: ${progress.totalInputTokens + progress.totalOutputTokens} | Requests: ${progress.requestCount}`);

      if (result.limitHit) {
        progress.completed = true;
        progress.limitHitAt = Date.now();
        progress.limitHitResponse = result.limitResponse;
        console.log("\n🎯 DAILY LIMIT REACHED!");
        break;
      }

      saveProgress();

      // Small delay between requests to avoid overwhelming
      await sleep(1000);
    }

    if (progress.requestCount >= config.maxRequests) {
      console.log(`\n⚠️  Safety stop: reached max requests (${config.maxRequests})`);
    }

  } finally {
    await stopProxy();
    saveProgress();
    printSummary();
  }
}

function printSummary(): void {
  const elapsed = (Date.now() - progress.startedAt) / 1000;
  const mins = Math.floor(elapsed / 60);
  const secs = Math.floor(elapsed % 60);

  console.log("\n═══════════════════════════════════════════");
  console.log("  STRESS TEST SUMMARY");
  console.log("═══════════════════════════════════════════");
  console.log(`Account:       ${progress.accountEmail}`);
  console.log(`Model:         ${progress.model}`);
  console.log(`Requests:      ${progress.requestCount}`);
  console.log(`Total Input:   ${progress.totalInputTokens.toLocaleString()} tokens`);
  console.log(`Total Output:  ${progress.totalOutputTokens.toLocaleString()} tokens`);
  console.log(`Total Tokens:  ${(progress.totalInputTokens + progress.totalOutputTokens).toLocaleString()} tokens`);
  console.log(`Time Elapsed:  ${mins}m ${secs}s`);
  console.log(`Avg/Request:   ${Math.round((progress.totalInputTokens + progress.totalOutputTokens) / Math.max(1, progress.requestCount))} tokens`);

  if (progress.completed && progress.limitHitAt) {
    const limitElapsed = (progress.limitHitAt - progress.startedAt) / 1000;
    const lMins = Math.floor(limitElapsed / 60);
    const lSecs = Math.floor(limitElapsed % 60);
    console.log(`\n🛑 LIMIT HIT at ${lMins}m ${lSecs}s`);
    console.log(`   Response: ${progress.limitHitResponse?.slice(0, 200)}...`);
  }

  console.log("═══════════════════════════════════════════\n");
}

main().catch(async (err) => {
  console.error("❌ Fatal error:", err);
  if (proxyProcess) await stopProxy();
  saveProgress();
  process.exit(1);
});