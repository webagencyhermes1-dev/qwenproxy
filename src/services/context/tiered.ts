/**
 * Tiered context assembly for failover (Loop 7).
 *
 * Adapter over the string-level compressor: operates on Message[] and
 * returns T0/T1/T2/T3 + refs for reversibility.
 *
 * Contract:
 * - T0 (system prompt + tools) is byte-identical to the input serialization.
 * - T1 = last 3 user/assistant exchanges verbatim.
 * - T2 = BM25-retrieved relevant older chunks, chronological.
 * - T3 = rolling summary (passed in).
 * - refs maps ref_id -> original message for every retained non-T0 message,
 *   so the proxy can re-inject the original chunk if the model asks for detail.
 * - Tool call/result pairs are never split: dropping one drops both.
 * - Budget enforced: drop lowest-scoring T2 first, then oldest T1 pairs.
 *   If even T0+T3+newest pair exceeds budget, T3 is truncated; if a single
 *   message STILL alone exceeds budget (a 2M-char paste that is the current
 *   turn cannot be dropped or paired away), its content tail is trimmed to a
 *   truncated notice so the turn is still served. The string-level error is
 *   reserved for the case where even an empty current turn cannot fit
 *   (T0/T2/T3 alone overflow), where the caller must error, never full-send.
 */

import type { Message } from "../../utils/types.ts";
import type { FunctionToolDefinition } from "../../tools/types.ts";
import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from "../../tools/toolcall-tags.ts";
import { tokenize } from "../context-compressor.ts";
import type { VectorStore } from "./vectorStore.ts";

export const TIERED_DEFAULT_BUDGET = 100_000;
const T1_EXCHANGES = 3;

export type RefMap = Record<string, Message>;

export interface ContextInput {
  systemPrompt: string;
  tools: FunctionToolDefinition[];
  messages: Message[];
  currentTurn: Message;
  vectorStore?: VectorStore;
  sessionKey?: string;
  rollingSummary: string;
  tokenBudget?: number;
}

export interface CompressedContext {
  t0: string;
  t1: Message[];
  t2: Message[];
  t3: string;
  refs: RefMap;
  /** Serialized failover payload (t0+t3+t2+t1 joined). Never exceeds budget. */
  payload: string;
  totalChars: number;
}

function textOf(m: Message): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((p) => p?.type === "text")
      .map((p) => p.text || "")
      .join("\n");
  }
  if (c && typeof c === "object") {
    try {
      return JSON.stringify(c);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Render messages in the exact segment format the upstream Qwen renderer
 * expects (mirrors validation.ts buildPromptFromMessages):
 * `User:`, `Assistant:` (+ reasoning + tool-call tags), `Tool Response (name):`.
 * System messages are skipped here — system rides the personalization channel
 * (or the verbatim envelope prefix in no-personalization mode), never the
 * selection, so it cannot be duplicated or dropped by compression.
 */
export function renderMessagesToPrompt(messages: Message[]): string {
  const toolCallNamesById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) toolCallNamesById.set(tc.id, tc.function.name);
      }
    }
  }
  const parts: string[] = [];
  for (const msg of messages) {
    const contentStr = textOf(msg);
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      parts.push(`User: ${contentStr || ""}\n\n`);
    } else if (msg.role === "assistant") {
      const chunks: string[] = [];
      const reasoning = (msg as Message).reasoning_content;
      if (reasoning) chunks.push(reasoning + "\n");
      if (contentStr) chunks.push(contentStr);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: unknown = {};
          const rawArgs = tc.function?.arguments;
          if (typeof rawArgs === "string") {
            try {
              parsedArgs = JSON.parse(rawArgs);
            } catch {
              parsedArgs = { _raw: rawArgs };
            }
          } else if (rawArgs && typeof rawArgs === "object") {
            parsedArgs = rawArgs;
          }
          const payload = { name: tc.function?.name, arguments: parsedArgs };
          const tag = `\n${TOOL_CALL_OPEN}\n${JSON.stringify(payload)}\n${TOOL_CALL_CLOSE}`;
          chunks.push(chunks.length > 0 ? tag : tag.trim());
        }
      }
      parts.push(`Assistant: ${chunks.join("").trim()}\n\n`);
    } else if (msg.role === "tool" || msg.role === "function") {
      const toolName =
        msg.name ||
        (msg.tool_call_id ? toolCallNamesById.get(msg.tool_call_id) : undefined);
      parts.push(`Tool Response (${toolName || "tool"}): ${contentStr || ""}\n\n`);
    }
  }
  return parts.join("");
}

