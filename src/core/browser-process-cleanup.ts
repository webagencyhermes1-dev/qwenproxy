/**
 * Browser process hygiene (startup reaper + shutdown killer).
 *
 * Playwright launches one persistent-context Chromium per account. Those
 * children are NOT tied to the lifetime of the Node process that spawned them:
 *
 *  - a hard kill of the server (TerminateProcess / SIGKILL / OOM) skips every
 *    graceful close path, so dozens of `chrome-headless-shell` processes keep
 *    their RSS after the parent is gone;
 *  - a `context.close()` that times out can leave the browser main process
 *    alive with its renderers.
 *
 * This module closes both holes without depending on Playwright internals:
 * child browser processes are found from the OS process table by parent PID
 * (plus, for the escalation path, by the profile dir on the command line), so
 * it works even when the Playwright objects are already gone.
 *
 * Policy:
 *  - `reapOrphanBrowserProcesses()` runs once before the FIRST context launch
 *    of a run (i.e. before warmup) and kills browser processes whose parent no
 *    longer exists (or was reparented to init). A live parent is never touched,
 *    so a second proxy instance or a concurrent test run keeps its browsers.
 *  - `installBrowserProcessExitCleanup()` arms a synchronous killer for
 *    `process.on("exit")` plus a delayed force-kill on SIGINT/SIGTERM, so a
 *    graceful shutdown that stalls still frees the browser RSS.
 *  - Cross-process reaping is suppressed under the test runner (it would scan
 *    and could kill browsers belonging to a concurrently running suite);
 *    killing THIS process's own children on exit is always active.
 */

import { execFile, spawnSync } from "node:child_process";
import { isRunningUnderNodeTest } from "./paths.ts";

export interface BrowserProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

/** Names of the browser processes the proxy can spawn (persistent contexts). */
const BROWSER_NAME_RE = /(chrome|headless[_-]?shell|msedge|chromium)/i;

export function isBrowserProcessName(name: string): boolean {
  return BROWSER_NAME_RE.test(name ?? "");
}

/**
 * Decide which browser processes are orphans.
 *
 * - a process whose parent is this process is ours: it is handled by the
 *   shutdown path (still alive here), not by the startup reaper;
 * - ppid 0 means "parent unknown" — never reaped on that basis;
 * - on POSIX the kernel reparents orphans to init (pid 1), which is therefore
 *   the orphan signal there (`reparentedToInitCounts`);
 * - otherwise the browser is an orphan exactly while its parent process no
 *   longer exists (on Windows the orphan keeps the dead parent's PID forever,
 *   so liveness has to be probed).
 *
 * Pure on purpose: the process-table scan and the liveness probe are the only
 * impure parts, so this classification is unit-testable.
 */
export function selectOrphanBrowserProcesses(
  records: readonly BrowserProcessRecord[],
  options: {
    selfPid: number;
    isAlive: (pid: number) => boolean;
    reparentedToInitCounts?: boolean;
  },
): BrowserProcessRecord[] {
  return records.filter((record) => {
    if (!isBrowserProcessName(record.name)) return false;
    if (record.pid === options.selfPid) return false;
    if (record.ppid === options.selfPid) return false;
    if (record.ppid <= 0) return false;
    if (record.ppid <= 1) return options.reparentedToInitCounts === true;
    return !options.isAlive(record.ppid);
  });
}

function parseWindowsProcessTable(stdout: string): BrowserProcessRecord[] {
  const records: BrowserProcessRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    records.push({
      pid,
      ppid,
      name: parts[2] ?? "",
      commandLine: parts.slice(3).join("\t"),
    });
  }
  return records;
}

function parsePsProcessTable(stdout: string): BrowserProcessRecord[] {
  const records: BrowserProcessRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    records.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      name: match[3],
      commandLine: match[4] ?? "",
    });
  }
  return records;
}

