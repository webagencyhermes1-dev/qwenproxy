import assert from "node:assert/strict";
import test from "node:test";

// The manager module imports playwright.ts; mock auth keeps that import hermetic.
process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  OperationRegistry,
  browserOwnershipEnabled,
} from "./operation-registry.ts";
import {
  BrowserSessionManager,
  type BrowserBoundary,
} from "./browser-session-manager.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeHandle {
  readonly name: string;
}

const fakeBoundary: BrowserBoundary<FakeHandle> = <T>(
  _accountId: string,
  work: (handle: FakeHandle) => Promise<T>,
): Promise<T> => work({ name: "fake-page" });

test("browser ownership flag defaults off", () => {
  const previous = process.env.QWEN_BROWSER_OWNERSHIP;
  delete process.env.QWEN_BROWSER_OWNERSHIP;
  assert.equal(browserOwnershipEnabled(), false);
  process.env.QWEN_BROWSER_OWNERSHIP = "true";
  assert.equal(browserOwnershipEnabled(), true);
  process.env.QWEN_BROWSER_OWNERSHIP = "false";
  assert.equal(browserOwnershipEnabled(), false);
  if (previous === undefined) delete process.env.QWEN_BROWSER_OWNERSHIP;
  else process.env.QWEN_BROWSER_OWNERSHIP = previous;
});

test("cancelAllForGeneration aborts the generation's ops and a second cancel is a no-op", async () => {
  const registry = new OperationRegistry();
  const op = registry.register({
    accountId: "a1",
    generationId: "genA",
    deadline: Date.now() + 60_000,
    kind: "qwen-browser-fetch",
  });
  op.completion.catch(() => undefined);

  await registry.cancelAllForGeneration("genA", "generation_terminal");

  assert.equal(op.controller.signal.aborted, true);
  assert.equal(op.controller.signal.reason instanceof Error, true);
  assert.equal(registry.get(op.operationId), undefined);
  assert.equal(registry.listForGeneration("genA").length, 0);

  // Duplicate cancel from a racing callback must not throw or mutate state.
  await registry.cancelAllForGeneration("genA", "generation_terminal");
  await registry.cancel(op.operationId, "generation_terminal");
  assert.equal(registry.listForGeneration("genA").length, 0);
});

test("an op cancelled by generation terminal cannot keep running (sibling generation untouched)", async () => {
  const registry = new OperationRegistry();
  const dead = registry.register({
    accountId: "a1",
    generationId: "genA",
    deadline: Date.now() + 60_000,
    kind: "qwen-browser-fetch",
  });
  const live = registry.register({
    accountId: "a1",
    generationId: "genB",
    deadline: Date.now() + 60_000,
    kind: "qwen-browser-fetch",
  });
  dead.completion.catch(() => undefined);
  live.completion.catch(() => undefined);

  await registry.cancelAllForGeneration("genA", "generation_terminal");

  assert.equal(dead.controller.signal.aborted, true);
  assert.equal(live.controller.signal.aborted, false);
  assert.equal(registry.get(live.operationId), live);
});

test("a late resolve/reject after removal does not mutate the registry", async () => {
  const registry = new OperationRegistry();
  const op = registry.register({
    accountId: "a1",
    generationId: "genA",
    deadline: Date.now() + 60_000,
    kind: "qwen-browser-fetch",
  });
  registry.remove(op.operationId);
  assert.equal(registry.get(op.operationId), undefined);

  // Late callbacks from an in-page fetch that outlived its registry entry.
  op.resolveCompletion();
  op.rejectCompletion(new Error("late"));
  op.resolveCompletion();

  assert.equal(registry.get(op.operationId), undefined);
  assert.equal(registry.listForAccount("a1").length, 0);
  assert.equal(registry.listForGeneration("genA").length, 0);
});

test("an op whose deadline passes is auto-cancelled", async () => {
  const registry = new OperationRegistry();
  const op = registry.register({
    accountId: "a1",
    deadline: Date.now() + 20,
    kind: "qwen-browser-fetch",
  });
  op.completion.catch(() => undefined);

  await sleep(150);

  assert.equal(op.controller.signal.aborted, true);
  assert.equal(op.controller.signal.reason instanceof Error, true);
  assert.equal(registry.get(op.operationId), undefined);
});

