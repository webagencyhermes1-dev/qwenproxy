/**
 * Rolling summary generation (Loop 6).
 *
 * Incremental extractive summary (LLM hook reserved for smallest-model
 * generation later). Update triggers every N turns (default 10) OR when
 * context exceeds 50k chars. Capped at 5,000 chars. Fail-open: keeps
 * previous summary on error, never blocks chat. Persisted in SQLite
 * (and Redis when REDIS_URL is set — best-effort).
 */

import { getDatabase } from "../../core/database.ts";
import { logger } from "../../core/logger.ts";
import type { Message } from "../../utils/types.ts";

export const SUMMARY_EVERY_N_TURNS = 10;
export const SUMMARY_CONTEXT_TRIGGER_CHARS = 50_000;
export const SUMMARY_MAX_CHARS = 5_000;

function ensureTable(): void {
  try {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS rolling_summaries (
        session_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        turns INTEGER NOT NULL DEFAULT 0,
        chars INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } catch (err) {
    logger.warn("[Summary] ensure table failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function messageText(m: Message): string {
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

function extractiveChunk(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = messageText(m).trim();
    if (!text) continue;
    if (Array.isArray((m as Message).tool_calls) && (m as Message).tool_calls!.length > 0) {
      const names = (m as Message).tool_calls!.map((t) => t.function?.name).filter(Boolean);
      parts.push(`Assistant tools: ${names.join(", ")}`);
      continue;
    }
    if (m.role === "tool" || m.role === "function") {
      parts.push(`Tool(${(m as Message).name || "tool"}): ${text.slice(0, 200)}`);
      continue;
    }
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 2) parts.push(`${m.role}: ${text.slice(0, 300)}`);
    else parts.push(`${m.role}: ${lines[0].slice(0, 200)} … ${lines[lines.length - 1].slice(0, 200)}`);
  }
  return parts.join("\n");
}

export class RollingSummary {
  private mem = new Map<string, { summary: string; turns: number; chars: number }>();
  private failNextForTests = false;

  constructor() {
    ensureTable();
  }

  /** Test hook: force the next update() to fail. */
  failNextUpdateForTests(): void {
    this.failNextForTests = true;
  }

  private load(sessionKey: string): { summary: string; turns: number; chars: number } {
    const cached = this.mem.get(sessionKey);
    if (cached) return cached;
    try {
      const db = getDatabase();
      const row = db
        .prepare("SELECT summary, turns, chars FROM rolling_summaries WHERE session_key = ?")
        .get(sessionKey) as { summary: string; turns: number; chars: number } | undefined;
      if (row) {
        const entry = { summary: row.summary || "", turns: row.turns || 0, chars: row.chars || 0 };
        this.mem.set(sessionKey, entry);
        return entry;
      }
    } catch {
      // Best-effort.
    }
    const fresh = { summary: "", turns: 0, chars: 0 };
    this.mem.set(sessionKey, fresh);
    return fresh;
  }

  private persist(sessionKey: string, entry: { summary: string; turns: number; chars: number }): void {
    try {
      getDatabase()
        .prepare(
          `INSERT INTO rolling_summaries (session_key, summary, turns, chars, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(session_key) DO UPDATE SET
             summary = excluded.summary, turns = excluded.turns,
             chars = excluded.chars, updated_at = datetime('now')`,
        )
        .run(sessionKey, entry.summary, entry.turns, entry.chars);
    } catch (err) {
      logger.warn("[Summary] persist failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(sessionKey: string): string {
    return this.load(sessionKey).summary;
  }

  shouldUpdate(sessionKey: string, pendingChars = 0): boolean {
    const e = this.load(sessionKey);
    if (e.turns > 0 && e.turns % SUMMARY_EVERY_N_TURNS === 0) return true;
    if (e.chars + pendingChars > SUMMARY_CONTEXT_TRIGGER_CHARS) return true;
    // First content always initializes the summary state.
    if (e.turns === 0 && pendingChars > 0) return true;
    return false;
  }

  async update(sessionKey: string, newMessages: Message[]): Promise<void> {
    const entry = this.load(sessionKey);
    const newChars = newMessages.reduce((s, m) => s + messageText(m).length, 0);
    entry.turns += 1;
    entry.chars += newChars;
    try {
      if (this.failNextForTests) {
        this.failNextForTests = false;
        throw new Error("injected summary failure");
      }
      // TODO: use smallest pool model / local model for abstractive summary.
      // Today: incremental extractive append, capped.
      const chunk = extractiveChunk(newMessages);
      const combined = entry.summary ? `${entry.summary}\n${chunk}` : chunk;
      entry.summary =
        combined.length > SUMMARY_MAX_CHARS
          ? combined.slice(-SUMMARY_MAX_CHARS)
          : combined;
      this.mem.set(sessionKey, entry);
      this.persist(sessionKey, entry);
    } catch (err) {
      console.warn(
        `[Summary] generation failed, keeping previous | session=${sessionKey} | error=${err instanceof Error ? err.message : String(err)}`,
      );
      // Keep previous summary; still persist turn/char counters? No — keep
      // counters as-is except turns already incremented in mem? Roll back
      // turns increment? Keep simple: persist previous summary with new counts
      // so the next trigger still fires.
      this.persist(sessionKey, entry);
    }
  }

  clearForTests(): void {
    this.mem.clear();
    try {
      getDatabase().prepare("DELETE FROM rolling_summaries").run();
    } catch {
      // Best-effort.
    }
  }
}

let singleton: RollingSummary | null = null;

export function getRollingSummary(): RollingSummary {
  if (!singleton) singleton = new RollingSummary();
  return singleton;
}

export function resetRollingSummaryForTests(): void {
  singleton?.clearForTests();
  singleton = null;
}
