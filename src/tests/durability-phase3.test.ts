import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  backupDatabase,
  getDatabase,
  getSynchronousMode,
  isStrictDurabilityEnabled,
} from "../core/database.ts";
import {
  buildPreMigrationBackupPath,
  listPreMigrationBackups,
  prunePreMigrationBackups,
  runVersionedMigrations,
} from "../runtime/persistence/migrations.ts";
import { CURRENT_SCHEMA_VERSION } from "../runtime/persistence/schema.ts";
import {
  getStream,
  markStreamEmitted,
  registerStream,
  removeStream,
  startStreamSweepTimer,
  stopStreamSweepTimer,
  STREAM_ORPHAN_MAX_AGE_MS,
  STREAM_SWEEP_INTERVAL_MS,
  sweepOrphanedStreams,
} from "../core/stream-registry.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkTempDir(prefix = "dur3-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// --- 1: strict-mode selection ---

test("strict durability: enabled only on literal \"true\"", () => {
  const prev = process.env.STRICT_DURABILITY;
  try {
    process.env.STRICT_DURABILITY = "true";
    assert.equal(isStrictDurabilityEnabled(), true);
    assert.equal(getSynchronousMode(), "FULL");

    process.env.STRICT_DURABILITY = "True";
    assert.equal(isStrictDurabilityEnabled(), false);
    assert.equal(getSynchronousMode(), "NORMAL");

    process.env.STRICT_DURABILITY = "1";
    assert.equal(isStrictDurabilityEnabled(), false);

    process.env.STRICT_DURABILITY = "";
    assert.equal(isStrictDurabilityEnabled(), false);

    delete process.env.STRICT_DURABILITY;
    assert.equal(isStrictDurabilityEnabled(), false);
    assert.equal(getSynchronousMode(), "NORMAL");
  } finally {
    if (prev === undefined) delete process.env.STRICT_DURABILITY;
    else process.env.STRICT_DURABILITY = prev;
  }
});

