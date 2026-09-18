/**
 * Canonical domain error codes, their HTTP status mapping, and the bridge from
 * the legacy QwenProxyError codes/types (core/errors.ts). This is the single
 * authority for domain-layer error semantics: the legacy hierarchy is not
 * duplicated here, only mapped onto these codes via {@link legacyCodeToErrorCode}.
 */

export type ErrorCode =
  | "INVALID_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "SESSION_CONFLICT"
  | "QUEUE_TIMEOUT"
  | "SERVICE_BUSY"
  | "ACCOUNT_UNAVAILABLE"
  | "ACCOUNT_COOLDOWN"
  | "ACCOUNT_INITIALIZATION_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_CHAT_BUSY"
  | "UPSTREAM_CHAT_CORRUPTED"
  | "CONTEXT_TOO_LARGE"
  | "CONTEXT_RECONSTRUCTION_FAILED"
  | "CONTEXT_COMPACTION_NON_CONVERGENT"
  | "GENERATION_CANCELLED"
  | "GENERATION_TIMEOUT"
  | "TOOL_CALL_INVALID"
  | "TOOL_RESULT_MISSING"
  | "PERSISTENCE_FAILURE"
  | "INTERNAL_ERROR"
  | "LEGACY_PATH";

export const HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  AUTHENTICATION_FAILED: 401,
  SESSION_NOT_FOUND: 404,
  SESSION_BUSY: 409,
  SESSION_CONFLICT: 409,
  QUEUE_TIMEOUT: 504,
  SERVICE_BUSY: 503,
  ACCOUNT_UNAVAILABLE: 503,
  ACCOUNT_COOLDOWN: 503,
  ACCOUNT_INITIALIZATION_FAILED: 503,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_CHAT_BUSY: 502,
  UPSTREAM_CHAT_CORRUPTED: 502,
  CONTEXT_TOO_LARGE: 400,
  CONTEXT_RECONSTRUCTION_FAILED: 500,
  CONTEXT_COMPACTION_NON_CONVERGENT: 500,
  GENERATION_CANCELLED: 499,
  GENERATION_TIMEOUT: 504,
  TOOL_CALL_INVALID: 400,
  TOOL_RESULT_MISSING: 400,
  PERSISTENCE_FAILURE: 500,
  INTERNAL_ERROR: 500,
  LEGACY_PATH: 500,
};

const TERMINAL_GENERATION_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "CONTEXT_TOO_LARGE",
  "CONTEXT_RECONSTRUCTION_FAILED",
  "CONTEXT_COMPACTION_NON_CONVERGENT",
  "SESSION_BUSY",
  "SESSION_CONFLICT",
  "GENERATION_CANCELLED",
  "GENERATION_TIMEOUT",
  "TOOL_CALL_INVALID",
  "INVALID_REQUEST",
  "AUTHENTICATION_FAILED",
  "SESSION_NOT_FOUND",
]);

const CONTEXT_BUDGET_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "CONTEXT_TOO_LARGE",
  "CONTEXT_RECONSTRUCTION_FAILED",
  "CONTEXT_COMPACTION_NON_CONVERGENT",
]);

/**
 * Errors that must never enter the generic network retry loop: retrying cannot
 * change the outcome (budget, conflict, cancellation, or a client fault).
 */
export function isTerminalGenerationError(code: ErrorCode): boolean {
  return TERMINAL_GENERATION_ERRORS.has(code);
}

export function isContextBudgetError(code: ErrorCode): boolean {
  return CONTEXT_BUDGET_ERRORS.has(code);
}

const LEGACY_TO_ERROR_CODE: Record<string, ErrorCode> = {
  // Legacy QwenProxyError codes (src/core/errors.ts).
  bad_request: "INVALID_REQUEST",
  context_length_exceeded: "CONTEXT_TOO_LARGE",
  invalid_api_key: "AUTHENTICATION_FAILED",
  insufficient_quota: "ACCOUNT_COOLDOWN",
  resource_not_found: "SESSION_NOT_FOUND",
  rate_limit_exceeded: "ACCOUNT_COOLDOWN",
  upstream_unavailable: "UPSTREAM_UNAVAILABLE",
  upstream_timeout: "UPSTREAM_TIMEOUT",
  internal_server_error: "INTERNAL_ERROR",
  client_aborted: "GENERATION_CANCELLED",
  service_degraded: "SERVICE_BUSY",
  account_busy: "ACCOUNT_COOLDOWN",
  content_policy_violation: "INVALID_REQUEST",

  // Legacy QwenProxyError types (src/core/errors.ts).
  invalid_request_error: "INVALID_REQUEST",
  authentication_error: "AUTHENTICATION_FAILED",
  permission_error: "AUTHENTICATION_FAILED",
  not_found_error: "SESSION_NOT_FOUND",
  rate_limit_error: "ACCOUNT_COOLDOWN",
  upstream_error: "UPSTREAM_UNAVAILABLE",
  timeout_error: "UPSTREAM_TIMEOUT",
  internal_error: "INTERNAL_ERROR",
  request_aborted: "GENERATION_CANCELLED",
  service_unavailable: "SERVICE_BUSY",

  // Upstream response codes classified in src/api/error-classifier.ts.
  quota_limit: "ACCOUNT_COOLDOWN",
  ratelimited: "ACCOUNT_COOLDOWN",
  rate_limit: "ACCOUNT_COOLDOWN",
  quota_exceeded: "ACCOUNT_COOLDOWN",
  usage_limit: "ACCOUNT_COOLDOWN",
  data_inspection_failed: "INVALID_REQUEST",
};

/**
 * Maps a legacy error code or type onto the canonical {@link ErrorCode}. Codes
 * are more specific than types, so callers should pass the code when available.
 * Unrecognized values fall back to INTERNAL_ERROR.
 */
export function legacyCodeToErrorCode(legacyTypeOrCode: string): ErrorCode {
  return LEGACY_TO_ERROR_CODE[legacyTypeOrCode] ?? "INTERNAL_ERROR";
}

/**
 * Typed runtime error for the domain layer. Uses the canonical {@link ErrorCode}
 * canon rather than the legacy QwenProxyStatusCode union, which cannot express
 * 409 (SESSION_BUSY / SESSION_CONFLICT).
 */
export class TypedRuntimeError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TypedRuntimeError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_ERROR_CODE[code];
    this.details = details;
  }

  static fromCode(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ): TypedRuntimeError {
    return new TypedRuntimeError(code, message ?? code, details);
  }
}