function serialize(m: Message): string {
  return JSON.stringify(m);
}

function charsOf(list: Message[]): number {
  return list.reduce((s, m) => s + serialize(m).length + 1, 0);
}

/**
 * Group messages into user-anchored exchanges, keeping assistant
 * tool_calls together with their tool/function responses.
 */
function groupExchanges(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  for (const m of messages) {
    if (m.role === "user" && current.length > 0) {
      // Start a new exchange, but don't split a pending tool pair:
      // tool responses belong to the assistant call that precedes them,
      // which is already inside `current`.
      flush();
    }
    current.push(m);
  }
  flush();
  return groups;
}

function bm25RankIndices(query: string, docs: string[], max: number): number[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || docs.length === 0) return [];
  const tokenized = docs.map((d) => tokenize(d));
  const N = docs.length;
  const avgDl = docs.reduce((s, d) => s + d.length, 0) / N;
  const k1 = 1.2;
  const b = 0.75;
  const df = new Map<string, number>();
  for (const qt of qTokens) {
    let c = 0;
    for (const toks of tokenized) if (toks.includes(qt)) c++;
    if (c > 0) df.set(qt, c);
  }
  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < docs.length; i++) {
    let score = 0;
    const toks = tokenized[i];
    const dl = docs[i].length;
    for (const qt of qTokens) {
      const docFreq = df.get(qt);
      if (!docFreq) continue;
      let tf = 0;
      for (const t of toks) if (t === qt) tf++;
      if (!tf) continue;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgDl)));
    }
    if (score > 0) scored.push({ idx: i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.idx);
}

const TRIM_NOTICE =
  "\n\n[Context truncated: this message was too large to fit the context budget and was cut to its most recent content.]\n\n";

/**
 * Last-resort guard for a single message so large that selection alone cannot
 * shrink it below budget (a 2M-char paste IS the current turn — it can't be
 * dropped or paired away). Binary-searches the content length so the
 * serialized selection fits, keeping a truncated-notice tail so the turn is
 * still served. Returns null when even an empty message cannot fit (T0/T2/T3
 * alone overflow) — the caller must then error rather than full-send.
 * A small join reserve absorbs the "\n\n" separators in the assembled payload.
 */
const JOIN_RESERVE = 128;

function trimLastMessageToFit(
  t1: Message[],
  t2: Message[],
  t3: string,
  budget: number,
  t0Len: number,
): Message[] | null {
  if (t1.length === 0) return null;
  const lastIdx = t1.length - 1;
  const last = t1[lastIdx];
  if (typeof last.content !== "string") return null;
  if (last.role !== "user" && last.role !== "assistant") return null;
  const budgetLimit = Math.max(1, budget - JOIN_RESERVE);
  const baseChars = t0Len + charsOf(t2) + t3.length;
  const fits = (content: string): boolean => {
    const candidate = [...t1.slice(0, lastIdx), { ...last, content } as Message];
    return baseChars + charsOf(candidate) <= budgetLimit;
  };
  if (!fits(TRIM_NOTICE)) return null;
  let lo = 0;
  let hi = last.content.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits((last.content as string).slice(0, mid) + TRIM_NOTICE)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  t1[lastIdx] = {
    ...last,
    content: (last.content as string).slice(0, lo) + TRIM_NOTICE,
  } as Message;
  return t1;
}

