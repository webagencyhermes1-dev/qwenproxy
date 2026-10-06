import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBrowserProcessName,
  isOrphanReapSuppressed,
  reapOrphanBrowserProcesses,
  selectOrphanBrowserProcesses,
  type BrowserProcessRecord,
} from "./browser-process-cleanup.ts";

const SELF_PID = 1000;

function record(
  overrides: Partial<BrowserProcessRecord>,
): BrowserProcessRecord {
  return {
    pid: 10,
    ppid: 20,
    name: "chrome-headless-shell.exe",
    commandLine: "chrome-headless-shell.exe --user-data-dir=C:\\profiles\\acct",
    ...overrides,
  };
}

test("browser process names: chromium family only", () => {
  assert.equal(isBrowserProcessName("chrome.exe"), true);
  assert.equal(isBrowserProcessName("chrome-headless-shell.exe"), true);
  assert.equal(isBrowserProcessName("headless_shell"), true);
  assert.equal(isBrowserProcessName("msedge.exe"), true);
  assert.equal(isBrowserProcessName("chromium"), true);
  assert.equal(isBrowserProcessName("node.exe"), false);
  assert.equal(isBrowserProcessName("powershell.exe"), false);
  assert.equal(isBrowserProcessName("notepad.exe"), false);
});

test("orphan selection: dead parent is an orphan, live parent is not", () => {
  const alive = new Set<number>([20]);
  const orphans = selectOrphanBrowserProcesses(
    [record({ pid: 1, ppid: 20 }), record({ pid: 2, ppid: 30 })],
    { selfPid: SELF_PID, isAlive: (pid) => alive.has(pid) },
  );
  assert.deepEqual(
    orphans.map((o) => o.pid),
    [2],
  );
});

test("orphan selection: never touches non-browser, our own children, or self", () => {
  const orphans = selectOrphanBrowserProcesses(
    [
      record({ pid: 1, ppid: 30, name: "node.exe" }),
      record({ pid: 2, ppid: 30 }),
      record({ pid: 3, ppid: SELF_PID }),
      record({ pid: SELF_PID, ppid: 30 }),
    ],
    { selfPid: SELF_PID, isAlive: () => false },
  );
  assert.deepEqual(
    orphans.map((o) => o.pid),
    [2],
  );
});

test("orphan selection: unknown parent (ppid 0) is never reaped", () => {
  const orphans = selectOrphanBrowserProcesses([record({ ppid: 0 })], {
    selfPid: SELF_PID,
    isAlive: () => false,
  });
  assert.equal(orphans.length, 0);
});

test("orphan selection: reparent-to-init only counts as orphan on POSIX", () => {
  const options = { selfPid: SELF_PID, isAlive: () => true };
  const posixOrphans = selectOrphanBrowserProcesses([record({ ppid: 1 })], {
    ...options,
    reparentedToInitCounts: true,
  });
  const windowsOrphans = selectOrphanBrowserProcesses([record({ ppid: 1 })], {
    ...options,
    reparentedToInitCounts: false,
  });
  assert.equal(posixOrphans.length, 1);
  assert.equal(windowsOrphans.length, 0);
});

test("orphan selection: Windows-style orphan keeps the dead parent's PID", () => {
  const orphans = selectOrphanBrowserProcesses([record({ ppid: 4321 })], {
    selfPid: SELF_PID,
    isAlive: () => false,
  });
  assert.equal(orphans.length, 1);
});

test("reap is suppressed under the test runner unless forced", () => {
  assert.equal(isOrphanReapSuppressed(), true);
});

test("dry-run reap scans without killing anything", async () => {
  const before = await reapOrphanBrowserProcesses({ force: true, dryRun: true });
  assert.equal(before.suppressed, false);
  assert.equal(before.killed, 0);
  assert.ok(Number.isFinite(before.scanned));
  assert.ok(Array.isArray(before.pids));

  const suppressed = await reapOrphanBrowserProcesses();
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.killed, 0);
});
