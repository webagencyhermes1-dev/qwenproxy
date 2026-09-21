import { test } from "node:test";
import assert from "node:assert/strict";
test("probe argv", async () => {
  console.log("ARGV=", JSON.stringify(process.argv));
  const orig = process.argv;
  try {
    (process as any).argv = ["node", "server.js"];
    console.log("REASSIGNED_OK=", JSON.stringify(process.argv));
  } finally {
    (process as any).argv = orig;
  }
  const { getBasicHeaders } = await import("../services/auth-playwright.ts");
  const { AuthError } = await import("../core/errors.ts");
  const o2 = process.argv;
  try {
    (process as any).argv = ["node", "server.js"];
    delete process.env.TEST_MOCK_QWEN_AUTH;
    await assert.rejects(() => getBasicHeaders("probe-cold"), (e: any) => {
      console.log("ERR_NAME=", e?.constructor?.name, "MSG=", e?.message, "ISAUTH=", e instanceof AuthError);
      return true;
    });
  } finally {
    (process as any).argv = o2;
  }
});
