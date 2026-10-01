import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside a request-scoped context carrying the request id.
 * Propagates through awaits so any `logger.*` call made while serving the
 * request can correlate its output via `getRequestId()`.
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** Current request id, or undefined outside a request (startup, timers, tests). */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
