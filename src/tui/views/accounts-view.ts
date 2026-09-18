/**
 * QwenProxy TUI - Accounts & Cooldowns Management View (Tab 5)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate } from "../theme.ts";
import {
  fetchProxyStatus,
  resetAllCooldowns,
  resetAccountCooldownById,
} from "../proxy-client.ts";
import { addAccount, removeAccount } from "../../core/accounts.ts";
import { ServerManager } from "../server-manager.ts";
import { config } from "../../core/config.ts";
export class AccountsView implements TuiView {
  public readonly id = "accounts";
  public readonly title = "Accounts";
  public readonly tabNumber = 5;

  private statusData: ProxyStatusSnapshot | null = null;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private statusMessage = "";
  private statusMessageTimer: NodeJS.Timeout | null = null;
  private isAddModalOpen = false;
  private addEmailInput = "";
  private addPasswordInput = "";
  private addEmailCursor = 0;
  private addPasswordCursor = 0;
  private addActiveField: "email" | "password" = "email";
  private hoveredActionRow: number | null = null;
  private hoveredAccountIndex: number | null = null;
  private modalHoveredField: "email" | "password" | "save" | "cancel" | null = null;
  private lastModalLeftPad = 0;
  private lastLeftW = 46;
  private lastContentH = 0;
  private confirmDialog: {
    type: "remove_account" | "delete_account_chats" | "delete_all_chats";
    title: string;
    message: string;
    detail: string;
    onConfirm: () => Promise<void>;
  } | null = null;
  private confirmDialogHovered: "confirm" | "cancel" | null = null;
  private lastConfirmModalLeftPad = 0;
  private lastConfirmModalStartRow = 0;
  private accounts: Array<{ id: string; emailOrName: string; [key: string]: unknown }> = [];

  /**
   * Ensure the selected account is visible within the viewport by adjusting scrollOffset.
   */
  private ensureSelectedVisible(contentH: number): void {
    const accounts = this.statusData?.accounts || [];
    if (accounts.length === 0) return;
    const visibleRows = Math.max(1, contentH - 5); // account for header/footer/summary
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIndex - visibleRows + 1;
    }
    const maxScroll = Math.max(0, accounts.length - visibleRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
  }

  constructor() {
    this.refresh();
  }

  public onActivate(): void {
    this.refresh();
  }

  public isCapturingText(): boolean {
    return this.isAddModalOpen || this.confirmDialog !== null;
  }
  public getShortcuts(): Array<{ key: string; label: string }> {
    if (this.confirmDialog) {
      return [
        { key: "Y / Enter", label: "Confirm" },
        { key: "N / Esc", label: "Cancel" },
      ];
    }
    if (this.isAddModalOpen) {
      return [
        { key: "↑↓/Mouse", label: "Switch" },
        { key: "Enter", label: "Save" },
        { key: "Esc", label: "Cancel" },
      ];
    }
    return [
      { key: "a", label: "Add Account" },
      { key: "d", label: "Remove Account" },
      { key: "x", label: "Clear Chats" },
      { key: "l", label: "Clear All Chats" },
      { key: "c", label: "Reset Cooldown" },
      { key: "z", label: "Reset All" },
    ];
  }

  public async refresh(): Promise<void> {
    try {
      this.statusData = await fetchProxyStatus();
      const count = this.statusData.accounts.length;
      if (this.selectedIndex >= count && count > 0) {
        this.selectedIndex = count - 1;
      }
    } catch {}
  }

  private setStatusMessage(msg: string): void {
    this.statusMessage = msg;
    clearTimeout(this.statusMessageTimer!);
    this.statusMessageTimer = setTimeout(() => {
      this.statusMessage = "";
    }, 4000);
  }

  private async saveModalAccount(): Promise<void> {
    const email = this.addEmailInput.trim();
    const password = this.addPasswordInput.trim();
    if (!email || !password) {
      this.setStatusMessage(theme.yellow("[!] Email and password are required"));
      return;
    }

    try {
      const newAcc = addAccount(email, password);
      this.isAddModalOpen = false;
      this.addEmailInput = "";
      this.addPasswordInput = "";
      this.addEmailCursor = 0;
      this.addPasswordCursor = 0;
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Account ${email} saved! Connecting...`));

      if (process.stdout.isTTY && !process.env.NODE_TEST_CONTEXT) {
        const sManager = ServerManager.getInstance();
        const sState = sManager.getState();
        if (sState !== "online" && sState !== "warming") {
          void sManager.ensureStarted().then(() => this.refresh());
        } else {
          // Server already online: initialize session and headers in background for the new account
          void (async () => {
            try {
              const { initPlaywrightForAccount } = await import("../../services/playwright.ts");
              const { getAccountCredentials } = await import("../../core/accounts.ts");
              const creds = getAccountCredentials(newAcc.id);
              if (creds) {
                await initPlaywrightForAccount(
                  creds,
                  config.playwright.headless,
                  config.playwright.browser,
                );
                await this.refresh();
              }
            } catch {}
          })();
        }
      }
    } catch (err: any) {
      this.setStatusMessage(theme.red(`✗ Error saving: ${err?.message || String(err)}`));
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
        this.setStatusMessage(theme.muted("Action cancelled"));
        return true;
      }
      if (key.name === "enter" || key.name === "return") {
        if (this.confirmDialogHovered === "cancel") {
          this.confirmDialog = null;
          this.confirmDialogHovered = null;
          this.setStatusMessage(theme.muted("Action cancelled"));
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
            this.setStatusMessage(theme.muted("Action cancelled"));
            return true;
          }
        }
      }
      return true;
    }

    // 1. Add Account Modal Active
    if (this.isAddModalOpen) {
      if (key.name === "escape") {
        this.isAddModalOpen = false;
        this.addEmailInput = "";
        this.addPasswordInput = "";
        return true;
      }

      // Mouse hover in Add Account modal
      if (key.name === "hover" && key.mouse) {
        const { row, col } = key.mouse;
        const leftPad = this.lastModalLeftPad || 0;
        const relCol = col - leftPad;
        if (row === 5 || row === 6) {
          if (this.modalHoveredField !== "email") {
            this.modalHoveredField = "email";
            return true;
          }
        } else if (row === 7 || row === 8) {
          if (this.modalHoveredField !== "password") {
            this.modalHoveredField = "password";
            return true;
          }
        } else if (row === 9) {
          const btn = relCol <= 24 ? "save" : "cancel";
          if (this.modalHoveredField !== btn) {
            this.modalHoveredField = btn;
            return true;
          }
        } else if (this.modalHoveredField !== null) {
          this.modalHoveredField = null;
          return true;
        }
      }

      // Mouse click in Add Account modal
      if (key.name === "click" && key.mouse) {
        const { row, col } = key.mouse;
        const leftPad = this.lastModalLeftPad || 0;
        const relCol = col - leftPad;
        // Click on email field row (rows 5 and 6)
        if (row === 5 || row === 6) {
          this.addActiveField = "email";
          return true;
        }
        // Click on password field row (rows 7 and 8)
        if (row === 7 || row === 8) {
          this.addActiveField = "password";
          return true;
        }
        // Click on buttons row (row 9)
        if (row === 9) {
          if (relCol <= 24) {
            await this.saveModalAccount();
            return true;
          } else {
            this.isAddModalOpen = false;
            this.addEmailInput = "";
            this.addPasswordInput = "";
            this.addEmailCursor = 0;
            this.addPasswordCursor = 0;
            return true;
          }
        }
      }
      // Switch field with Up / Down arrow keys
      if (key.name === "up" || key.name === "down") {
        this.addActiveField = this.addActiveField === "email" ? "password" : "email";
        return true;
      }

      // Cursor navigation with Left / Right / Home / End
      if (key.name === "left") {
        if (this.addActiveField === "email") {
          this.addEmailCursor = Math.max(0, this.addEmailCursor - 1);
        } else {
          this.addPasswordCursor = Math.max(0, this.addPasswordCursor - 1);
        }
        return true;
      }
      if (key.name === "right") {
        if (this.addActiveField === "email") {
          this.addEmailCursor = Math.min(this.addEmailInput.length, this.addEmailCursor + 1);
        } else {
          this.addPasswordCursor = Math.min(this.addPasswordInput.length, this.addPasswordCursor + 1);
        }
        return true;
      }
      if (key.name === "home") {
        if (this.addActiveField === "email") this.addEmailCursor = 0;
        else this.addPasswordCursor = 0;
        return true;
      }
      if (key.name === "end") {
        if (this.addActiveField === "email") this.addEmailCursor = this.addEmailInput.length;
        else this.addPasswordCursor = this.addPasswordInput.length;
        return true;
      }

      // Paste from clipboard with Ctrl+V
      if (key.ctrl && (key.name === "v" || key.raw === "\x16")) {
        const { getClipboardText } = require("../theme.ts");
        const pasted = getClipboardText();
        if (pasted) {
          if (this.addActiveField === "email") {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              pasted +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor += pasted.length;
          } else {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              pasted +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor += pasted.length;
          }
          return true;
        }
      }
      // Single Ctrl+C in active field clears current field (normal CLI function)
      if (key.ctrl && key.name === "c") {
        if (this.addActiveField === "email") {
          this.addEmailInput = "";
          this.addEmailCursor = 0;
        } else {
          this.addPasswordInput = "";
          this.addPasswordCursor = 0;
        }
        return true;
      }

      // Backspace in active field at cursor
      if (key.name === "backspace") {
        if (this.addActiveField === "email") {
          if (this.addEmailCursor > 0) {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor - 1) +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor--;
          }
        } else {
          if (this.addPasswordCursor > 0) {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor - 1) +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor--;
          }
        }
        return true;
      }

      // Delete key at cursor
      if (key.name === "delete") {
        if (this.addActiveField === "email") {
          if (this.addEmailCursor < this.addEmailInput.length) {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              this.addEmailInput.slice(this.addEmailCursor + 1);
          }
        } else {
          if (this.addPasswordCursor < this.addPasswordInput.length) {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              this.addPasswordInput.slice(this.addPasswordCursor + 1);
          }
        }
        return true;
      }

      // Save on Enter
      if (key.name === "return") {
        await this.saveModalAccount();
        return true;
      }
      // Type character into active field
      // Type character into active field at cursor position
      if (key.char && !key.ctrl && !key.meta && key.name !== "tab") {
        if (key.char >= " ") {
          if (this.addActiveField === "email") {
            this.addEmailInput =
              this.addEmailInput.slice(0, this.addEmailCursor) +
              key.char +
              this.addEmailInput.slice(this.addEmailCursor);
            this.addEmailCursor += key.char.length;
          } else {
            this.addPasswordInput =
              this.addPasswordInput.slice(0, this.addPasswordCursor) +
              key.char +
              this.addPasswordInput.slice(this.addPasswordCursor);
            this.addPasswordCursor += key.char.length;
          }
          return true;
        }
      }
      return true;
    }

    const accounts = this.statusData?.accounts || [];

    // Open Add Account modal with 'a' or 'A'
    if ((key.name === "a" || key.name === "A") && !key.ctrl) {
      this.isAddModalOpen = true;
      this.addEmailInput = "";
      this.addPasswordInput = "";
      this.addActiveField = "email";
      return true;
    }

    // Delete selected account with 'd' or 'D' (requires confirmation)
    if ((key.name === "d" || key.name === "D") && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("[!] No account selected to remove"));
        return true;
      }
      this.confirmDialog = {
        type: "remove_account",
        title: "⚠️  Confirm Account Removal",
        message: `Remove account ${selected.emailOrName}?`,
        detail: "The account will be deleted from the database and its session closed.",
        onConfirm: async () => {
          removeAccount(selected.id);
          try {
            const { closePlaywrightForAccount, removePlaywrightProfile } = await import("../../services/playwright.ts");
            const { getAccountProfilePath } = await import("../../core/paths.ts");
            await closePlaywrightForAccount(selected.id);
            removePlaywrightProfile(getAccountProfilePath(selected.id));
          } catch {}
          await this.refresh();
          this.setStatusMessage(theme.green(`✓ Account ${selected.emailOrName} removed successfully`));
        },
      };
      return true;
    }

    // Delete chats of selected account with 'x' or 'X' (requires confirmation)
    if ((key.name === "x" || key.name === "X") && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("[!] No account selected"));
        return true;
      }
      this.confirmDialog = {
        type: "delete_account_chats",
        title: "⚠️  Delete Remote Chats on Qwen",
        message: `Delete ALL chats on Qwen for account ${selected.emailOrName}?`,
        detail: "This action is irreversible and will clear all conversations on chat.qwen.ai.",
        onConfirm: async () => {
          this.setStatusMessage(theme.yellow(`⏳ Deleting chats on Qwen for ${selected.emailOrName}...`));
          try {
            const { deleteChatsForAccountId } = await import("../../services/chat-cleanup.ts");
            await deleteChatsForAccountId(selected.id);
            await this.refresh();
            this.setStatusMessage(theme.green(`✓ All chats for ${selected.emailOrName} were deleted on Qwen!`));
          } catch (err: any) {
            this.setStatusMessage(theme.red(`✗ Failed to delete chats: ${err?.message || String(err)}`));
          }
        },
      };
      return true;
    }

    // Delete chats of all accounts with 'l' or 'L' (requires confirmation)
    if ((key.name === "l" || key.name === "L") && !key.ctrl) {
      if (accounts.length === 0) {
        this.setStatusMessage(theme.yellow("[!] No accounts configured"));
        return true;
      }
      this.confirmDialog = {
        type: "delete_all_chats",
        title: "⚠️  Delete Chats for ALL Accounts",
        message: `Delete ALL remote chats for ALL ${accounts.length} accounts on Qwen?`,
        detail: "This action is irreversible and will clear history on chat.qwen.ai.",
        onConfirm: async () => {
          this.setStatusMessage(theme.yellow(`⏳ Deleting chats on Qwen for all accounts...`));
          try {
            const { deleteChatsForConfiguredAccounts } = await import("../../services/chat-cleanup.ts");
            const res = await deleteChatsForConfiguredAccounts(true);
            await this.refresh();
            this.setStatusMessage(theme.green(`✓ Chats deleted on Qwen: ${res.succeeded}/${res.attempted} accounts cleared!`));
          } catch (err: any) {
            this.setStatusMessage(theme.red(`✗ Failed to delete chats: ${err?.message || String(err)}`));
          }
        },
      };
      return true;
    }

    // Mouse hover on account rows or right panel actions
if (key.name === "hover" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;

      // Account list rows start at row 9 (row 4=box border, 5=blank, 6=summary, 7=header, 8=divider)
      const visibleRows = Math.max(1, this.lastContentH - 5);
      const maxVisible = Math.min(accounts.length - this.scrollOffset, visibleRows);
      if (col >= 2 && col <= leftW - 1 && row >= 9 && row < 9 + maxVisible) {
        const hoverIdx = this.scrollOffset + (row - 9);
        if (this.hoveredAccountIndex !== hoverIdx) {
          this.hoveredAccountIndex = hoverIdx;
          return true;
        }
      } else if (this.hoveredAccountIndex !== null) {
        this.hoveredAccountIndex = null;
        return true;
      }

      // Right panel action buttons hover (rows 15 to 20)
      if (col >= leftW) {
        if (row >= 15 && row <= 20) {
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
    // Mouse click on account rows or action buttons
    if (key.name === "click" && key.mouse) {
      const { row, col } = key.mouse;
      const leftW = this.lastLeftW || 46;
      const visibleRows = Math.max(1, this.lastContentH - 5);
      const startIdx = Math.max(0, Math.min(this.scrollOffset, Math.max(0, accounts.length - visibleRows)));

      // Click on account row
      if (col >= 2 && col <= leftW - 1 && row >= 9 && row < 9 + Math.min(accounts.length - this.scrollOffset, visibleRows)) {
        this.selectedIndex = this.scrollOffset + (row - 9);
        return true;
      }
      // Right panel action buttons click (rows 15, 16, 17, 18)
      if (col >= leftW) {
        if (row === 15) {
          await this.handleKey({ name: "a", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 16) {
          await this.handleKey({ name: "d", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 17) {
          await this.handleKey({ name: "c", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 18) {
          await this.handleKey({ name: "z", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 19) {
          await this.handleKey({ name: "x", ctrl: false, shift: false, meta: false });
          return true;
        }
        if (row === 20) {
          await this.handleKey({ name: "l", ctrl: false, shift: false, meta: false });
          return true;
        }
      }
    }
    if (key.name === "up" || key.name === "wheelup" || (key.name === "k" && !key.ctrl)) {
      if (accounts.length > 0) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      }
      return true;
    }
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "j" && !key.ctrl)) {
      if (accounts.length > 0) {
        this.selectedIndex = Math.min(accounts.length - 1, this.selectedIndex + 1);
      }
      return true;
    }

    // Page up/down for scrolling through accounts
    if (key.name === "pageup" || (key.name === "up" && key.ctrl)) {
      if (accounts.length > 0) {
        const visibleRows = Math.max(1, this.lastContentH - 5); // account for header/footer/summary
        this.scrollOffset = Math.max(0, this.scrollOffset - visibleRows);
        this.ensureSelectedVisible(this.lastContentH);
      }
      return true;
    }
    if (key.name === "pagedown" || (key.name === "down" && key.ctrl)) {
      if (accounts.length > 0) {
        const visibleRows = Math.max(1, this.lastContentH - 5);
        const maxScroll = Math.max(0, accounts.length - visibleRows);
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + visibleRows);
        this.ensureSelectedVisible(this.lastContentH);
      }
      return true;
    }

    // Refresh with 'r' or 'R'
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      await this.refresh();
      this.setStatusMessage(theme.green("✓ Account list refreshed"));
      return true;
    }

    // Clear cooldown of all accounts with 'z' or 'Z'
    if ((key.name === "z" || key.name === "Z") && !key.ctrl) {
      const cleared = resetAllCooldowns();
      await this.refresh();
      this.setStatusMessage(theme.green(`✓ Cooldowns reset: ${cleared} account(s) released`));
      return true;
    }

    // Clear cooldown of selected account with 'c' or 'C'
    if ((key.name === "c" || key.name === "C") && !key.ctrl) {
      const selected = accounts[this.selectedIndex];
      if (!selected) {
        this.setStatusMessage(theme.yellow("[!] No account selected"));
        return true;
      }
      resetAccountCooldownById(selected.id);
      await this.refresh();
      this.setStatusMessage(
        theme.green(`✓ Cooldown for account ${selected.emailOrName} reset successfully`),
      );
      return true;
    }
  }

  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const contentH = Math.max(12, height);
    this.lastContentH = contentH;
    const leftW = Math.max(46, Math.floor(width * 0.54));
    this.lastLeftW = leftW;
    const rightW = Math.max(30, width - leftW - 1);

    if (snapshot) {
      this.statusData = snapshot;
    }
    const data = snapshot || this.statusData;
    const accounts = data?.accounts || [];
    this.accounts = accounts; // Store for ensureSelectedVisible
    const selected = accounts[this.selectedIndex];

    // Left Panel: Accounts List Table (Pool 2.0 compact: state/health/load).
    const leftContent: string[] = [""];

    if (accounts.length > 0) {
      let readyCount = 0;
      let busyCount = 0;
      let cooldownCount = 0;
      let standbyCount = 0;
      for (const acc of accounts) {
        const state = acc.state ?? (acc.onCooldown ? "COOLDOWN" : acc.headersReady ? "READY" : "WARMING");
        if (state === "COOLDOWN" || acc.onCooldown) {
          cooldownCount++;
        } else if (state === "BUSY") {
          busyCount++;
        } else if (!acc.headersReady) {
          standbyCount++;
        } else {
          readyCount++;
        }
      }
      leftContent.push(
        `  ${theme.green(`r:${readyCount}`)} ${theme.cyan(`b:${busyCount}`)} ${theme.yellow(`c:${cooldownCount}`)} ${theme.muted(`s:${standbyCount}`)}`,
      );
    }

    leftContent.push(`  ${theme.dim("#  Account      State     H  Strm S/F  Cd")}`);
    leftContent.push(`  ${theme.dim("───────────────────────────────────────")}`);

    if (accounts.length === 0) {
      leftContent.push("");
      leftContent.push(`  ${theme.yellow("No accounts configured yet.")}`);
      leftContent.push(`  ${theme.muted("Press ")}${theme.cyan("'A'")}${theme.muted(" or use the side option to add.")}`);
    } else {
      const visibleRows = Math.max(1, contentH - 5);
      const maxScroll = Math.max(0, accounts.length - visibleRows);
      const startIdx = Math.max(0, Math.min(this.scrollOffset, Math.max(0, accounts.length - visibleRows)));
      const endIdx = Math.min(accounts.length, startIdx + visibleRows);
      const visibleAccounts = accounts.slice(startIdx, endIdx);

      visibleAccounts.forEach((acc, idx) => {
        const actualIdx = startIdx + idx;
        const isFocused = actualIdx === this.selectedIndex;
        const isHovered = actualIdx === this.hoveredAccountIndex;
        const pointer = isFocused ? theme.cyan(`${glyphs.pointer} `) : "  ";
        const num = pad(String(actualIdx + 1) + ".", 3);
        const name = pad(truncate(acc.emailOrName, 12), 13);
        const health = typeof acc.health === "number" ? acc.health : 100;
        const streams = acc.activeStreams ?? 0;
        const sf = `${acc.success ?? 0}/${acc.failure ?? 0}`;

        let status = theme.green(`${glyphs.bullet} Ready `);
        const state = acc.state ?? (acc.onCooldown ? "COOLDOWN" : acc.headersReady ? "READY" : "WARMING");
        if (state === "COOLDOWN" || acc.onCooldown) {
          const mins = Math.max(1, Math.round(acc.remainingCooldownMs / 60000));
          status = theme.yellow(`⚠️ ${mins}m cd`);
        } else if (state === "BUSY") {
          status = theme.cyan(`● Busy   `);
        } else if (state === "AUTH_ERROR") {
          status = theme.red(`✗ Auth   `);
        } else if (state === "BROKEN") {
          status = theme.red(`✗ Broken `);
        } else if (state === "DISABLED") {
          status = theme.muted(`⊘ Disab. `);
        } else if (state === "SESSION_EXPIRED") {
          status = theme.yellow(`◐ Expired`);
        } else if (!acc.headersReady) {
          status = acc.isInitialized
            ? theme.yellow(`◐ Warming...`)
            : theme.muted(`○ Standby     `);
        }

        const hStr = pad(String(health), 3);
        const sStr = pad(String(streams), 4);
        const line = `${pointer}${num}${name}${status} ${hStr}${sStr} ${truncate(sf, 7)}`;
        if (isHovered) {
          leftContent.push(theme.bgHover(line));
        } else if (isFocused) {
          leftContent.push(theme.bgSelected(line));
        } else {
          leftContent.push(line);
        }
      });

      // Scroll indicator
      if (accounts.length > visibleRows) {
        const scrollPercent = accounts.length > 0 ? Math.round((this.scrollOffset / (accounts.length - visibleRows)) * 100) : 0;
        leftContent.push("");
        leftContent.push(`  ${theme.muted(`↕ ${this.scrollOffset + 1}-${Math.min(accounts.length, this.scrollOffset + visibleRows)} of ${accounts.length} (${scrollPercent}%)`)}`);
      }
    }

    const leftBox = drawBox({
      title: `Accounts (${accounts.length})`,
      width: leftW,
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.blue,
      footer: this.statusMessage || undefined,
      content: leftContent,
    });

    // Right Panel: Selected Account Details
    const rightContent: string[] = [
      "",
      `  ${theme.bold("Details:")}`,
      `  ${theme.dim("─────────────────────────────────")}`,
    ];

    if (!selected) {
      rightContent.push("");
      rightContent.push(theme.muted("  No accounts configured."));
      rightContent.push("");
      rightContent.push("");
      rightContent.push("");
      rightContent.push("");
      rightContent.push(`  ${theme.dim("─────────────────────────────────")}`);
      rightContent.push(`  ${this.hoveredActionRow === 15 ? theme.bgHover(` ${theme.cyan("[ A ] Add Account")} `) : `${theme.cyan("[ A ]")} Add Account`}`);
    } else {
      const email = truncate(selected.emailOrName, 18);
      rightContent.push(`  ${theme.bold("Account:")}    ${theme.cyan(email)}`);
      rightContent.push(`  ${theme.bold("System ID:")} ${theme.muted(selected.id.slice(0, 14))}`);
      rightContent.push(`  ${theme.bold("Level:")}      ${selected.priority}`);

      const stateLabel = selected.state ?? (selected.onCooldown ? "COOLDOWN" : "READY");
      const cdStatus = selected.onCooldown
        ? theme.yellow(`[!] Cooldown ${Math.round(selected.remainingCooldownMs / 60000)}m${selected.cooldownReason ? ` (${truncate(String(selected.cooldownReason), 18)})` : ""}`)
        : theme.green(`${glyphs.check} Available`);
      rightContent.push(`  ${theme.bold("State:")}      ${cdStatus} ${theme.dim(`[${stateLabel}]`)}`);
      const healthVal = typeof selected.health === "number" ? selected.health : 100;
      rightContent.push(`  ${theme.bold("Health:")}     ${healthVal}/100  Strm:${selected.activeStreams ?? 0}  S/F:${selected.success ?? 0}/${selected.failure ?? 0}`);
      if (selected.lastUsed) {
        const agoS = Math.max(0, Math.round((Date.now() - selected.lastUsed) / 1000));
        const ago = agoS >= 3600 ? `${Math.floor(agoS / 3600)}h${Math.floor((agoS % 3600) / 60)}m` : agoS >= 60 ? `${Math.floor(agoS / 60)}m` : `${agoS}s`;
        rightContent.push(`  ${theme.bold("Last used:")} ${ago} ago`);
      }

      const hStatus = selected.headersReady
        ? theme.green(`${glyphs.check} Captured`)
        : selected.isInitialized
          ? theme.yellow(`◐ Warming...`)
          : theme.muted(`${glyphs.circle} Standby (On Demand)`);
      rightContent.push(`  ${theme.bold("Headers:")}    ${hStatus}`);
      rightContent.push("");
      rightContent.push(`  ${theme.dim("─────────────────────────────────")}`);
      rightContent.push(`  ${this.hoveredActionRow === 15 ? theme.bgHover(` ${theme.cyan("[ A ] Add Account")} `) : `${theme.cyan("[ A ]")} Add Account`}`);
      rightContent.push(`  ${this.hoveredActionRow === 16 ? theme.bgHover(` ${theme.red("[ D ] Remove Account")} `) : `${theme.red("[ D ]")} Remove Account`}`);
      rightContent.push(`  ${this.hoveredActionRow === 17 ? theme.bgHover(` ${theme.yellow("[ C ] Reset Cooldown")} `) : `${theme.yellow("[ C ]")} Reset Cooldown`}`);
      rightContent.push(`  ${this.hoveredActionRow === 18 ? theme.bgHover(` ${theme.green("[ Z ] Reset All")} `) : `${theme.green("[ Z ]")} Reset All`}`);
      rightContent.push(`  ${this.hoveredActionRow === 19 ? theme.bgHover(` ${theme.peach("[ X ] Clear Chats (Account)")} `) : `${theme.peach("[ X ]")} Clear Chats (Account)`}`);
      rightContent.push(`  ${this.hoveredActionRow === 20 ? theme.bgHover(` ${theme.red("[ L ] Clear All Chats")} `) : `${theme.red("[ L ]")} Clear All Chats`}`);
    }
    const rightBox = drawBox({
      title: "Account Inspector",
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
    if (this.isAddModalOpen) {
      const modalW = Math.min(width - 4, 66);
      this.lastModalLeftPad = Math.max(0, Math.floor((width - modalW) / 2));

      const isEmail = this.addActiveField === "email";
      const isPass = this.addActiveField === "password";

      const emailHover = !isEmail && this.modalHoveredField === "email";
      const passHover = !isPass && this.modalHoveredField === "password";

      // Render Email field with clean cursor
      let emailDisplay: string;
      if (isEmail) {
        if (this.addEmailInput.length === 0) {
          emailDisplay = `${theme.inverse(" ")} ${theme.dim("(enter email)")}`;
        } else {
          const before = this.addEmailInput.slice(0, this.addEmailCursor);
          const at = this.addEmailInput[this.addEmailCursor] || " ";
          const after = this.addEmailInput.slice(this.addEmailCursor + 1);
          emailDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
        }
      } else {
        emailDisplay = this.addEmailInput
          ? (emailHover ? theme.bgHover(` ${this.addEmailInput} `) : theme.cyan(` ${this.addEmailInput} `))
          : (emailHover ? theme.bgHover(" (enter email) ") : theme.muted(" (enter email) "));
      }

      // Render Password field with clean cursor
      let passDisplay: string;
      const maskedPass = "•".repeat(this.addPasswordInput.length);
      if (isPass) {
        if (this.addPasswordInput.length === 0) {
          passDisplay = `${theme.inverse(" ")} ${theme.dim("(enter password)")}`;
        } else {
          const before = maskedPass.slice(0, this.addPasswordCursor);
          const at = maskedPass[this.addPasswordCursor] || " ";
          const after = maskedPass.slice(this.addPasswordCursor + 1);
          passDisplay = `${theme.cyan(before)}${theme.inverse(at)}${theme.cyan(after)}`;
        }
      } else {
        passDisplay = this.addPasswordInput
          ? (passHover ? theme.bgHover(` ${maskedPass} `) : theme.cyan(` ${maskedPass} `))
          : (passHover ? theme.bgHover(" (enter password) ") : theme.muted(" (enter password) "));
      }
      const saveBtn =
        this.modalHoveredField === "save"
          ? theme.bgHover(theme.green(" [ Enter ] Save "))
          : theme.green("[ Enter ] Save");

      const cancelBtn =
        this.modalHoveredField === "cancel"
          ? theme.bgHover(theme.red(" [ Esc ] Cancel "))
          : theme.muted("[ Esc ] Cancel");
      const modalContent = [
        "",
        `  ${theme.bold("Email:")}  ${emailDisplay}`,
        `  ${theme.bold("Password:")}   ${passDisplay}`,
        "",
        `  ${saveBtn}   ${cancelBtn}   ${theme.dim("(↑↓/mouse to switch)")}`,
      ];

      const modalBox = drawBox({
        title: "Add New Qwen Account (Login)",
        width: modalW,
        height: Math.min(contentH, 11),
        borderColor: theme.borderActive,
        titleColor: theme.cyan,
        content: modalContent,
      });

      const padStr = " ".repeat(this.lastModalLeftPad);
      return modalBox.map((line) => padStr + line);
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
