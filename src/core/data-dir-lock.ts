/**
 * Single-replica guard for the data dir.
 *
 * Two live servers sharing one data dir double-book accounts (leases are
 * per-process) and race SQLite writers, so the first process to boot writes
 * `server.pid` and every later start resolves that holder before touching
 * shared state:
 *
 *   dead pid       -> stale lock from a crashed run, reclaimed
 *   foreign pid    -> the pid was recycled by an unrelated process, reclaimed
 *                     (never killed — we only ever terminate what we verified)
 *   live QwenProxy -> taken over: clean HTTP handover, then SIGTERM, then the
 *                     process tree. Set QWEN_LOCK_TAKEOVER=false to restore the
 *                     old refuse-to-start behaviour instead.
 *
 * A holder is identified by pid + process start time, plus its command line
 * for legacy bare-pid lockfiles. The start time is what makes recycled pids
 * safe: a pid alone cannot distinguish a predecessor from any other process
 * that happened to be assigned the same number.
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { getDataDir } from "./paths.ts";

export interface DataDirLockRecord {
  pid: number;
  /** Epoch ms of the holder's process start; NaN for legacy bare-pid locks. */
  startedAt: number;
  port?: number;
  host?: string;
}

export interface ClaimDataDirLockOptions {
  port?: number;
  host?: string;
  /** API key presented to the holder's loopback handover endpoint. */
  apiKey?: string;
}

export interface HolderProbe {
  startedAt?: number;
  commandLine?: string;
}

export type HolderIdentity = "verified" | "foreign" | "unknown";

const LOCK_FILE_NAME = "server.pid";
/** Same process, same start time: a few seconds of clock slop is tolerated. */
const START_TIME_TOLERANCE_MS = 5_000;
const HANDOVER_TIMEOUT_MS = 2_000;
const HANDOVER_EXIT_TIMEOUT_MS = 20_000;
const SIGTERM_EXIT_TIMEOUT_MS = 8_000;
const PORT_RELEASE_TIMEOUT_MS = 5_000;
const QWEN_PROXY_CMDLINE_PATTERN = /qwen[-_]?proxy|\bqpx\b/i;

let exitHookInstalled = false;

export function getDataDirLockPath(): string {
  return path.join(getDataDir(), LOCK_FILE_NAME);
}

/** QWEN_LOCK_TAKEOVER=false keeps the old refuse-to-start behaviour. */
export function isTakeoverEnabled(): boolean {
  const raw = (process.env.QWEN_LOCK_TAKEOVER ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "no", "off", "never"].includes(raw);
}

function ownStartEpochMs(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists, but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function parseLockContents(raw: string): DataDirLockRecord | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  if (text.startsWith("{")) {
    let parsed: Partial<DataDirLockRecord>;
    try {
      parsed = JSON.parse(text) as Partial<DataDirLockRecord>;
    } catch {
      return undefined;
    }
    const pid = Number(parsed.pid);
    if (!Number.isFinite(pid) || pid <= 0) return undefined;
    const startedAt = Number(parsed.startedAt);
    const port = Number(parsed.port);
    return {
      pid,
      startedAt: Number.isFinite(startedAt) ? startedAt : NaN,
      port: Number.isFinite(port) && port > 0 ? port : undefined,
      host:
        typeof parsed.host === "string" && parsed.host.trim().length > 0
          ? parsed.host.trim()
          : undefined,
    };
  }

  // Legacy format: a bare pid with no start time to compare against.
  const pid = Number.parseInt(text, 10);
  if (Number.isFinite(pid) && pid > 0) return { pid, startedAt: NaN };
  return undefined;
}

interface LockFileState {
  exists: boolean;
  record?: DataDirLockRecord;
}

function readLockFile(lockPath: string): LockFileState {
  try {
    const record = parseLockContents(fs.readFileSync(lockPath, "utf8"));
    return { exists: true, record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false };
    }
    // Unreadable lock: treat as present-but-unusable so it gets reclaimed.
    return { exists: true };
  }
}

function probeWindows(pid: number): HolderProbe {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    `$g = Get-Process -Id ${pid};` +
    "if ($g) { 'START=' + ([DateTimeOffset]$g.StartTime).ToUnixTimeMilliseconds() };" +
    `$w = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';` +
    "if ($w) { 'CMD=' + $w.CommandLine }";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 8_000 },
  );
  return parseProbeLines(String(result.stdout ?? ""));
}

function parseProbeLines(stdout: string): HolderProbe {
  const probe: HolderProbe = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("START=")) {
      const value = Number(line.slice("START=".length).trim());
      if (Number.isFinite(value) && value > 0) probe.startedAt = value;
    } else if (line.startsWith("CMD=")) {
      probe.commandLine = line.slice("CMD=".length);
    } else if (probe.commandLine !== undefined && line.length > 0) {
      probe.commandLine += line;
    }
  }
  return probe;
}

