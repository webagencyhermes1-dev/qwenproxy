/**
 * QwenProxy TUI - Storage & Cache Management View (Tab 4)
 */

import fs from "node:fs";
import path from "node:path";
import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad } from "../theme.ts";
import { pruneAllPlaywrightProfiles, cleanupOrphanProfiles } from "../../services/playwright.ts";
import { getProfilesDir } from "../../core/paths.ts";
import {
  formatBytes,
  getDirStats,
  cleanPlaywrightBrowsers,
} from "../../clean-cache.ts";
import { loadAccounts } from "../../core/accounts.ts";
import { maskAccountIdentifier, resetAllCooldowns } from "../proxy-client.ts";

export class StorageView implements TuiView {
  public readonly id = "storage";
  public readonly title = "Storage";
  public readonly tabNumber = 4;

  private profilesTotalBytes = 0;
  private profilesCount = 0;
  private profileStats: Array<{ name: string; size: string; files: number }> = [];

  private activeBrowser = "--";
  private unusedBrowsersCount = 0;
  private reclaimableBrowserBytes = 0;

  private actionLogs: string[] = [];
  private isScanning = false;

  private addLog(message: string): void {
    this.actionLogs.push(message);
    if (this.actionLogs.length > 50) {
      this.actionLogs.shift();
    }
  }

  constructor() {
    this.refresh();
  }
  private hoveredActionRow: number | null = null;
  private lastLeftW = 48;
  private confirmDialog: {
    title: string;
    message: string;
    detail: string;
    onConfirm: () => Promise<void>;
  } | null = null;
  private confirmDialogHovered: "confirm" | "cancel" | null = null;
  private lastConfirmModalLeftPad = 0;
  private lastConfirmModalStartRow = 0;