test("strict durability: temp DB pragma follows selection", () => {
  const prev = process.env.STRICT_DURABILITY;
  const dir = mkTempDir();
  const p1 = path.join(dir, "a.db");
  const p2 = path.join(dir, "b.db");
  try {
    process.env.STRICT_DURABILITY = "true";
    const dbFull = new Database(p1);
    try {
      dbFull.pragma(`synchronous = ${getSynchronousMode()}`);
      assert.equal(dbFull.pragma("synchronous", { simple: true }), 2);
    } finally {
      dbFull.close();
    }

    process.env.STRICT_DURABILITY = "false";
    const dbNormal = new Database(p2);
    try {
      dbNormal.pragma(`synchronous = ${getSynchronousMode()}`);
      assert.equal(dbNormal.pragma("synchronous", { simple: true }), 1);
    } finally {
      dbNormal.close();
    }
  } finally {
    if (prev === undefined) delete process.env.STRICT_DURABILITY;
    else process.env.STRICT_DURABILITY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("strict durability defaults: 10min max age, 60s interval", () => {
  assert.equal(STREAM_ORPHAN_MAX_AGE_MS, 10 * 60 * 1000);
  assert.equal(STREAM_SWEEP_INTERVAL_MS, 60 * 1000);
});

// --- 2: backupDatabase ---

test("backupDatabase creates file at temp dest", async () => {
  const dir = mkTempDir();
  const dest = path.join(dir, "backup.db");
  try {
    getDatabase();
    await backupDatabase(dest);
    assert.ok(fs.existsSync(dest), "backup file must exist");
    assert.ok(fs.statSync(dest).size > 0, "backup file must be non-empty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backupDatabase restore-read: backup contains singleton row", async () => {
  const dir = mkTempDir();
  const dest = path.join(dir, "restore.db");
  const id = uniq("dur3-acct");
  const email = `${id}@example.com`;
  const db = getDatabase();
  try {
    db.prepare(
      "INSERT OR IGNORE INTO accounts (id, email, password) VALUES (?, ?, ?)",
    ).run(id, email, "pw");
    await backupDatabase(dest);
    assert.ok(fs.existsSync(dest));

    const restored = new Database(dest, { readonly: true });
    try {
      const row = restored
        .prepare("SELECT id, email FROM accounts WHERE id = ?")
        .get(id) as { id: string; email: string } | undefined;
      assert.ok(row, "restored backup must contain inserted row");
      assert.equal(row.email, email);
    } finally {
      restored.close();
    }
  } finally {
    try {
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    } catch {
      /* best-effort */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3: backup rotation ---

test("backup rotation: prune keeps newest 3", () => {
  const dir = mkTempDir();
  try {
    const names = [1, 2, 3, 4, 5].map(
      (n) => `pre-migrate-${String(1000 + n).padStart(13, "0")}.db`,
    );
    for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
    // Unrelated file must be left alone.
    fs.writeFileSync(path.join(dir, "qwenproxy.db"), "x");

    prunePreMigrationBackups(dir);

    const remaining = listPreMigrationBackups(dir).map((p) => path.basename(p));
    assert.equal(remaining.length, 3);
    assert.deepEqual(remaining, names.slice(2));
    assert.ok(fs.existsSync(path.join(dir, "qwenproxy.db")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup rotation: prune handles empty and missing dirs", () => {
  const dir = mkTempDir();
  try {
    prunePreMigrationBackups(dir);
    assert.equal(listPreMigrationBackups(dir).length, 0);
    prunePreMigrationBackups(path.join(dir, "does-not-exist"));
    assert.equal(
      listPreMigrationBackups(path.join(dir, "does-not-exist")).length,
      0,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPreMigrationBackupPath uses <dbdir>/pre-migrate-<timestamp>.db", () => {
  const dir = mkTempDir();
  try {
    const p = buildPreMigrationBackupPath(dir, 1234567890);
    assert.equal(p, path.join(dir, "pre-migrate-1234567890.db"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVersionedMigrations creates pre-migrate backup in temp db dir", async () => {
  const dir = mkTempDir();
  const dbPath = path.join(dir, "mig.db");
  const db = new Database(dbPath);
  try {
    const version = runVersionedMigrations(db);
    assert.equal(version, CURRENT_SCHEMA_VERSION);
    // Sync copy is immediate; async backupDatabase may need a tick.
    let found: string[] = [];
    for (let i = 0; i < 50; i++) {
      found = listPreMigrationBackups(dir);
      if (found.length > 0) break;
      await sleep(10);
    }
    assert.ok(found.length >= 1, "expected at least one pre-migrate backup");
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runVersionedMigrations rotation keeps <=3 after repeated migrations", async () => {
  const dir = mkTempDir();
  const handles: Database.Database[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `mig-${i}.db`);
      const h = new Database(p);
      handles.push(h);
      runVersionedMigrations(h);
      await sleep(3);
    }
    // Allow floating backupDatabase promises to settle.
    await sleep(200);
    prunePreMigrationBackups(dir);
    const remaining = listPreMigrationBackups(dir);
    assert.ok(
      remaining.length <= 3,
      `expected <=3 backups, got ${remaining.length}`,
    );
  } finally {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4: stream sweep ---

test("sweep removes only stale unemitted entries (fresh kept)", async () => {
  const stale = uniq("dur3-stale");
  const fresh = uniq("dur3-fresh");
  try {
    registerStream(stale, {
      abortController: new AbortController(),
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });
    await sleep(50);
    registerStream(fresh, {
      abortController: new AbortController(),
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });

    const swept = sweepOrphanedStreams(25);
    assert.equal(swept, 1);
    assert.equal(getStream(stale), undefined);
    assert.ok(getStream(fresh), "fresh entry must be kept");
  } finally {
    removeStream(stale);
    removeStream(fresh);
    stopStreamSweepTimer();
  }
});

test("sweep keeps emitted (completed) stale entries", async () => {
  const key = uniq("dur3-emitted");
  try {
    registerStream(key, {
      abortController: new AbortController(),
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });
    markStreamEmitted(key);
    await sleep(30);
    const swept = sweepOrphanedStreams(10);
    assert.equal(swept, 0);
    assert.ok(getStream(key), "emitted entry must be kept");
  } finally {
    removeStream(key);
  }
});

test("sweep returns 0 when nothing stale or empty", async () => {
  const key = uniq("dur3-fresh2");
  try {
    registerStream(key, {
      abortController: new AbortController(),
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });
    assert.equal(sweepOrphanedStreams(60 * 1000), 0);
    assert.ok(getStream(key));
  } finally {
    removeStream(key);
  }
  assert.equal(sweepOrphanedStreams(0), 0);
});

test("timer start/stop idempotence", () => {
  try {
    startStreamSweepTimer(50);
    startStreamSweepTimer(50);
    startStreamSweepTimer();
    stopStreamSweepTimer();
    stopStreamSweepTimer();
    startStreamSweepTimer(50);
    stopStreamSweepTimer();
  } finally {
    stopStreamSweepTimer();
  }
});

// --- 5: register/remove unchanged ---

test("register/get/remove round-trip unchanged", () => {
  const key = uniq("dur3-reg");
  const ac = new AbortController();
  try {
    registerStream(key, {
      abortController: ac,
      accountId: "acc-1",
      uiSessionId: "sess-1",
      targetResponseId: "resp-1",
      headers: { "x-a": "b" },
    });
    const got = getStream(key);
    assert.ok(got);
    assert.equal(got.accountId, "acc-1");
    assert.equal(got.uiSessionId, "sess-1");
    assert.equal(got.targetResponseId, "resp-1");
    assert.equal(got.emittedChunk, false);

    markStreamEmitted(key);
    assert.equal(getStream(key)?.emittedChunk, true);

    removeStream(key);
    assert.equal(getStream(key), undefined);
  } finally {
    removeStream(key);
  }
});

test("register supersede aborts previous controller, same controller kept", () => {
  const key = uniq("dur3-sup");
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  try {
    registerStream(key, {
      abortController: ac1,
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });
    registerStream(key, {
      abortController: ac2,
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });
    assert.equal(ac1.signal.aborted, true);
    assert.equal(getStream(key)?.abortController, ac2);

    // Same controller re-register must not abort.
    registerStream(key, {
      abortController: ac2,
      accountId: "acc",
      uiSessionId: "sess",
      targetResponseId: "resp",
      headers: {},
    });
    assert.equal(ac2.signal.aborted, false);
  } finally {
    removeStream(key);
  }
});