/** [[dd-]hh:]mm:ss -> seconds, as printed by `ps -o etime=`. */
export function parseEtimeSeconds(raw: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(raw.trim());
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return undefined;
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function probeProcFs(pid: number): HolderProbe | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const cmdline = fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
    const closingParen = stat.lastIndexOf(")");
    const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
    // Field 22 of /proc/<pid>/stat (starttime, in clock ticks since boot) sits
    // at index 19 once pid+comm are consumed; btime pins it to an epoch.
    const starttime = Number(fields[19]);
    const probe: HolderProbe = {};
    if (cmdline) probe.commandLine = cmdline;
    if (Number.isFinite(starttime)) {
      const statInfo = fs.readFileSync("/proc/stat", "utf8");
      const btime = /^btime (\d+)$/m.exec(statInfo);
      if (btime) {
        probe.startedAt = Number(btime[1]) * 1000 + Math.round(starttime * 10);
      }
    }
    return probe;
  } catch {
    return undefined;
  }
}

function probePosix(pid: number): HolderProbe {
  const fromProc = probeProcFs(pid);
  if (fromProc) return fromProc;

  const result = spawnSync("ps", ["-p", String(pid), "-o", "etime=", "-o", "args="], {
    encoding: "utf8",
    timeout: 8_000,
  });
  const output = String(result.stdout ?? "").trim();
  if (!output) return {};

  const separator = output.indexOf(" ");
  const etime = separator === -1 ? output : output.slice(0, separator);
  const args = separator === -1 ? "" : output.slice(separator + 1).trim();
  const seconds = parseEtimeSeconds(etime);
  if (seconds === undefined) {
    return args ? { commandLine: args } : { commandLine: output };
  }
  return {
    startedAt: Date.now() - seconds * 1000,
    commandLine: args || undefined,
  };
}

/**
 * Best-effort identity of another process: start time plus command line.
 * Either may be missing (permissions, missing tooling) — callers must then
 * treat the holder as unverified rather than assume the worst.
 */
export function probeProcess(pid: number): HolderProbe {
  try {
    if (process.platform === "win32") return probeWindows(pid);
    return probePosix(pid);
  } catch {
    return {};
  }
}

export function looksLikeQwenProxyProcess(commandLine?: string): boolean {
  if (!commandLine) return false;
  return QWEN_PROXY_CMDLINE_PATTERN.test(commandLine);
}

/**
 * Decides what the lock's pid actually refers to:
 * - "verified": the pid was probed to have the exact start time the lock was
 *   written with (proof it is the process that claimed this data dir), or —
 *   for a legacy bare-pid lock with no start time to compare — a command line
 *   that is unmistakably QwenProxy.
 * - "foreign":  the pid exists but cannot be our predecessor (recycled pid).
 * - "unknown":  nothing could be probed — never block, never kill.
 */
export function classifyHolder(
  record: DataDirLockRecord,
  probe: HolderProbe,
): HolderIdentity {
  if (Number.isFinite(record.startedAt) && Number.isFinite(probe.startedAt)) {
    const drift = Math.abs(record.startedAt - (probe.startedAt as number));
    return drift <= START_TIME_TOLERANCE_MS ? "verified" : "foreign";
  }
  if (probe.commandLine) {
    return looksLikeQwenProxyProcess(probe.commandLine) ? "verified" : "foreign";
  }
  return "unknown";
}

function describeHolder(record: DataDirLockRecord, probe?: HolderProbe): string {
  const startedAt = Number.isFinite(record.startedAt)
    ? record.startedAt
    : probe?.startedAt;
  const parts = [`pid ${record.pid}`];
  if (Number.isFinite(startedAt)) {
    parts.push(`started ${new Date(startedAt as number).toLocaleString()}`);
  }
  if (record.port) parts.push(`port ${record.port}`);
  return parts.join(", ");
}

function stopCommandFor(pid: number): string {
  return process.platform === "win32"
    ? `taskkill /PID ${pid} /T /F`
    : `kill ${pid}`;
}

function buildBlockedMessage(record: DataDirLockRecord, probe: HolderProbe): string {
  return (
    `❌ [Server] Another live QwenProxy instance holds this data dir (${describeHolder(record, probe)}).` +
    `\n   Stop it first: ${stopCommandFor(record.pid)}` +
    `\n   Automatic takeover is off (QWEN_LOCK_TAKEOVER=false) — set it to true to let this start stop the old instance itself,` +
    `\n   or point this run at its own data dir: QWEN_DATA_DIR=<path> npm start`
  );
}