test("the registry evicts the oldest entry past the cap and cancels it", () => {
  const registry = new OperationRegistry(3);
  const first = registry.register({
    accountId: "a1",
    deadline: Date.now() + 60_000,
    kind: "op",
  });
  const second = registry.register({
    accountId: "a1",
    deadline: Date.now() + 60_000,
    kind: "op",
  });
  registry.register({ accountId: "a1", deadline: Date.now() + 60_000, kind: "op" });
  first.completion.catch(() => undefined);
  second.completion.catch(() => undefined);

  assert.equal(registry.listAll().length, 3);

  registry.register({ accountId: "a1", deadline: Date.now() + 60_000, kind: "op" });

  assert.equal(registry.listAll().length, 3, "cap is enforced");
  assert.equal(registry.get(first.operationId), undefined, "oldest evicted");
  assert.equal(first.controller.signal.aborted, true, "evicted op is cancelled");
  assert.equal(registry.get(second.operationId), second, "second entry survives");
});

test("withOperation tracks the op and removes it on completion", async () => {
  const registry = new OperationRegistry();
  const manager = new BrowserSessionManager<FakeHandle>(fakeBoundary, registry);

  const result = await manager.withOperation(
    { accountId: "a1", generationId: "genA", deadline: Date.now() + 5_000, kind: "page-op" },
    async (ctx) => {
      assert.equal(typeof ctx.operationId, "string");
      assert.ok(ctx.operationId.startsWith("op_"));
      assert.equal(ctx.handle.name, "fake-page");
      assert.ok(ctx.remainingMs() > 0);
      assert.equal(registry.get(ctx.operationId)?.generationId, "genA");
      return "done";
    },
  );

  assert.equal(result, "done");
  assert.equal(registry.listAll().length, 0, "op removed after completion");
});

test("withOperation propagates the remaining budget: a child never outlives the parent deadline", async () => {
  const registry = new OperationRegistry();
  const manager = new BrowserSessionManager<FakeHandle>(fakeBoundary, registry);

  let childRemaining = -1;
  let parentRemainingAtChild = -1;
  await manager.withOperation(
    { accountId: "a1", deadline: Date.now() + 1_000, kind: "parent" },
    async (parentCtx) => {
      parentRemainingAtChild = parentCtx.remainingMs();
      await manager.withOperation(
        {
          accountId: "a1",
          // J.3: the child derives its deadline from the parent's remaining
          // time instead of arming a fresh nested timeout.
          deadline: Date.now() + parentCtx.remainingMs(),
          kind: "child",
        },
        async (childCtx) => {
          childRemaining = childCtx.remainingMs();
          return true;
        },
      );
      return true;
    },
  );

  assert.ok(childRemaining >= 0, "child has a live budget");
  assert.ok(
    childRemaining <= parentRemainingAtChild,
    `child remaining ${childRemaining} must not exceed parent remaining ${parentRemainingAtChild}`,
  );
});

test("withOperation observes op abort and cleans up", async () => {
  const registry = new OperationRegistry();
  const manager = new BrowserSessionManager<FakeHandle>(fakeBoundary, registry);
  const controller = new AbortController();

  await assert.rejects(
    manager.withOperation(
      {
        accountId: "a1",
        deadline: Date.now() + 5_000,
        signal: controller.signal,
        kind: "page-op",
      },
      async (ctx) => {
        const aborted = new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        controller.abort();
        return await Promise.race([aborted, sleep(100).then(() => "unreachable")]);
      },
    ),
    /aborted/,
  );
  assert.equal(registry.listAll().length, 0);
});

test("shutdown cancels in-flight ops and force-aborts stragglers", async () => {
  const registry = new OperationRegistry();
  let closedAccount: string | undefined = "unset";
  const manager = new BrowserSessionManager<FakeHandle>(
    fakeBoundary,
    registry,
    async (accountId) => {
      closedAccount = accountId;
    },
  );

  const park = manager.withOperation(
    { accountId: "a1", generationId: "genA", deadline: Date.now() + 60_000, kind: "hang" },
    async (ctx) => {
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      return "never";
    },
  );
  await sleep(10);
  assert.equal(registry.listAll().length, 1, "op is live");

  await manager.shutdown("a1");

  await assert.rejects(park, /aborted/);
  assert.equal(closedAccount, "a1", "browser contexts closed via the existing closer");
  assert.equal(registry.listAll().length, 0, "no op outlives shutdown");
});
