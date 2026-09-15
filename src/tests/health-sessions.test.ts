import assert from "node:assert/strict";
import test from "node:test";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.ts";
import { getStickyMap, STICKY_TTL_MS } from "../services/session/stickyMap.ts";

test("health/sessions reports accurate counts", async () => {
  const sm = getStickyMap();
  // Isolate: clear then add known bindings.
  for (const e of sm.entries()) sm.delete(e.key);
  const now = Date.now();
  sm.set("aaaaaaaaaaaaaaaa", {
    accountId: "acc-a",
    proxyId: null,
    boundAt: now,
    lastUsedAt: now,
    ttlMs: STICKY_TTL_MS,
  });
  sm.set("bbbbbbbbbbbbbbbb", {
    accountId: "acc-b",
    proxyId: null,
    boundAt: now,
    lastUsedAt: now,
    ttlMs: STICKY_TTL_MS,
  });
  sm.rebind("aaaaaaaaaaaaaaaa", "acc-c", null);
  try {
    const res = await app.fetch(new Request("http://localhost/health/sessions"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      size: number;
      activeBindings: number;
      rebindsLastHour: number;
    };
    assert.equal(body.size, 2);
    assert.equal(body.activeBindings, 2);
    assert.ok(body.rebindsLastHour >= 1);
  } finally {
    sm.delete("aaaaaaaaaaaaaaaa");
    sm.delete("bbbbbbbbbbbbbbbb");
  }
});