function buildConcurrentMessage(record?: DataDirLockRecord): string {
  const holder = record ? ` (${describeHolder(record)})` : "";
  return (
    `❌ [Server] Another QwenProxy instance claimed this data dir moments ago${holder}.` +
    `\n   Wait for it to finish starting (or stop it) and retry.`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  } while (true);
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

async function waitForPortFree(
  port: number,
  host: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await canBind(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  } while (true);
}

function forceStopProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function normalizeHolderHost(host?: string): string {
  if (!host || host === "0.0.0.0" || host === "::" || host === "::0") {
    return "127.0.0.1";
  }
  return host;
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Ask the holder to exit through its own shutdown path (flush SQLite, close
 * browsers) instead of being killed mid-write. Only succeeds against a build
 * that exposes the loopback `/-/shutdown` route.
 */
async function requestHandover(
  record: DataDirLockRecord,
  apiKey?: string,
): Promise<boolean> {
  if (!record.port) return false;
  const url = `http://${formatUrlHost(normalizeHolderHost(record.host))}:${record.port}/-/shutdown`;
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(HANDOVER_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function stopHolder(
  record: DataDirLockRecord,
  probe: HolderProbe,
  options: ClaimDataDirLockOptions,
): Promise<void> {
  console.log(
    `🔁 [Server] Stopping the live QwenProxy instance that blocks this start | ${describeHolder(record, probe)}`,
  );

  const accepted = await requestHandover(record, options.apiKey);
  let stopped = await waitForPidExit(
    record.pid,
    accepted ? HANDOVER_EXIT_TIMEOUT_MS : 0,
  );

  if (!stopped) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    stopped = await waitForPidExit(record.pid, SIGTERM_EXIT_TIMEOUT_MS);
  }

  if (!stopped) {
    forceStopProcessTree(record.pid);
    stopped = await waitForPidExit(record.pid, SIGTERM_EXIT_TIMEOUT_MS);
  }

  if (!stopped) {
    throw new Error(
      `❌ [Server] Could not stop the QwenProxy instance blocking this start (${describeHolder(record, probe)}).` +
        `\n   Stop it manually (${stopCommandFor(record.pid)}) and retry.`,
    );
  }

  console.log(`✅ [Server] Previous instance stopped | pid=${record.pid}`);

  // The listening socket is released with the process, but Windows hands it
  // back asynchronously — wait so the port pre-flight below cannot flake.
  if (options.port && options.port === record.port) {
    await waitForPortFree(
      options.port,
      normalizeHolderHost(options.host),
      PORT_RELEASE_TIMEOUT_MS,
    );
  }
}

export function getStopCommand(pid: number): string {
  return stopCommandFor(pid);
}

function parsePid(text: string | undefined): number | undefined {
  const pid = Number.parseInt(String(text ?? "").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function findListenerWindows(port: number): number | undefined {
  const script =
    `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1;` +
    "if ($c) { [string]$c.OwningProcess }";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 8_000 },
  );
  const fromCmdlet = parsePid(result.stdout);
  if (fromCmdlet) return fromCmdlet;

  // Fallback for hosts without the NetTCpConnection cmdlet.
  const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8_000,
  });
  for (const line of String(netstat.stdout ?? "").split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const [, localAddress, , state, pidText] = columns;
    if (!localAddress?.endsWith(`:${port}`) || !/listen/i.test(state ?? "")) {
      continue;
    }
    const pid = parsePid(pidText);
    if (pid) return pid;
  }
  return undefined;
}

function findListenerPosix(port: number): number | undefined {
  const ss = spawnSync("ss", ["-H", "-tlnp", "sport", "=", `:${port}`], {
    encoding: "utf8",
    timeout: 8_000,
  });
  const fromSs = /pid=(\d+)/.exec(String(ss.stdout ?? ""));
  if (fromSs) return parsePid(fromSs[1]);

  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 8_000,
  });
  const lsofPids = String(lsof.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => parsePid(line))
    .filter((pid): pid is number => Boolean(pid));
  return lsofPids[0];
}

/** Pid listening on `port`, best-effort across platforms. */
export function findPortListener(port: number): number | undefined {
  if (!Number.isFinite(port) || port <= 0) return undefined;
  try {
    if (process.platform === "win32") return findListenerWindows(port);
    return findListenerPosix(port);
  } catch {
    return undefined;
  }
}

export interface PortTakeoverResult {
  tookOver: boolean;
  listener?: { pid: number; commandLine?: string };
}

/**
 * Second line of defence for a start whose lockfile went missing (a hard
 * kill, or a lock deleted by a build older than the ownership-checked
 * release). If the process squatting on our port is verifiably QwenProxy,
 * stop it the same way the data-dir holder is stopped; anything else is a
 * genuine conflict and is only reported, never touched.
 */
