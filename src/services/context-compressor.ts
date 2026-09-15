/**
 * Tiered context compressor for account-failover replay.
 *
 * When the proxy must replay a conversation onto a NEW upstream account
 * (sticky-account failover, chat_in_progress escalation, forceNewChat),
 * the full prompt can exceed 2M chars for long coding-agent sessions.
 * This module compresses it to a configurable budget (default 200k chars)
 * using a 4-tier strategy:
 *
 *   T0 = System prompt + tool instructions (kept verbatim for KV-cache
 *        friendliness — the upstream model sees a stable prefix)
 *   T1 = Last N exchanges kept verbatim (default 3)
 *   T2 = BM25-retrieved relevant chunks from older history
 *   T3 = Extractive rolling summary of the remaining older history
 *
 * Invariants:
 * - Tool call blocks (<tool_call>…</tool_call>) are NEVER split or summarized.
 * - The output preserves the same serialization format the upstream
 *   Qwen renderer expects (User:/Assistant:/Tool headers).
 * - On any internal error the original prompt is returned unchanged
 *   (fail-open: compression must never break a request).
 */

import { config } from "../core/config.ts";
import { logger } from "../core/logger.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompressResult {
  prompt: string;
  originalChars: number;
  compressedChars: number;
  wasCompressed: boolean;
  tierSizes: { t0: number; t1: number; t2: number; t3: number };
  exchangesTotal: number;
  exchangesKeptVerbatim: number;
  chunksRetrieved: number;
  chunksSummarized: number;
}

interface ParsedExchange {
  /** Full serialized text of this exchange (may span multiple role headers). */
  text: string;
  /** True when the exchange contains at least one  block. */
  hasToolCall: boolean;
  /** Character offset of this exchange in the original prompt. */
  start: number;
  end: number;
}

interface Chunk {
  text: string;
  tokens: string[];
  exchangeIndex: number;
  hasToolCall: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/**
 * Role headers emitted by validation.ts buildPromptFromMessages.
 * We split on these boundaries to recover exchange structure.
 */
const ROLE_HEADER_RE = /^(?:User|Assistant|Tool(?:\s*\([^)]*\))?|System):\s/gm;

/**
 * Common English stop words filtered from BM25 tokenization.
 * Code identifiers (camelCase, snake_case) are preserved.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "and", "or",
  "but", "not", "no", "nor", "so", "if", "then", "than", "that", "this",
  "it", "its", "he", "she", "they", "we", "you", "i", "me", "my",
  "your", "his", "her", "our", "their", "what", "which", "who", "whom",
  "when", "where", "why", "how", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "only", "own", "same", "too",
  "very", "just", "about", "up", "out", "off", "over", "under", "again",
  "further", "once", "here", "there",
]);

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Split text into lowercase tokens for BM25.
 * Preserves code identifiers (splits camelCase/snake_case into sub-tokens)
 * and filters stop words + single-char noise.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split on non-alphanumeric (keeps _ and - for identifiers)
  const words = text.toLowerCase().split(/[^a-z0-9_\-]+/);
  for (const word of words) {
    if (word.length < 2) continue;
    if (STOP_WORDS.has(word)) continue;
    tokens.push(word);
    // Split snake_case and camelCase for better retrieval
    if (word.includes("_")) {
      for (const part of word.split("_")) {
        if (part.length >= 2 && !STOP_WORDS.has(part)) tokens.push(part);
      }
    }
  }
  return tokens;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Split the serialized prompt into exchanges.
 * An "exchange" starts at a User: header and includes the subsequent
 * Assistant/Tool responses until the next User: header.
 *
 * The preamble (system prompt + tool instructions before the first User:)
 * is returned separately as T0.
 */
