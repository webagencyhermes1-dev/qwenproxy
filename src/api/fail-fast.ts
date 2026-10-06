import {
  QwenProxyError,
  type QwenProxyStatusCode,
} from "../core/errors.js";

/**
 * Request-path fail-fast primitives.
 *
 * Every wait that sits between an HTTP request and an account-scoped
 * Playwright resource (per-account mutex, header capture, live metadata
 * fetch) can be stuck behind warmup work holding that mutex for minutes.
 * These helpers bound such waits so the API answers with a structured 503
 * in milliseconds instead of queueing behind a 60s mutex acquire timeout.
 */
export class FailFastTimeoutError extends QwenProxyError {
  readonly statusCode: QwenProxyStatusCode = 503;
  readonly type = "service_unavailable";
  readonly code: string;

  constructor(message: string, code = "request_wait_timeout") {
    super(message);
    this.code = code;
  }
}

/** Model catalog cannot be served right now (cold pool, no cached catalog). */
export class ModelsUnavailableError extends QwenProxyError {
  readonly statusCode: QwenProxyStatusCode = 503;
  readonly type = "service_unavailable";
  readonly code = "models_unavailable";
}

/**
 * Run `fn` with a hard deadline. On timeout the caller gets a
 * FailFastTimeoutError (503) while the underlying work is left to settle in
 * the background — Promise.race keeps a rejection handler attached to it, so
 * a late failure never surfaces as an unhandled rejection.
 *
 * The timer is unref'd so a pending deadline never keeps the process alive
 * (important for `node --test` runs).
 */
export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const work = Promise.resolve().then(fn);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new FailFastTimeoutError(
              `${label} timed out after ${timeoutMs}ms (dependency busy); failing fast instead of blocking the request`,
              "wait_timeout",
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
