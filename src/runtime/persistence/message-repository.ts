/**
 * Durable repository for the message tree inside a Session.
 *
 * Sequence numbers are stable and monotonic within a session: each append takes
 * `max(sequence_number) + 1` inside the append transaction, so the numbers can
 * never collide or skip, even after a branch trim. Tool calls are stored as a
 * JSON payload on the assistant message and correlated back by `tool_call_id`
 * only — results may arrive in arbitrary order for parallel calls.
 */
import type Database from "better-sqlite3";

import { getDatabase } from "../../core/database.ts";
import type { Message, MessageRole } from "../../domain/session.ts";
import { isToolRoundComplete } from "../../domain/tools.ts";
import type { ToolCall, ToolResult, ToolRound } from "../../domain/tools.ts";

export interface AppendMessageInput {
  messageId: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  parentMessageId?: string | null;
  /** Defaults to the session's current branch. */
  branchId?: string | null;
  toolCalls?: readonly ToolCall[];
  /** For role "tool": the call being answered. */
  toolCallId?: string | null;
  createdAt?: number;
}

export interface GetMessagesOptions {
  fromSequence?: number;
  limit?: number;
}

interface MessageRow {
  message_id: string;
  session_id: string;
  role: string;
  content: string | null;
  sequence_number: number;
  parent_message_id: string | null;
  branch_id: string | null;
  created_at: number;
  tool_calls_json: string | null;
  tool_call_id: string | null;
}

interface ToolResultRow {
  tool_call_id: string;
  content: string | null;
  created_at: number;
}

interface PendingCallRow {
  call_id: string | null;
  name: string | null;
  arguments: string | null;
}

const MESSAGE_ROLES: readonly MessageRole[] = [
  "system",
  "user",
  "assistant",
  "tool",
];

const MESSAGE_COLUMNS =
  "message_id, session_id, role, content, sequence_number, " +
  "parent_message_id, branch_id, created_at, tool_calls_json, tool_call_id";

function asMessageRole(value: string): MessageRole {
  const role = MESSAGE_ROLES.find((candidate) => candidate === value);
  if (!role) {
    throw new Error(`Corrupt messages row: unknown role '${value}'`);
  }
  return role;
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.callId === "string" &&
    typeof record.name === "string" &&
    typeof record.arguments === "string" &&
    typeof record.status === "string"
  );
}

/** Parses stored tool calls; malformed payloads read back as no calls. */
function parseToolCalls(
  json: string | null | undefined,
): readonly ToolCall[] | undefined {
  if (!json) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;
  const calls = parsed.filter(isToolCall);
  return calls.length > 0 ? calls : undefined;
}

function rowToMessage(row: MessageRow | undefined): Message | null {
  if (!row) return null;

  const message: Message = {
    messageId: row.message_id,
    sessionId: row.session_id,
    role: asMessageRole(row.role),
    content: row.content ?? "",
    sequenceNumber: row.sequence_number,
    parentMessageId: row.parent_message_id,
    branchId: row.branch_id ?? "",
    createdAt: row.created_at,
  };

  const toolCalls = parseToolCalls(row.tool_calls_json);
  if (toolCalls) message.toolCalls = toolCalls;
  if (row.tool_call_id) message.toolCallId = row.tool_call_id;

  return message;
}

export class MessageRepository {
  private readonly insertMessage: Database.Statement;
  private readonly nextSequence: Database.Statement;
  private readonly currentBranch: Database.Statement;
  private readonly selectById: Database.Statement;
  private readonly selectBySession: Database.Statement;
  private readonly selectToolResults: Database.Statement;
  private readonly deleteFromSequenceStmt: Database.Statement;
  private readonly selectPendingToolCalls: Database.Statement;

