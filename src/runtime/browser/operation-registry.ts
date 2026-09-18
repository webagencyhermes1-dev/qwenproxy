import { newOperationId } from "../../domain/ids.ts";

export interface RegisteredOperation {
  operationId: string;
  accountId: string;
  generationId?: string;
  attemptId?: string;
  deadline: number;
  kind: string;
  controller: AbortController;
  signal: AbortSignal;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (error: unknown) => void;
}

export interface RegisterOperationInput {
  accountId: string;
  generationId?: string;
  attemptId?: string;
  deadline: number;
  signal?: AbortSignal;
  kind: string;
  operationId?: string;
}

interface RegistryEntry {
  op: RegisteredOperation;
  timer?: ReturnType<typeof setTimeout>;
  unlinkSignal?: () => void;
}

const DEFAULT_MAX_ENTRIES = 10_000;

export class OperationRegistry {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  register(input: RegisterOperationInput): RegisteredOperation {
    const operationId = input.operationId ?? newOperationId();
    if (this.entries.has(operationId)) {
      this.detach(operationId);
    }

    const controller = new AbortController();
    let settled = false;
    let resolveFn!: () => void;
    let rejectFn!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    completion.catch(() => undefined);

    const op: RegisteredOperation = {
      operationId,
      accountId: input.accountId,
      deadline: input.deadline,
      kind: input.kind,
      controller,
      signal: controller.signal,
      completion,
      resolveCompletion: () => {
        if (settled) return;
        settled = true;
        resolveFn();
      },
      rejectCompletion: (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectFn(error);
      },
      ...(input.generationId ? { generationId: input.generationId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    };

    let unlinkSignal: (() => void) | undefined;
    if (input.signal) {
      const external = input.signal;
      if (external.aborted) {
        controller.abort(external.reason);
      } else {
        const onAbort = () => controller.abort(external.reason);
        external.addEventListener("abort", onAbort, { once: true });
        unlinkSignal = () => external.removeEventListener("abort", onAbort);
      }
    }

    const entry: RegistryEntry = { op };
    if (unlinkSignal) entry.unlinkSignal = unlinkSignal;
    this.entries.set(operationId, entry);

    const remaining = input.deadline - Date.now();
    if (remaining <= 0) {
      void this.cancel(operationId, "deadline_exceeded");
    } else {
      const timer = setTimeout(() => {
        void this.cancel(operationId, "deadline_exceeded");
      }, remaining);
      timer.unref?.();
      entry.timer = timer;
    }

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      void this.cancel(oldest.value, "registry_capacity");
    }

    return op;
  }

  remove(operationId: string): boolean {
    const existed = this.entries.has(operationId);
    this.detach(operationId);
    return existed;
  }

  get(operationId: string): RegisteredOperation | undefined {
    return this.entries.get(operationId)?.op;
  }

  listAll(): RegisteredOperation[] {
    return [...this.entries.values()].map((entry) => entry.op);
  }

  listForAccount(accountId: string): RegisteredOperation[] {
    return this.listAll().filter((op) => op.accountId === accountId);
  }

  listForGeneration(generationId: string): RegisteredOperation[] {
    return this.listAll().filter((op) => op.generationId === generationId);
  }

  async cancel(operationId: string, reason: string): Promise<void> {
    const entry = this.entries.get(operationId);
    if (!entry) return;
    this.detach(operationId);
    if (!entry.op.controller.signal.aborted) {
      entry.op.controller.abort(new Error(reason));
    }
    entry.op.rejectCompletion(new Error(reason));
  }

  async cancelAllForGeneration(generationId: string, reason: string): Promise<void> {
    await Promise.all(
      this.listForGeneration(generationId).map((op) => this.cancel(op.operationId, reason)),
    );
  }

  private detach(operationId: string): void {
    const entry = this.entries.get(operationId);
    if (!entry) return;
    this.entries.delete(operationId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.unlinkSignal?.();
  }
}

export const operationRegistry = new OperationRegistry();

export const browserOwnershipEnabled = (): boolean =>
  process.env.QWEN_BROWSER_OWNERSHIP === "true";