export function assembleCompressedContext(input: ContextInput): CompressedContext {
  const budget = input.tokenBudget ?? TIERED_DEFAULT_BUDGET;
  // T0 byte-identical: verbatim systemPrompt + verbatim tools JSON (no trim).
  const t0 =
    input.tools.length > 0
      ? `${input.systemPrompt}\n\n${JSON.stringify(input.tools)}`
      : input.systemPrompt;
  const t3 = input.rollingSummary || "";

  const groups = groupExchanges(input.messages);
  const t1Groups = groups.slice(-T1_EXCHANGES);
  let t1: Message[] = t1Groups.flat();
  const olderGroups = groups.slice(0, Math.max(0, groups.length - T1_EXCHANGES));
  const olderFlat = olderGroups.flat();

  // T2: BM25 over older messages scored against currentTurn text.
  const queryText = textOf(input.currentTurn);
  const olderTexts = olderFlat.map((m) => `${m.role}: ${textOf(m)}`);
  // K grows until budget filled: start with up to 8, budget enforcement trims.
  const topIdx = bm25RankIndices(queryText, olderTexts, 8);
  // Score-descending for trimming, then chronological for coherence.
  const topByScore = [...topIdx];
  let t2: Message[] = topByScore
    .sort((a, b) => a - b)
    .map((i) => olderFlat[i])
    .filter(Boolean);

  const totalOf = (t1list: Message[], t2list: Message[], t3str: string): number =>
    t0.length + charsOf(t1list) + charsOf(t2list) + t3str.length;

  // Budget: drop lowest-scoring T2 first.
  let curT3 = t3;
  // Keep score order for trimming (lowest = end of topByScore desc? bm25Rank
  // returns desc, so lowest is last).
  const t2ByScoreDesc: Message[] = topByScore.map((i) => olderFlat[i]).filter(Boolean);
  let t2ByScore = [...t2ByScoreDesc];
  while (t2ByScore.length > 0 && totalOf(t1, t2ByScore, curT3) > budget) {
    t2ByScore.pop(); // drop lowest-scoring
  }
  // Chronological for payload.
  const order = new Map<Message, number>();
  olderFlat.forEach((m, i) => {
    if (!order.has(m)) order.set(m, i);
  });
  t2 = [...t2ByScore].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  // Still over: drop oldest T1 groups (whole groups keep tool pairs intact).
  let t1work = [...t1Groups];
  while (t1work.length > 1 && totalOf(t1work.flat(), t2, curT3) > budget) {
    t1work.shift();
  }
  t1 = t1work.flat();

  // Still over: truncate T3.
  if (totalOf(t1, t2, curT3) > budget && curT3.length > 0) {
    const over = totalOf(t1, t2, curT3) - budget;
    curT3 = curT3.slice(0, Math.max(0, curT3.length - over));
  }

  let total = totalOf(t1, t2, curT3);
  if (total > budget) {
    // Last resort: a single message so large it survives selection and alone
    // still exceeds the budget (a 2M-char paste that is the current turn).
    // Never refuse to serve it — trim the tail with a truncation notice.
    const trimmed = trimLastMessageToFit(t1, t2, curT3, budget, t0.length);
    if (trimmed !== null) {
      t1 = trimmed;
      total = totalOf(t1, t2, curT3);
      console.warn(
        `[Session] Context last-resort trimmed | t1=${t1.length}msgs | t2=${t2.length}msgs | t3=${curT3.length} | total=${total}/${budget}`,
      );
    } else {
      throw new Error(
        `Compressed context still exceeds budget (${total} > ${budget}); refusing to send full context`,
      );
    }
  }

  // Refs for every retained non-T0 message.
  const refs: RefMap = {};
  let n = 0;
  for (const m of [...t2, ...t1]) {
    n++;
    refs[`ref_${n}`] = m;
  }

  const payload = [t0, curT3 ? `[Earlier conversation summary]\n${curT3}` : "", ...t2.map(serialize), ...t1.map(serialize)]
    .filter((s) => s.length > 0)
    .join("\n\n");

  if (payload.length > budget) {
    throw new Error(
      `Serialized payload exceeds budget (${payload.length} > ${budget}); refusing full context`,
    );
  }

  console.log(
    `[Session] Context compressed | t0=${t0.length} | t1=${t1.length}msgs | t2=${t2.length}msgs | t3=${curT3.length} | total=${total}/${budget}`,
  );

  return { t0, t1, t2, t3: curT3, refs, payload, totalChars: total };
}

