import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { discoverAgents } from "../subagent/agents.ts";
import {
  buildDelegationGuidance,
  buildIntentHint,
  COORDINATOR_BASE_SNIPPET,
  DEFAULT_MODE,
  detectSubagentIntents,
  INTENT_HINT_CUSTOM_TYPE,
  MODES,
  PARENT_MODE_ENV,
  parseModeArgs,
  SESSION_ONLY_FLAG,
  subagentMode,
  type AgentMode,
} from "./policy.ts";
import {
  addPairPreference,
  buildPairPreferencesSnippet,
  loadPairPreferences,
  newPreferenceId,
  PAIR_PREFERENCES_FILE,
  parsePairPrefsArgs,
  removePairPreference,
  savePairPreferences,
  type PairPreference,
} from "./preferences.ts";

// Spawned as a subagent by the subagent extension (which sets PI_SUBAGENT=1 on the child).
const IS_SUBAGENT = process.env.PI_SUBAGENT === "1";

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

function describeEditToolCall(toolName: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, any>) : {};
  const path = typeof obj.path === "string" ? obj.path : "unknown path";
  if (toolName === "write") return `write file: ${path}`;
  if (toolName === "edit") {
    const count = Array.isArray(obj.edits) ? obj.edits.length : undefined;
    return `edit file: ${path}${count === undefined ? "" : ` (${count} replacement${count === 1 ? "" : "s"})`}`;
  }
  return toolName;
}

function describeBashToolCall(input: unknown): string {
  const obj = input && typeof input === "object" ? (input as { command?: unknown }) : {};
  return typeof obj.command === "string" ? obj.command : "unknown command";
}

