import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "./subagent/agents.ts";

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

const COORDINATOR_BASE_SNIPPET =
  "You are in COORDINATOR mode. You are a coordinator, not an implementer:\n" +
  "- Do not do substantial thinking, research, or implementation work yourself. " +
  "Break the user's request into concrete tasks and delegate each one to a " +
  "subagent (the subagent tool). Let subagents do the heavy lifting.\n" +
  "- Built-in file edit/write and git commit/push are blocked for you directly in " +
  "this mode - that is intentional. Have a subagent make file changes and commits; " +
  "only use light read-only tools yourself to route work or sanity-check results.\n" +
  "- If a subagent's response contains a question, asks for clarification, or " +
  "seems unsure how to proceed, do NOT answer on its behalf and do NOT guess. Stop, " +
  "relay the question to the user (ask them directly), and wait for their answer " +
  "before resuming or re-dispatching the subagent.\n" +
  "- Default to self-doubt: assume your own unaided judgement is more likely wrong " +
  "than a subagent's focused output or the user's clarification. Prefer verifying " +
  "through a subagent, or checking with the user, over confidently asserting an " +
  "answer yourself.\n" +
  "- When unsure whether something needs user input or another subagent, err on the " +
  "side of asking rather than proceeding unilaterally.\n" +
  "- Default to one-shot delegation (single/parallel/chain) - it's simpler and " +
  "leaves no stale state behind. Reach for persistent open/send/close only for " +
  "genuine multi-turn work against the same accumulated context, e.g. iterative " +
  "code review: open a reviewer on a diff, dispatch a one-shot worker to make " +
  "fixes, then send the updated diff back to that same reviewer handle to verify " +
  "the prior findings. Close a session once its work is done; use list if you " +
  "lose track of a handle; never invent or guess a handle - only use ones " +
  "returned by open or list.";

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
  coordinator: {
    name: "coordinator",
    label: "Coordinator",
    description:
      "Delegate work to subagents instead of doing it yourself; escalate subagent " +
      "questions to the user; err on the side of self-doubt.",
    editPolicy: "blocked",
    gitWritePolicy: "blocked",
    // Static fallback only - the live snippet actually injected each turn is
    // computed fresh by buildCoordinatorSnippet() so it can include an
    // up-to-date list of real subagent names. See lastCoordinatorSnippet.
    systemPromptSnippet: COORDINATOR_BASE_SNIPPET,
  },
};

const DEFAULT_MODE = "pair";

function isQwen3(model: Model | undefined): boolean {
  if (!model) return false;
  const id = (model.id ?? "").toLowerCase();
  const name = (model.name ?? "").toLowerCase();
  return id.includes("qwen3") || name.includes("qwen3");
}

const GIT_WRITE_COMMAND = /\bgit\b[^&|;]*\b(commit|push|merge|rebase|reset\s+--hard|tag)\b/;

function isGitWriteCommand(command: string | undefined): boolean {
  if (!command) return false;
  return GIT_WRITE_COMMAND.test(command);
}

// --- Coordinator-mode delegation footer -----------------------------------
//
// Tracks subagent tool calls made while in coordinator mode and renders them
// as a status bar widget: one line per task with a live-ticking elapsed time
// and a status icon (⏳ running, ✓ finished, ⚠️ failed), plus a ✅ summary
// line once every tracked task has settled with no failures. Reuses the
// subagent tool's own toolCallId as the task id, so it stays in step with
// the same tool_execution_start/end events the subagent extension's session
// store (extensions/subagent/store.ts) is built from - this is a second,
// lightweight view over the same underlying task data, not a competing
// tracker.

type DelegationStatus = "running" | "done" | "failed";

interface DelegatedTask {
  id: string;
  label: string;
  status: DelegationStatus;
  startedAt: number;
  endedAt?: number;
}

const MAX_TRACKED_DELEGATIONS = 20;
const MAX_SHOWN_DELEGATIONS = 5;
const WIDGET_TICK_MS = 1000;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function truncate(text: string | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

// Mirrors the subagent tool's own argument shapes just enough to build a
// short human-readable label; kept intentionally loose/untyped since this
// extension doesn't share types with the subagent extension.
function labelForSubagentCall(args: Record<string, any>): string {
  if (args.list) return "list sessions";
  if (args.close) return `close ${args.close.handle}`;
  if (args.send) return `${args.send.handle}: ${truncate(args.send.message, 40)}`;
  if (args.open) return `open ${args.open.agent}: ${truncate(args.open.task, 40)}`;
  if (Array.isArray(args.chain) && args.chain.length > 0) {
    return `chain (${args.chain.length}): ${args.chain.map((s: any) => s.agent).join(" → ")}`;
  }
  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    return `parallel (${args.tasks.length}): ${args.tasks.map((t: any) => t.agent).join(", ")}`;
  }
  if (args.agent) return `${args.agent}: ${truncate(args.task, 40)}`;
  return "subagent";
}