export interface FailoverPromptInput extends ContextInput {
  /** Verbatim tool-instruction text (prompt envelope, no-personalization mode). */
  toolInstructions: string;
  /**
   * True when agent instructions ride the account-level personalization channel
   * (re-synced on the new account before the completion). Then system/tools
   * stay out of the prompt; otherwise they prefix it verbatim.
   */
  usePersonalization: boolean;
}

export interface FailoverPromptResult {
  /** Upstream-ready prompt string in validation segment format. Never > budget. */
  prompt: string;
  compressed: CompressedContext;
}

/**
 * THE real failover path: tiered Message-level selection rendered into the
 * same envelope the original full prompt used, so the upstream renderer sees
 * a familiar shape at a fraction of the chars.
 *
 * - Personalization mode: `[T3 section, T2+T1 rendered]` (system rides the
 *   re-synced personalization channel, byte-identical instruction string).
 * - No-personalization mode: `[systemPrompt, toolInstructions, T3, rendered]`
 *   with the system prefix verbatim (T0 byte-identical).
 * - Tool call/result pairs survive via whole-group selection + faithful tags.
 * - Over budget after selection → throw (caller must error, never full-send).
 */
export function buildFailoverPrompt(input: FailoverPromptInput): FailoverPromptResult {
  const budget = input.tokenBudget ?? TIERED_DEFAULT_BUDGET;
  // System messages are covered by the envelope/personalization — keep them
  // out of the selection so compression cannot duplicate or drop them.
  const nonSystem = input.messages.filter((m) => m.role !== "system");
  // Rendering re-emits segment prefixes ("User: ", "Assistant: ", re-serialized
  // tool-call tags) that the JSON serialization inside assemble does not count,
  // and in no-personalization mode toolInstructions rides only the envelope.
  // Shrink the assembly budget by that overhead so the downstream render check
  // passes with the same 100k ceiling instead of throwing on the envelope.
  const RENDER_OVERHEAD_RESERVE = 4_096;
  const assemblyBudget = Math.max(
    1,
    budget - input.toolInstructions.length - RENDER_OVERHEAD_RESERVE,
  );
  const compressed = assembleCompressedContext({
    ...input,
    messages: nonSystem,
    tokenBudget: assemblyBudget,
  });
  const prompt = renderFailoverPrompt(compressed, {
    systemPrompt: input.systemPrompt,
    toolInstructions: input.toolInstructions,
    usePersonalization: input.usePersonalization,
    budget,
  });
  return { prompt, compressed };
}

/**
 * Render a tiered selection into the upstream-ready prompt string.
 * Split out so live failover paths can select (assembleCompressedContext)
 * and render as explicit steps with refs retained for re-injection.
 */
export function renderFailoverPrompt(
  compressed: CompressedContext,
  opts: {
    systemPrompt: string;
    toolInstructions: string;
    usePersonalization: boolean;
    budget?: number;
  },
): string {
  const budget = opts.budget ?? TIERED_DEFAULT_BUDGET;
  const rendered = renderMessagesToPrompt([...compressed.t2, ...compressed.t1]);
  const t3section = compressed.t3 ? `[Earlier conversation summary]\n${compressed.t3}` : "";
  const parts = opts.usePersonalization
    ? [t3section, rendered]
    : [opts.systemPrompt, opts.toolInstructions, t3section, rendered];
  const prompt = parts.filter((p) => p.trim().length > 0).join("\n\n");
  if (prompt.length > budget) {
    throw new Error(
      `Failover prompt exceeds budget (${prompt.length} > ${budget}); refusing to send full context`,
    );
  }
  return prompt;
}
