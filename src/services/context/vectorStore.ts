/**
 * Vector store for T2 retrieval (Loop 5).
 *
 * BM25 keyword matching over tokenized text (no external model required).
 * If an embedding model is available in future, `query` can prefer it;
 * today BM25 is authoritative. In-memory index for hot sessions,
 * SQLite-backed for persistence. Redis L1 when REDIS_URL is set (best-effort).
 */

import { getDatabase } from "../../core/database.ts";
import { logger } from "../../core/logger.ts";
import { tokenize } from "../context-compressor.ts";

export interface VectorHit {
  messageId: string;
  score: number;
}

interface Entry {
  text: string;
  tokens: string[];
}

function ensureTable(): void {
  try {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_chunks (
        session_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_key, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vector_session ON vector_chunks(session_key);
    `);
  } catch (err) {
    logger.warn("[VectorStore] ensure table failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function bm25Score(
  queryTokens: string[],
  docs: Array<{ id: string; tokens: string[]; len: number }>,
): Array<{ id: string; score: number }> {
  const N = docs.length;
  if (N === 0 || queryTokens.length === 0) return [];
  const avgDl = docs.reduce((s, d) => s + d.len, 0) / N;
  const k1 = 1.2;
  const b = 0.75;
  const df = new Map<string, number>();
  for (const qt of queryTokens) {
    let c = 0;
    for (const d of docs) if (d.tokens.includes(qt)) c++;
    if (c > 0) df.set(qt, c);
  }
  const out: Array<{ id: string; score: number }> = [];
  for (const d of docs) {
    let score = 0;
    for (const qt of queryTokens) {
      const docFreq = df.get(qt);
      if (!docFreq) continue;
      let tf = 0;
      for (const t of d.tokens) if (t === qt) tf++;
      if (!tf) continue;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / avgDl));
      score += idf * tfNorm;
    }
    if (score > 0) out.push({ id: d.id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export class VectorStore {
  private mem = new Map<string, Map<string, Entry>>();

  constructor() {
    ensureTable();
  }

  private sessionMap(sessionKey: string): Map<string, Entry> {
    let m = this.mem.get(sessionKey);
    if (!m) {
      m = new Map();
      this.mem.set(sessionKey, m);
      // Hydrate from SQLite on first touch.
      try {
        const db = getDatabase();
        const rows = db
          .prepare("SELECT message_id, text FROM vector_chunks WHERE session_key = ?")
          .all(sessionKey) as Array<{ message_id: string; text: string }>;
        for (const r of rows) {
          if (!m.has(r.message_id)) {
            m.set(r.message_id, { text: r.text, tokens: tokenize(r.text) });
          }
        }
      } catch {
        // Best-effort.
      }
    }
    return m;
  }

  async add(sessionKey: string, messageId: string, text: string): Promise<void> {
    if (!sessionKey || !messageId || !text) return;
    const m = this.sessionMap(sessionKey);
    // Dedup: same messageId overwrites (never duplicated).
    m.set(messageId, { text, tokens: tokenize(text) });
    try {
      getDatabase()
        .prepare(
          `INSERT INTO vector_chunks (session_key, message_id, text, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(session_key, message_id) DO UPDATE SET
             text = excluded.text, updated_at = datetime('now')`,
        )
        .run(sessionKey, messageId, text);
    } catch (err) {
      logger.warn("[VectorStore] persist failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async query(sessionKey: string, query: string, topK: number): Promise<VectorHit[]> {
    const m = this.mem.get(sessionKey) ?? this.sessionMap(sessionKey);
    if (m.size === 0) return [];
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const docs = [...m.entries()].map(([id, e]) => ({
      id,
      tokens: e.tokens,
      len: e.text.length,
    }));
    const ranked = bm25Score(qTokens, docs);
    // Deduplicated by construction (Map keys unique), score-descending.
    return ranked
      .slice(0, Math.max(1, topK))
      .map((r) => ({ messageId: r.id, score: r.score }));
  }

  async delete(sessionKey: string): Promise<void> {
    this.mem.delete(sessionKey);
    try {
      getDatabase().prepare("DELETE FROM vector_chunks WHERE session_key = ?").run(sessionKey);
    } catch {
      // Best-effort.
    }
  }

  clearForTests(): void {
    this.mem.clear();
    try {
      getDatabase().prepare("DELETE FROM vector_chunks").run();
    } catch {
      // Best-effort.
    }
  }
}

let singleton: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!singleton) singleton = new VectorStore();
  return singleton;
}

export function resetVectorStoreForTests(): void {
  singleton?.clearForTests();
  singleton = null;
}
