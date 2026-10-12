/**
 * File log sink: JSON-line output, secret redaction on disk, size rotation,
 * TTL auto-delete (prune + protected active file), startup reaper, and
 * clean shutdown semantics.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initFileLogger,
  stopFileLogger,
  isFileLogActive,
  pruneExpiredLogFiles,
} from "../core/file-logger.ts";
import { Logger } from "../core/logger.ts";

const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qpx-filelog-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readJsonLines(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Let the setImmediate-based drain land between batches. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test("file logger writes JSON lines and closes cleanly", async () => {
  const dir = tempDir();
  try {
    const file = initFileLogger({ dir, ttlMs: 3_600_000 });
    assert.ok(file, "init returns the active file path");
    assert.ok(file!.startsWith(dir));
    assert.ok(isFileLogActive());

    const log = new Logger("debug", "file-log-test");
    log.info("hello file log", { key: "value" });
    await settle();
    await stopFileLogger();
    assert.equal(isFileLogActive(), false);

    const lines = readJsonLines(file!);
    const entry = lines.find((l) => l.message.includes("hello file log"));
    assert.ok(entry, "the emitted entry lands in the file");
    assert.equal(entry.level, "info");
    assert.equal(entry.context, "file-log-test");
    assert.equal(entry.data.key, "value");
    assert.ok(entry.timestamp, "timestamp present");
  } finally {
    await stopFileLogger();
    cleanup(dir);
  }
});

test("file log lines redact secrets before they hit disk", async () => {
  const dir = tempDir();
  try {
    const file = initFileLogger({ dir });
    const log = new Logger("debug");
    log.warn("credentials", {
      cookie: "x5secdata=deadbeef",
      token: FAKE_JWT,
      note: "keep-me",
    });
    await settle();
    await stopFileLogger();

    const raw = fs.readFileSync(file!, "utf8");
    assert.ok(!raw.includes("x5secdata=deadbeef"), "cookie redacted");
    assert.ok(!raw.includes(FAKE_JWT), "JWT redacted");
    assert.ok(raw.includes("[REDACTED]"));
    assert.ok(raw.includes("keep-me"), "non-secret data passes through");
  } finally {
    await stopFileLogger();
    cleanup(dir);
  }
});

test("size rotation rolls the active file and caps rotated segments", async () => {
  const dir = tempDir();
  try {
    initFileLogger({ dir, maxSizeBytes: 512, maxRotatedFiles: 2 });
    const log = new Logger("debug");
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 5; i++) {
        log.info(`rotation probe ${batch}-${i} ${"x".repeat(60)}`);
      }
      await settle();
    }
    await stopFileLogger();

    const files = fs.readdirSync(dir).filter((f) => f.startsWith("qwenproxy-"));
    const rotated = files.filter((f) => /\.\d+$/.test(f));
    assert.ok(
      rotated.length >= 1,
      `expected rotated segments, got: ${files.join(", ")}`,
    );
    assert.ok(rotated.length <= 2, "never more than maxRotatedFiles segments");
    for (const f of files) {
      assert.ok(fs.statSync(path.join(dir, f)).size > 0, `${f} is not empty`);
    }
  } finally {
    await stopFileLogger();
    cleanup(dir);
  }
});

test("TTL prune deletes expired logs, keeps fresh/protected/foreign files", () => {
  const dir = tempDir();
  try {
    const expired = path.join(dir, "qwenproxy-old-pid9.log");
    const expiredRotated = path.join(dir, "qwenproxy-old-pid9.log.1");
    const fresh = path.join(dir, "qwenproxy-fresh-pid9.log");
    const foreign = path.join(dir, "unrelated.txt");
    for (const f of [expired, expiredRotated, fresh, foreign]) {
      fs.writeFileSync(f, "x");
    }
    const past = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(expired, past, past);
    fs.utimesSync(expiredRotated, past, past);

    const removed = pruneExpiredLogFiles(dir, 3_600_000);
    assert.equal(removed, 2);
    assert.ok(!fs.existsSync(expired));
    assert.ok(!fs.existsSync(expiredRotated));
    assert.ok(fs.existsSync(fresh), "fresh file survives");
    assert.ok(fs.existsSync(foreign), "non-log file untouched");

    fs.utimesSync(fresh, past, past);
    const removedProtected = pruneExpiredLogFiles(dir, 3_600_000, fresh);
    assert.equal(removedProtected, 0);
    assert.ok(fs.existsSync(fresh), "protected (active) file survives its TTL");
  } finally {
    cleanup(dir);
  }
});

test("init reaps expired files left by previous runs", async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "qwenproxy-stale-pid1.log");
    fs.writeFileSync(stale, "old run");
    const past = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(stale, past, past);

    initFileLogger({ dir, ttlMs: 3_600_000 });
    assert.ok(!fs.existsSync(stale), "stale file pruned at startup");
    assert.ok(isFileLogActive());
  } finally {
    await stopFileLogger();
    cleanup(dir);
  }
});

test("writes after stop are dropped without throwing", async () => {
  const dir = tempDir();
  try {
    initFileLogger({ dir });
    await stopFileLogger();
    const log = new Logger("debug");
    assert.doesNotThrow(() => log.warn("dropped line"));
    await settle();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("qwenproxy-"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!content.includes("dropped line"));
    }
  } finally {
    await stopFileLogger();
    cleanup(dir);
  }
});