export function parseExchanges(fullPrompt: string): {
  preamble: string;
  exchanges: ParsedExchange[];
} {
  const headers: Array<{ index: number; isUser: boolean }> = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  ROLE_HEADER_RE.lastIndex = 0;

  while ((match = ROLE_HEADER_RE.exec(fullPrompt)) !== null) {
    headers.push({
      index: match.index,
      isUser: match[0].startsWith("User"),
    });
  }

  // Find the first User: header — everything before it is preamble (T0)
  const firstUserIdx = headers.findIndex((h) => h.isUser);
  if (firstUserIdx === -1) {
    return { preamble: fullPrompt, exchanges: [] };
  }

  const preamble = fullPrompt.substring(0, headers[firstUserIdx].index);

  const exchanges: ParsedExchange[] = [];
  let exchangeStart = -1;

  for (let i = firstUserIdx; i < headers.length; i++) {
    const header = headers[i];

    if (header.isUser) {
      // Close previous exchange if open
      if (exchangeStart >= 0) {
        const end = header.index;
        const text = fullPrompt.substring(exchangeStart, end);
        exchanges.push({
          text,
          hasToolCall: text.includes(TOOL_CALL_OPEN),
          start: exchangeStart,
          end,
        });
      }
      exchangeStart = header.index;
    }
  }

  // Close final exchange
  if (exchangeStart >= 0) {
    const text = fullPrompt.substring(exchangeStart);
    exchanges.push({
      text,
      hasToolCall: text.includes(TOOL_CALL_OPEN),
      start: exchangeStart,
      end: fullPrompt.length,
    });
  }

  return { preamble, exchanges };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split older exchanges into fixed-size chunks for BM25 retrieval.
 * Exchanges containing tool calls are kept as whole chunks (never split)
 * to preserve tool call structure integrity.
 */
function chunkExchanges(
  exchanges: ParsedExchange[],
  chunkSize: number,
  offset: number,
): Chunk[] {
  const chunks: Chunk[] = [];

  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i];

    if (ex.hasToolCall || ex.text.length <= chunkSize) {
      // Keep whole — tool calls must never be split
      chunks.push({
        text: ex.text,
        tokens: tokenize(ex.text),
        exchangeIndex: offset + i,
        hasToolCall: ex.hasToolCall,
      });
    } else {
      // Split large non-tool exchanges at paragraph boundaries
      let start = 0;
      while (start < ex.text.length) {
        let end = Math.min(start + chunkSize, ex.text.length);

        // Try to break at a newline near the boundary
        if (end < ex.text.length) {
          const nlIdx = ex.text.lastIndexOf("\n", end);
          if (nlIdx > start + chunkSize * 0.5) {
            end = nlIdx + 1;
          }
        }

        const slice = ex.text.substring(start, end);
        chunks.push({
          text: slice,
          tokens: tokenize(slice),
          exchangeIndex: offset + i,
          hasToolCall: false,
        });
        start = end;
      }
    }
  }

  return chunks;
}

// ─── BM25 Retrieval ───────────────────────────────────────────────────────────

/**
 * Score chunks against a query using Okapi BM25.
 * k1 = 1.2, b = 0.75 (standard defaults).
 */
function bm25Rank(
  queryTokens: string[],
  chunks: Chunk[],
  maxResults: number,
): Chunk[] {
  if (chunks.length === 0 || queryTokens.length === 0) return [];

  const N = chunks.length;
  const avgDl = chunks.reduce((s, c) => s + c.text.length, 0) / N;
  const k1 = 1.2;
  const b = 0.75;

  // Document frequency for each query term
  const df = new Map<string, number>();
  for (const qt of queryTokens) {
    let count = 0;
    for (const chunk of chunks) {
      if (chunk.tokens.includes(qt)) count++;
    }
    if (count > 0) df.set(qt, count);
  }

  const scored: Array<{ chunk: Chunk; score: number }> = [];

  for (const chunk of chunks) {
    let score = 0;
    const dl = chunk.text.length;

    for (const qt of queryTokens) {
      const docFreq = df.get(qt);
      if (!docFreq) continue;

      // Term frequency in this chunk
      let tf = 0;
      for (const t of chunk.tokens) {
        if (t === qt) tf++;
      }
      if (tf === 0) continue;

      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgDl));
      score += idf * tfNorm;
    }

    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.chunk);
}

