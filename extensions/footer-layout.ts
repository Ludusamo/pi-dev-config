/**
 * Custom footer layout.
 *
 * Replaces the built-in two-line footer with:
 *   line 1: cost + token/status info (left)   | cwd + git branch (right)
 *   line 2: mode + model + effort (left)
 * Extension status lines (ctx.ui.setStatus) are preserved below, unchanged.
 *
 * Rendered in normal (non-dim) theme text, unlike the built-in footer which
 * dims most of this content.
 *
 * Mode comes from the agent-modes extension's footer status entry
 * ("agent-mode" -> "Mode: <label>", set via ctx.ui.setStatus). That status
 * text is exposed to any footer through footerData.getExtensionStatuses(),
 * so no direct coupling to agent-modes.ts is needed.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Extracts the mode label from the agent-modes extension's "Mode: <label>" status text. */
function extractModeLabel(statuses: ReadonlyMap<string, string>): string | undefined {
  const raw = statuses.get("agent-mode");
  if (!raw) return undefined;
  const match = raw.match(/^Mode:\s*(.+)$/);
  return match ? match[1] : raw;
}

/** Right-aligns `right` against `left` within `width`, truncating `right` first if needed. */
function padLine(left: string, right: string, width: number): string {
  const minPadding = 2;
  let leftStr = left;
  let leftWidth = visibleWidth(leftStr);
  if (leftWidth > width) {
    leftStr = truncateToWidth(leftStr, width, "...");
    leftWidth = visibleWidth(leftStr);
  }
  const rightWidth = visibleWidth(right);
  if (leftWidth + minPadding + rightWidth <= width) {
    return leftStr + " ".repeat(width - leftWidth - rightWidth) + right;
  }
  const availableForRight = width - leftWidth - minPadding;
  if (availableForRight <= 0) return leftStr;
  const truncatedRight = truncateToWidth(right, availableForRight, "");
  const truncatedRightWidth = visibleWidth(truncatedRight);
  return leftStr + " ".repeat(Math.max(0, width - leftWidth - truncatedRightWidth)) + truncatedRight;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
          let latestCacheHitRate: number | undefined;

          const addUsage = (usage: Usage) => {
            totals.input += usage.input;
            totals.output += usage.output;
            totals.cacheRead += usage.cacheRead;
            totals.cacheWrite += usage.cacheWrite;
            totals.cost += usage.cost.total;
          };

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const usage = (entry.message as AssistantMessage).usage;
              addUsage(usage);
              const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
              latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
            } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
              addUsage(entry.message.usage);
            } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
              addUsage(entry.usage);
            }
          }

          // --- line 1 left: cost + token/status info ---
          const statsParts: string[] = [];
          // Always shown, even at $0.000: subscription usage can legitimately be zero cost.
          statsParts.push(`$${totals.cost.toFixed(3)}`);
          if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
            statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercentDisplay =
            contextUsage?.percent != null
              ? `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)}`
              : `?/${formatTokens(contextWindow)}`;
          const contextPercentStr =
            contextPercentValue > 90
              ? theme.fg("error", contextPercentDisplay)
              : contextPercentValue > 70
                ? theme.fg("warning", contextPercentDisplay)
                : theme.fg("text", contextPercentDisplay);

          const line1Left =
            statsParts.length > 0 ? `${theme.fg("text", statsParts.join(" "))} ${contextPercentStr}` : contextPercentStr;

          // --- line 2 left: mode + model + effort ---
          const extensionStatuses = footerData.getExtensionStatuses();
          const modeLabel = extractModeLabel(extensionStatuses);
          const modelName =
            footerData.getAvailableProviderCount() > 1 && ctx.model
              ? `${ctx.model.provider}/${ctx.model.id}`
              : (ctx.model?.id ?? "no-model");
          const effort = ctx.model?.reasoning ? (ctx.thinkingLevel ?? "off") : undefined;

          const line2Parts = [modeLabel, modelName, effort ? `effort: ${effort}` : undefined].filter(
            (part): part is string => Boolean(part),
          );
          const line2Left = theme.fg("text", line2Parts.join(" • "));

          // --- right side (line 1 only): cwd + git branch/subtree ---
          const home = process.env.HOME || process.env.USERPROFILE;
          let pwd = formatCwd(ctx.cwd, home);
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const rightSide = theme.fg("text", pwd);

          const lines = [padLine(line1Left, rightSide, width), truncateToWidth(line2Left, width, "...")];

          // "agent-mode" is already rendered as part of line 2 above; exclude it here to avoid duplication.
          const remainingStatuses = Array.from(extensionStatuses.entries()).filter(([key]) => key !== "agent-mode");
          if (remainingStatuses.length > 0) {
            const sortedStatuses = remainingStatuses
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  });
}
