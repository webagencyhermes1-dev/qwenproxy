/**
 * TUI Responsiveness Tests - Child Process Isolation
 */

import test from "node:test";
import assert from "node:assert";
import { ServerProcess } from "../server-process.ts";

test("ServerProcess starts in offline state", () => {
  const serverProcess = new ServerProcess();
  try {
    assert.strictEqual(serverProcess.getState(), "offline");
    assert.strictEqual(serverProcess.getPid(), null);
    assert.strictEqual(serverProcess.getRestartCount(), 0);
  } finally {
    serverProcess.cleanup();
  }
});

test("ServerProcess decodeUtf8 handles ASCII", () => {
  const serverProcess = new ServerProcess();
  try {
    // Access private method through cast
    const decoded = (serverProcess as any).decodeUtf8(Buffer.from("Hello World"));
    assert.strictEqual(decoded, "Hello World");
  } finally {
    serverProcess.cleanup();
  }
});

test("ServerProcess sanitizeAnsi strips ANSI codes", () => {
  const serverProcess = new ServerProcess();
  try {
    const input = "\x1b[31mRed\x1b[0m";
    const output = (serverProcess as any).sanitizeAnsi(input);
    assert.strictEqual(output, "Red");
  } finally {
    serverProcess.cleanup();
  }
});

test("ServerProcess sanitizeAnsi strips OSC sequences", () => {
  const serverProcess = new ServerProcess();
  try {
    const input = "\x1b]0;Title\x07Hello";
    const output = (serverProcess as any).sanitizeAnsi(input);
    assert.strictEqual(output, "Hello");
  } finally {
    serverProcess.cleanup();
  }
});

test("ServerProcess sanitizeAnsi strips cursor codes", () => {
  const serverProcess = new ServerProcess();
  try {
    const input = "\x1b[2JHello";
    const output = (serverProcess as any).sanitizeAnsi(input);
    assert.strictEqual(output, "Hello");
  } finally {
    serverProcess.cleanup();
  }
});

test("ServerProcess event listeners work", () => {
  const serverProcess = new ServerProcess();
  const stateChanges: string[] = [];
  const logs: any[] = [];

  serverProcess.on("stateChange", (state) => stateChanges.push(state));
  serverProcess.on("log", (log) => logs.push(log));

  assert.strictEqual(stateChanges.length, 0);
  assert.strictEqual(logs.length, 0);

  serverProcess.cleanup();
});

test("ServerProcess getStartupDuration returns null when not started", () => {
  const serverProcess = new ServerProcess();
  try {
    assert.strictEqual(serverProcess.getStartupDuration(), null);
  } finally {
    serverProcess.cleanup();
  }
});