// ─── Extractive Summary (T3) ──────────────────────────────────────────────────

/**
 * Build a rolling extractive summary of older exchanges.
 * Keeps the first and last meaningful lines of each exchange,
 * preserving tool call names as compact markers.
 */
function buildSummary(
  exchanges: ParsedExchange[],
  budget: number,
): string {
  const parts: string[] = [];
  let used = 0;

  for (const ex of exchanges) {
    if (used >= budget) break;

    let summary: string;

    if (ex.hasToolCall) {
      // Extract tool names for a compact representation
      const toolNames: string[] = [];
      const toolRe = /<tool_call>\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = toolRe.exec(ex.text)) !== null) {
        if (!toolNames.includes(m[1])) toolNames.push(m[1]);
      }
      const firstLine = ex.text.split("\n")[0] || "";
      summary = toolNames.length > 0
        ? `${firstLine}\n  [tools: ${toolNames.join(", ")}]`
        : firstLine;
    } else {
      const lines = ex.text.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length <= 3) {
        summary = ex.text;
      } else {
        summary = `${lines[0]}\n  [… ${lines.length - 2} lines …]\n${lines[lines.length - 1]}`;
      }
    }

    const remaining = budget - used;
    if (summary.length > remaining) {
      if (remaining > 100) {
        parts.push(summary.substring(0, remaining - 3) + "…");
        used = budget;
      }
      break;
    }

    parts.push(summary);
    used += summary.length + 2;
  }

  return parts.join("\n\n");
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Compress a full-conversation prompt for failover replay.
 *
 * Returns the original prompt unchanged when:
 * - It is below the compression threshold
 * - Compression is disabled in config
 * - Any internal error occurs (fail-open)
 *
 * @param fullPrompt  The full serialized conversation (2M+ on large sessions)
 * @param query       The current user prompt (used as BM25 query for T2)
 * @param options     Override config defaults (for testing)
 */
