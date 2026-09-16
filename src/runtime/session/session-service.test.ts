import Database from "better-sqlite3";
import assert from "node:assert";
import test from "node:test";

import { NEW_TABLE_DDL } from "../persistence/schema.ts";
import { GenerationRepository } from "../persistence/generation-repository.ts";
import { MessageRepository } from "../persistence/message-repository.ts";
import { SessionRepository } from "../persistence/session-repository.ts";
import { SessionService } from "./session-service.ts";

let db: Database.Database;
let service: SessionService;

test.beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const ddl of NEW_TABLE_DDL) db.exec(ddl);
  service = new SessionService(
    new SessionRepository(db),
    new MessageRepository(db),
    new GenerationRepository(db),
  );
});

test.afterEach(() => {
  db.close();
});

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      fn().then(resolve, reject);
    });
  });
}

function messageCount(sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
    .get(sessionId) as { n: number };
  return row.n;
}

test("resolveSession creates once, returns existing on second call", async () => {
  const first = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_resolve",
    modelId: "qwen-max",
  });
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.session.version, 1);
  assert.ok(first.session.currentBranchId.length > 0);

  const second = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_resolve",
    modelId: "qwen-max",
  });
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.session.sessionId, first.session.sessionId);
  assert.strictEqual(second.session.version, 1);
  assert.strictEqual(
    second.session.currentBranchId,
    first.session.currentBranchId,
  );
});

test("two concurrent beginGeneration on the same session: exactly one wins", async () => {
  const { session } = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_busy",
    modelId: "qwen-max",
  });
  const begin = (key: string, turn: string) =>
    service.beginGeneration({
      sessionId: session.sessionId,
      tenantId: "tenant_a",
      turnId: turn,
      modelId: "qwen-max",
      deadline: Date.now() + 60_000,
      idempotencyKey: key,
    });

  const [first, second] = await Promise.all([
    schedule(() => begin("key_a", "turn_a")),
    schedule(() => begin("key_b", "turn_b")),
  ]);

  const outcomes = [first, second];
  assert.strictEqual(
    outcomes.filter((outcome) => outcome.ok).length,
    1,
    "exactly one racer must win",
  );
  const loser = outcomes.find((outcome) => !outcome.ok);
  if (loser === undefined || loser.ok) {
    throw new Error("expected a losing beginGeneration");
  }
  assert.strictEqual(loser.error.code, "SESSION_BUSY");

  const winner = outcomes.find((outcome) => outcome.ok);
  if (winner === undefined || !winner.ok) {
    throw new Error("expected a winning beginGeneration");
  }
  assert.strictEqual(winner.versionAtStart, 1);
});

test("same idempotency key twice: replay gets SESSION_CONFLICT, no second generation", async () => {
  const { session } = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_idem",
    modelId: "qwen-max",
  });
  const base = {
    sessionId: session.sessionId,
    tenantId: "tenant_a",
    turnId: "turn_first",
    modelId: "qwen-max",
    deadline: Date.now() + 60_000,
    idempotencyKey: "idem_1",
  };
  const first = await service.beginGeneration(base);
  if (!first.ok) throw new Error("expected the first begin to win");

  const second = await service.beginGeneration({
    ...base,
    turnId: "turn_replay",
  });
  if (second.ok) throw new Error("expected the replay to conflict");
  assert.strictEqual(second.error.code, "SESSION_CONFLICT");
  assert.strictEqual(
    second.error.details?.["generationId"],
    first.generationId,
  );

  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM generations WHERE tenant_id = ? AND idempotency_key = ?",
    )
    .get("tenant_a", "idem_1") as { n: number };
  assert.strictEqual(row.n, 1);
});