async function confirmToolCall(
  ctx: ExtensionCommandContext | ExtensionContext,
  title: string,
  body: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  return await ctx.ui.confirm(title, body);
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

function availableAgentNames(cwd: string): string[] {
  try {
    return discoverAgents(cwd, "user").agents.map((a) => a.name);
  } catch {
    return [];
  }
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
  // Non-coordinator snippet (static snippet + optional delegation guidance) injected on the most recent turn.
  let lastModeSnippet: string | undefined;
  // Intent hint injected on the most recent turn; older ones are stripped from context.
  let lastIntentHint: string | undefined;

  // Global saved pair preferences, loaded at session start and refreshed before every change.
  let pairPreferences: PairPreference[] = [];

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
    lastModeSnippet = undefined;
    // Children spawned by the subagent extension inherit process.env, so this tells them
    // which mode they were dispatched from (see subagentMode in policy.ts).
    process.env[PARENT_MODE_ENV] = mode.name;
    if (opts?.persist ?? true) await saveLastMode(name);
    updateStatus(ctx);
    updateDelegationWidget(ctx);
    if (opts?.notify ?? true) ctx.ui.notify(`Switched to ${mode.label} mode.`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    delegatedTasks = [];
    stopWidgetTicker();
    if (IS_SUBAGENT) {
      // Never adopt the persisted mode: it is the user's mode for their own sessions, and
      // it would block a worker's edits. Derive a subagent policy from the dispatcher instead.
      currentMode = subagentMode(process.env[PARENT_MODE_ENV]);
      updateStatus(ctx);
      return;
    }
    pairPreferences = loadPairPreferences();
    const name = await loadLastMode();
    currentMode = MODES[name];
    process.env[PARENT_MODE_ENV] = currentMode.name;

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
    if (IS_SUBAGENT) return; // a subagent's mode is fixed by its dispatcher
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
    description:
      `Switch agent mode (${Object.keys(MODES).join(" | ")}). Add ${SESSION_ONLY_FLAG} to switch ` +
      "for this session only, without changing the persisted default for future sessions/projects.",
    handler: async (args, ctx) => {
      const { name: requested, persist, error } = parseModeArgs(args);
      if (error) {
        ctx.ui.notify(error, "error");
        return;
      }
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
      await setMode(requested, ctx, { persist });
    },
  });

  if (!IS_SUBAGENT) {
    pi.registerTool({
      name: "pair_preference",
      label: "Pair Preference",
      description:
        "Save or remove a stable pair-mode collaboration-style preference (global, persists across sessions). " +
        "Only works in pair mode and always asks the user to confirm; nothing is saved without an interactive UI or if declined.",
      promptGuidelines: [
        "Use pair_preference only for stable collaboration-style preferences, never task-specific or one-off requests.",
      ],
      parameters: Type.Object({
        action: Type.Union([Type.Literal("add"), Type.Literal("remove")], { description: "add or remove" }),
        text: Type.Optional(Type.String({ description: "Preference text (for add), at most 200 characters" })),
        id: Type.Optional(Type.String({ description: "Preference id (for remove)" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
        if (currentMode.name !== "pair") return fail("pair_preference only works in pair mode.");
        if (!ctx.hasUI) return fail("No interactive UI available, so nothing was saved.");
        const initial = loadPairPreferences();
        let proposed: PairPreference | undefined;
        let prompt: string;
        let done: string;
        if (params.action === "add") {
          const result = addPairPreference(initial, params.text ?? "", new Date(), newPreferenceId());
          if ("error" in result) return fail(result.error);
          if (result.prefs.length === initial.length) {
            pairPreferences = initial;
            return { content: [{ type: "text" as const, text: "Preference already saved." }], details: {} };
          }
          proposed = result.prefs[result.prefs.length - 1];
          prompt = `Save this pair preference?\n\n${proposed.text}`;
          done = "Saved preference.";
        } else {
          const result = removePairPreference(initial, params.id ?? "");
          if (!result.removed) return fail(`No saved preference with id ${params.id ?? ""}.`);
          prompt = `Remove this pair preference?\n\n${result.removed.text}`;
          done = "Removed preference.";
        }
        const ok = await ctx.ui.confirm("Pair preference", prompt);
        if (!ok) return fail("The user declined; nothing was saved.");
        // The file may have changed while the confirm dialog was open, so apply to a fresh copy.
        const fresh = loadPairPreferences();
        let next: PairPreference[];
        if (params.action === "add" && proposed) {
          const result = addPairPreference(fresh, proposed.text, new Date(proposed.createdAt), proposed.id);
          if ("error" in result) return fail(result.error);
          next = result.prefs;
        } else {
          next = removePairPreference(fresh, params.id ?? "").prefs;
        }
        try {
          savePairPreferences(PAIR_PREFERENCES_FILE, next);
        } catch (err) {
          return fail(`Could not save preferences: ${err instanceof Error ? err.message : String(err)}`);
        }
        pairPreferences = next;
        return { content: [{ type: "text" as const, text: done }], details: { preferences: next } };
      },
    });

    pi.registerCommand("pair-prefs", {
      description: "Manage saved pair-mode preferences: list | add <text> | remove <id> | clear",
      handler: async (args, ctx) => {
        const cmd = parsePairPrefsArgs(args);
        if (cmd.action === "invalid") {
          ctx.ui.notify(cmd.error, "error");
          return;
        }
        const current = loadPairPreferences();
        if (cmd.action === "list") {
          pairPreferences = current;
          ctx.ui.notify(
            current.length === 0
              ? "No saved pair preferences."
              : `Saved pair preferences:\n${current.map((p) => `[${p.id}] ${p.text}`).join("\n")}`,
            "info",
          );
          return;
        }
        let next: PairPreference[];
        let message: string;
        if (cmd.action === "add") {
          const result = addPairPreference(current, cmd.text, new Date(), newPreferenceId());
          if ("error" in result) {
            ctx.ui.notify(result.error, "error");
            return;
          }
          next = result.prefs;
          message = next.length === current.length ? "Preference already saved." : "Saved preference.";
        } else if (cmd.action === "remove") {
          const result = removePairPreference(current, cmd.id);
          if (!result.removed) {
            ctx.ui.notify(`No saved preference with id ${cmd.id}.`, "error");
            return;
          }
          next = result.prefs;
          message = `Removed preference [${cmd.id}].`;
        } else {
          if (!ctx.hasUI) {
            ctx.ui.notify("/pair-prefs clear needs an interactive UI to confirm.", "error");
            return;
          }
          if (current.length === 0) {
            ctx.ui.notify("No saved pair preferences.", "info");
            return;
          }
          const ok = await confirmToolCall(ctx, "Clear pair preferences?", `Remove all ${current.length} saved pair preferences.`);
          if (!ok) return;
          next = [];
          message = "Cleared all pair preferences.";
        }
        try {
          savePairPreferences(PAIR_PREFERENCES_FILE, next);
        } catch (err) {
          ctx.ui.notify(`Could not save preferences: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        pairPreferences = next;
        ctx.ui.notify(message, "info");
      },
    });
  }

  // Tool gating: block or confirm edit/write and git write commands per mode policy.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      if (currentMode.editPolicy === "blocked") {
        return {
          block: true,
          reason:
            currentMode.name === "pair"
              ? `${currentMode.label} mode: direct file edits are blocked. Ask the user to switch modes ` +
                "(e.g. /mode guarded --session), delegate to a subagent, or let the user make the change."
              : `${currentMode.label} mode: direct file edits are blocked. Ask the user, or delegate ` +
                "to a subagent, to make this change.",
        };
      }
      if (currentMode.editPolicy === "confirm") {
        const action = describeEditToolCall(event.toolName, event.input);
        const ok = await confirmToolCall(ctx, `${currentMode.label}: allow file write?`, action);
        if (!ok) {
          return {
            block: true,
            reason: `${currentMode.label} mode: file write blocked because approval was not granted.`,
          };
        }
      }
    }
    if (event.toolName === "bash" && isGitWriteCommand((event.input as { command?: string }).command)) {
      if (currentMode.gitWritePolicy === "blocked") {
        return {
          block: true,
          reason: `${currentMode.label} mode: git write commands (commit/push/etc.) are blocked.`,
        };
      }
      if (currentMode.gitWritePolicy === "confirm") {
        const command = describeBashToolCall(event.input);
        const ok = await confirmToolCall(ctx, `${currentMode.label}: allow git write command?`, command);
        if (!ok) {
          return {
            block: true,
            reason: `${currentMode.label} mode: git write command blocked because approval was not granted.`,
          };
        }
      }
    }
  });

  // Inject the current mode's behavior snippet for each turn. Coordinator
  // mode's snippet is recomputed fresh every time (rather than the mode's
  // static systemPromptSnippet) so it always reflects the current live list
  // of subagents.
  pi.on("before_agent_start", async (_event, ctx) => {
    let content: string;
    if (currentMode.name === "coordinator") {
      content = buildCoordinatorSnippet(ctx.cwd);
      lastCoordinatorSnippet = content;
    } else {
      const guidance = IS_SUBAGENT ? "" : buildDelegationGuidance(currentMode.name, availableAgentNames(ctx.cwd));
      content = guidance ? `${currentMode.systemPromptSnippet}\n\n${guidance}` : currentMode.systemPromptSnippet;
      if (!IS_SUBAGENT && currentMode.name === "pair") {
        const prefs = buildPairPreferencesSnippet(pairPreferences);
        if (prefs) content = `${content}\n\n${prefs}`;
      }
      lastModeSnippet = content;
    }
    return {
      message: {
        customType: "agent-mode-context",
        content,
        display: false,
      },
    };
  });

  // One-turn hint when the user explicitly asks for a devil's advocate or worker.
  pi.on("before_agent_start", async (event, ctx) => {
    lastIntentHint = undefined;
    if (IS_SUBAGENT) return;
    const intents = detectSubagentIntents(event.prompt ?? "");
    if (intents.length === 0) return;
    const hint = buildIntentHint(intents, currentMode.name, availableAgentNames(ctx.cwd));
    if (!hint) return;
    lastIntentHint = hint;
    return {
      message: {
        customType: INTENT_HINT_CUSTOM_TYPE,
        content: hint,
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
        : (lastModeSnippet ?? currentMode.systemPromptSnippet);
    return {
      messages: event.messages.filter((m) => {
        const msg = m as typeof m & { customType?: string; content?: unknown };
        if (msg.customType === INTENT_HINT_CUSTOM_TYPE) return msg.content === lastIntentHint;
        if (msg.customType !== "agent-mode-context") return true;
        return msg.content === expected;
      }),
    };
  });
}
