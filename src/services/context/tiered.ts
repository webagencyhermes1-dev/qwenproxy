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
 *   If even T0+T3+newest pair exceeds budget, T3 is truncated; if still over,
 *   an error is thrown (caller must return an error, never the full context).
 */

import type { Message } from "../../utils/types.ts";
import type { FunctionToolDefinition } from "../../tools/types.ts";
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
      .join(" ");
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

  const total = totalOf(t1, t2, curT3);
  if (total > budget) {
    throw new Error(
      `Compressed context still exceeds budget (${total} > ${budget}); refusing to send full context`,
    );
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