const POWERSHELL_QUERY = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$ErrorActionPreference='SilentlyContinue';" +
    "Get-CimInstance Win32_Process |" +
    "Where-Object { $_.Name -match 'chrome|headless_shell|msedge|chromium' } |" +
    "ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
];

/** Best-effort snapshot of every browser process on the machine. */
export async function listBrowserProcesses(): Promise<BrowserProcessRecord[]> {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? execFile(
            "powershell.exe",
            POWERSHELL_QUERY,
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
            (error, stdout) => {
              if (error) return resolve([]);
              resolve(parseWindowsProcessTable(String(stdout ?? "")));
            },
          )
        : execFile(
            "ps",
            ["-eo", "pid=,ppid=,comm=,args="],
            { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
            (error, stdout) => {
              if (error) return resolve([]);
              resolve(parsePsProcessTable(String(stdout ?? "")));
            },
          );
    child.on("error", () => resolve([]));
  });
}

function listBrowserProcessesSync(): BrowserProcessRecord[] {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", POWERSHELL_QUERY, {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
        encoding: "utf8",
      });
      if (result.status !== 0 || !result.stdout) return [];
      return parseWindowsProcessTable(result.stdout);
    }
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
      encoding: "utf8",
    });
    if (result.status !== 0 || !result.stdout) return [];
    return parsePsProcessTable(result.stdout);
  } catch {
    return [];
  }
}

/** Kill one process together with its descendants (Chromium forks renderers). */
export function killBrowserProcessTree(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
        stdio: "ignore",
      });
      return (result.status ?? 1) === 0;
    }
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Cross-process reaping is skipped under the test runner by default. */
export function isOrphanReapSuppressed(): boolean {
  if (process.env.PLAYWRIGHT_ORPHAN_REAP === "false") return true;
  if (process.env.PLAYWRIGHT_ORPHAN_REAP === "always") return false;
  return Boolean(process.env.NODE_TEST_CONTEXT) || isRunningUnderNodeTest();
}

export interface ReapResult {
  scanned: number;
  killed: number;
  pids: number[];
  suppressed: boolean;
}

/**
 * Kill browser processes whose owning parent process no longer exists —
 * leftovers of a crashed/killed run of this proxy (or of anything else that
 * spawned Chromium and died). Runs once per process, before the first context
 * launch, so a stale 7 GB of chrome-headless-shell is reclaimed before warmup
 * starts adding new browsers.
 */
export async function reapOrphanBrowserProcesses(
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<ReapResult> {
  if (!options.force && isOrphanReapSuppressed()) {
    return { scanned: 0, killed: 0, pids: [], suppressed: true };
  }
  const records = await listBrowserProcesses();
  const orphans = selectOrphanBrowserProcesses(records, {
    selfPid: process.pid,
    isAlive: isPidAlive,
    reparentedToInitCounts: process.platform !== "win32",
  });

  const killed: number[] = [];
  for (const orphan of orphans) {
    if (options.dryRun) continue;
    if (killBrowserProcessTree(orphan.pid)) killed.push(orphan.pid);
  }
  if (killed.length > 0) {
    console.warn(
      `🧹 [BrowserCleanup] Reaped ${killed.length} orphaned browser process(es) from a previous run | pids=${killed.join(",")}`,
    );
  }
  return {
    scanned: records.length,
    killed: killed.length,
    pids: options.dryRun ? orphans.map((orphan) => orphan.pid) : killed,
    suppressed: false,
  };
}

/**
 * Kill the browser processes launched FOR ONE PROFILE by this process. Used to
 * escalate a `context.close()` timeout into a guaranteed process kill instead
 * of hanging: Playwright always passes `--user-data-dir=<profile>` on the
 * browser command line, which identifies the process even when the Playwright
 * object is wedged.
 */
export async function killBrowserProcessesForProfile(
  profilePath: string,
): Promise<number> {
  if (!profilePath) return 0;
  const records = await listBrowserProcesses();
  const needle = profilePath.replace(/\\/g, "/").toLowerCase();
  // Roots: browsers THIS process launched for this profile (Playwright always
  // passes --user-data-dir=<profile>), so another instance's browsers of the
  // same profile are never touched.
  const roots = records.filter(
    (record) =>
      record.ppid === process.pid &&
      isBrowserProcessName(record.name) &&
      record.commandLine.replace(/\\/g, "/").toLowerCase().includes(needle),
  );
  if (roots.length === 0) return 0;

  // Collect the descendants too: on POSIX a plain SIGKILL of the root would
  // leave its renderers behind, and on Windows the profile switch may not be
  // repeated on every renderer's command line.
  const byParent = new Map<number, BrowserProcessRecord[]>();
  for (const record of records) {
    const children = byParent.get(record.ppid) ?? [];
    children.push(record);
    byParent.set(record.ppid, children);
  }
  const targets: number[] = [];
  const seen = new Set<number>();
  const queue = roots.map((root) => root.pid);
  for (const pid of queue) seen.add(pid);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    targets.push(pid);
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
    }
  }

  let killed = 0;
  for (const pid of targets) {
    if (killBrowserProcessTree(pid)) killed++;
  }
  return killed;
}

