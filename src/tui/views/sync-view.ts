/**
 * QwenProxy TUI - Selective Client Sync View (Tab 3)
 */

import type { TuiView } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad } from "../theme.ts";
import {
  syncAllClients,
  restoreAllClients,
  getDefaultPaths,
  inspectClientSyncStatus,
} from "../../sync/index.ts";
import { fetchLiveModels } from "../proxy-client.ts";

interface ClientOption {
  id: "claude-code" | "codex" | "opencode" | "omp";
  name: string;
  path: string;
  selected: boolean;
  detected: boolean;
  synced: boolean;
  configuredModel?: string;
}
export class SyncView implements TuiView {
  public readonly id = "sync";
  public readonly title = "Sync";
  public readonly tabNumber = 3;
  private clients: ClientOption[] = [];
  private selectedRowIndex = 0; // 0..3 for clients, 4 for model, 5 for scope, 6 for sync, 7 for restore
  private hoveredActionRow: number | null = null;
  private availableModels = [
    "qwen3.8-max",
    "qwen3.7-plus",
    "qwen3.7-max",
    "z-image-turbo",
    "qwen-image-3.0-pro",
    "wan3.0-video",
  ];
  private modelIndex = 0;
  private syncAllModels = true;
  private actionLog: string[] = [];
  private lastLeftW = 46;
  constructor() {
    this.detectClients();
  }

  public onActivate(): void {
    this.detectClients();
    void this.refreshModels();
  }
  private async refreshModels(): Promise<void> {
    try {
      const live = await fetchLiveModels();
      if (live && live.length > 0) {
        this.availableModels = live;
      }
    } catch {}
  }

