import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getStorageStatePath,
  loadStorageState,
  getRestorableCookies,
  isTokenCookieJwtExpired,
  saveStorageState,
  isPlaywrightAlreadyClosedError,
  isPageLoggedIn,
  cleanupOrphanProfiles,
} from "../services/playwright.ts";
test("Playwright Storage State: getStorageStatePath returns storage_state.json inside profile path", () => {
  const accountId = "test-acc-123";
  const statePath = getStorageStatePath(accountId);
  assert.ok(statePath.endsWith("storage_state.json"));
  assert.ok(statePath.includes(accountId));
});

test("Playwright Storage State: loadStorageState returns undefined when file does not exist", () => {
  const nonExistent = loadStorageState("non-existent-account-999");
  assert.equal(nonExistent, undefined);
});

test("Playwright Storage State: loadStorageState validates JSON and cookies array", () => {
  const accountId = "storage-test-acc";
  const statePath = getStorageStatePath(accountId);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    // 1. Invalid structure
    fs.writeFileSync(statePath, JSON.stringify({ invalid: true }));
    assert.equal(loadStorageState(accountId), undefined);

    // 2. Valid structure with cookies
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [{ name: "token", value: "abc" }], origins: [] }));
    const loaded = loadStorageState(accountId);
    assert.ok(loaded);
    assert.equal(loaded, statePath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("isTokenCookieJwtExpired parses JWT exp and ignores opaque tokens", () => {
  const past = makeJwt(Math.floor(Date.now() / 1000) - 60);
  const future = makeJwt(Math.floor(Date.now() / 1000) + 3600);

  assert.equal(isTokenCookieJwtExpired({ name: "token", value: past }), true);
  assert.equal(isTokenCookieJwtExpired({ name: "token", value: future }), false);
  // Opaque / non-JWT values must never be treated as expired.
  assert.equal(isTokenCookieJwtExpired({ name: "token", value: "opaque-value" }), false);
  assert.equal(isTokenCookieJwtExpired({ name: "acw_tc", value: past }), false);
  // URL-encoded JWT (cookie values can be percent-encoded).
  assert.equal(isTokenCookieJwtExpired({ name: "token", value: encodeURIComponent(past) }), true);
});

test("getRestorableCookies drops expired cookies and expired-token JWTs", () => {
  const accountId = "restore-test-acc";
  const statePath = getStorageStatePath(accountId);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const pastToken = makeJwt(Math.floor(Date.now() / 1000) - 60);
    const futureToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        cookies: [
          { name: "token", value: pastToken, expires: -1 },
          { name: "session", value: futureToken, expires: -1 },
          { name: "acw_tc", value: "risk-cookie", expires: 9999999999 },
          { name: "expired_http", value: "x", expires: Math.floor(Date.now() / 1000) - 10 },
        ],
        origins: [],
      }),
    );

    const restorable = getRestorableCookies(accountId);
    const names = restorable.map((c) => c.name).sort();
    assert.deepEqual(names, ["acw_tc", "session"], "expired token and expired http cookies must be filtered out");
    // A dead-only-token backup is unusable: full state must be refused so the
    // caller re-logs-in with credentials instead of dragging the stale cookie in.
    const deadAccountId = "restore-expired-token-acc";
    const deadStatePath = getStorageStatePath(deadAccountId);
    fs.mkdirSync(path.dirname(deadStatePath), { recursive: true });
    fs.writeFileSync(
      deadStatePath,
      JSON.stringify({ cookies: [{ name: "token", value: pastToken, expires: -1 }], origins: [] }),
    );
    assert.equal(getRestorableCookies(deadAccountId).length, 0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("loadStorageState refuses a stale storage state beyond its TTL", () => {
  const accountId = "stale-test-acc";
  const statePath = getStorageStatePath(accountId);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ cookies: [{ name: "token", value: "abc", expires: -1 }], origins: [] }),
    );
    const oldMtime = Math.floor((Date.now() - 10_000) / 1000);
    fs.utimesSync(statePath, oldMtime, oldMtime);

    // Older than the 5s budget -> treated as an expired session.
    assert.equal(loadStorageState(accountId, 5_000), undefined);
    // Within the 60s budget -> reusable.
    const loaded = loadStorageState(accountId, 60_000);
    assert.ok(loaded);
    assert.equal(loaded, statePath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("Playwright Storage State: saveStorageState bounds hung storageState call with timeout", async () => {
  const accountId = "hang-test-acc";
  const fakeContext: any = {
    storageState: () => new Promise(() => {}), // never resolves
  };
  const start = Date.now();
  await saveStorageState(fakeContext, accountId);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 2000 && elapsed < 8000, `must time out within ~5s, took ${elapsed}ms`);
});

