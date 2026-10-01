// Test-count contract (Phase 0 safety net).
//
// Runs the hermetic suites and asserts (a) zero failures and (b) the total
// test count never shrinks below the pinned baselines. Catches silent test
// deletions, suites dropped from package.json, and runner misconfigurations
// that a plain "exit 0" would hide.
//
// Usage: node scripts/test-contract.mjs
// Baselines pinned 2026-10-01 (end of Phase 3: +31 new mock tests — 8
// rate-limit, 7 observability, 16 durability): mock=1039, runtime=164.

import { spawnSync } from "node:child_process";

const BASELINES = {
  "test:mock": 1039,
  "test:runtime": 164,
};

function runSuite(script) {
  const res = spawnSync("npm", ["run", script], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    // Windows resolves npm via npm.cmd — requires a shell.
    shell: process.platform === "win32",
  });
  if (res.error) {
    return `SPAWN_ERROR: ${res.error.message}`;
  }
  return (res.stdout ?? "") + (res.stderr ?? "");
}

function parseSummary(output) {
  // node:test prints one final summary block; take the LAST occurrence.
  const pick = (re) => {
    const matches = [...output.matchAll(re)];
    return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
  };
  return {
    tests: pick(/ℹ tests (\d+)/g),
    pass: pick(/ℹ pass (\d+)/g),
    fail: pick(/ℹ fail (\d+)/g),
  };
}

let failed = false;
for (const [script, baseline] of Object.entries(BASELINES)) {
  console.log(`\n=== contract: ${script} (baseline ${baseline}) ===`);
  const output = runSuite(script);
  const { tests, pass, fail } = parseSummary(output);
  console.log(`tests=${tests} pass=${pass} fail=${fail}`);
  if (tests === null || pass === null || fail === null) {
    console.error(`CONTRACT FAIL: could not parse summary for ${script}`);
    failed = true;
    continue;
  }
  if (fail !== 0) {
    console.error(`CONTRACT FAIL: ${script} has ${fail} failing test(s)`);
    failed = true;
  }
  if (tests < baseline) {
    console.error(
      `CONTRACT FAIL: ${script} shrank ${baseline} -> ${tests} (tests removed?)`,
    );
    failed = true;
  }
}

if (failed) {
  console.error("\nTest-count contract FAILED");
  process.exit(1);
}
console.log("\nTest-count contract PASSED");
