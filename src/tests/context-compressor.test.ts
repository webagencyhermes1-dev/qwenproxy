import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compressContextForFailover,
  parseExchanges,
  tokenize,
} from "../services/context-compressor.ts";

function buildConversation(exchangeCount: number, charsPerExchange = 2000): string {
  const parts: string[] = [];
  parts.push("System: You are a helpful coding assistant.\n\n");
  for (let i = 0; i < exchangeCount; i++) {
    const filler = `x`.repeat(charsPerExchange);
    parts.push(`User: Question about topic ${i}. ${filler}\n\n`);
    parts.push(`Assistant: Answer about topic ${i}. ${filler}\n\n`);
  }
  return parts.join("");
}

function buildConversationWithToolCalls(exchangeCount: number): string {
  const parts: string[] = [];
  parts.push("System: You are a helpful coding assistant.\n\n");
  for (let i = 0; i < exchangeCount; i++) {
    parts.push(`User: Fix the bug in module ${i}.\n\n`);
    parts.push(
      `Assistant: I'll fix it.\n<tool_call>{"name":"read_file","arguments":{"path":"src/module${i}.ts"}}</tool_call>\n\n`,
    );
    parts.push(`Tool (read_file): file contents for module ${i}\n\n`);
  }
  return parts.join("");
}

test("compressor: passthrough when below threshold", () => {
  const prompt = buildConversation(5, 100);
  const result = compressContextForFailover(prompt, "latest question", {
    threshold: 200_000,
    budget: 200_000,
  });
  assert.equal(result.wasCompressed, false);
  assert.equal(result.prompt, prompt);
});

test("compressor: compresses large conversation below budget", () => {
  const prompt = buildConversation(200, 2000);
  assert.ok(prompt.length > 500_000);

  const result = compressContextForFailover(prompt, "topic 199", {
    threshold: 50_000,
    budget: 200_000,
    recentExchanges: 3,
    chunkSize: 500,
    maxChunks: 8,
  });

  assert.equal(result.wasCompressed, true);
  assert.ok(result.compressedChars <= 200_000, `compressed=${result.compressedChars}`);
  assert.ok(result.compressedChars < result.originalChars);
  assert.equal(result.exchangesTotal, 200);
  assert.equal(result.exchangesKeptVerbatim, 3);
});

test("compressor: preserves tool calls intact", () => {
  const prompt = buildConversationWithToolCalls(200);
  assert.ok(prompt.length > 20_000, `prompt length: ${prompt.length}`);

  const result = compressContextForFailover(prompt, "module 199", {
    threshold: 10_000,
    budget: 30_000,
    recentExchanges: 2,
    chunkSize: 500,
    maxChunks: 10,
  });

  assert.equal(result.wasCompressed, true);
  const openCount = (result.prompt.match(/<tool_call>/g) || []).length;
  const closeCount = (result.prompt.match(/<\/tool_call>/g) || []).length;
  assert.equal(openCount, closeCount, "tool call tags must be balanced");
});

test("compressor: keeps recent exchanges verbatim", () => {
  const prompt = buildConversation(20, 3000);
  const lastExchange = "User: Question about topic 19.";

  const result = compressContextForFailover(prompt, lastExchange, {
    threshold: 10_000,
    budget: 50_000,
    recentExchanges: 3,
    chunkSize: 500,
    maxChunks: 5,
  });

  assert.equal(result.wasCompressed, true);
  assert.ok(result.prompt.includes("Question about topic 19"));
  assert.ok(result.prompt.includes("Question about topic 18"));
  assert.ok(result.prompt.includes("Question about topic 17"));
});

test("compressor: BM25 retrieves relevant chunks", () => {
  const parts: string[] = ["System: assistant\n\n"];
  for (let i = 0; i < 30; i++) {
    parts.push(`User: Tell me about database optimization ${i}. ${"a".repeat(500)}\n\n`);
    parts.push(`Assistant: Here is info about database optimization ${i}. ${"b".repeat(500)}\n\n`);
  }
  parts.push(`User: What about caching strategies? ${"c".repeat(500)}\n\n`);
  parts.push(`Assistant: Caching is important. ${"d".repeat(500)}\n\n`);
  const prompt = parts.join("");

  const result = compressContextForFailover(prompt, "database optimization", {
    threshold: 10_000,
    budget: 30_000,
    recentExchanges: 1,
    chunkSize: 500,
    maxChunks: 5,
  });

  assert.equal(result.wasCompressed, true);
  assert.ok(result.chunksRetrieved > 0);
  assert.ok(result.prompt.includes("database optimization"));
});

test("compressor: handles empty prompt gracefully", () => {
  const result = compressContextForFailover("", "query", {
    threshold: 100,
    budget: 1000,
  });
  assert.equal(result.wasCompressed, false);
  assert.equal(result.prompt, "");
});

test("compressor: handles prompt with no exchanges", () => {
  const prompt = "Just some text without any role headers. ".repeat(100);
  const result = compressContextForFailover(prompt, "query", {
    threshold: 100,
    budget: 1000,
  });
  assert.equal(result.wasCompressed, false);
});

test("compressor: parseExchanges splits correctly", () => {
  const prompt =
    "System: hello\n\nUser: first question\n\nAssistant: first answer\n\nUser: second question\n\nAssistant: second answer\n\n";
  const { preamble, exchanges } = parseExchanges(prompt);
  assert.equal(preamble, "System: hello\n\n");
  assert.equal(exchanges.length, 2);
  assert.ok(exchanges[0].text.startsWith("User: first question"));
  assert.ok(exchanges[1].text.startsWith("User: second question"));
});

test("compressor: tokenize filters stop words and splits identifiers", () => {
  const tokens = tokenize("The quick brown fox jumps over my_variable_name");
  assert.ok(tokens.includes("quick"));
  assert.ok(tokens.includes("brown"));
  assert.ok(tokens.includes("fox"));
  assert.ok(tokens.includes("jumps"));
  assert.ok(tokens.includes("my_variable_name"));
  assert.ok(tokens.includes("variable"));
  assert.ok(tokens.includes("name"));
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("over"));
});

test("compressor: 500-message conversation compresses to under 200k", () => {
  const prompt = buildConversation(250, 4000);
  assert.ok(prompt.length > 1_000_000);

  const result = compressContextForFailover(prompt, "topic 249", {
    threshold: 50_000,
    budget: 200_000,
    recentExchanges: 3,
    chunkSize: 500,
    maxChunks: 8,
  });

  assert.equal(result.wasCompressed, true);
  assert.ok(
    result.compressedChars <= 200_000,
    `Expected <=200k but got ${result.compressedChars}`,
  );
});