  private detectClients(): void {
    const paths = getDefaultPaths();
    const defs: Array<{ id: "claude-code" | "codex" | "opencode" | "omp"; name: string; path: string }> = [
      { id: "claude-code", name: "Claude Code", path: paths.claudeCode },
      { id: "codex", name: "OpenAI Codex", path: paths.codex },
      { id: "opencode", name: "OpenCode", path: paths.openCode },
      { id: "omp", name: "OMP (Oh My Pi)", path: paths.omp },
    ];

    this.clients = defs.map((d) => {
      const status = inspectClientSyncStatus(d.id, d.path);
      return {
        id: d.id,
        name: d.name,
        path: d.path,
        selected: false,
        detected: status.installed,
        synced: status.synced,
        configuredModel: status.model,
      };
    });
  }

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "Space", label: "Check/Uncheck" },
      { key: "Enter", label: "Sync" },
      { key: "r", label: "Restore Backups" },
      { key: "a", label: "Toggle All" },
    ];
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    // Mouse hover interactions
    if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;
      if (col >= 2 && col <= leftW - 1) {
        if (row >= 8 && row <= 11) {
          const targetRow = row - 8;
          if (this.selectedRowIndex !== targetRow) {
            this.selectedRowIndex = targetRow;
            return true;
          }
        } else if (row === 14) {
          if (this.selectedRowIndex !== 4) {
            this.selectedRowIndex = 4;
            return true;
          }
        } else if (row === 15) {
          if (this.selectedRowIndex !== 5) {
            this.selectedRowIndex = 5;
            return true;
          }
        } else if (row === 18 || row === 19) {
          if (this.hoveredActionRow !== row) {
            this.hoveredActionRow = row;
            return true;
          }
        } else if (this.hoveredActionRow !== null) {
          this.hoveredActionRow = null;
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
      const leftW = this.lastLeftW || 46;
      if (col >= 2 && col <= leftW - 1) {
        // Rows 8, 9, 10, 11: Toggle client
        if (row >= 8 && row <= 11) {
          const client = this.clients[row - 8];
          if (client) {
            client.selected = !client.selected;
            this.selectedRowIndex = row - 8;
            return true;
          }
        }
        // Row 14: Model selector
        if (row === 14) {
          this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
          this.selectedRowIndex = 4;
          return true;
        }
        // Row 15: Scope selector
        if (row === 15) {
          this.syncAllModels = !this.syncAllModels;
          this.selectedRowIndex = 5;
          return true;
        }
        // Row 18: Sync button
        if (row === 18) {
          this.selectedRowIndex = 6;
          this.executeSync();
          return true;
        }
        // Row 19: Restore button
        if (row === 19) {
          this.selectedRowIndex = 7;
          this.executeRollback();
          return true;
        }
      }
    }

    // Navigate rows (Mouse wheel or Up/Down keys)
    if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
      this.selectedRowIndex = Math.max(0, this.selectedRowIndex - 1);
      return true;
    }
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
      this.selectedRowIndex = Math.min(7, this.selectedRowIndex + 1);
      return true;
    }

    // Toggle client selection with Space
    if (key.name === "space") {
      if (this.selectedRowIndex < 4) {
        const client = this.clients[this.selectedRowIndex];
        if (client) {
          client.selected = !client.selected;
        }
      } else if (this.selectedRowIndex === 4) {
        // Cycle model with space
        this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
      } else if (this.selectedRowIndex === 5) {
        this.syncAllModels = !this.syncAllModels;
      }
      return true;
    }

    // Cycle model left/right on row 4
    if (this.selectedRowIndex === 4 && (key.name === "left" || key.name === "right")) {
      if (key.name === "left") {
        this.modelIndex =
          (this.modelIndex - 1 + this.availableModels.length) %
          this.availableModels.length;
      } else {
        this.modelIndex = (this.modelIndex + 1) % this.availableModels.length;
      }
      return true;
    }

    // Toggle all with 'a'
    if (key.name === "a" && !key.ctrl) {
      const allSelected = this.clients.every((c) => c.selected);
      for (const c of this.clients) {
        c.selected = !allSelected;
      }
      this.actionLog.unshift(
        allSelected ? "Unchecked all clients." : "Selected all clients.",
      );
      return true;
    }

    // Rollback with 'r'
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      this.executeRollback();
      return true;
    }

    // Confirm action on Enter
    if (key.name === "return") {
      if (this.selectedRowIndex === 7) {
        this.executeRollback();
      } else {
        this.executeSync();
      }
      return true;
    }
  }

  private executeSync(): void {
    const selectedTargets = this.clients
      .filter((c) => c.selected)
      .map((c) => c.id);

    if (selectedTargets.length === 0) {
      this.actionLog.unshift(theme.yellow("⚠ No clients selected to sync."));
      return;
    }
    const currentModel = this.availableModels[this.modelIndex] || "qwen3.8-max";
    this.actionLog.unshift(
      theme.cyan(`⏳ Syncing [${selectedTargets.join(", ")}] with model ${currentModel}...`),
    );
    try {
      const res = syncAllClients({
        targets: selectedTargets,
      });

      let successCount = 0;
      for (const [key, clientRes] of Object.entries(res.clients)) {
        if (clientRes && clientRes.success) {
          successCount++;
          this.actionLog.unshift(
            theme.green(`✓ [${key}] ${clientRes.message || "Configured successfully"}`),
          );
        } else if (clientRes) {
          this.actionLog.unshift(
            theme.red(`✗ [${key}] Failed: ${clientRes.error || "Unknown error"}`),
          );
        }
      }

      this.actionLog.unshift(
        theme.green(`🎉 Done: ${successCount} client(s) synced with zero loss!`),
      );
      this.detectClients();
    } catch (err: any) {
    }
  }

  private executeRollback(): void {
    this.actionLog.unshift(theme.yellow("⏳ Restoring previous config backups..."));
    try {
      const res = restoreAllClients();
      this.actionLog.unshift(
        theme.green(`✓ Rollback done: ${res.restoredCount} file(s) restored successfully.`),
      );
      this.detectClients();
    } catch (err: any) {
      this.actionLog.unshift(theme.red(`✗ Error restoring backups: ${err?.message || String(err)}`));
    }
  }

  public render(width: number, height: number): string[] {
    const contentH = Math.max(12, height);
    const leftW = Math.max(46, Math.floor(width * 0.52));
    this.lastLeftW = leftW;
    const rightW = Math.max(30, width - leftW - 1);

    // Left Panel: Options and Selectors
    const leftContent: string[] = [
      "",
      `  ${theme.bold("Clients:")} (Space to check)`,
      "",
    ];

    this.clients.forEach((c, idx) => {
      const isFocused = this.selectedRowIndex === idx;
      const pointer = isFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
      const check = c.selected ? theme.green(glyphs.checkOn) : theme.muted(glyphs.checkOff);
      const name = pad(c.name, 16);

      let status: string;
      if (c.synced) {
        status = theme.green(`${glyphs.check} Synced`);
      } else if (c.detected) {
        status = theme.yellow(`${glyphs.bullet} Other provider`);
      } else {
        status = theme.muted(`${glyphs.circle} Not installed`);
      }

      const line = `${pointer}${check} ${name} ${status}`;
      leftContent.push(isFocused ? theme.bgSelected(line) : line);
    });

    leftContent.push("");
    leftContent.push(`  ${theme.bold("Model:")}`);

    // Row index 4: Model Selector
    const isModelFocused = this.selectedRowIndex === 4;
    const modelPointer = isModelFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
    const currentModel = this.availableModels[this.modelIndex] || "qwen3.8-max";
    const modelText = `${currentModel} (${this.modelIndex + 1}/${this.availableModels.length})`;

    const modelLine = this.syncAllModels
      ? `${modelPointer}${theme.dim(`${modelText}`)}`
      : `${modelPointer}${theme.cyan(modelText)}`;

    leftContent.push(isModelFocused ? theme.bgSelected(modelLine) : modelLine);

    // Row index 5: Scope Selector
    const isScopeFocused = this.selectedRowIndex === 5;
    const scopePointer = isScopeFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
    const scopeCheck = this.syncAllModels ? theme.green(glyphs.radioOn) : theme.muted(glyphs.radioOff);
    const scopeLine = `${scopePointer}${scopeCheck} Register all models`;
    leftContent.push(isScopeFocused ? theme.bgSelected(scopeLine) : scopeLine);
    leftContent.push("");
    leftContent.push(`  ${theme.bold("Actions:")}`);
    // Row 18: Sync
    const isSyncFocused = this.selectedRowIndex === 6;
    const isSyncHovered = this.hoveredActionRow === 18;
    const syncLine = `    ${isSyncHovered || isSyncFocused ? theme.bgHover(` ${theme.cyan("[ Enter ] Sync")} `) : `${theme.cyan("[ Enter ]")} Sync`}`;
    leftContent.push(syncLine);

    // Row 19: Restore
    const isRestoreFocused = this.selectedRowIndex === 7;
    const isRestoreHovered = this.hoveredActionRow === 19;
    const restoreLine = `    ${isRestoreHovered || isRestoreFocused ? theme.bgHover(` ${theme.yellow("[ R ] Restore")} `) : `${theme.yellow("[ R ]")} Restore`}`;
    leftContent.push(restoreLine);

    const leftBox = drawBox({
      title: "Configure",
      width: leftW,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    // Right Panel: Action Log & Backups
    const rightContent: string[] = [
      "",
      `  ${theme.bold("History:")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
    ];

    if (this.actionLog.length === 0) {
      rightContent.push("");
      rightContent.push(theme.muted("  No recent syncs run in this session."));
      rightContent.push("");
      rightContent.push(
        theme.muted("  Press [ Enter ] to sync the selected clients."),
      );
      rightContent.push(
        theme.muted("  Backups (.bak) are created automatically before each change."),
      );
    } else {
      for (const log of this.actionLog.slice(0, contentH - 5)) {
        rightContent.push(`  ${log}`);
      }
    }
    const rightBox = drawBox({
      title: "History & Backups",
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
