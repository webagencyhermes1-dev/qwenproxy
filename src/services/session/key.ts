/**
 * Deterministic sticky key generation (Loop 2).
 *
 * Priority:
 *  1. X-Session-Id header (covers Claude Code / Codex explicit sessions,
 *     also accepts x-session-id, session_id / conversation_id body fields
 *     via the caller's `explicitKey`).
 *  2. Per-request unique key (no stickiness; warns).
 *
 * Header keys are 16 lowercase hex chars, deterministic for the same input.
 * The fallback is never derived from prompt content: two clients with the
 * same (or empty) first message must not share a sticky namespace.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Message } from "../../utils/types.ts";

export type StickyKeySource = "header" | "ephemeral";

export interface StickyKeyRequest {
  sessionHeader?: string | null;
  explicitKey?: string | null;
  systemPrompt?: string;
  messages?: Message[];
}

function sha16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function extractFirstUserText(messages?: Message[]): string {
  if (!messages) return "";
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  const c = first.content;
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

export function generateStickyKey(req: StickyKeyRequest): string {
  const header = req.sessionHeader?.trim() || req.explicitKey?.trim();
  if (header) {
    const key = sha16(`header:${header}`);
    console.log(`[Session] Sticky key generated | key=${key} | source=header`);
    return key;
  }
  const key = `ephem:${randomUUID()}`;
  console.warn(`[Session] No stable key; session will not be sticky | key=${key}`);
  console.log(`[Session] Sticky key generated | key=${key} | source=ephemeral`);
  return key;
}

/** True when the key came from a stable source (anything but the ephemeral fallback). */
export function isStableStickyKey(source: StickyKeySource): boolean {
  return source !== "ephemeral";
}
