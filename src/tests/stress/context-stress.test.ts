/**
 * Appendix G scenario 3 — context stress.
 *
 * 100k / 200k / 500k / 1M / 2M character contexts plus Unicode, code, JSON,
 * URL-heavy, huge tool output and a giant tool schema. Asserts
 * oversized payload sent = 0 (an oversized context fails closed instead of
 * being sent) and unbounded compaction loop = 0 (bounded pass count).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FakeSink, FakeTime, StressCounters, flushEvents } from "./driver.ts";
import {
  type ScenarioResult,
  newScenarioRecorder,
  printStressSummary,
  registerScenarioResult,
} from "./summary.ts";
import type { Message } from "../../domain/session.ts";
import type { ToolCall, ToolDefinition } from "../../domain/tools.ts";
import type { JsonSchema } from "../../tools/types.ts";
import {
  CONTEXT_COMPACTION_MAX_PASSES,
  buildContextBudget,
} from "../../domain/context.ts";
import {
  type PrepareContextResult,
  prepareContext,
} from "../../runtime/context/context-service.ts";
import { createStream, createStreamRegistry } from "../../runtime/stream/stream-manager.ts";
import type { ModelCapabilitySource } from "../../runtime/context/context-service.ts";

export const SCENARIO_NAME = "context-stress";
export let STRESS_RESULT: ScenarioResult;

const counters = new StressCounters();
const recorder = newScenarioRecorder(SCENARIO_NAME, counters);

type ContentKind = "ascii" | "unicode" | "code" | "json" | "url" | "tool-output";
type SchemaKind = "none" | "moderate" | "giant";

interface ContextCase {
  name: string;
  chars: number;
  kind: ContentKind;
  schema?: SchemaKind;
  oversizedTurn?: boolean;
  pendingRounds?: boolean;
}

const CONTEXT_WINDOW_TOKENS = 8192;
const MAX_OUTPUT_TOKENS = 2048;
const EXCHANGES = 4;

const CASES: readonly ContextCase[] = [
  { name: "100k-ascii", chars: 100_000, kind: "ascii" },
  { name: "200k-unicode", chars: 200_000, kind: "unicode" },
  { name: "500k-code", chars: 500_000, kind: "code" },
  { name: "1m-json", chars: 1_000_000, kind: "json" },
  { name: "2m-url", chars: 2_000_000, kind: "url" },
  { name: "2m-tool-output", chars: 2_000_000, kind: "tool-output", schema: "moderate" },
  { name: "2m-oversized-turn", chars: 2_000_000, kind: "ascii", oversizedTurn: true },
  { name: "2m-non-convergent-pending", chars: 2_000_000, kind: "ascii", pendingRounds: true },
  { name: "giant-tool-schema", chars: 200_000, kind: "code", schema: "giant" },
];

const capabilities: ModelCapabilitySource = {
  getContextWindowTokens: () => CONTEXT_WINDOW_TOKENS,
  getMaxOutputTokens: () => MAX_OUTPUT_TOKENS,
};

function repeatTo(base: string, chars: number): string {
  if (base.length === 0) return "";
  const repeats = Math.ceil(chars / base.length);
  return base.repeat(repeats).slice(0, chars);
}

function buildContent(kind: ContentKind, chars: number): string {
  switch (kind) {
    case "ascii":
      return repeatTo("alpha bravo charlie delta echo foxtrot golf ", chars);
    case "unicode":
      return repeatTo("中文测试日本語テスト한국어ελληνικάрусскийعربي🎉🚀✅ ", chars);
    case "code":
      return repeatTo("function f(a, b) { return a + b; }\nconst x = [1, 2, 3];\n", chars);
    case "json":
      return repeatTo('{"key":"value","nested":{"a":1,"b":[2,3]}}', chars);
    case "url":
      return repeatTo("https://example.com/path/segment?q=1&v=2&x=abc ", chars);
    case "tool-output":
      return repeatTo("row{id=1,status=ok,payload=0xdeadbeef} ", chars);
    default:
      return repeatTo("x", chars);
  }
}

function buildSchema(kind: SchemaKind): ToolDefinition[] {
  if (kind === "none") return [];
  if (kind === "moderate") {
    const properties: Record<string, JsonSchema> = {};
    for (let i = 0; i < 24; i++) {
      properties[`param_${i}`] = {
        type: i % 2 === 0 ? "string" : "number",
        description: `parameter ${i} for the stress tool`,
      };
    }
    return [
      { name: "stress_tool", description: "moderate schema", parameters: { type: "object", properties, required: ["param_0"] } },
    ];
  }
  // giant: a wide, deep schema that alone reserves more tokens than the window
  const deep = (depth: number): JsonSchema => {
    const schema: JsonSchema = {
      type: "object",
      description: `giant schema level ${depth} with a very long description ` + "d".repeat(48),
      properties: {},
    };
    const properties = schema.properties as Record<string, JsonSchema>;
    for (let i = 0; i < 6; i++) {
      properties[`property_${depth}_${i}`] =
        depth > 0 ? deep(depth - 1) : { type: "string", description: "leaf".repeat(16) };
    }
    return schema;
  };
  return [
    {
      name: "giant_tool",
      description: "a deliberately oversized tool schema",
      parameters: deep(3),
    },
  ];
}

function makeMessage(
  sessionId: string,
  role: Message["role"],
  content: string,
  seq: number,
  createdAt: number,
  extra: Partial<Message> = {},
): Message {
  return {
    messageId: `msg-${seq}`,
    sessionId,
    role,
    content,
    sequenceNumber: seq,
    parentMessageId: null,
    branchId: "br-1",
    createdAt,
    ...extra,
  };
}

function buildMessages(caseSpec: ContextCase): Message[] {
  const sessionId = "sess-context";
  const messages: Message[] = [
    makeMessage(sessionId, "system", "You are a stress harness assistant.", 0, 0),
  ];
  let seq = 1;
  const perExchange = Math.floor(caseSpec.chars / EXCHANGES);
  for (let exchange = 0; exchange < EXCHANGES; exchange++) {
    const userMessageId = `msg-user-${exchange}`;
    const assistantMessageId = `msg-assistant-${exchange}`;
    messages.push(
      makeMessage(
        sessionId,
        "user",
        buildContent(caseSpec.kind, caseSpec.oversizedTurn ? 256 : perExchange),
        seq++,
        exchange * 10,
        { messageId: userMessageId },
      ),
    );
    const calls: ToolCall[] =
      caseSpec.kind === "tool-output"
        ? [
            {
              callId: `ctx-call-${exchange}`,
              name: "stress_tool",
              arguments: JSON.stringify({ exchange }),
              status: "completed",
            },
          ]
        : [];
    if (caseSpec.pendingRounds) {
      calls.push({
        callId: `ctx-call-${exchange}`,
        name: "stress_tool",
        arguments: JSON.stringify({ exchange }),
        status: "completed",
      });
    }
    messages.push(
      makeMessage(
        sessionId,
        "assistant",
        caseSpec.pendingRounds
          ? buildContent(caseSpec.kind, perExchange)
          : `assistant turn ${exchange}`,
        seq++,
        exchange * 10 + 1,
        { messageId: assistantMessageId, parentMessageId: userMessageId, toolCalls: calls },
      ),
    );
    if (caseSpec.kind === "tool-output" && calls.length > 0) {
      messages.push(
        makeMessage(
          sessionId,
          "tool",
          buildContent("tool-output", perExchange),
          seq++,
          exchange * 10 + 2,
          { parentMessageId: assistantMessageId, toolCallId: calls[0]!.callId },
        ),
      );
    }
  }
  // The current user turn is tier 1 and invariant: small unless intentionally oversized.
  messages.push(
    makeMessage(
      sessionId,
      "user",
      buildContent(caseSpec.kind, caseSpec.oversizedTurn ? caseSpec.chars : 512),
      seq++,
      EXCHANGES * 10,
    ),
  );
  return messages;
}

async function sendAndVerify(
  caseSpec: ContextCase,
  result: Extract<PrepareContextResult, { ok: true }>,
  usableInputTokens: number,
): Promise<void> {
  if (result.prepared.estimatedTokens > usableInputTokens) {
    counters.inc("oversizedPayloadSent");
    throw new Error(`${caseSpec.name}: prepared payload exceeds the usable budget`);
  }
  const time = new FakeTime();
  const registry = createStreamRegistry(64);
  const sink = new FakeSink();
  const stream = createStream({
    streamId: `ctx-send-${caseSpec.name}`,
    totalDeadline: time.now() + 10_000,
    firstTokenDeadlineMs: 5_000,
    idleTimeoutMs: 5_000,
    maxBufferBytes: Math.max(usableInputTokens * 8, 1024),
    sink,
    time,
    registry,
  });
  await stream.push(result.prepared.renderedPrompt);
  await stream.close("completed");
  await stream.terminal;
  await flushEvents(2);
  if (sink.bytes > Math.max(usableInputTokens * 8, 1024)) {
    counters.inc("oversizedPayloadSent");
    throw new Error(`${caseSpec.name}: sent payload exceeded the send cap`);
  }
  assert.equal(stream.pushedBytes, sink.bytes, "exactly the prepared payload was sent");
  assert.equal(registry.size(), 0, "the send stream was removed from the registry");
}

function runCase(caseSpec: ContextCase): Promise<void> {
  const toolDefinitions = buildSchema(caseSpec.schema ?? "none");
  const messages = buildMessages(caseSpec);
  const toolSchemaTokens =
    toolDefinitions.length > 0 ? JSON.stringify(toolDefinitions).length : 0;
  counters.setMetric(`case:${caseSpec.name}:input-chars`, messages.reduce((a, m) => a + m.content.length, 0));
  counters.setMetric(`case:${caseSpec.name}:schema-chars`, toolSchemaTokens);

  const budget = buildContextBudget({
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxThinkingTokens: 0,
    toolSchemaTokens: Math.ceil(toolSchemaTokens / 4),
    thinkingEnabled: false,
    toolsPresent: toolDefinitions.length > 0,
  });

  const result = prepareContext({
    messages,
    systemPrompt: "You are a stress harness assistant.",
    toolDefinitions,
    modelId: "stress-model",
    capabilities,
  });

  if (result.ok) {
    counters.setMetric(`case:${caseSpec.name}:passes`, result.prepared.compactionPasses);
    if (result.prepared.compactionPasses > CONTEXT_COMPACTION_MAX_PASSES) {
      counters.inc("unboundedCompactionLoop");
    }
    return sendAndVerify(caseSpec, result, budget.usableInputTokens);
  }
  counters.setMetric(`case:${caseSpec.name}:passes`, result.attempts.length);
  if (result.attempts.length > CONTEXT_COMPACTION_MAX_PASSES) {
    counters.inc("unboundedCompactionLoop");
    throw new Error(`${caseSpec.name}: compaction ran ${result.attempts.length} passes`);
  }
  assert.ok(
    result.errorCode === "CONTEXT_TOO_LARGE" || result.errorCode === "CONTEXT_COMPACTION_NON_CONVERGENT",
    `${caseSpec.name}: oversized context must fail closed (${result.errorCode})`,
  );
  counters.metric(`fail-closed:${result.errorCode}`);
  return Promise.resolve();
}

for (const caseSpec of CASES) {
  test(
    `context-stress: ${caseSpec.name}`,
    recorder.track(caseSpec.name, () => runCase(caseSpec)),
  );
}

test(
  "context-stress: deterministic content generators are byte-exact",
  recorder.track("content determinism", () => {
    const a = buildContent("unicode", 4096);
    const b = buildContent("unicode", 4096);
    assert.equal(a.length, 4096);
    assert.equal(a, b);
    assert.equal(buildContent("code", 100).length, 100);
  }),
);

test.after(() => {
  STRESS_RESULT = recorder.finalize();
  registerScenarioResult(STRESS_RESULT);
  printStressSummary();
});