test("Playwright already-closed error detection", () => {
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Browser has been closed")), true);
  assert.equal(isPlaywrightAlreadyClosedError(new Error("Some random network failure")), false);
  assert.equal(isPlaywrightAlreadyClosedError({ type: "closed", message: "Protocol error (Network.setCacheDisabled): Internal server error, session closed." }), true);
});

test("isPageLoggedIn detects authenticated session via API/DOM and rejects unauthenticated", async () => {
  const authUrlPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/auth?redirect=/",
  };
  assert.equal(await isPageLoggedIn(authUrlPage), false);

  const loginUrlPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/login",
  };
  assert.equal(await isPageLoggedIn(loginUrlPage), false);

  const loggedOutApiPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async (fn: any) => false,
  };
  assert.equal(await isPageLoggedIn(loggedOutApiPage), false);

  const loggedInApiPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async (fn: any) => true,
  };
  assert.equal(await isPageLoggedIn(loggedInApiPage), true);

  const closedPage: any = {
    isClosed: () => true,
    url: () => "https://chat.qwen.ai/",
  };
  assert.equal(await isPageLoggedIn(closedPage), false);
});
test("isPageLoggedIn bounds a hanging in-page probe instead of waiting forever", async () => {
  // page.evaluate ignores Playwright's default timeouts: on a WAF-blocked page
  // the in-page fetch can stay pending indefinitely. The probe must time out.
  const hangingPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: () => new Promise<boolean>(() => {}),
  };

  const startedAt = Date.now();
  assert.equal(await isPageLoggedIn(hangingPage, 1_000), false);
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed >= 900 && elapsed < 5_000,
    `probe must fail at its bound, took ${elapsed}ms`,
  );
});
test("cleanupOrphanProfiles removes directories not belonging to active accounts and stale dirs", () => {
  const tempBase = path.join(process.cwd(), ".tmp", "test-profiles-" + Date.now());
  fs.mkdirSync(tempBase, { recursive: true });

  try {
    // 1. Create active account folder
    const activeDir = path.join(tempBase, "active-acc-1");
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, "storage_state.json"), "{}");

    // 2. Create orphan folder (not in accounts)
    const orphanDir = path.join(tempBase, "orphan-acc-99");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "junk.txt"), "hello orphan");

    // 3. Create stale folder
    const staleDir = path.join(tempBase, "active-acc-1.stale-12345");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "old.txt"), "old data");

    const activeSet = new Set(["active-acc-1"]);
    const result = cleanupOrphanProfiles(tempBase, activeSet);
    // Active folder should still exist
    assert.equal(fs.existsSync(activeDir), true, "active account folder must be preserved");
    // Orphan and stale folders should be removed
    assert.equal(fs.existsSync(orphanDir), false, "orphan folder must be deleted");
    assert.equal(fs.existsSync(staleDir), false, "stale folder must be deleted");
    assert.equal(result.removedCount, 2, "must report 2 removed directories");
    assert.ok(result.freedBytes > 0, "must report freed bytes > 0");
  } finally {
    try { fs.rmSync(tempBase, { recursive: true, force: true }); } catch {}
  }
});