export async function takeOverPortHolder(options: {
  port: number;
  host?: string;
  apiKey?: string;
}): Promise<PortTakeoverResult> {
  const pid = findPortListener(options.port);
  if (!pid || pid === process.pid) return { tookOver: false };

  const probe = probeProcess(pid);
  const listener = { pid, commandLine: probe.commandLine };
  if (!looksLikeQwenProxyProcess(probe.commandLine)) {
    return { tookOver: false, listener };
  }
  if (!isTakeoverEnabled()) {
    return { tookOver: false, listener };
  }

  await stopHolder(
    { pid, startedAt: NaN, port: options.port, host: options.host },
    probe,
    {
      port: options.port,
      host: options.host,
      apiKey: options.apiKey,
    },
  );
  return { tookOver: true, listener };
}


function buildLockPayload(options: ClaimDataDirLockOptions): string {
  return JSON.stringify({
    pid: process.pid,
    startedAt: ownStartEpochMs(),
    ...(options.port ? { port: options.port } : {}),
    ...(options.host ? { host: options.host } : {}),
  });
}

function ensureLockDir(lockPath: string): void {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Best-effort: the write below reports the real failure.
  }
}

/** Exclusive create, so two starters racing on an empty dir cannot both win. */
function writeOwnLock(lockPath: string, options: ClaimDataDirLockOptions): void {
  ensureLockDir(lockPath);
  const payload = buildLockPayload(options);
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(buildConcurrentMessage(readLockFile(lockPath).record));
    }
    // Best-effort: a read-only data dir must not block startup; the port
    // check still catches the common collision.
    try {
      fs.writeFileSync(lockPath, payload, "utf8");
    } catch {
      // Ignore.
    }
  }
}

function overwriteOwnLock(lockPath: string, options: ClaimDataDirLockOptions): void {
  ensureLockDir(lockPath);
  try {
    fs.writeFileSync(lockPath, buildLockPayload(options), "utf8");
  } catch {
    // Best-effort.
  }
}

/**
 * Deletes the lock only while it still names `expectedPid`. A failed start
 * must never drop the live holder's lock — that silently disables the guard
 * for every later start.
 */
function releaseOwnedLock(
  lockPath: string,
  expectedPid: number,
  acceptUnreadable: boolean,
): void {
  try {
    const state = readLockFile(lockPath);
    if (!state.exists) return;
    if (state.record) {
      if (state.record.pid !== expectedPid) return;
    } else if (!acceptUnreadable) {
      return;
    }
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Best-effort.
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous: runs for process.exit() and normal termination, so a failed
  // or interrupted start leaves no lock behind for the next run to triage.
  process.on("exit", () => {
    releaseOwnedLock(getDataDirLockPath(), process.pid, false);
  });
}

/**
 * Claims the data dir for this process, resolving whatever already holds it.
 * Throws (actionable message) only when takeover is disabled, or when a
 * concurrent starter won the race.
 */
export async function claimDataDirLock(
  options: ClaimDataDirLockOptions = {},
): Promise<void> {
  const lockPath = getDataDirLockPath();
  const state = readLockFile(lockPath);

  if (state.exists && state.record?.pid === process.pid) {
    // Re-claim within the same process (index.ts then startServer()).
    overwriteOwnLock(lockPath, options);
    installExitHook();
    return;
  }

  if (state.exists) {
    const record = state.record;
    if (!record) {
      console.warn("🧹 [Server] Unreadable data dir lock — reclaiming.");
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Best-effort.
      }
    } else if (isPidAlive(record.pid)) {
      const probe = probeProcess(record.pid);
      const identity = classifyHolder(record, probe);
      if (identity === "verified") {
        if (!isTakeoverEnabled()) {
          throw new Error(buildBlockedMessage(record, probe));
        }
        await stopHolder(record, probe, options);
      } else if (identity === "foreign") {
        console.warn(
          `🧹 [Server] Data dir lock pid ${record.pid} belongs to another process (pid reused) — reclaiming.`,
        );
      } else {
        console.warn(
          `⚠️  [Server] Could not verify lock holder pid ${record.pid} — reclaiming. If startup then fails on the port, stop that pid manually.`,
        );
      }
    } else {
      console.warn(
        `🧹 [Server] Stale data dir lock from a dead process (pid ${record.pid}) — reclaiming.`,
      );
    }
    releaseOwnedLock(lockPath, record?.pid ?? -1, true);
  }

  writeOwnLock(lockPath, options);
  installExitHook();
}

/** Removes the lock if (and only if) this process is the holder. */
export function releaseDataDirLockSync(): void {
  releaseOwnedLock(getDataDirLockPath(), process.pid, false);
}

export async function releaseDataDirLock(): Promise<void> {
  releaseDataDirLockSync();
}
