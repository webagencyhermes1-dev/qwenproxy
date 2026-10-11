import { createHash, randomUUID } from "crypto";
import type { Message } from "./types.js";

/**
 * Derive a deterministic session ID from a caller-provided conversation key
 * plus the conversation's anchoring content.
 *
 * An absent/empty conversation key is never hashed: content-derived ids would
 * collide across clients sharing the same first prompt, so a unique ephemeral
 * id is minted instead.
 */
export function deriveSessionId(
  messages: Message[],
  systemPrompt: string = "",
  conversationKey?: string,
): string {
  const key = conversationKey?.trim();
  if (!key) return `sess_eph_${randomUUID()}`;
  const firstUser = messages.find((m) => m.role === "user");
  const anchor = [
    key,
    systemPrompt.trim(),
    extractTextContent(firstUser),
  ]
    .filter((part) => part && part.length > 0)
    .join("|");
  const hash = createHash("sha256").update(anchor).digest("hex").slice(0, 16);
  return `sess_${hash}`;
}

function extractTextContent(msg: Message | undefined): string {
  if (!msg || !msg.content) return "";
  if (typeof msg.content === "string") return msg.content;

  const content = msg.content as any;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text || "")
      .join(" ");
  }
  return "";
}
