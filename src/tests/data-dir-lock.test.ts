import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

// Isolated data dir: the suite must never touch the developer's lock file.
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-lock-"));
process.env.QWEN_DATA_DIR = tempDataDir;
delete process.env.QWEN_LOCK_TAKEOVER;

const {
  claimDataDirLock,
  releaseDataDirLock,
  getDataDirLockPath,
  isPidAlive,
  parseLockContents,
  classifyHolder,
  looksLikeQwenProxyProcess,
  parseEtimeSeconds,
  takeOverPortHolder,
} = await import("../core/data-dir-lock.ts");

const lockPath = getDataDirLockPath();

function writeLock(record: {
  pid: number;
  startedAt: number;
  port?: number;
  host?: string;
}): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(record), "utf8");
}

function readLock() {
  return parseLockContents(fs.readFileSync(lockPath, "utf8"));
}

function removeLock(): void {
  fs.rmSync(lockPath, { force: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

/** Long-running node process; resolves once it is actually schedulable. */
async function spawnSleeper(extraArg?: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "console.log('ready'); setInterval(() => {}, 1000);",
      ...(extraArg ? [extraArg] : []),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
    setTimeout(() => resolve(), 5_000);
  });
  return child;
}

async function spawnExitedPid(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (!isPidAlive(child.pid as number)) return child.pid as number;
  }
  throw new Error("could not obtain a dead pid for the stale-lock test");
}

const ownedChildren: ChildProcess[] = [];
async function sleeper(extraArg?: string): Promise<ChildProcess> {
  const child = await spawnSleeper(extraArg);
  ownedChildren.push(child);
  return child;
}

