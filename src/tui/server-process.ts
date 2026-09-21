/**
 * QwenProxy TUI - Server Child Process Manager
 * Spawns and manages the QwenProxy server as a separate child process
 * to ensure TUI responsiveness during heavy server workload.
 */

import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ServerProcessState =
  | "offline"
  | "starting"
  | "online"
  | "stopping"
  | "restarting"
  | "error";

export interface ServerProcessEvent {
  type: "log";
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  timestamp: string;
}

export interface ServerProcessEvents {
  stateChange: (state: ServerProcessState) => void;
  log: (event: ServerProcessEvent) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  startupComplete: () => void;
  startupFailed: (error: string) => void;
}

export class ServerProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: ServerProcessState = "offline";
  private pid: number | null = null;
  private restartCount = 0;
  private startupStartTime: number | null = null;
  private startupTimeout: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private exitHandler: (() => void) | null = null;
  private utf8Buffer = "";

  constructor() {
    super();
    this.exitHandler = () => this.stop();
    process.on("exit", this.exitHandler);
    process.on("SIGINT", this.exitHandler);
    process.on("SIGTERM", this.exitHandler);
  }

  public getState(): ServerProcessState {
    return this.state;
  }

  public getPid(): number | null {
    return this.pid;
  }

  public getRestartCount(): number {
    return this.restartCount;
  }

  public getStartupDuration(): number | null {
    if (this.startupStartTime && this.state === "online") {
      return Date.now() - this.startupStartTime;
    }
    return null;
  }

  private setState(newState: ServerProcessState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit("stateChange", newState);
    }
  }

  private decodeUtf8(chunk: Buffer | string): string {
    if (typeof chunk === "string") {
      return chunk;
    }
    
    const str = this.utf8Buffer + chunk.toString("binary");
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i);
    }
    
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const decoded = decoder.decode(bytes);
    
    if (decoded.includes("�")) {
      const lastCompleteChar = this.findLastCompleteUtf8Char(bytes);
      if (lastCompleteChar < str.length) {
        this.utf8Buffer = str.slice(lastCompleteChar);
        const completeBytes = new Uint8Array(lastCompleteChar);
        for (let i = 0; i < lastCompleteChar; i++) {
          completeBytes[i] = str.charCodeAt(i);
        }
        return new TextDecoder("utf-8").decode(completeBytes);
      }
    } else {
      this.utf8Buffer = "";
    }
    
    return decoded;
  }

  private findLastCompleteUtf8Char(bytes: Uint8Array): number {
    for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
      const byte = bytes[i];
      if ((byte & 0x80) === 0) {
        return i + 1;
      }
      if ((byte & 0xe0) === 0xc0 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
        return i + 2;
      }
      if (
        (byte & 0xf0) === 0xe0 &&
        i + 2 < bytes.length &&
        (bytes[i + 1] & 0xc0) === 0x80 &&
        (bytes[i + 2] & 0xc0) === 0x80
      ) {
        return i + 3;
      }
      if (
        (byte & 0xf8) === 0xf0 &&
        i + 3 < bytes.length &&
        (bytes[i + 1] & 0xc0) === 0x80 &&
        (bytes[i + 2] & 0xc0) === 0x80 &&
        (bytes[i + 3] & 0xc0) === 0x80
      ) {
        return i + 4;
      }
    }
    return bytes.length;
  }

  private sanitizeAnsi(text: string): string {
    return text
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[\d;]*[a-zA-Z]/g, "")
      .replace(/\x1b\([\x40-\x7f]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  }

  private emitLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
    const cleanMessage = this.sanitizeAnsi(message.trim());
    if (!cleanMessage) return;

    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    this.emit("log", {
      type: "log",
      level,
      message: cleanMessage,
      timestamp,
    });
  }

  public async start(port: number, host: string): Promise<void> {
    if (this.state === "online" || this.state === "starting") {
      return;
    }

    this.setState("starting");
    this.startupStartTime = Date.now();

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const serverScript = path.resolve(currentDir, "../index.ts");

    try {
      this.child = fork(serverScript, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          PORT: String(port),
          HOST: host,
          QWEN_TUI: "false",
        },
      });

      this.pid = this.child.pid || null;
      this.emitLog("INFO", `[ServerProcess] Starting server (PID: ${this.pid})...`);

      this.child.stdout?.on("data", (chunk: Buffer) => {
        const text = this.decodeUtf8(chunk);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            this.emitLog("INFO", line);
          }
        }
      });

      this.child.stderr?.on("data", (chunk: Buffer) => {
        const text = this.decodeUtf8(chunk);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            this.emitLog("ERROR", line);
          }
        }
      });

      this.child.on("exit", (code, signal) => {
        this.pid = null;
        this.child = null;
        
        if (this.startupTimeout) {
          clearTimeout(this.startupTimeout);
          this.startupTimeout = null;
        }
        
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }

        if (this.state === "stopping") {
          this.setState("offline");
          this.emit("exit", code, signal);
        } else if (this.state === "restarting") {
          this.emit("exit", code, signal);
        } else {
          this.setState("error");
          this.emit("exit", code, signal);
          
          if (this.restartCount < 3) {
            this.restartCount++;
            setTimeout(() => {
              if (this.state === "error") {
                this.emitLog("WARN", `[ServerProcess] Auto-restarting (attempt ${this.restartCount})...`);
                this.setState("restarting");
                this.start(port, host);
              }
            }, 2000 * this.restartCount);
          }
        }
      });

      this.child.on("error", (err) => {
        this.emitLog("ERROR", `[ServerProcess] Child process error: ${err.message}`);
      });

      this.startupTimeout = setTimeout(() => {
        if (this.state === "starting") {
          this.emitLog("ERROR", "[ServerProcess] Startup timeout (30s)");
          this.emit("startupFailed", "Startup timeout");
          this.stop();
        }
      }, 30000);

      await this.waitForReady(port, host);

    } catch (err: any) {
      this.setState("error");
      this.emit("startupFailed", err.message || String(err));
      throw err;
    }
  }

  private async waitForReady(port: number, host: string): Promise<void> {
    const cleanHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const maxAttempts = 60;
    const interval = 500;

    for (let i = 0; i < maxAttempts; i++) {
      if (this.state !== "starting") {
        break;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        const resp = await fetch(`http://${cleanHost}:${port}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (resp.ok) {
          if (this.startupTimeout) {
            clearTimeout(this.startupTimeout);
            this.startupTimeout = null;
          }

          this.setState("online");
          const duration = this.getStartupDuration();
          this.emitLog("INFO", `[ServerProcess] Server ready (${duration}ms)`);
          this.emit("startupComplete");

          this.healthCheckInterval = setInterval(async () => {
            if (this.state !== "online") return;
            try {
              const ctrl = new AbortController();
              const to = setTimeout(() => ctrl.abort(), 2000);
              const r = await fetch(`http://${cleanHost}:${port}/health`, {
                signal: ctrl.signal,
              });
              clearTimeout(to);
              if (!r.ok && this.state === "online") {
                this.emitLog("WARN", "[ServerProcess] Health check failed");
              }
            } catch {
              if (this.state === "online") {
                this.emitLog("WARN", "[ServerProcess] Health check timeout");
              }
            }
          }, 5000);

          return;
        }
      } catch {
        // Server not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (this.state === "starting") {
      throw new Error("Server startup timeout");
    }
  }

  public async stop(): Promise<void> {
    if (this.state === "offline" || this.state === "stopping") {
      return;
    }

    this.setState("stopping");

    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (!this.child) {
      this.setState("offline");
      return;
    }

    const stopPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.emitLog("WARN", "[ServerProcess] Graceful shutdown timeout, force killing");
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      this.child!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.child!.kill("SIGTERM");
    });

    await stopPromise;
    this.child = null;
    this.pid = null;
    this.setState("offline");
  }

  public async restart(port: number, host: string): Promise<void> {
    if (this.state === "restarting") {
      return;
    }

    this.setState("restarting");
    await this.stop();
    this.restartCount++;
    await this.start(port, host);
  }

  public cleanup(): void {
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      process.removeListener("SIGINT", this.exitHandler);
      process.removeListener("SIGTERM", this.exitHandler);
      this.exitHandler = null;
    }

    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
    }
  }
}