// --- Coordinator-mode live agent list ---------------------------------
//
// Coordinator mode's whole job is delegating to subagents, so its system
// prompt needs to know which subagent names actually exist right now -
// otherwise the model tends to guess/invent plausible-sounding agent names.
// This is recomputed on every before_agent_start (see below) from the same
// user-scope agent directory the subagent tool itself reads from, so it
// can't drift out of sync as agents are added/removed/renamed.

const AGENT_DESCRIPTION_MAX = 160;

function buildAgentListSnippet(cwd: string): string {
  let agents: { name: string; description: string }[];
  try {
    agents = discoverAgents(cwd, "user").agents;
  } catch {
    return (
      "The list of available subagents could not be loaded right now. Do not " +
      "delegate to the subagent tool until this is resolved - tell the user the " +
      "subagent list failed to load and ask how they'd like to proceed."
    );
  }

  if (agents.length === 0) {
    return (
      "There are currently no subagents available. Do not attempt to use the " +
      "subagent tool - tell the user no subagents are configured and ask how " +
      "they'd like to proceed."
    );
  }

  const lines = agents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `- \`${a.name}\`: ${truncate(a.description, AGENT_DESCRIPTION_MAX)}`);

  return (
    "Available subagents (the only valid values for `agent` in the subagent tool, " +
    "including inside tasks/chain/open):\n" +
    lines.join("\n") +
    "\n" +
    "These are the ONLY valid agent names. Never invent, guess, or rename an agent " +
    "- if none of these fit the task, say so and ask the user rather than making one up."
  );
}

