/**
 * QwenProxy TUI - Status and Live Dashboard View (Tab 1)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate } from "../theme.ts";
import { fetchProxyStatus, resetAllCooldowns, formatUptime } from "../proxy-client.ts";
import { ServerManager } from "../server-manager.ts";

export class StatusView implements TuiView {
  public readonly id = "status";
  public readonly title = "Status";
  public readonly tabNumber = 1;

  private statusData: ProxyStatusSnapshot | null = null;
  private actionMessage = "";
  private actionMessageTimeout: NodeJS.Timeout | null = null;
  private hoveredActionRow: number | null = null;
  private lastLeftW = 34;

  constructor() {
    this.refresh();
  }

  public async refresh(): Promise<void> {
    try {
      if (process.stdout.isTTY && !process.env.NODE_TEST_CONTEXT) {
        const sManager = ServerManager.getInstance();
        if (sManager.getState() === "error") {
          void sManager.ensureStarted();
        }
      }
      this.statusData = await fetchProxyStatus();
    } catch {}
  }

  public onActivate(): void {
    this.refresh();
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "r", label: "Reload" },
      { key: "z", label: "Reset Cooldowns" },
    ];
  }

  private setMessage(msg: string): void {
    this.actionMessage = msg;
    clearTimeout(this.actionMessageTimeout!);
    this.actionMessageTimeout = setTimeout(() => {
      this.actionMessage = "";
    }, 4000);
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // Mouse hover over quick actions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 34;
      if (col >= 2 && col <= leftW - 1 && (row === 13 || row === 14)) {
        if (this.hoveredActionRow !== row) {
          this.hoveredActionRow = row;
          return true;
        }
      } else if (this.hoveredActionRow !== null) {
        this.hoveredActionRow = null;
        return true;
      }
    }

    // Mouse click interactions
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 34;
      if (col >= 2 && col <= leftW - 1) {
        if (row === 13) {
          await this.refresh();
          this.setMessage(theme.green("✓ Status refreshed"));
          return true;
        }
        if (row === 14) {
          const cleared = resetAllCooldowns();
          await this.refresh();
          this.setMessage(theme.green(`✓ Cooldowns reset: ${cleared} account(s) released`));
          return true;
        }
      }
    }

    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      await this.refresh();
      this.setMessage(theme.green("✓ Status refreshed"));
      return true;
    }

    if ((key.name === "z" || key.name === "Z") && !key.ctrl) {
      const cleared = resetAllCooldowns();
      await this.refresh();
      this.setMessage(theme.green(`✓ Cooldowns reset: ${cleared} account(s) released`));
      return true;
    }
  }

  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const data = snapshot || this.statusData;
    const isOnline = data?.online ?? false;
    const contentH = Math.max(10, height);

    // Two-column layout
    const leftW = Math.max(34, Math.floor(width * 0.42));
    this.lastLeftW = leftW;
    const rightW = Math.max(34, width - leftW - 1);

    // Left Column: System & Proxy Status
    const serverState = ServerManager.getInstance().getState();
    let onlineBadge: string;
    if (isOnline || serverState === "online") {
      onlineBadge = theme.green(`${glyphs.bullet} Online`);
    } else if (serverState === "warming") {
      onlineBadge = theme.yellow(`🟡 Starting...`);
    } else if (serverState === "error") {
      onlineBadge = theme.red(`✗ Error`);
    } else {
      onlineBadge = theme.muted(`${glyphs.circle} Offline`);
    }

    const uptimeSecs = data?.uptimeSeconds || Math.floor(process.uptime());
    const uptimeStr = formatUptime(uptimeSecs);

    const baseUrl = `http://${data?.host || "127.0.0.1"}:${data?.port || 7936}/v1`;

    const pool = data?.pool;
    const poolLine = pool
      ? `  ${theme.bold("Pool:")}       R:${pool.ready} W:${pool.warming} B:${pool.busy} C:${pool.cooldown} A:${pool.authError} X:${pool.broken} D:${pool.disabled} H:${pool.averageHealth}`
      : null;
    const leftContent = [
      "",
      `  ${theme.bold("Status:")}     ${onlineBadge}`,
      `  ${theme.bold("Base URL:")}   ${theme.cyan(baseUrl)}`,
      `  ${theme.bold("Uptime:")}     ${theme.cyan(uptimeStr)}`,
      `  ${theme.bold("RAM:")}        ${theme.cyan(String(data?.rssMb || 0) + " MB")}`,
      `  ${theme.bold("Connections:")}   ${data?.activeStreams ? theme.yellow(String(data.activeStreams) + " active") : "0 active"}`,
      ...(poolLine ? [poolLine] : []),
      "",
      `  ${theme.bold("Actions:")}`,
      `    ${this.hoveredActionRow === 13 ? theme.bgHover(` ${theme.cyan("[ R ] Reload")} `) : `${theme.cyan("[ R ]")} Reload`}`,
      `    ${this.hoveredActionRow === 14 ? theme.bgHover(` ${theme.yellow("[ Z ] Reset Cooldowns")} `) : `${theme.yellow("[ Z ]")} Reset Cooldowns`}`,
      "",
      this.actionMessage ? `  ${this.actionMessage}` : "",
    ];

    const leftBox = drawBox({
      title: "System",
      width: leftW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    // Right Column: Accounts Pool Status
    const accounts = data?.accounts || [];
    const readyCount = accounts.filter((a) => !a.onCooldown && a.headersReady).length;
    const rightContent: string[] = [
      "",
      `  ${theme.dim("#   Account               Status")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (accounts.length === 0) {
      rightContent.push(`  ${theme.muted("No accounts added. (Go to [5] Accounts)")}`);
    } else {
      accounts.slice(0, contentH - 5).forEach((acc, idx) => {
        const num = pad(String(idx + 1), 3);
        const name = pad(truncate(acc.emailOrName, 20), 20);
        let status = theme.green(`${glyphs.bullet} Ready`);
        if (acc.onCooldown) {
          const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
          status = theme.yellow(`⚠️ Cooldown ${mins}m`);
        } else if (!acc.headersReady) {
          status = acc.isInitialized
            ? theme.yellow(`◐ Warming...`)
            : theme.muted(`○ Standby`);
        }
        rightContent.push(`  ${num} ${name}  ${status}`);
      });
    }

    const rightBox = drawBox({
      title: `Accounts (${readyCount}/${accounts.length})`,
      width: rightW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.lavender,
      content: rightContent,
    });

    // Merge columns side by side
    const mergedLines: string[] = [];
    const maxRows = Math.max(leftBox.length, rightBox.length);
    for (let r = 0; r < maxRows; r++) {
      const leftRow = leftBox[r] || " ".repeat(leftW);
      const rightRow = rightBox[r] || " ".repeat(rightW);
      mergedLines.push(leftRow + " " + rightRow);
    }

    return mergedLines;
  }
}
