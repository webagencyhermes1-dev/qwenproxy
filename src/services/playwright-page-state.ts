import type { Page } from "patchright";

/**
 * Live Playwright context registry (accountId -> open page), deliberately kept
 * in its own leaf module.
 *
 * Readiness and header-resolution code in core/ needs these two probes, but
 * importing services/playwright.ts for them closes the cycle
 *
 *   core/waf-isolation -> core/account-manager -> services/playwright
 *     -> core/waf-isolation
 *
 * and, depending on which module enters the cycle first, evaluates the
 * setWafContextResetListener call at module scope while core/waf-isolation is
 * still initializing — a TDZ `ReferenceError: Cannot access
 * 'contextResetListener' before initialization` (reproduced by
 * src/tests/waf-isolation.test.ts). Querying state must never require loading
 * the browser layer.
 */
export const accountPages = new Map<string, Page>();

export function isPlaywrightInitialized(accountId: string): boolean {
  return accountPages.has(accountId);
}

export function isPlaywrightPageAlive(accountId: string): boolean {
  const page = accountPages.get(accountId);
  return page !== undefined && !page.isClosed();
}
