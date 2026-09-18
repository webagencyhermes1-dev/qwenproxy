export const isSessionVersioningEnabled = (): boolean => false;
export const DEFAULT_TENANT_ID = 'default';
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';
export const SESSION_GENERATION_DEADLINE_MS = 60000;
export const SESSION_VERSIONING_ENDPOINT_CHAT = '/v1/chat/completions';
export type SessionStreamCommit = any;
export const getSharedSessionService = (): any => ({ resolveSession: () => Promise.resolve({ session: { sessionId: '' } }), beginGeneration: () => Promise.resolve({ ok: false }) });
export const scopedIdempotencyKey = (_: string, __: string) => '';
