/**
 * Bounded registry of LIVE browser operations.
 *
 * Phase 6 ownership model: every browser operation (in-page fetch, header
 * capture, page op) is tracked here by operation identity — not by mutex key
 * string — so a generation terminal can cancel ALL browser work that outlives
 * its generation (J.4 late-callback safety) and a deadline can abort an
 * in-page fetch that no Node timer observes.
 */
import { newOperationId } from "../../domain/ids.ts";

/**
 * Feature flag for the browser operation ownership model.
 * Exact name: QWEN_BROWSER_OWNERSHIP. Default OFF: all call sites behave
 * exactly as before. Set to "true" to enable operation tracking.
 */
export function browserOwnershipEnabled(): boolean {
  return process.env.QWEN_BROWSER_OWNERSHIP === "true";
}

/**
 * A live browser operation. The AbortController is the single cancellation
 * channel: registry cancel / deadline / linked external signal all funnel
 * through `controller.abort()`. The completion promise is settled by whichever
 * component owns the resolve/reject handles (the work itself), never by the
 * registry — a late callback after removal settles nothing in the registry.
 */
export interface RegisteredOperation {
  readonly operationId: string;
  readonly accountId: string;
  readonly generationId?: string;
  readonly attemptId?: string;
  readonly startedAt: number;
  /** Absolute epoch-ms deadline; the op is auto-cancelled once it passes. */
  readonly deadline: number;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly rejectCompletion: (error: unknown) => void;
  /** Category label for observability (e.g. "qwen-browser-fetch"). */
  readonly kind: string;
}

export interface RegisterOperationInput {
  accountId: string;
  generationId?: string;
  attemptId?: string;
  /** Absolute epoch-ms deadline (J.3: children derive remaining time from it). */
  deadline: number;
  /** External signal whose abort cancels this operation. */
  signal?: AbortSignal;
  kind: string;
  /** Use a caller-supplied identity (attribution) instead of a fresh id. */
  operationId?: string;
}

interface OperationEntry extends RegisteredOperation {
  /** Guards exactly-once timer/listener disposal (remove and cancel both run it). */
  disposed: boolean;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
}

const DEFAULT_MAX_OPERATIONS = 4096;

export class OperationRegistry {
  private readonly ops = new Map<string, OperationEntry>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxOperations: number;

  constructor(maxOperations = DEFAULT_MAX_OPERATIONS) {
    this.maxOperations = Math.max(1, maxOperations);
  }

  /**
   * Register a live operation. Returns the entry holding the AbortController
   * (already linked to `signal`) and the completion handles.
   *
   * Cleanup path for every entry: `remove(operationId)` on clean completion, or
   * `cancel(operationId, reason)` on any terminal — both dispose the deadline
   * timer and the external-signal listener exactly once. A caller-supplied id
   * that collides with a live entry cancels the stale owner first.
   */
  register(input: RegisterOperationInput): RegisteredOperation {
    while (this.ops.size >= this.maxOperations) {
      const oldestId = this.ops.keys().next().value;
      if (oldestId === undefined) break;
      void this.cancel(oldestId, "registry_capacity_eviction");
    }

    const operationId = input.operationId ?? newOperationId();
    if (this.ops.has(operationId)) {
      void this.cancel(operationId, "operation_id_reused");
    }

    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // The completion is optional observation: nobody may await it, so a
    // rejection must never become an unhandled-rejection process error. Later
    // awaiters still observe the rejection.
    completion.catch(() => {
      /* handled lazily by owners */
    });

    const entry: OperationEntry = {
      operationId,
      accountId: input.accountId,
      startedAt: Date.now(),
      deadline: input.deadline,
      controller: new AbortController(),
      completion,
      resolveCompletion,
      rejectCompletion,
      kind: input.kind,
      disposed: false,
      ...(input.generationId ? { generationId: input.generationId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    };

    this.ops.set(operationId, entry);
    this.armDeadline(entry);
    if (input.signal) this.linkExternalSignal(entry, input.signal);
    return entry;
  }

  get(operationId: string): RegisteredOperation | undefined {
    return this.ops.get(operationId);
  }

  listForAccount(accountId: string): RegisteredOperation[] {
    return Array.from(this.ops.values()).filter((e) => e.accountId === accountId);
  }

  listForGeneration(generationId: string): RegisteredOperation[] {
    return Array.from(this.ops.values()).filter((e) => e.generationId === generationId);
  }

  listAll(): RegisteredOperation[] {
    return Array.from(this.ops.values());
  }

  /**
   * Idempotent cancellation: aborts the operation's controller and removes the
   * entry. Duplicate calls from racing callbacks are no-ops (the entry is gone).
   */
  async cancel(operationId: string, reason: string): Promise<void> {
    const entry = this.ops.get(operationId);
    if (!entry) return;
    this.ops.delete(operationId);
    this.dispose(entry);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new Error(reason));
    }
  }

  /** Exactly-once removal on clean completion; does not abort the controller. */
  remove(operationId: string): void {
    const entry = this.ops.get(operationId);
    if (!entry) return;
    this.ops.delete(operationId);
    this.dispose(entry);
  }

  /**
   * Cancel every live op of a generation. Called at generation terminal so no
   * browser work outlives its generation (J.4).
   */
  async cancelAllForGeneration(generationId: string, reason: string): Promise<void> {
    const ops = this.listForGeneration(generationId);
    await Promise.all(ops.map((op) => this.cancel(op.operationId, reason)));
  }

  private armDeadline(entry: OperationEntry): void {
    const delay = entry.deadline - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => {
      void this.cancel(entry.operationId, "operation_deadline_passed");
    }, Math.max(0, delay));
    timer.unref?.();
    this.deadlineTimers.set(entry.operationId, timer);
  }

  private linkExternalSignal(entry: OperationEntry, signal: AbortSignal): void {
    if (signal.aborted) {
      void this.cancel(entry.operationId, "external_signal_already_aborted");
      return;
    }
    const onAbort = () => {
      void this.cancel(entry.operationId, "external_signal_aborted");
    };
    entry.externalSignal = signal;
    entry.onExternalAbort = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private dispose(entry: OperationEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    const timer = this.deadlineTimers.get(entry.operationId);
    if (timer) {
      clearTimeout(timer);
      this.deadlineTimers.delete(entry.operationId);
    }
    if (entry.externalSignal && entry.onExternalAbort) {
      entry.externalSignal.removeEventListener("abort", entry.onExternalAbort);
    }
    entry.externalSignal = undefined;
    entry.onExternalAbort = undefined;
  }
}

/** Process-wide singleton shared by qwen.ts and playwright.ts. */
export const operationRegistry = new OperationRegistry();
