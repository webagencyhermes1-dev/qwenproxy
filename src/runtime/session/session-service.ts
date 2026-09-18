import { getDatabase } from "../../core/database.ts";
import { newGenerationId, newMessageId } from "../../domain/ids.ts";
import type { Session } from "../../domain/session.ts";
import type { ToolCall } from "../../domain/tools.ts";
import { GenerationRepository } from "../persistence/generation-repository.ts";
import { MessageRepository } from "../persistence/message-repository.ts";
import { SessionRepository } from "../persistence/session-repository.ts";

export const DEFAULT_TENANT_ID = "default";
export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";
export const SESSION_GENERATION_DEADLINE_MS = 60000;
export const SESSION_VERSIONING_ENDPOINT_CHAT = "/v1/chat/completions";

export function isSessionVersioningEnabled(): boolean {
  return process.env.QWEN_SESSION_VERSIONING === "true";
}

export function scopedIdempotencyKey(endpoint: string, key: string): string {
  return `${endpoint}:${key}`;
}

export interface SessionStreamCommit {
  sessionId: string;
  generationId: string;
  versionAtStart: number;
}

export interface ResolveSessionInput {
  tenantId: string;
  sessionId: string;
  modelId: string;
}

export interface ResolveSessionResult {
  session: Session;
  created: boolean;
}

export interface BeginGenerationInput {
  sessionId: string;
  tenantId: string;
  turnId: string;
  modelId: string;
  deadline: number;
  idempotencyKey?: string;
}

export interface SessionServiceError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type BeginGenerationResult =
  | { ok: true; generationId: string; versionAtStart: number }
  | { ok: false; error: SessionServiceError };

export interface CommitMessageInput {
  content: string;
  toolCalls?: readonly ToolCall[];
}

export interface CommitGenerationInput {
  sessionId: string;
  generationId: string;
  fromVersion: number;
  userMessage: CommitMessageInput;
  assistantMessage: CommitMessageInput;
}

export type CommitGenerationResult =
  | { committed: true; version: number }
  | { committed: false; conflict: true; currentVersion: number };

export interface FailGenerationInput {
  sessionId: string;
  generationId: string;
}

export class SessionService {
  private readonly activeGenerations = new Map<string, string>();
  private readonly committedVersions = new Map<string, number>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly messages: MessageRepository,
    private readonly generations: GenerationRepository,
  ) {}

  async resolveSession(
    input: ResolveSessionInput,
  ): Promise<ResolveSessionResult> {
    const existing = this.sessions.getById(input.sessionId);
    if (existing) return { session: existing, created: false };
    const session = this.sessions.createSession({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      modelId: input.modelId,
    });
    return { session, created: true };
  }

  async beginGeneration(
    input: BeginGenerationInput,
  ): Promise<BeginGenerationResult> {
    if (input.idempotencyKey) {
      const existing = this.generations.findByIdempotencyKey(
        input.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        return {
          ok: false,
          error: {
            code: "SESSION_CONFLICT",
            message: "Idempotency key already claimed by another generation",
            details: { generationId: existing.generationId },
          },
        };
      }
    }

    if (this.activeGenerations.has(input.sessionId)) {
      return {
        ok: false,
        error: {
          code: "SESSION_BUSY",
          message: "Session already has an active generation",
        },
      };
    }

    const session = this.sessions.getById(input.sessionId);
    if (!session) {
      return {
        ok: false,
        error: {
          code: "SESSION_NOT_FOUND",
          message: `Session ${input.sessionId} does not exist`,
        },
      };
    }

    const generationId = newGenerationId();
    this.activeGenerations.set(input.sessionId, generationId);

    this.generations.create({
      generationId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sessionVersionAtStart: session.version,
      deadline: input.deadline,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    if (input.idempotencyKey) {
      this.generations.insertIdempotencyClaim({
        tenantId: input.tenantId,
        key: input.idempotencyKey,
        generationId,
        status: "active",
      });
    }

    return { ok: true, generationId, versionAtStart: session.version };
  }

  async commitGeneration(
    input: CommitGenerationInput,
  ): Promise<CommitGenerationResult> {
    const priorVersion = this.committedVersions.get(input.generationId);
    if (priorVersion !== undefined) {
      return { committed: true, version: priorVersion };
    }

    const result = this.sessions.advanceVersion({
      sessionId: input.sessionId,
      fromVersion: input.fromVersion,
      toVersion: input.fromVersion + 1,
      updatedAt: Date.now(),
    });

    if (!result.advanced) {
      return {
        committed: false,
        conflict: true,
        currentVersion: result.currentVersion,
      };
    }

    const userMessage = this.messages.append({
      messageId: newMessageId(),
      sessionId: input.sessionId,
      role: "user",
      content: input.userMessage.content,
    });

    this.messages.append({
      messageId: newMessageId(),
      sessionId: input.sessionId,
      role: "assistant",
      content: input.assistantMessage.content,
      parentMessageId: userMessage.messageId,
      toolCalls: input.assistantMessage.toolCalls,
    });

    this.generations.updateState(
      { generationId: input.generationId, to: "COMPLETED" },
      { expectedState: "QUEUED" },
    );

    this.activeGenerations.delete(input.sessionId);
    this.committedVersions.set(input.generationId, input.fromVersion + 1);

    return { committed: true, version: input.fromVersion + 1 };
  }

  async failGeneration(input: FailGenerationInput): Promise<void> {
    if (this.activeGenerations.get(input.sessionId) === input.generationId) {
      this.activeGenerations.delete(input.sessionId);
    }
    this.generations.updateState(
      {
        generationId: input.generationId,
        to: "FAILED",
        failureCode: "SESSION_GENERATION_FAILED",
      },
      { expectedState: "QUEUED" },
    );
  }
}

let sharedService: SessionService | null = null;

export function getSharedSessionService(): SessionService {
  if (!sharedService) {
    const db = getDatabase();
    sharedService = new SessionService(
      new SessionRepository(db),
      new MessageRepository(db),
      new GenerationRepository(db),
    );
  }
  return sharedService;
}