test("commitGeneration advances monotonically; stale fromVersion loses with no messages", async () => {
  const { session } = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_commit",
    modelId: "qwen-max",
  });
  const first = await service.beginGeneration({
    sessionId: session.sessionId,
    tenantId: "tenant_a",
    turnId: "turn_1",
    modelId: "qwen-max",
    deadline: Date.now() + 60_000,
  });
  if (!first.ok) throw new Error("expected the first begin to win");

  const committed = await service.commitGeneration({
    sessionId: session.sessionId,
    generationId: first.generationId,
    fromVersion: first.versionAtStart,
    userMessage: { content: "hello" },
    assistantMessage: { content: "hi" },
  });
  assert.deepStrictEqual(committed, { committed: true, version: 2 });
  assert.strictEqual(messageCount(session.sessionId), 2);
  const sequences = new MessageRepository(db)
    .getBySession(session.sessionId)
    .map((message) => message.sequenceNumber);
  assert.deepStrictEqual(sequences, [1, 2]);

  const second = await service.beginGeneration({
    sessionId: session.sessionId,
    tenantId: "tenant_a",
    turnId: "turn_2",
    modelId: "qwen-max",
    deadline: Date.now() + 60_000,
  });
  if (!second.ok) throw new Error("expected the second begin to win");
  assert.strictEqual(second.versionAtStart, 2);

  const stale = await service.commitGeneration({
    sessionId: session.sessionId,
    generationId: second.generationId,
    fromVersion: 1,
    userMessage: { content: "stale" },
    assistantMessage: { content: "stale reply" },
  });
  assert.strictEqual(stale.committed, false);
  if (stale.committed) throw new Error("expected the stale commit to lose");
  assert.strictEqual(stale.conflict, true);
  assert.strictEqual(stale.currentVersion, 2);
  assert.strictEqual(messageCount(session.sessionId), 2);
});

test("failGeneration clears tracking without advancing the version", async () => {
  const { session } = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_fail",
    modelId: "qwen-max",
  });
  const first = await service.beginGeneration({
    sessionId: session.sessionId,
    tenantId: "tenant_a",
    turnId: "turn_1",
    modelId: "qwen-max",
    deadline: Date.now() + 60_000,
  });
  if (!first.ok) throw new Error("expected the first begin to win");

  await service.failGeneration({
    sessionId: session.sessionId,
    generationId: first.generationId,
  });
  await service.failGeneration({
    sessionId: session.sessionId,
    generationId: first.generationId,
  });

  const reloaded = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: session.sessionId,
    modelId: "qwen-max",
  });
  assert.strictEqual(reloaded.session.version, 1);
  assert.strictEqual(messageCount(session.sessionId), 0);

  const retry = await service.beginGeneration({
    sessionId: session.sessionId,
    tenantId: "tenant_a",
    turnId: "turn_2",
    modelId: "qwen-max",
    deadline: Date.now() + 60_000,
  });
  if (!retry.ok) throw new Error("expected begin after fail to win");
  assert.strictEqual(retry.versionAtStart, 1);
});

test("double commit is idempotent: one version bump, no duplicate messages", async () => {
  const { session } = await service.resolveSession({
    tenantId: "tenant_a",
    sessionId: "sess_double",
    modelId: "qwen-max",
  });
  const begun = await service.beginGeneration({
    sessionId: session.sessionId,
    tenantId: "tenant_a",
    turnId: "turn_1",
    modelId: "qwen-max",
    deadline: Date.now() + 60_000,
  });
  if (!begun.ok) throw new Error("expected begin to win");

  const input = {
    sessionId: session.sessionId,
    generationId: begun.generationId,
    fromVersion: begun.versionAtStart,
    userMessage: { content: "hello" },
    assistantMessage: { content: "hi" },
  };
  const first = await service.commitGeneration(input);
  const second = await service.commitGeneration(input);
  assert.deepStrictEqual(first, { committed: true, version: 2 });
  assert.deepStrictEqual(second, { committed: true, version: 2 });
  assert.strictEqual(messageCount(session.sessionId), 2);
});