function buildCoordinatorSnippet(cwd: string): string {
  return `${COORDINATOR_BASE_SNIPPET}\n\n${buildAgentListSnippet(cwd)}`;
}

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
  // Set when the current mode was entered automatically because the active
  // model looked like qwen3, so we know to revert once the model changes
  // away again (but not if the user has since picked a mode explicitly).
  let autoSwitchedForModel = false;
  let modeBeforeAutoSwitch: string | undefined;

  // The coordinator-mode snippet actually injected on the most recent turn
  // (base instructions + live agent list), so the context filter below can
  // recognize it as current even though it's recomputed per-turn rather than
  // being a fixed string like the other modes' snippets.
  let lastCoordinatorSnippet: string | undefined;

  let delegatedTasks: DelegatedTask[] = [];
  // Context from the most recent event, reused by the tick timer below since
  // setInterval callbacks don't get one of their own.
  let latestCtx: ExtensionCommandContext | ExtensionContext | undefined;
  let widgetTicker: ReturnType<typeof setInterval> | undefined;

  function updateStatus(ctx: ExtensionCommandContext | ExtensionContext) {
    ctx.ui.setStatus("agent-mode", `Mode: ${currentMode.label}`);
  }

  function stopWidgetTicker() {
    if (widgetTicker) {
      clearInterval(widgetTicker);
      widgetTicker = undefined;
    }
  }

  function startWidgetTicker() {
    if (widgetTicker) return;
    // Re-render every second so each running task's elapsed time keeps
    // ticking without waiting for the next tool_execution_* event.
    widgetTicker = setInterval(() => {
      if (latestCtx) updateDelegationWidget(latestCtx);
    }, WIDGET_TICK_MS);
  }

  function updateDelegationWidget(ctx: ExtensionCommandContext | ExtensionContext) {
    latestCtx = ctx;
    if (currentMode.name !== "coordinator") {
      ctx.ui.setWidget("coordinator-delegations", undefined);
      stopWidgetTicker();
      return;
    }
    if (delegatedTasks.length === 0) {
      ctx.ui.setWidget("coordinator-delegations", [
        ctx.ui.theme.fg("muted", "🧭 Coordinator: no subagents delegated yet"),
      ]);
      stopWidgetTicker();
      return;
    }

    const now = Date.now();
    const runningCount = delegatedTasks.filter((t) => t.status === "running").length;
    const doneCount = delegatedTasks.filter((t) => t.status === "done").length;
    const failedCount = delegatedTasks.filter((t) => t.status === "failed").length;
    const allSettled = runningCount === 0;

    const summary =
      allSettled && failedCount === 0
        ? ctx.ui.theme.fg("success", `✅ All ${doneCount} subagent${doneCount === 1 ? "" : "s"} complete`)
        : ctx.ui.theme.fg(
            "accent",
            `🧭 Delegated to subagents: ${runningCount} running, ${doneCount} done` +
              (failedCount > 0 ? `, ${failedCount} failed` : ""),
          );

    const lines = [summary];
    for (const task of delegatedTasks.slice(-MAX_SHOWN_DELEGATIONS)) {
      const icon =
        task.status === "running"
          ? ctx.ui.theme.fg("warning", "⏳")
          : task.status === "failed"
            ? ctx.ui.theme.fg("error", "⚠️")
            : ctx.ui.theme.fg("success", "✓");
      const elapsed = formatElapsed((task.status === "running" ? now : (task.endedAt ?? now)) - task.startedAt);
      lines.push(`  ${icon} ${task.label} ${ctx.ui.theme.fg("dim", `(${elapsed})`)}`);
    }
    ctx.ui.setWidget("coordinator-delegations", lines);

    if (runningCount > 0) startWidgetTicker();
    else stopWidgetTicker();
  }

  async function setMode(
    name: string,
    ctx: ExtensionCommandContext | ExtensionContext,
    opts?: { persist?: boolean; notify?: boolean },
  ) {
    const mode = MODES[name];
    if (!mode) {
      ctx.ui.notify(`Unknown mode: ${name}. Available: ${Object.keys(MODES).join(", ")}`, "error");
      return;
    }
    currentMode = mode;
    if (opts?.persist ?? true) await saveLastMode(name);
    updateStatus(ctx);
    updateDelegationWidget(ctx);
    if (opts?.notify ?? true) ctx.ui.notify(`Switched to ${mode.label} mode.`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    const name = await loadLastMode();
    currentMode = MODES[name];
    delegatedTasks = [];
    stopWidgetTicker();

    if (isQwen3(ctx.model) && currentMode.name !== "coordinator") {
      modeBeforeAutoSwitch = currentMode.name;
      autoSwitchedForModel = true;
      await setMode("coordinator", ctx, { persist: false, notify: false });
    }

    updateStatus(ctx);
    updateDelegationWidget(ctx);
  });

  // Track subagent delegations while in coordinator mode for the footer widget.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    delegatedTasks.push({
      id: event.toolCallId,
      label: labelForSubagentCall(event.args as Record<string, any>),
      status: "running",
      startedAt: Date.now(),
    });
    if (delegatedTasks.length > MAX_TRACKED_DELEGATIONS) delegatedTasks.shift();
    updateDelegationWidget(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const task = delegatedTasks.find((t) => t.id === event.toolCallId);
    if (task) {
      task.status = event.isError ? "failed" : "done";
      task.endedAt = Date.now();
    }
    updateDelegationWidget(ctx);
  });

  // Extension runtimes are torn down on quit/reload/session-replacement -
  // stop the ticker so it doesn't keep firing against a stale context.
  pi.on("session_shutdown", async () => {
    stopWidgetTicker();
  });

  pi.on("model_select", async (event, ctx) => {
    if (isQwen3(event.model)) {
      if (currentMode.name !== "coordinator") {
        modeBeforeAutoSwitch = currentMode.name;
        autoSwitchedForModel = true;
        await setMode("coordinator", ctx, { persist: false });
      }
    } else if (autoSwitchedForModel) {
      const fallback = modeBeforeAutoSwitch ?? DEFAULT_MODE;
      autoSwitchedForModel = false;
      modeBeforeAutoSwitch = undefined;
      await setMode(fallback, ctx, { persist: false });
    }
  });

  pi.registerCommand("mode", {
    description: "Switch agent mode (pair | auto | coordinator)",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        ctx.ui.notify(
          `Current mode: ${currentMode.label}. Available: ${Object.keys(MODES).join(", ")}`,
          "info",
        );
        return;
      }
      // A manual mode change is an explicit user decision - it should stick
      // even if the active model happens to be qwen3.
      autoSwitchedForModel = false;
      modeBeforeAutoSwitch = undefined;
      await setMode(requested, ctx);
    },
  });

  // Tool gating: block edit/write and git write commands per mode policy.
  pi.on("tool_call", async (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && currentMode.editPolicy === "blocked") {
      return {
        block: true,
        reason:
          `${currentMode.label} mode: direct file edits are blocked. Ask the user, or delegate ` +
          "to a subagent, to make this change.",
      };
    }
    if (
      event.toolName === "bash" &&
      currentMode.gitWritePolicy === "blocked" &&
      isGitWriteCommand((event.input as { command?: string }).command)
    ) {
      return {
        block: true,
        reason: `${currentMode.label} mode: git write commands (commit/push/etc.) are blocked.`,
      };
    }
  });

  // Inject the current mode's behavior snippet for each turn. Coordinator
  // mode's snippet is recomputed fresh every time (rather than the mode's
  // static systemPromptSnippet) so it always reflects the current live list
  // of subagents.
  pi.on("before_agent_start", async (_event, ctx) => {
    const content =
      currentMode.name === "coordinator" ? buildCoordinatorSnippet(ctx.cwd) : currentMode.systemPromptSnippet;
    if (currentMode.name === "coordinator") lastCoordinatorSnippet = content;
    return {
      message: {
        customType: "agent-mode-context",
        content,
        display: false,
      },
    };
  });

  // Strip stale mode-context messages that don't match the current mode, so
  // switching modes mid-session doesn't leave old instructions in context.
  // Coordinator mode's snippet is recomputed per-turn (see above), so it's
  // compared against the last-injected value rather than a fixed string.
  pi.on("context", async (event) => {
    const expected =
      currentMode.name === "coordinator"
        ? (lastCoordinatorSnippet ?? COORDINATOR_BASE_SNIPPET)
        : currentMode.systemPromptSnippet;
    return {
      messages: event.messages.filter((m) => {
        const msg = m as typeof m & { customType?: string; content?: unknown };
        if (msg.customType !== "agent-mode-context") return true;
        return msg.content === expected;
      }),
    };
  });
}
