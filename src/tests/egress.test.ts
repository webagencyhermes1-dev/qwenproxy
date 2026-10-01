import test from "node:test";
import assert from "node:assert/strict";
import { validateEgressUrl, fetchUserMedia } from "../utils/egress.ts";
import { ValidationError } from "../core/errors.ts";

const PUBLIC_IP_URL = "https://93.184.216.34/file.png";
const resolvePublic = async () => ["93.184.216.34"];

function saveEnv() {
  return {
    allow: process.env.EGRESS_MEDIA_ALLOWLIST,
    http: process.env.EGRESS_ALLOW_HTTP,
    timeout: process.env.EGRESS_FETCH_TIMEOUT_MS,
    max: process.env.EGRESS_MAX_BYTES,
  };
}

function restoreEnv(saved: ReturnType<typeof saveEnv>) {
  if (saved.allow === undefined) delete process.env.EGRESS_MEDIA_ALLOWLIST;
  else process.env.EGRESS_MEDIA_ALLOWLIST = saved.allow;
  if (saved.http === undefined) delete process.env.EGRESS_ALLOW_HTTP;
  else process.env.EGRESS_ALLOW_HTTP = saved.http;
  if (saved.timeout === undefined) delete process.env.EGRESS_FETCH_TIMEOUT_MS;
  else process.env.EGRESS_FETCH_TIMEOUT_MS = saved.timeout;
  if (saved.max === undefined) delete process.env.EGRESS_MAX_BYTES;
  else process.env.EGRESS_MAX_BYTES = saved.max;
}

async function rejectsWithHost(fn: () => Promise<unknown>, host: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
    assert.match((err as Error).message, new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
}

test("rejects http: scheme by default", async () => {
  const saved = saveEnv();
  delete process.env.EGRESS_ALLOW_HTTP;
  try {
    await rejectsWithHost(
      () => validateEgressUrl("http://example.com/img.png", { resolve: resolvePublic }),
      "example.com",
    );
  } finally {
    restoreEnv(saved);
  }
});

test("allows http: only when EGRESS_ALLOW_HTTP=true", async () => {
  const saved = saveEnv();
  process.env.EGRESS_ALLOW_HTTP = "true";
  try {
    const parsed = await validateEgressUrl("http://example.com/img.png", {
      resolve: resolvePublic,
    });
    assert.strictEqual(parsed.protocol, "http:");
  } finally {
    restoreEnv(saved);
  }
});

test("rejects non-https schemes", async () => {
  await rejectsWithHost(
    () => validateEgressUrl("ftp://example.com/file", { resolve: resolvePublic }),
    "example.com",
  );
});

test("rejects 127.0.0.1 loopback literal", async () => {
  await rejectsWithHost(() => validateEgressUrl("https://127.0.0.1/x"), "127.0.0.1");
});

test("rejects 169.254.169.254 cloud-metadata literal", async () => {
  await rejectsWithHost(
    () => validateEgressUrl("https://169.254.169.254/latest/meta-data/"),
    "169.254.169.254",
  );
});

test("rejects 10/8 private literal", async () => {
  await rejectsWithHost(() => validateEgressUrl("https://10.0.0.5/x"), "10.0.0.5");
});

test("rejects 192.168/16 and 172.16/12 literals", async () => {
  await rejectsWithHost(() => validateEgressUrl("https://192.168.1.10/x"), "192.168.1.10");
  await rejectsWithHost(() => validateEgressUrl("https://172.16.5.4/x"), "172.16.5.4");
});

test("rejects IPv6 ::1 loopback literal", async () => {
  await rejectsWithHost(() => validateEgressUrl("https://[::1]/x"), "::1");
});

test("rejects decimal-octet bypass 2130706433 (=127.0.0.1)", async () => {
  // WHATWG URL normalizes the numeric host to 127.0.0.1 before we see it.
  await rejectsWithHost(() => validateEgressUrl("https://2130706433/x"), "127.0.0.1");
});

test("rejects hostnames resolving to private IPs", async () => {
  await rejectsWithHost(
    () =>
      validateEgressUrl("https://internal.example.com/x", {
        resolve: async () => ["10.1.2.3"],
      }),
    "internal.example.com",
  );
});

test("enforces EGRESS_MEDIA_ALLOWLIST", async () => {
  const saved = saveEnv();
  process.env.EGRESS_MEDIA_ALLOWLIST = "cdn.allowed.com";
  try {
    await rejectsWithHost(
      () =>
        validateEgressUrl("https://other.example.com/x", { resolve: resolvePublic }),
      "other.example.com",
    );
    const ok = await validateEgressUrl("https://cdn.allowed.com/x", {
      resolve: resolvePublic,
    });
    assert.strictEqual(ok.hostname, "cdn.allowed.com");
  } finally {
    restoreEnv(saved);
  }
});

test("rejects redirect target resolving to private IP", async () => {
  // Manual-redirect hops are re-validated with the same helper.
  await rejectsWithHost(() => validateEgressUrl("https://127.0.0.1/secret"), "127.0.0.1");
});

test("fetchUserMedia refuses redirect to private IP", async () => {
  const saved = saveEnv();
  delete process.env.EGRESS_MEDIA_ALLOWLIST;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/secret" },
    })) as typeof fetch;
  try {
    await rejectsWithHost(() => fetchUserMedia(PUBLIC_IP_URL), "127.0.0.1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test("fetchUserMedia enforces content-length up front", async () => {
  const saved = saveEnv();
  delete process.env.EGRESS_MEDIA_ALLOWLIST;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("x", {
      status: 200,
      headers: { "content-length": String(26 * 1024 * 1024) },
    })) as typeof fetch;
  try {
    await rejectsWithHost(() => fetchUserMedia(PUBLIC_IP_URL), "93.184.216.34");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test("fetchUserMedia caps streamed bytes", async () => {
  const saved = saveEnv();
  delete process.env.EGRESS_MEDIA_ALLOWLIST;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("a".repeat(100), { status: 200 })) as typeof fetch;
  try {
    await rejectsWithHost(
      () => fetchUserMedia(PUBLIC_IP_URL, { maxBytes: 10 }),
      "93.184.216.34",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});

test("fetchUserMedia returns small public bodies", async () => {
  const saved = saveEnv();
  delete process.env.EGRESS_MEDIA_ALLOWLIST;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("hello", {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as typeof fetch;
  try {
    const res = await fetchUserMedia(PUBLIC_IP_URL);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), "hello");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(saved);
  }
});
