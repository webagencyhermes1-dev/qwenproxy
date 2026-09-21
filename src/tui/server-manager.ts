/**
 * QwenProxy TUI - Server Manager with Child Process Isolation
 * Manages the QwenProxy server as a separate child process to ensure
 * TUI responsiveness during heavy server workload.
 */

import { config } from "../core/config.ts";
import { ServerProcess } from "./server-process.ts";

export type ServerLifecycleState = "offline" | "warming" | "online" | "error";

export interface ServerLogEntry {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}

export class ServerManager {
  private static instance: ServerManager | null = null;
  private serverProcess: ServerProcess;
  private state: ServerLifecycleState = "offline";
  private logEntries: ServerLogEntry[] = [];
  private logBuffer: string[] = [];

  private constructor() {
    this.serverProcess = new ServerProcess();
    this.setupEventHandlers();
  }

  public static getInstance(): ServerManager {
    if (!ServerManager.instance) {
      ServerManager.instance = new ServerManager();
    }
    return ServerManager.instance;
  }

  private setupEventHandlers(): void {
    this.serverProcess.on("stateChange", (state) => {
      const mappedState = this.mapServerProcessState(state);
      if (mappedState) {
        this.state = mappedState;
      }
    });

    this.serverProcess.on("log", (event) => {
      this.appendLog(event.level, event.message);
    });
  }

  private mapServerProcessState(state: string): ServerLifecycleState | null {
    switch (state) {
      case "offline":
      case "stopping":
        return "offline";
      case "starting":
      case "restarting":
        return "warming";
      case "online":
        return "online";
      case "error":
        return "error";
      default:
        return null;
    }
  }

  public getState(): ServerLifecycleState {
    return this.state;
  }

  public getServerProcess(): ServerProcess {
    return this.serverProcess;
  }

  public getRecentLogs(max = 12): string[] {
    return this.logBuffer.slice(-max);
  }

  public getLogEntries(filter: "all" | "warn" | "error" = "all"): ServerLogEntry[] {
    if (filter === "error") {
      return this.logEntries.filter((e) => e.level === "ERROR");
    }
    if (filter === "warn") {
      return this.logEntries.filter((e) => e.level === "WARN" || e.level === "ERROR");
    }
    return this.logEntries;
  }

  public clearLogs(): void {
    this.logEntries = [];
    this.logBuffer = [];
  }

  private appendLog(level: "INFO" | "WARN" | "ERROR", text: string): void {
    if (!text) return;
    const clean = text.trim();
    if (!clean || clean.length === 0) return;

    const last = this.logEntries[this.logEntries.length - 1];
    if (last && last.time === this.getCurrentTime() && last.level === level && last.message === clean) {
      return;
    }

    const time = this.getCurrentTime();
    const entry: ServerLogEntry = { time, level, message: clean };

    this.logEntries.push(entry);
    if (this.logEntries.length > 500) {
      this.logEntries.shift();
    }

    const formatted = `[${time}] ${clean}`;
    this.logBuffer.push(formatted);
    if (this.logBuffer.length > 500) {
      this.logBuffer.shift();
    }
  }

  private getCurrentTime(): string {
    return new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  public async ensureStarted(): Promise<void> {
    if (this.state === "online") return;
    if (this.serverProcess.getState() === "starting") return;

    const port = config.server?.port || 7936;
    const host = config.server?.host || "127.0.0.1";
    const cleanHost = host === "0.0.0.0" ? "127.0.0.1" : host;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 600);
      const resp = await fetch(`http://${cleanHost}:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        this.state = "online";
        this.appendLog("INFO", `✨ [Server] Connected to the running instance on port ${port}`);
        return;
      }
    } catch {}

    await this.serverProcess.start(port, host);
  }

  public async stop(): Promise<void> {
    await this.serverProcess.stop();
  }

  public cleanup(): void {
    this.serverProcess.cleanup();
  }
}