  constructor(private readonly db: Database.Database = getDatabase()) {
    this.insertMessage = db.prepare(
      `INSERT INTO messages
         (message_id, session_id, role, content, sequence_number,
          parent_message_id, branch_id, created_at, tool_calls_json,
          tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.nextSequence = db.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next
       FROM messages
       WHERE session_id = ?`,
    );
    this.currentBranch = db.prepare(
      `SELECT current_branch_id FROM sessions WHERE session_id = ?`,
    );
    this.selectById = db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE message_id = ?`,
    );
    // A negative LIMIT means "no upper bound" in SQLite, so unlimited reads
    // stay a single prepared statement.
    this.selectBySession = db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE session_id = ? AND sequence_number >= ?
       ORDER BY sequence_number ASC
       LIMIT ?`,
    );
    this.selectToolResults = db.prepare(
      `SELECT tool_call_id, content, created_at
       FROM messages
       WHERE session_id = ? AND role = 'tool'`,
    );
    this.deleteFromSequenceStmt = db.prepare(
      `DELETE FROM messages
       WHERE session_id = ? AND sequence_number >= ?`,
    );
    // LEFT JOIN anti-semi-join: every assistant tool call left without a
    // matching tool message. The stored call status is deliberately ignored —
    // only a persisted result makes a call resolved.
    this.selectPendingToolCalls = db.prepare(
      `SELECT
         json_extract(c.call_json, '$.callId') AS call_id,
         json_extract(c.call_json, '$.name')    AS name,
         json_extract(c.call_json, '$.arguments') AS arguments
       FROM (
         SELECT m.message_id AS message_id,
                je.key       AS call_index,
                je.value     AS call_json
         FROM messages m, json_each(m.tool_calls_json) je
         WHERE m.session_id = ?
           AND m.role = 'assistant'
           AND m.tool_calls_json IS NOT NULL
           AND json_valid(m.tool_calls_json)
       ) c
       LEFT JOIN messages t
         ON t.session_id = ?
        AND t.role = 'tool'
        AND t.tool_call_id = json_extract(c.call_json, '$.callId')
       WHERE t.message_id IS NULL
       ORDER BY c.message_id, c.call_index`,
    );
  }

  /**
   * Appends a message with the next sequence number in its session. The
   * sequence is computed and written inside one transaction, so concurrent
   * appends converge on distinct monotonic numbers.
   */
  append(input: AppendMessageInput): Message {
    const now = input.createdAt ?? Date.now();
    const toolCallsJson =
      input.toolCalls && input.toolCalls.length > 0
        ? JSON.stringify(input.toolCalls)
        : null;

    const append = this.db.transaction(() => {
      const branchId = this.resolveBranchId(input.sessionId, input.branchId);
      const row = this.nextSequence.get(input.sessionId) as
        | { next: number }
        | undefined;
      const sequenceNumber = row ? row.next : 1;

      this.insertMessage.run(
        input.messageId,
        input.sessionId,
        input.role,
        input.content ?? null,
        sequenceNumber,
        input.parentMessageId ?? null,
        branchId,
        now,
        toolCallsJson,
        input.toolCallId ?? null,
      );

      return { branchId, sequenceNumber };
    });

    const { branchId, sequenceNumber } = append();

    const message: Message = {
      messageId: input.messageId,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      sequenceNumber,
      parentMessageId: input.parentMessageId ?? null,
      branchId,
      createdAt: now,
    };
    if (input.toolCalls) message.toolCalls = input.toolCalls;
    if (input.toolCallId) message.toolCallId = input.toolCallId;

    return message;
  }

  /** Reads a message or null when absent. */
  getById(messageId: string): Message | null {
    return rowToMessage(this.selectById.get(messageId) as MessageRow | undefined);
  }

  /** Reads a session's messages in sequence order. */
  getBySession(
    sessionId: string,
    opts?: GetMessagesOptions,
  ): Message[] {
    const fromSequence = opts?.fromSequence ?? 0;
    const limit = opts?.limit ?? -1;
    const rows = this.selectBySession.all(sessionId, fromSequence, limit) as MessageRow[];
    return rows
      .map((row) => rowToMessage(row))
      .filter((message): message is Message => message !== null);
  }

  /**
   * Rebuilds the atomic group compaction must never split: the assistant
   * message, the calls it issued, and every persisted result for those calls.
   * `isComplete` follows the domain rule that a call without a result stays
   * pending — a missing result is never summarized as resolved.
   */
  getToolRound(assistantMessageId: string): ToolRound | null {
    const assistant = rowToMessage(
      this.selectById.get(assistantMessageId) as MessageRow | undefined,
    );
    if (!assistant || assistant.role !== "assistant") return null;

    const calls = assistant.toolCalls ?? [];
    const results: ToolResult[] = [];
    if (calls.length > 0) {
      const known = new Set(calls.map((call) => call.callId));
      const rows = this.selectToolResults.all(assistant.sessionId) as ToolResultRow[];
      for (const row of rows) {
        if (!known.has(row.tool_call_id)) continue;
        results.push({
          callId: row.tool_call_id,
          content: row.content ?? "",
          isError: false,
          completedAt: row.created_at,
        });
      }
    }

    const round: ToolRound = {
      assistantMessageId,
      calls,
      results,
      isComplete: false,
    };
    round.isComplete = isToolRoundComplete(round);
    return round;
  }

  /**
   * Every tool call in the session whose result is still missing, reported as
   * PENDING regardless of the status the model stored. Correlation is by
   * persisted result only.
   */
  getPendingToolCalls(sessionId: string): ToolCall[] {
    const rows = this.selectPendingToolCalls.all(sessionId, sessionId) as PendingCallRow[];
    const pending: ToolCall[] = [];
    for (const row of rows) {
      if (typeof row.call_id !== "string") continue;
      pending.push({
        callId: row.call_id,
        name: row.name ?? "",
        arguments: row.arguments ?? "",
        status: "pending",
      });
    }
    return pending;
  }

  /**
   * Trims every message from `fromSequence` upward — used by branch reset and
   * compaction repair. Returns the number of messages removed.
   */
  deleteFromSequence(sessionId: string, fromSequence: number): number {
    const result = this.deleteFromSequenceStmt.run(sessionId, fromSequence);
    return result.changes;
  }

  private resolveBranchId(
    sessionId: string,
    explicit: string | null | undefined,
  ): string {
    if (explicit) return explicit;

    const row = this.currentBranch.get(sessionId) as
      | { current_branch_id: string | null }
      | undefined;
    const branchId = row ? row.current_branch_id : null;
    if (!branchId) {
      throw new Error(
        `Cannot append message: session ${sessionId} has no current branch`,
      );
    }
    return branchId;
  }
}