export function compressContextForFailover(
  fullPrompt: string,
  query: string,
  options?: {
    enabled?: boolean;
    threshold?: number;
    budget?: number;
    recentExchanges?: number;
    chunkSize?: number;
    maxChunks?: number;
    summaryBudget?: number;
  },
): CompressResult {
  const originalChars = fullPrompt.length;
  const noop: CompressResult = {
    prompt: fullPrompt,
    originalChars,
    compressedChars: originalChars,
    wasCompressed: false,
    tierSizes: { t0: 0, t1: 0, t2: 0, t3: 0 },
    exchangesTotal: 0,
    exchangesKeptVerbatim: 0,
    chunksRetrieved: 0,
    chunksSummarized: 0,
  };

  try {
    const enabled = options?.enabled ?? config.contextCompression.enabled;
    if (!enabled) {
      return noop;
    }
    const threshold = options?.threshold ?? config.contextCompression.threshold;
    const budget = options?.budget ?? config.contextCompression.budget;
    const recentCount = options?.recentExchanges ?? config.contextCompression.recentExchanges;
    const chunkSize = options?.chunkSize ?? config.contextCompression.chunkSize;
    const maxChunks = options?.maxChunks ?? config.contextCompression.maxChunks;
    const summaryBudget = options?.summaryBudget ?? Math.floor(budget * 0.2);

    // Skip compression for small prompts
    if (originalChars <= threshold) {
      return noop;
    }

    const startedAt = Date.now();

    // ── Parse ──────────────────────────────────────────────────────────────
    const { preamble, exchanges } = parseExchanges(fullPrompt);

    if (exchanges.length === 0) {
      // No recognizable structure — cannot compress safely
      return noop;
    }

    // ── T0: Preamble (system prompt + tool instructions) ──────────────────
    const t0 = preamble;

    // ── T1: Recent exchanges (verbatim) ────────────────────────────────────
    const t1Count = Math.min(recentCount, exchanges.length);
    const t1Exchanges = exchanges.slice(-t1Count);
    const t1 = t1Exchanges.map((e) => e.text).join("");

    // ── Older exchanges (candidates for T2/T3) ────────────────────────────
    const olderExchanges = exchanges.slice(0, exchanges.length - t1Count);

    if (olderExchanges.length === 0) {
      // Everything fits in T1 — no compression needed
      return noop;
    }

    // ── T2: BM25 retrieval ────────────────────────────────────────────────
    const queryTokens = tokenize(query);
    const chunks = chunkExchanges(olderExchanges, chunkSize, 0);
    const retrieved = bm25Rank(queryTokens, chunks, maxChunks);

    // Sort retrieved chunks by original position for coherence
    retrieved.sort((a, b) => a.exchangeIndex - b.exchangeIndex);
    const t2 = retrieved.map((c) => c.text).join("\n\n");

    // ── T3: Summary of non-retrieved older exchanges ──────────────────────
    const retrievedExchangeIndices = new Set(retrieved.map((c) => c.exchangeIndex));
    const toSummarize = olderExchanges.filter(
      (_, i) => !retrievedExchangeIndices.has(i),
    );
    const t3 = buildSummary(toSummarize, summaryBudget);

    // ── Assemble ──────────────────────────────────────────────────────────
    const sections: string[] = [];
    if (t0) sections.push(t0);
    if (t3) {
      sections.push(
        "[Earlier conversation summary]\n" + t3,
      );
    }
    if (t2) {
      sections.push(
        "[Relevant context from earlier in the conversation]\n" + t2,
      );
    }
    if (t1) sections.push(t1);

    let result = sections.join("\n\n");

    // ── Budget enforcement ────────────────────────────────────────────────
    if (result.length > budget) {
      // Trim T3 first, then reduce T2 chunks
      const overBudget = result.length - budget;

      if (t3.length > 0 && t3.length >= overBudget) {
        // Remove T3 entirely
        result = result.replace("[Earlier conversation summary]\n" + t3, "");
      } else if (t3.length > 0) {
        // Truncate T3
        const trimmedT3 = t3.substring(0, Math.max(0, t3.length - overBudget));
        result = result.replace(t3, trimmedT3);
      } else {
        // Hard truncate as last resort (never cut T1)
        const t1Start = result.lastIndexOf(t1);
        if (t1Start > 0) {
          const preT1 = result.substring(0, t1Start);
          const allowedPre = Math.max(0, budget - t1.length);
          result = preT1.substring(0, allowedPre) + t1;
        } else {
          result = result.substring(0, budget);
        }
      }
    }

    const elapsed = Date.now() - startedAt;

    const compressedResult: CompressResult = {
      prompt: result,
      originalChars,
      compressedChars: result.length,
      wasCompressed: true,
      tierSizes: {
        t0: t0.length,
        t1: t1.length,
        t2: t2.length,
        t3: t3.length,
      },
      exchangesTotal: exchanges.length,
      exchangesKeptVerbatim: t1Count,
      chunksRetrieved: retrieved.length,
      chunksSummarized: toSummarize.length,
    };

    logger.debug("[context-compressor] compressed failover replay", {
      originalChars,
      compressedChars: result.length,
      ratio: ((result.length / originalChars) * 100).toFixed(1) + "%",
      exchanges: exchanges.length,
      recentKept: t1Count,
      chunksRetrieved: retrieved.length,
      elapsedMs: elapsed,
    });

    return compressedResult;
  } catch (error) {
    // Fail-open: never let compression break a request
    logger.warn("[context-compressor] compression failed, using original", {
      error: error instanceof Error ? error.message : String(error),
      originalChars,
    });
    return noop;
  }
}
