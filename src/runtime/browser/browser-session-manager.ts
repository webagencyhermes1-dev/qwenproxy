/**
 * Owns the browser lifecycle boundary: Account -> BrowserSessionManager ->
 * context/page. It does NOT launch browsers — it composes the existing
 * Playwright slot/page helpers and layers operation ownership (identity,
 * absolute deadline, AbortSignal, completion) on top of them.
 */
import type { Page } from "patchright";
import {
  withAccountPage,
  withPlaywrightOpSlot,
  closePlaywrightForAccount,
  closeAllPlaywright,
} from "../../services/playwright.ts";
import {
  OperationRegistry,
  operationRegistry,
  type RegisteredOperation,
} from "./operation-registry.ts";

/** The composed browser boundary; the default wraps the real Playwright slot + page. */
export type BrowserBoundary<THandle> = <T>(
  accountId: string,
  work: (handle: THandle) => Promise<T>,
) => Promise<T>;

export const defaultPlaywrightBoundary: BrowserBoundary<Page> = (accountId, work) =>
  withPlaywrightOpSlot(() => withAccountPage(accountId, work));

/** Closes the account's context (or every context when accountId is omitted). */
export type AccountCloser = (accountId?: string) => Promise<void>;

const defaultPlaywrightCloser: AccountCloser = (accountId) =>
  accountId ? closePlaywrightForAccount(accountId) : closeAllPlaywright();

/** Bounded grace given to in-flight ops at shutdown before force-aborting. */
const SHUTDOWN_DRAIN_MS = 5_000;

export interface OperationContext<THandle> {
  readonly operationId: string;
  readonly accountId: string;
  readonly generationId?: string;
  readonly attemptId?: string;
  /** Absolute epoch-ms deadline. */
  readonly deadline: number;
  readonly signal: AbortSignal;
  /** Remaining ms until the deadline; never negative. Child ops derive their
   * deadline from this so a nested op never gets a fresh timeout (J.3). */
  remainingMs(): number;
  /** Browser handle composed by the boundary (Playwright Page in production). */
  readonly handle: THandle;
}

export interface WithOperationInput {
  accountId: string;
  generationId?: string;
  attemptId?: string;
  /** Absolute epoch-ms deadline; children compute remaining time, never a fresh budget. */
  deadline: number;
  signal?: AbortSignal;
  kind: string;
  /** Caller-supplied operation identity for attribution; a fresh id otherwise. */
  operationId?: string;
}

export class BrowserSessionManager<THandle = Page> {
  private readonly registry: OperationRegistry;
  private readonly boundary: BrowserBoundary<THandle>;
  private readonly closer: AccountCloser;

  constructor(
    boundary: BrowserBoundary<THandle>,
    registry: OperationRegistry = operationRegistry,
    closer: AccountCloser = defaultPlaywrightCloser,
  ) {
    this.boundary = boundary;
    this.registry = registry;
    this.closer = closer;
  }

  /**
   * Run `work` as a tracked browser operation: it gets an operationId, an
   * absolute deadline, an AbortSignal and a completion promise. The op is
   * removed from the registry exactly once when work settles.
   */
  async withOperation<T>(
    input: WithOperationInput,
    work: (ctx: OperationContext<THandle>) => Promise<T>,
  ): Promise<T> {
    const op = this.registry.register({
      accountId: input.accountId,
      deadline: input.deadline,
      signal: input.signal,
      kind: input.kind,
      ...(input.generationId ? { generationId: input.generationId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });

    if (op.controller.signal.aborted) {
      this.registry.remove(op.operationId);
      op.rejectCompletion(new DOMException("The operation was aborted", "AbortError"));
      throw new DOMException("The operation was aborted", "AbortError");
    }

    try {
      return await this.boundary(input.accountId, (handle) =>
        work({
          operationId: op.operationId,
          accountId: input.accountId,
          deadline: input.deadline,
          signal: op.controller.signal,
          remainingMs: () => Math.max(0, input.deadline - Date.now()),
          handle,
          ...(input.generationId ? { generationId: input.generationId } : {}),
          ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        }),
      );
    } catch (error) {
      op.rejectCompletion(error);
      throw error;
    } finally {
      op.resolveCompletion();
      this.registry.remove(op.operationId);
    }
  }

  /**
   * Cancel in-flight ops for the account (or every account), close the browser
   * contexts via the existing playwright.ts close path, drain completions up to
   * a bounded deadline, then force-abort whatever never settled.
   */
  async shutdown(accountId?: string): Promise<void> {
    const ops = accountId
      ? this.registry.listForAccount(accountId)
      : this.registry.listAll();

    await Promise.all(
      ops.map((op) => this.registry.cancel(op.operationId, "manager_shutdown")),
    );
    await this.closer(accountId).catch(() => undefined);

    const settled = new Set<string>();
    const drain = Promise.all(
      ops.map((op) =>
        op.completion
          .catch(() => undefined)
          .then(() => settled.add(op.operationId)),
      ),
    );
    const bounded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
      timer.unref?.();
    });
    await Promise.race([drain, bounded]);

    for (const op of ops) {
      if (!settled.has(op.operationId)) {
        void this.registry.cancel(op.operationId, "shutdown_force_abort");
      }
    }
  }
}

export type { RegisteredOperation };

/** Process-wide seam; other phases call shutdown() at account/server terminal. */
export const browserSessionManager = new BrowserSessionManager(defaultPlaywrightBoundary);