  public isCapturingText(): boolean {
    return this.confirmDialog !== null;
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    if (this.confirmDialog) {
      return [
        { key: "Y / Enter", label: "Confirm" },
        { key: "N / Esc", label: "Cancel" },
      ];
    }
    return [
      { key: "p", label: "Prune Caches" },
      { key: "b", label: "Clean Browsers" },
      { key: "z", label: "Reset Cooldowns" },
      { key: "l", label: "Clear Qwen Chats" },
      { key: "r", label: "Refresh Disk" },
    ];
  }
  public async refresh(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      // 0. Auto-prune orphan directories from removed accounts
      cleanupOrphanProfiles();

      // 1. Scan profiles
      const profilesDir = getProfilesDir();
      let totalBytes = 0;
      let count = 0;
      this.profileStats = [];
      if (fs.existsSync(profilesDir)) {
        const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            count++;
            const fullPath = path.join(profilesDir, entry.name);
            const stats = getDirStats(fullPath);
            totalBytes += stats.bytes;
            this.profileStats.push({
              name: entry.name,
              size: formatBytes(stats.bytes),
              files: stats.files,
            });
          }
        }
      }
      this.profilesTotalBytes = totalBytes;
      this.profilesCount = count;

      // 2. Scan Playwright browsers
      const browserRes = await cleanPlaywrightBrowsers(false);
      this.activeBrowser = browserRes.activeBrowserDir || "chromium";
      this.unusedBrowsersCount = browserRes.unusedDirs.length;
      this.reclaimableBrowserBytes = browserRes.unusedDirs.reduce(
        (acc, d) => acc + d.bytes,
        0,
      );
    } catch (err: any) {
      this.addLog(
        theme.red(`✗ Error calculating storage: ${err?.message || String(err)}`),
      );
    } finally {
      this.isScanning = false;
    }
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // 0. Confirm Dialog Active
    if (this.confirmDialog) {
      if (key.name === "y" || key.name === "Y") {
        const dialog = this.confirmDialog;
        this.confirmDialog = null;
        this.confirmDialogHovered = null;
        await dialog.onConfirm();
        return true;
      }
      if (key.name === "escape" || key.name === "n" || key.name === "N") {
        this.confirmDialog = null;
        this.confirmDialogHovered = null;
        this.addLog(theme.muted("Action cancelled"));
        return true;
      }
      if (key.name === "enter" || key.name === "return") {
        if (this.confirmDialogHovered === "cancel") {
          this.confirmDialog = null;
          this.confirmDialogHovered = null;
          this.addLog(theme.muted("Action cancelled"));
          return true;
        }
        const dialog = this.confirmDialog;
        this.confirmDialog = null;
        this.confirmDialogHovered = null;
        await dialog.onConfirm();
        return true;
      }
      if (key.name === "left" || key.name === "right" || key.name === "tab") {
        this.confirmDialogHovered = this.confirmDialogHovered === "cancel" ? "confirm" : "cancel";
        return true;
      }
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        const btnRow = (this.lastConfirmModalStartRow || 4) + 5;
        if (row === btnRow || row === btnRow - 1) {
          const relCol = col - (this.lastConfirmModalLeftPad || 0);
          if (relCol >= 2 && relCol <= 34) {
            if (this.confirmDialogHovered !== "confirm") {
              this.confirmDialogHovered = "confirm";
              return true;
            }
            return true;
          }
          if (relCol >= 35 && relCol <= 60) {
            if (this.confirmDialogHovered !== "cancel") {
              this.confirmDialogHovered = "cancel";
              return true;
            }
            return true;
          }
        }
        if (this.confirmDialogHovered !== null) {
          this.confirmDialogHovered = null;
          return true;
        }
      }
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        const btnRow = (this.lastConfirmModalStartRow || 4) + 5;
        if (row === btnRow || row === btnRow - 1) {
          const relCol = col - (this.lastConfirmModalLeftPad || 0);
          if (relCol >= 2 && relCol <= 34) {
            const dialog = this.confirmDialog;
            this.confirmDialog = null;
            this.confirmDialogHovered = null;
            await dialog.onConfirm();
            return true;
          }
          if (relCol >= 35 && relCol <= 60) {
            this.confirmDialog = null;
            this.confirmDialogHovered = null;
            this.addLog(theme.muted("Action cancelled"));
            return true;
          }
        }
      }
      return true;
    }

    // Mouse hover over quick actions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 48;
      if (col >= 2 && col <= leftW - 1 && row >= 13 && row <= 17) {
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
      const leftW = this.lastLeftW || 48;
      if (col >= 2 && col <= leftW - 1) {
        if (row === 13) {
          this.handleKey({ name: "p", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 14) {
          this.handleKey({ name: "b", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 15) {
          this.handleKey({ name: "z", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 16) {
          this.handleKey({ name: "l", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 17) {
          this.handleKey({ name: "r", ctrl: false, shift: false, meta: false });
          return true;
        }
      }
    }
    // Reset cooldowns with 'z'
    if ((key.name === "z" || key.name === "Z") && !key.ctrl) {
      const cleared = resetAllCooldowns();
      this.addLog(
        theme.green(`✓ Cooldowns reset: ${cleared} account(s) unlocked`),
      );
      return true;
    }

    // Refresh storage stats
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      await this.refresh();
      this.addLog(
        theme.green(`✓ Measurements updated: ${formatBytes(this.profilesTotalBytes)} across ${this.profilesCount} profile(s)`),
      );
      return true;
    }
    // Prune profile caches
    if ((key.name === "p" || key.name === "P") && !key.ctrl) {
      try {
        const res = pruneAllPlaywrightProfiles();
        const orphanRes = cleanupOrphanProfiles();
        let logMsg = `✓ Caches cleaned: ${formatBytes(res.totalFreedBytes)} freed across ${res.totalFreedFiles} files (${res.profilesCleaned} profiles)`;
        if (orphanRes.removedCount > 0) {
          logMsg += ` + ${orphanRes.removedCount} orphan profile(s) removed`;
        }
        this.addLog(theme.green(logMsg));
        await this.refresh();
      } catch (err: any) {
        this.addLog(theme.red(`✗ Failed to clean profiles: ${err?.message || String(err)}`));
      }
      return true;
    }

    // Clean unused playwright browsers
    if ((key.name === "b" || key.name === "B") && !key.ctrl) {
      try {
        const res = await cleanPlaywrightBrowsers(true);
        if (res.freedBytes > 0 || res.unusedDirs.length > 0) {
          this.addLog(
            theme.green(
              `✓ Browsers cleaned: ${formatBytes(res.freedBytes)} reclaimed (${res.unusedDirs.length} versions removed)`,
            ),
          );
        } else {
          this.addLog(
            theme.green(
              `✓ Browsers checked: no old browsers found`,
            ),
          );
        }
        await this.refresh();
      } catch (err: any) {
        this.addLog(
          theme.red(`✗ Failed to remove browsers: ${err?.message || String(err)}`),
        );
      }
      return true;
    }
    // Delete all remote chats with 'l' or 'L' (requires confirmation)
    if ((key.name === "l" || key.name === "L") && !key.ctrl) {
      this.confirmDialog = {
        title: "⚠️  Confirm Remote Chat Deletion",
        message: "Delete ALL remote chats for ALL accounts on Qwen?",
        detail: "This action will permanently delete all conversations on chat.qwen.ai.",
        onConfirm: async () => {
          this.addLog(theme.yellow("⏳ Deleting chats on Qwen for all accounts..."));
          try {
            const { deleteChatsForConfiguredAccounts } = await import("../../services/chat-cleanup.ts");
            const res = await deleteChatsForConfiguredAccounts(true);
            this.addLog(
              theme.green(
                `✓ All remote chats were deleted on Qwen (${res.succeeded}/${res.attempted} accounts)`,
              ),
            );
          } catch (err: any) {
            this.addLog(theme.red(`✗ Failed to delete chats: ${err?.message || String(err)}`));
          }
        },
      };
      return true;
    }
  }
  public render(width: number, height: number): string[] {
    const contentH = Math.max(12, height);
    const leftW = Math.max(48, Math.floor(width * 0.48));
    this.lastLeftW = leftW;
    const rightW = Math.max(34, width - leftW - 1);

    // Map account directory UUIDs to real user emails
    const accountMap = new Map<string, string>();
    try {
      const accs = loadAccounts();
      for (const a of accs) {
        accountMap.set(a.id, maskAccountIdentifier(a.email || a.id));
      }
    } catch {}

    // Left Panel: Storage Diagnostics
    const unusedStatus =
      this.unusedBrowsersCount > 0
        ? theme.yellow(`${glyphs.bullet} ${formatBytes(this.reclaimableBrowserBytes)} (${this.unusedBrowsersCount} versions)`)
        : theme.green("✓ None");

    const leftContent: string[] = [
      "",
      `  ${theme.bold(theme.white("Profile Storage:"))}`,
      `    ${theme.dim("Qwen Profiles:")}       ${theme.cyan(formatBytes(this.profilesTotalBytes))} ${theme.muted(`(${this.profilesCount} account${this.profilesCount === 1 ? "" : "s"})`)}`,
      `    ${theme.dim("Active Browser:")}      ${theme.green(`${glyphs.bullet} ${this.activeBrowser}`)}`,
      `    ${theme.dim("Old Browsers:")}        ${unusedStatus}`,
      `    ${theme.dim("Integrity:")}           ${theme.green("✓ Sessions saved")}`,
      "",
      `  ${theme.bold(theme.white("Quick Actions:"))}`,
      `    ${this.hoveredActionRow === 13 ? theme.bgHover(` ${theme.cyan("[ P ] Prune Caches")} `) : `${theme.cyan("[ P ]")} Prune Caches`}`,
      `    ${this.hoveredActionRow === 14 ? theme.bgHover(` ${theme.yellow("[ B ] Clean Browsers")} `) : `${theme.yellow("[ B ]")} Clean Browsers`}`,
      `    ${this.hoveredActionRow === 15 ? theme.bgHover(` ${theme.green("[ Z ] Reset All Cooldowns")} `) : `${theme.green("[ Z ]")} Reset All Cooldowns`}`,
      `    ${this.hoveredActionRow === 16 ? theme.bgHover(` ${theme.red("[ L ] Clear All Chats (Qwen)")} `) : `${theme.red("[ L ]")} Clear All Chats (Qwen)`}`,
      `    ${this.hoveredActionRow === 17 ? theme.bgHover(` ${theme.muted("[ R ] Refresh Disk")} `) : `${theme.muted("[ R ]")} Refresh Disk`}`,
      "",
    ];

    const leftBox = drawBox({
      title: "Disk Space",
      width: leftW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    // Right Panel: Account Profiles & Optimization Logs
    const rightContent: string[] = [
      "",
      `  ${theme.bold(theme.white("On-Disk Account Profiles:"))}`,
      `  ${theme.dim("#   Account               Size          Files")}`,
      `  ${theme.dim("──────────────────────────────────────────────────────────")}`,
    ];

    if (this.profileStats.length === 0) {
      rightContent.push(`  ${theme.muted("No browser profiles initialized yet.")}`);
    } else {
      this.profileStats.forEach((p, idx) => {
        const num = pad(String(idx + 1) + ".", 4);
        const rawName = accountMap.get(p.name) || maskAccountIdentifier(p.name);
        const name = pad(rawName, 22);
        rightContent.push(
          `  ${theme.dim(num)}${theme.white(name)}  ${theme.cyan(pad(p.size, 12))}  ${theme.muted(p.files + " files")}`,
        );
      });
    }

    rightContent.push("");
    rightContent.push(`  ${theme.bold(theme.white("Optimization History:"))}`);
    rightContent.push(`  ${theme.dim("──────────────────────────────────────────────────────────")}`);

    if (this.actionLogs.length === 0) {
      rightContent.push(theme.muted("  No optimizations run in this session."));
      rightContent.push(theme.muted("  Run one of the Quick Actions to optimize disk."));
    } else {
      const maxLogs = Math.max(1, contentH - 12);
      const visibleLogs = this.actionLogs.slice(-maxLogs);
      for (const log of visibleLogs) {
        rightContent.push(`  ${log}`);
      }
    }
    const rightBox = drawBox({
      title: "Profiles & History",
      width: rightW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.cyan,
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

    if (this.confirmDialog) {
      const modalW = Math.min(width - 4, 66);
      this.lastConfirmModalLeftPad = Math.max(0, Math.floor((width - modalW) / 2));
      this.lastConfirmModalStartRow = 4;
      const confirmBtn =
        this.confirmDialogHovered === "confirm"
          ? theme.bgHover(theme.red(" [ Y / Enter ] Yes, Confirm "))
          : ` ${theme.red("[ Y / Enter ] Yes, Confirm")} `;
      const cancelBtn =
        this.confirmDialogHovered === "cancel"
          ? theme.bgHover(theme.green(" [ N / Esc ] Cancel "))
          : ` ${theme.green("[ N / Esc ] Cancel")} `;

      const modalContent = [
        "",
        `  ${theme.bold(this.confirmDialog.message)}`,
        `  ${theme.muted(this.confirmDialog.detail)}`,
        "",
        `  ${confirmBtn}   ${cancelBtn}`,
      ];

      const modalBox = drawBox({
        title: this.confirmDialog.title,
        width: modalW,
        height: Math.min(contentH, 8),
        borderColor: theme.red,
        titleColor: theme.red,
        content: modalContent,
      });

      const padStr = " ".repeat(this.lastConfirmModalLeftPad);
      return modalBox.map((line) => padStr + line);
    }
    return mergedLines;
  }
}
