import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A mode bundles the policies that govern how autonomously the agent behaves:
 * - which built-in tools are available (e.g. edit/write removed in pair mode)
 * - whether git write commands (commit/push) are allowed
 * - a system prompt snippet describing the mode's behavior to the model
 */
interface AgentMode {
  name: string;
  label: string;
  description: string;
  editPolicy: "blocked" | "unrestricted";
  gitWritePolicy: "blocked" | "unrestricted";
  systemPromptSnippet: string;
}

const MODES: Record<string, AgentMode> = {
  pair: {
    name: "pair",
    label: "Pair Coding",
    description:
      "Design and discuss together. Never edit files or commit/push without explicit user permission.",
    editPolicy: "blocked",
    gitWritePolicy: "blocked",
    systemPromptSnippet:
      "You are in PAIR CODING mode. Spend time designing with the user, offering " +
      "suggestions, and proposing code snippets. Do not edit or write files, and do " +
      "not commit or push, unless the user explicitly asks you to.",
  },
  auto: {
    name: "auto",
    label: "Full Auto",
    description:
      "Fully autonomous: design, implement, review, and commit without needing to check in.",
    editPolicy: "unrestricted",
    gitWritePolicy: "unrestricted",
    systemPromptSnippet:
      "You are in FULL AUTO mode. Act autonomously: design, implement, review, and " +
      "commit/push as needed to complete the task, unless the user's prompt asks you " +
      "to be more careful.",
  },
};

const DEFAULT_MODE = "pair";

// Global (cross-session, cross-project) record of the last mode used.
const STATE_FILE = join(homedir(), ".pi", "agent", "agent-modes-state.json");

async function loadLastMode(): Promise<string> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { mode?: string };
    if (parsed.mode && MODES[parsed.mode]) return parsed.mode;
  } catch {
    // No state file yet, or unreadable/corrupt -- fall back to default.
  }
  return DEFAULT_MODE;
}

async function saveLastMode(mode: string): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ mode }, null, 2), "utf8");
}

export default function (pi: ExtensionAPI) {
  let currentMode: AgentMode = MODES[DEFAULT_MODE];

  function updateStatus(ctx: ExtensionCommandContext | ExtensionContext) {
    ctx.ui.setStatus("agent-mode", `Mode: ${currentMode.label}`);
  }

  async function setMode(name: string, ctx: ExtensionCommandContext) {
    const mode = MODES[name];
    if (!mode) {
      ctx.ui.notify(`Unknown mode: ${name}. Available: ${Object.keys(MODES).join(", ")}`, "error");
      return;
    }
    currentMode = mode;
    await saveLastMode(name);
    updateStatus(ctx);
    ctx.ui.notify(`Switched to ${mode.label} mode.`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    const name = await loadLastMode();
    currentMode = MODES[name];
    updateStatus(ctx);
  });

  pi.registerCommand("mode", {
    description: "Switch agent mode (pair | auto)",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        ctx.ui.notify(
          `Current mode: ${currentMode.label}. Available: ${Object.keys(MODES).join(", ")}`,
          "info",
        );
        return;
      }
      await setMode(requested, ctx);
    },
  });

  // Tool gating and prompt injection come next.
}