/** Kill every browser process this process spawned (no scan needed beyond it). */
export function killChildBrowserProcessesSync(): number {
  const records = listBrowserProcessesSync();
  const children = records.filter(
    (record) => record.ppid === process.pid && isBrowserProcessName(record.name),
  );
  let killed = 0;
  for (const child of children) {
    if (killBrowserProcessTree(child.pid)) killed++;
  }
  return killed;
}

let exitCleanupInstalled = false;
let signalForceKillTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm the process-lifetime hooks:
 *  - `exit`: synchronous kill of the browser children (the only hook that runs
 *    when the graceful path calls process.exit());
 *  - SIGINT/SIGTERM: if the graceful shutdown has not finished within
 *    `forceKillAfterMs`, the browser children are killed anyway so a stalled
 *    close cannot keep hundreds of MB resident.
 * Idempotent; safe to call from every launch path.
 */
export function installBrowserProcessExitCleanup(
  options: { forceKillAfterMs?: number } = {},
): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;

  process.on("exit", () => {
    try {
      const killed = killChildBrowserProcessesSync();
      if (killed > 0) {
        console.warn(
          `🧹 [BrowserCleanup] Killed ${killed} browser child process(es) on exit`,
        );
      }
    } catch {
      // Exit handlers must never throw.
    }
  });

  const forceKillAfterMs = options.forceKillAfterMs ?? 15_000;
  const armForceKill = (): void => {
    if (signalForceKillTimer) return;
    signalForceKillTimer = setTimeout(() => {
      try {
        const killed = killChildBrowserProcessesSync();
        if (killed > 0) {
          console.warn(
            `🧹 [BrowserCleanup] Graceful shutdown still running after ${forceKillAfterMs}ms: force-killed ${killed} browser child process(es)`,
          );
        }
      } catch {
        // Best-effort.
      }
    }, forceKillAfterMs);
    signalForceKillTimer.unref?.();
  };
  process.on("SIGINT", armForceKill);
  process.on("SIGTERM", armForceKill);
}

let startupReapPromise: Promise<ReapResult> | null = null;

/**
 * Once-per-process startup hygiene: install the exit hooks and reap browsers
 * orphaned by a previous run. Awaited by every launch path, so it completes
 * before the first warmup launch.
 */
export function ensureBrowserProcessHygiene(): Promise<ReapResult> {
  installBrowserProcessExitCleanup();
  if (!startupReapPromise) {
    startupReapPromise = reapOrphanBrowserProcesses().catch(
      (): ReapResult => ({ scanned: 0, killed: 0, pids: [], suppressed: false }),
    );
  }
  return startupReapPromise;
}
