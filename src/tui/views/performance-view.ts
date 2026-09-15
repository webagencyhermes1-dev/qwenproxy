/**
 * QwenProxy TUI - Performance Metrics View (Tab 7)
 */

import type { TuiView, ProxyStatusSnapshot } from "../types.ts";
import type { KeyEvent } from "../screen.ts";
import { theme, glyphs, drawBox, pad, truncate, stringWidth } from "../theme.ts";
import { formatUptime } from "../proxy-client.ts";

export class PerformanceView implements TuiView {
  public readonly id = "performance";
  public readonly title = "Performance";
  public readonly tabNumber = 7;

  public getShortcuts(): Array<{ key: string; label: string }> {
    return [
      { key: "r", label: "Refresh" },
    ];
  }

  public async handleKey(key: KeyEvent): Promise<boolean | void> {
    if ((key.name === "r" || key.name === "R") && !key.ctrl) {
      return true;
    }
  }

  public render(width: number, height: number, snapshot?: ProxyStatusSnapshot | null): string[] {
    const data = snapshot;
    const perf = data?.performance;
    const contentH = Math.max(12, height);

    const uptimeSecs = data?.uptimeSeconds || Math.floor(process.uptime());
    const uptimeStr = formatUptime(uptimeSecs);

    const leftContent: string[] = [
      "",
      `  ${theme.bold("Uptime:")}       ${theme.cyan(uptimeStr)}`,
      "",
      `  ${theme.bold("Latency (Avg):")} ${perf ? theme.cyan(perf.avgLatencyMs.toFixed(1) + " ms") : theme.muted("N/A")}`,
      `  ${theme.bold("TTFB (Avg):")}    ${perf ? theme.cyan(perf.avgTtfbMs.toFixed(1) + " ms") : theme.muted("N/A")}`,
      `  ${theme.bold("Tokens/sec:")}    ${perf ? theme.cyan(perf.tokensPerSecond.toFixed(1) + " tok/s") : theme.muted("N/A")}`,
      "",
      `  ${theme.bold("Total Requests:")}     ${perf ? theme.cyan(String(perf.totalRequests)) : theme.muted("0")}`,
      `  ${theme.bold("Prompt Tokens:")}      ${perf ? theme.cyan(this.formatNumber(perf.totalPromptTokens)) : theme.muted("0")}`,
      `  ${theme.bold("Completion Tokens:")}  ${perf ? theme.cyan(this.formatNumber(perf.totalCompletionTokens)) : theme.muted("0")}`,
      `  ${theme.bold("Total Tokens:")}       ${perf ? theme.cyan(this.formatNumber(perf.totalTokens)) : theme.muted("0")}`,
      "",
      `  ${theme.bold("Recent (1m):")}        ${perf ? theme.yellow(String(perf.recentRequests)) : theme.muted("0")} requests`,
    ];

    const rightContent: string[] = [
      "",
      `  ${theme.bold("Performance Indicators")}`,
      `  ${theme.dim("───────────────────────────────────────")}`,
      "",
    ];

    if (perf) {
      const latencyStatus = this.getLatencyStatus(perf.avgLatencyMs);
      const ttfbStatus = this.getTtfbStatus(perf.avgTtfbMs);
      const tpsStatus = this.getTpsStatus(perf.tokensPerSecond);

      rightContent.push(`  Latency:       ${latencyStatus}`);
      rightContent.push(`  TTFB:          ${ttfbStatus}`);
      rightContent.push(`  Throughput:    ${tpsStatus}`);
      rightContent.push("");

      rightContent.push(`  ${theme.bold("Token Breakdown")}`);
      rightContent.push(`  ${theme.dim("───────────────────────────────────────")}`);
      rightContent.push("");

      const total = perf.totalTokens || 1;
      const promptPct = Math.round((perf.totalPromptTokens / total) * 100);
      const completionPct = Math.round((perf.totalCompletionTokens / total) * 100);

      rightContent.push(`  ${theme.cyan("Prompt:")}       ${this.renderBar(promptPct, 20)} ${promptPct}%`);
      rightContent.push(`  ${theme.green("Completion:")}   ${this.renderBar(completionPct, 20)} ${completionPct}%`);
      rightContent.push("");
      rightContent.push(`  ${theme.bold("Efficiency")}`);
      rightContent.push(`  ${theme.dim("───────────────────────────────────────")}`);
      rightContent.push("");

      if (perf.totalRequests > 0) {
        const avgPromptPerReq = Math.round(perf.totalPromptTokens / perf.totalRequests);
        const avgCompletionPerReq = Math.round(perf.totalCompletionTokens / perf.totalRequests);
        rightContent.push(`  Avg Prompt/Req:      ${theme.cyan(String(avgPromptPerReq))}`);
        rightContent.push(`  Avg Completion/Req:  ${theme.green(String(avgCompletionPerReq))}`);
      }

      if (perf.tokensPerSecond > 0 && perf.avgLatencyMs > 0) {
        const efficiency = (perf.tokensPerSecond * 1000) / perf.avgLatencyMs;
        rightContent.push(`  Token Efficiency:    ${theme.yellow(efficiency.toFixed(2))}`);
      }
    } else {
      rightContent.push(`  ${theme.muted("No performance data available yet.")}`);
      rightContent.push(`  ${theme.muted("Make some requests to populate metrics.")}`);
    }

    const leftBox = drawBox({
      title: "System Metrics",
      width: Math.max(40, Math.floor(width * 0.5)),
      height: contentH,
      borderColor: theme.borderActive,
      titleColor: theme.cyan,
      content: leftContent,
    });

    const rightW = Math.max(40, width - leftBox[0].length - 1);
    const rightBox = drawBox({
      title: "Analysis",
      width: rightW,
      height: contentH,
      borderColor: theme.borderInactive,
      titleColor: theme.lavender,
      content: rightContent,
    });

    const mergedLines: string[] = [];
    const maxRows = Math.max(leftBox.length, rightBox.length);
    for (let r = 0; r < maxRows; r++) {
      const leftRow = leftBox[r] || " ".repeat(leftBox[0].length);
      const rightRow = rightBox[r] || " ".repeat(rightW);
      mergedLines.push(leftRow + " " + rightRow);
    }

    return mergedLines;
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + "M";
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + "K";
    }
    return String(num);
  }

  private getLatencyStatus(avgMs: number): string {
    if (avgMs === 0) return theme.muted("N/A");
    if (avgMs < 100) return theme.green(`${avgMs.toFixed(1)}ms ${glyphs.check} Excellent`);
    if (avgMs < 500) return theme.yellow(`${avgMs.toFixed(1)}ms ${glyphs.warn} Good`);
    if (avgMs < 1000) return theme.peach(`${avgMs.toFixed(1)}ms ${glyphs.warn} Fair`);
    return theme.red(`${avgMs.toFixed(1)}ms ${glyphs.cross} Poor`);
  }

  private getTtfbStatus(avgMs: number): string {
    if (avgMs === 0) return theme.muted("N/A");
    if (avgMs < 50) return theme.green(`${avgMs.toFixed(1)}ms ${glyphs.check} Excellent`);
    if (avgMs < 200) return theme.yellow(`${avgMs.toFixed(1)}ms ${glyphs.warn} Good`);
    if (avgMs < 500) return theme.peach(`${avgMs.toFixed(1)}ms ${glyphs.warn} Fair`);
    return theme.red(`${avgMs.toFixed(1)}ms ${glyphs.cross} Poor`);
  }

  private getTpsStatus(tps: number): string {
    if (tps === 0) return theme.muted("N/A");
    if (tps > 100) return theme.green(`${tps.toFixed(1)} tok/s ${glyphs.check} Excellent`);
    if (tps > 50) return theme.yellow(`${tps.toFixed(1)} tok/s ${glyphs.warn} Good`);
    if (tps > 20) return theme.peach(`${tps.toFixed(1)} tok/s ${glyphs.warn} Fair`);
    return theme.red(`${tps.toFixed(1)} tok/s ${glyphs.cross} Poor`);
  }

  private renderBar(percentage: number, width: number): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return theme.green(glyphs.blockFull.repeat(filled)) + theme.muted(glyphs.blockLight.repeat(empty));
  }
}