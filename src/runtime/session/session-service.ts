import { getDatabase } from "../../core/database.ts";
import { TypedRuntimeError } from "../../domain/errors.ts";
import { newGenerationId, newMessageId, newSessionId } from "../../domain/ids.ts";
import type { Session } from "../../domain/session.ts";
import type { ToolCall } from "../../domain/tools.ts";
import { GenerationRepository } from "../persistence/generation-repository.ts";
import { MessageRepository } from "../persistence/message-repository.ts";
import { SessionRepository } from "../persistence/session-repository.ts";

// Flag: process.env.QWEN_SESSION_VERSIONING === "true" (default OFF →
// legacy behavior; routes skip every call below when the flag is off).
export const SESSION_VERSIONING_FLAG = "QWEN_SESSION_VERSIONING";
export const SESSION_VERSIONING_ENDPOINT_CHAT = "chat-completions";
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const DEFAULT_TENANT_ID = "default";
export const SESSION_GENERATION_DEADLINE_MS = 300_000;

export function isSessionVersioningEnabled(): boolean {
  return process.env[SESSION_VERSIONING_FLAG] === "true";
}

// Idempotency scope is tenant + endpoint: the same client key on another
// endpoint must not collide, so the endpoint namespaces the stored key.
export function scopedIdempotencyKey(endpoint: string, key: string): string {
  return `${endpoint}:${key}`;
}

export interface ResolveSessionInput {
  tenantId: string;
  sessionId?: string;
  modelId: string;
}

export interface BeginGenerationInput {
  sessionId: string;
  tenantId: string;
  turnId: string;
  modelId: string;
  deadline: number;
  idempotencyKey?: string;
}

export type BeginGenerationResult =
  | { ok: true; session: Session; versionAtStart: number; generationId: string }
  | { ok: false; error: TypedRuntimeError };

export interface CommitMessageInput {
  content: string;
  messageId?: string;
}

export interface CommitGenerationInput {
  sessionId: string;
  generationId: string;
  fromVersion: number;
  userMessage: CommitMessageInput;
  assistantMessage: CommitMessageInput;
  toolCalls?: readonly ToolCall[];
}

export type CommitResult =
  | { committed: true; version: number }
  | { committed: false; conflict: true; currentVersion: number };

export interface FailGenerationInput {
  sessionId: string;
  generationId: string;
  fromVersion?: number;
}

// Hand-off from the route (index.ts) to the stream layer (streaming.ts):
// the snapshot basis a generation must commit against. Retries reuse it
// verbatim instead of rebuilding from mutable live state mid-retry.
export interface SessionStreamCommit {
  sessionId: string;
  generationId: string;
  versionAtStart: number;
}

function isSqliteConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