after(() => {
  for (const child of ownedChildren) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test("claim writes an owned lock; release only removes our own", async () => {
  removeLock();
  await claimDataDirLock({ port: 7936, host: "127.0.0.1" });

  const record = readLock();
  assert.equal(record?.pid, process.pid);
  assert.equal(record?.port, 7936);
  assert.equal(record?.host, "127.0.0.1");
  assert.ok(Number.isFinite(record?.startedAt));

  await releaseDataDirLock();
  assert.equal(fs.existsSync(lockPath), false);

  // A foreign lock must survive our release — a failed start used to delete
  // the live holder's lock and silently disable the guard.
  writeLock({ pid: 4194000, startedAt: Date.now() - 60_000 });
  await releaseDataDirLock();
  assert.ok(fs.existsSync(lockPath), "release must not touch another holder's lock");
  assert.equal(readLock()?.pid, 4194000);
  removeLock();
});

test("a stale lock from a dead pid is reclaimed", async () => {
  const deadPid = await spawnExitedPid();
  writeLock({ pid: deadPid, startedAt: Date.now() - 60_000 });

  await claimDataDirLock();

  const record = readLock();
  assert.equal(record?.pid, process.pid, "stale lock must be replaced");
  removeLock();
});

test("a recycled pid is reclaimed without killing the unrelated process", async () => {
  const impostor = await sleeper();
  // Lock start time does not match the impostor's real start time: the pid
  // was reused, so this lock refers to a process that never existed here.
  writeLock({ pid: impostor.pid as number, startedAt: Date.now() - 60_000 });

  await claimDataDirLock();

  assert.equal(readLock()?.pid, process.pid);
  assert.equal(
    isPidAlive(impostor.pid as number),
    true,
    "an unverified pid must never be killed",
  );
});

test("a verified live holder is taken over", async () => {
  const holder = await sleeper("src/index.ts");
  writeLock({ pid: holder.pid as number, startedAt: Date.now() });

  await claimDataDirLock();

  assert.equal(readLock()?.pid, process.pid);
  const exited = await waitUntil(() => !isPidAlive(holder.pid as number), 10_000);
  assert.equal(exited, true, "the verified predecessor must be stopped");
});

test("takeover can be disabled, and then the holder's lock survives", async () => {
  process.env.QWEN_LOCK_TAKEOVER = "false";
  try {
    const holder = await sleeper("src/index.ts");
    writeLock({ pid: holder.pid as number, startedAt: Date.now() });

    await assert.rejects(
      () => claimDataDirLock(),
      /Another live QwenProxy instance holds this data dir/,
    );

    assert.equal(
      isPidAlive(holder.pid as number),
      true,
      "refusal must not stop the running instance",
    );
    assert.equal(readLock()?.pid, holder.pid, "a refused claim keeps the lock");
  } finally {
    delete process.env.QWEN_LOCK_TAKEOVER;
    removeLock();
  }
});

async function spawnPortListener(port: number, marker?: string): Promise<ChildProcess> {
  const script =
    "require('net').createServer((s) => s.destroy()).listen(process.env.TEST_LISTEN_PORT, '127.0.0.1', () => console.log('ready')); setInterval(() => {}, 1000);";
  const child = spawn(
    process.execPath,
    ["-e", script, ...(marker ? [marker] : [])],
    {
      env: { ...process.env, TEST_LISTEN_PORT: String(port) },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  ownedChildren.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
    setTimeout(() => resolve(), 5_000);
  });
  return child;
}

async function findFreePort(): Promise<number> {
  for (let port = 3210; port < 3400; port++) {
    if (await bindable(port)) return port;
  }
  throw new Error("no free port found");
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

test("a QwenProxy squatter on the port is taken over when the lockfile is gone", async () => {
  const port = await findFreePort();
  const listener = await spawnPortListener(port, "C:\\apps\\qwenproxy-cli\\src\\index.ts");
  assert.equal(await bindable(port), false, "listener must hold the port");

  const result = await takeOverPortHolder({ port, host: "127.0.0.1" });

  assert.equal(result.tookOver, true);
  assert.equal(result.listener?.pid, listener.pid);
  const exited = await waitUntil(() => !isPidAlive(listener.pid as number), 10_000);
  assert.equal(exited, true, "the QwenProxy on our port must be stopped");
  assert.equal(await bindable(port), true, "the port must be released");
});

test("a foreign program on the port is reported but never killed", async () => {
  const port = await findFreePort();
  const listener = await spawnPortListener(port);
  assert.equal(await bindable(port), false);

  const result = await takeOverPortHolder({ port, host: "127.0.0.1" });

  assert.equal(result.tookOver, false);
  assert.equal(result.listener?.pid, listener.pid);
  assert.equal(
    isPidAlive(listener.pid as number),
    true,
    "a non-QwenProxy listener must be left alone",
  );
});

test("classifyHolder separates verified, recycled and unprobed holders", () => {
  const now = Date.now();
  assert.equal(
    classifyHolder({ pid: 1, startedAt: now }, { startedAt: now - 500 }),
    "verified",
  );
  assert.equal(
    classifyHolder({ pid: 1, startedAt: now }, { startedAt: now - 60_000 }),
    "foreign",
  );
  assert.equal(
    classifyHolder({ pid: 1, startedAt: NaN }, { commandLine: "node C:\\qwenproxy-cli\\src\\index.ts" }),
    "verified",
  );
  assert.equal(
    classifyHolder({ pid: 1, startedAt: NaN }, { commandLine: "node -e other.js" }),
    "foreign",
  );
  assert.equal(classifyHolder({ pid: 1, startedAt: NaN }, {}), "unknown");
  assert.equal(
    classifyHolder({ pid: 1, startedAt: now }, { startedAt: now }),
    "verified",
    "start-time match alone is enough: only this process wrote that stamp",
  );
});

test("cmdline and etime helpers parse what the probes return", () => {
  assert.equal(looksLikeQwenProxyProcess("node --import tsx C:\\x\\qwenproxy-cli\\src\\index.ts"), true);
  assert.equal(looksLikeQwenProxyProcess("/home/u/qwen-proxy/bin/qwenproxy.js"), true);
  assert.equal(looksLikeQwenProxyProcess("node -e other-project/index.js"), false);

  assert.equal(parseEtimeSeconds("05:12"), 5 * 60 + 12);
  assert.equal(parseEtimeSeconds("01:02:03"), 3723);
  assert.equal(parseEtimeSeconds("2-03:04:05"), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseEtimeSeconds("nonsense"), undefined);
});

test("legacy bare-pid lockfiles are still understood", () => {
  assert.deepEqual(parseLockContents("17920"), { pid: 17920, startedAt: NaN });
  assert.deepEqual(parseLockContents("not-a-pid"), undefined);
  assert.equal(
    parseLockContents('{"pid":42,"startedAt":123,"port":7936,"host":"127.0.0.1"}')?.port,
    7936,
  );
  assert.equal(parseLockContents("{}"), undefined);
});

function readLockAt(dataDir: string) {
  try {
    return parseLockContents(fs.readFileSync(path.join(dataDir, "server.pid"), "utf8"));
  } catch {
    return undefined;
  }
}

function spawnQwenProxy(
  port: number,
  dataDir: string,
): ChildProcess & { output: () => string } {
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(process.cwd(), "src", "index.ts");
  const child = spawn(process.execPath, [tsxCli, entry], {
    env: {
      ...process.env,
      QWEN_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      API_KEY: "",
      QWEN_ACCOUNTS: "",
      TEST_MOCK_QWEN_AUTH: "true",
      NODE_ENV: process.env.NODE_ENV === "production" ? "test" : process.env.NODE_ENV ?? "",
      // Keep the child hermetic: never import the developer's Qwen-Forge
      // accounts (they would trigger real browser warmup in a test).
      QWEN_FORGE_ACCOUNTS_PATH: path.join(dataDir, "forge-import-disabled.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { output: () => string };

  ownedChildren.push(child);
  let captured = "";
  child.stdout?.on("data", (chunk) => {
    captured += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    captured += String(chunk);
  });
  child.output = () => captured;
  return child;
}

function connectable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

async function waitUntilListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connectable(port)) return true;
    await sleep(250);
  }
  return false;
}

test("a second start takes over a live instance and shuts it down cleanly", async () => {
  const port = await findFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwenproxy-handover-"));

  try {
    const first = spawnQwenProxy(port, dataDir);
    assert.equal(
      await waitUntilListening(port, 60_000),
      true,
      `first instance never came up:\n${first.output()}`,
    );
    // tsx spawns the real worker as a child, so the lock names the worker,
    // not the pid we spawned — assert on what the data dir records.
    const firstLock = readLockAt(dataDir);
    assert.ok(firstLock, "the first instance must own the lock");
    assert.equal(firstLock.port, port, "the lock records what it is serving");
    assert.equal(isPidAlive(firstLock.pid), true);
    const firstWorkerPid = firstLock.pid;

    const second = spawnQwenProxy(port, dataDir);
    const firstExited = await waitUntil(() => first.exitCode !== null, 45_000);
    assert.equal(
      firstExited,
      true,
      `handover never stopped the first instance:\n${first.output()}\n---\n${second.output()}`,
    );
    assert.equal(
      first.exitCode,
      0,
      `handover must be a clean shutdown, not a kill:\n${first.output()}`,
    );
    assert.equal(
      isPidAlive(firstWorkerPid),
      false,
      "the previous worker must be gone",
    );

    assert.equal(
      await waitUntilListening(port, 60_000),
      true,
      `second instance never came up:\n${second.output()}`,
    );
    const secondLock = readLockAt(dataDir);
    assert.ok(secondLock, "the lock must name the new owner");
    assert.notEqual(secondLock.pid, firstWorkerPid, "ownership must have moved");
    assert.equal(isPidAlive(secondLock.pid), true, "the new owner is alive");

    const response = await fetch(`http://127.0.0.1:${port}/-/shutdown`, {
      method: "POST",
    });
    assert.equal(response.status, 202);

    const stopped = await waitUntil(() => second.exitCode !== null, 30_000);
    assert.equal(stopped, true, `second instance did not exit:\n${second.output()}`);
    assert.equal(second.exitCode, 0, second.output());
    assert.equal(
      fs.existsSync(path.join(dataDir, "server.pid")),
      false,
      "a clean exit must leave no lock behind",
    );
  } finally {
    for (const child of ownedChildren) {
      try {
        if (child.exitCode === null) child.kill();
      } catch {
        // Already gone.
      }
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on a database that is still closing.
    }
  }
});