export class SessionService {
  // One active generation per session. In-memory only: a restart drops the
  // map while durable rows survive. Follow-up: replace with a durable
  // active-generation query (e.g. listNonterminal filtered by session) so
  // crash recovery re-arms the guard instead of starting unguarded.
  private readonly activeGenerations = new Map<string, string>();
  private readonly committedGenerations = new Map<string, number>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly generations: GenerationRepository,
  ) {}

  async resolveSession(
    input: ResolveSessionInput,
  ): Promise<{ session: Session; created: boolean }> {
    const sessionId = input.sessionId ?? newSessionId();
    const existing = this.sessions.getById(sessionId);
    if (existing) return { session: existing, created: false };
    try {
      const created = this.sessions.createSession({
        sessionId,
        tenantId: input.tenantId,
        modelId: input.modelId,
      });
      return { session: created, created: true };
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const raced = this.sessions.getById(sessionId);
        if (raced) return { session: raced, created: false };
      }
      throw error;
    }
  }

  async beginGeneration(
    input: BeginGenerationInput,
  ): Promise<BeginGenerationResult> {
    const session = this.getOrCreateSession(
      input.sessionId,
      input.tenantId,
      input.modelId,
    );
    if (input.idempotencyKey) {
      const replay = this.generations.findByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey,
      );
      if (replay) {
        return { ok: false, error: this.replayConflict(input, replay.generationId) };
      }
    }
    const active = this.activeGenerations.get(session.sessionId);
    if (active !== undefined) {
      return {
        ok: false,
        error: TypedRuntimeError.fromCode(
          "SESSION_BUSY",
          `Session ${session.sessionId} already has an active generation`,
          { sessionId: session.sessionId, generationId: active },
        ),
      };
    }
    const generationId = newGenerationId();
    if (input.idempotencyKey) {
      const claim = this.generations.insertIdempotencyClaim({
        tenantId: input.tenantId,
        key: input.idempotencyKey,
        generationId,
        status: "claimed",
      });
      if (!claim.inserted) {
        const raced = this.generations.findByIdempotencyKey(
          input.tenantId,
          input.idempotencyKey,
        );
        return {
          ok: false,
          error: this.replayConflict(input, raced?.generationId),
        };
      }
    }
    this.generations.create({
      generationId,
      tenantId: input.tenantId,
      sessionId: session.sessionId,
      turnId: input.turnId,
      sessionVersionAtStart: session.version,
      deadline: input.deadline,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    this.activeGenerations.set(session.sessionId, generationId);
    return {
      ok: true,
      session,
      versionAtStart: session.version,
      generationId,
    };
  }

  async commitGeneration(
    input: CommitGenerationInput,
  ): Promise<CommitResult> {
    const already = this.committedGenerations.get(input.generationId);
    if (already !== undefined) {
      const live = this.sessions.getById(input.sessionId);
      return { committed: true, version: live ? live.version : already };
    }
    const now = Date.now();
    const advance = this.sessions.advanceVersion({
      sessionId: input.sessionId,
      fromVersion: input.fromVersion,
      toVersion: input.fromVersion + 1,
      updatedAt: now,
    });
    if (!advance.advanced) {
      return {
        committed: false,
        conflict: true,
        currentVersion: advance.currentVersion,
      };
    }
    const userMessageId = input.userMessage.messageId ?? newMessageId();
    const assistantMessageId = input.assistantMessage.messageId ?? newMessageId();
    this.messages.append({
      messageId: userMessageId,
      sessionId: input.sessionId,
      role: "user",
      content: input.userMessage.content,
      createdAt: now,
    });
    this.messages.append({
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      role: "assistant",
      content: input.assistantMessage.content,
      parentMessageId: userMessageId,
      toolCalls: input.toolCalls,
      createdAt: now,
    });
    if (this.activeGenerations.get(input.sessionId) === input.generationId) {
      this.activeGenerations.delete(input.sessionId);
    }
    this.committedGenerations.set(input.generationId, input.fromVersion + 1);
    return { committed: true, version: input.fromVersion + 1 };
  }

  async failGeneration(input: FailGenerationInput): Promise<void> {
    if (this.activeGenerations.get(input.sessionId) === input.generationId) {
      this.activeGenerations.delete(input.sessionId);
    }
  }

  private getOrCreateSession(
    sessionId: string,
    tenantId: string,
    modelId: string,
  ): Session {
    const existing = this.sessions.getById(sessionId);
    if (existing) return existing;
    try {
      return this.sessions.createSession({ sessionId, tenantId, modelId });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const raced = this.sessions.getById(sessionId);
        if (raced) return raced;
      }
      throw error;
    }
  }

  private replayConflict(
    input: BeginGenerationInput,
    generationId: string | undefined,
  ): TypedRuntimeError {
    return TypedRuntimeError.fromCode(
      "SESSION_CONFLICT",
      "Idempotency replay: a generation already exists for this key",
      {
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey ?? "",
        ...(generationId !== undefined ? { generationId } : {}),
      },
    );
  }
}

let shared: SessionService | null = null;

// Live-path seam so the route and the stream layer share one active map.
// Tests construct SessionService directly with injected repositories.
export function getSharedSessionService(): SessionService {
  if (!shared) {
    shared = new SessionService(
      new SessionRepository(getDatabase()),
      new MessageRepository(getDatabase()),
      new GenerationRepository(getDatabase()),
    );
  }
  return shared;
}
