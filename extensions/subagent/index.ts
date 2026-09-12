/**
 * Subagent Tool - delegate tasks to specialized agents running in either the
 * `pi` or `claude` CLI, with isolated context windows.
 *
 * Modes:
 *   - Single:    { agent, task }                 one-shot
 *   - Parallel:  { tasks: [...] }                 one-shot, concurrent
 *   - Chain:     { chain: [...] }                 one-shot, sequential w/ {previous}
 *   - Open:      { open: { agent, task } }        starts a persistent session, returns a handle
 *   - Send:      { send: { handle, message } }    continues a persistent session
 *   - Close:     { close: { handle } }            forgets a persistent session
 *   - List:      { list: true }                   lists open persistent sessions
 *
 * Each invocation spawns a short-lived child process; persistence across
 * "open"/"send" calls comes from the underlying CLI's own session/resume
 * mechanism (`pi --session-id`, `claude --session-id`/`--resume`), not a
 * long-running daemon.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { type AgentConfig, type AgentRuntime, type AgentScope, discoverAgents } from "./agents.ts";
import type { AgentCostBreakdown } from "./cost.ts";
import { type DisplayItem, type DispatchDefaults, emptyUsage, runAgent, type RunResult, type UsageStats } from "./runners.ts";
import { type SessionMode, SubagentStore, type SubagentSession } from "./store.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function aggregateUsageStats(usages: UsageStats[]): UsageStats {
	const total = emptyUsage();
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += usage.turns;
		total.contextTokens = Math.max(total.contextTokens, usage.contextTokens);
	}
	return total;
}

function usageStatsToPiUsage(usage: UsageStats): Usage | undefined {
	if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost) return undefined;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}

function resultUsage(results: SingleResult[]): Usage | undefined {
	return usageStatsToPiUsage(aggregateUsageStats(results.map((r) => r.usage)));
}

/** Sum of the main (non-subagent) session's own assistant-turn cost, for combining with subagent cost into a single total. */
function getMainSessionCost(ctx: ExtensionCommandContext | ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		cost += (entry.message as AssistantMessage).usage.cost.total;
	}
	return cost;
}

function statusIcon(status: SubagentSession["status"], themeFg: (color: any, text: string) => string): string {
	switch (status) {
		case "running":
			return themeFg("warning", "⏳");
		case "open":
			return themeFg("success", "●");
		case "done":
			return themeFg("success", "✓");
		case "failed":
			return themeFg("error", "✗");
		case "closed":
			return themeFg("muted", "○");
		default:
			return themeFg("muted", "?");
	}
}

function formatElapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const name = toolName.toLowerCase();

	switch (name) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "read ") + themeFg("accent", shortenPath(rawPath));
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "glob":
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	runtime: AgentRuntime | "unknown";
	task: string;
	exitCode: number; // -1 = still running
	items: DisplayItem[];
	finalText: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

type SubagentDetails =
	| { kind: "run"; mode: "single" | "parallel" | "chain"; agentScope: AgentScope; projectAgentsDir: string | null; results: SingleResult[] }
	| { kind: "session"; action: "open" | "send" | "close"; session: SubagentSession }
	| { kind: "list"; sessions: SubagentSession[] };

interface CostSummary {
	mainCost: number;
	subagentCost: number;
	runCount: number;
	breakdown: AgentCostBreakdown[];
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) return result.errorMessage || result.stderr || result.finalText || "(no output)";
	return result.finalText || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function unknownAgentResult(agentName: string, task: string, agents: AgentConfig[], step?: number): SingleResult {
	const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
	return {
		agent: agentName,
		agentSource: "unknown",
		runtime: "unknown",
		task,
		exitCode: 1,
		items: [],
		finalText: "",
		stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
		usage: emptyUsage(),
		step,
	};
}

async function runSingleAgent(
	store: SubagentStore,
	mode: SessionMode,
	agentScope: AgentScope,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string,
	dispatchDefaults: DispatchDefaults,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: SingleResult) => void) | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return unknownAgentResult(agentName, task, agents, step);

	const current: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		runtime: agent.runtime,
		task,
		exitCode: 0,
		items: [],
		finalText: "",
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	// Track this run in the shared store (live while running, kept briefly afterward)
	// so `list`/`/subagents` give visibility into one-shot subagents, not just persistent ones.
	const handle = store.makeHandle(agent.name);
	const startedAt = Date.now();
	const track = (patch: Partial<SubagentSession>) => {
		store.set({
			handle,
			sessionId: "",
			agent: agent.name,
			runtime: agent.runtime,
			mode,
			ephemeral: true,
			agentScope,
			cwd,
			model: agent.model,
			createdAt: startedAt,
			lastActivity: Date.now(),
			turns: 0,
			lastTask: task,
			lastOutput: "",
			usage: emptyUsage(),
			status: "running",
			...patch,
		});
	};
	track({});

	let result: RunResult;
	try {
		result = await runAgent({
			agent,
			task,
			cwd,
			dispatchDefaults,
			signal,
			onUpdate: (partial) => {
				current.items = partial.items;
				current.usage = partial.usage;
				current.finalText = partial.finalText || current.finalText;
				track({ usage: partial.usage, turns: partial.usage.turns, lastOutput: partial.finalText || current.finalText });
				onUpdate?.(current);
			},
		});
	} catch (err) {
		// Guarantee the tracked session never gets stuck at "running" forever in `list`/`/subagents`
		// even if runAgent throws unexpectedly (e.g. a filesystem error writing the system-prompt
		// temp file) instead of returning a normal error result.
		const message = err instanceof Error ? err.message : String(err);
		track({ status: "failed", lastOutput: message });
		current.exitCode = 1;
		current.stderr = message;
		current.stopReason = "error";
		current.errorMessage = message;
		onUpdate?.(current);
		return current;
	}

	current.exitCode = result.exitCode;
	current.items = result.items;
	current.finalText = result.finalText;
	current.stderr = result.stderr;
	current.usage = result.usage;
	current.model = result.model;
	current.stopReason = result.stopReason;
	current.errorMessage = result.errorMessage;
	track({
		usage: result.usage,
		turns: result.usage.turns,
		lastOutput: result.finalText,
		status: result.stopReason === "error" || result.stopReason === "aborted" ? "failed" : "done",
	});
	onUpdate?.(current);
	return current;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} run concurrently" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} run sequentially" })),
	open: Type.Optional(
		Type.Object(
			{ agent: Type.String(), task: Type.String() },
			{ description: "Start a persistent subagent session; returns a handle for later `send` calls" },
		),
	),
	send: Type.Optional(
		Type.Object(
			{ handle: Type.String(), message: Type.String() },
			{ description: "Continue a persistent session started with `open`" },
		),
	),
	close: Type.Optional(Type.Object({ handle: Type.String() }, { description: "Forget a persistent session handle" })),
	list: Type.Optional(Type.Boolean({ description: "List currently open persistent sessions" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
});

export default function (pi: ExtensionAPI) {
	const store = new SubagentStore();

	// Subagent model usage is returned from the tool result itself, so pi's built-in
	// footer, /session, and RPC totals stay authoritative without a custom status override.

	// Rebuild the handle map from session history so handles survive resume/fork.
	pi.on("session_start", async (_event, ctx) => {
		store.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			if (entry.message.toolName !== "subagent") continue;
			const toolCallId = entry.message.toolCallId;
			const details = entry.message.details as SubagentDetails | undefined;
			if (!details) continue;
			if (details.kind === "run") {
				// One-shot single/parallel/chain results aren't replayed as sessions (they're never
				// resumable), but their cost still needs to survive resume/fork so the running total
				// stays accurate. `toolCallId:index` is stable and unique per historical run, so
				// replaying this on every session_start can't double-count it.
				details.results.forEach((r, i) => {
					if (r.runtime === "unknown") return;
					store.recordHistoricalCost(`${toolCallId}:${i}`, r.agent, r.runtime, r.usage.cost);
				});
				continue;
			}
			if (details.kind !== "session") continue;
			if (details.action === "close") {
				const existing = store.get(details.session.handle);
				if (existing) store.set({ ...existing, status: "closed" });
			} else {
				// Backfill agentScope for sessions recorded before this field existed, defaulting to
				// "user" (the tool's own default) rather than "both", so `send` doesn't silently widen scope.
				// A session still marked "running" here means its process was orphaned by a restart/crash
				// mid-turn, so it can never actually finish; mark it "failed" instead of leaving it stuck.
				const session = { agentScope: "user" as const, ...details.session };
				store.set(session.status === "running" ? { ...session, status: "failed" } : session);
			}
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents running in either the `pi` or `claude` CLI, each with isolated context.",
			"One-shot modes: single (agent+task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Persistent modes: open (start a session, returns a handle), send (continue a session by handle), close (forget a handle), list (show open handles).",
			"Default to one-shot for most tasks; use open/send/close only when a subagent needs to keep the same accumulated context across turns (e.g. a reviewer verifying fixes against its own prior findings).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			"Each agent's frontmatter sets `runtime: pi` (default) or `runtime: claude` to pick which CLI runs it.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const modes = [
				Boolean(params.chain?.length),
				Boolean(params.tasks?.length),
				Boolean(params.agent && params.task),
				Boolean(params.open),
				Boolean(params.send),
				Boolean(params.close),
				Boolean(params.list),
			];
			const modeCount = modes.filter(Boolean).length;

			const makeRunDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					kind: "run",
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source}/${a.runtime})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
					details: makeRunDetails("single")([]),
				};
			}

			// --- list ---
			if (params.list) {
				const sessions = store.list();
				const text =
					sessions.length === 0
						? "No subagent sessions."
						: sessions
								.map(
									(s) =>
										`${s.handle} [${s.status}]${s.ephemeral ? " (one-shot)" : ""} ${s.agent} (${s.runtime}) — ${s.turns} turn(s) — last: ${s.lastTask.slice(0, 60)}`,
								)
								.join("\n");
				return { content: [{ type: "text", text }], details: { kind: "list", sessions } satisfies SubagentDetails };
			}

			// --- close ---
			if (params.close) {
				const session = store.get(params.close.handle);
				if (!session || session.ephemeral) {
					return { content: [{ type: "text", text: `No open session with handle "${params.close.handle}".` }], details: makeRunDetails("single")([]) };
				}
				const closed: SubagentSession = { ...session, status: "closed", lastActivity: Date.now() };
				store.set(closed);
				return {
					content: [{ type: "text", text: `Closed session ${closed.handle}.` }],
					details: { kind: "session", action: "close", session: closed } satisfies SubagentDetails,
				};
			}

			// Confirm project-local agents before running any mode that can spawn them.
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI && !ctx.isProjectTrusted()) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);
				if (params.open) requestedAgentNames.add(params.open.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeRunDetails("single")([]),
						};
					}
				}
			}

			// --- open ---
			if (params.open) {
				const { agent: agentName, task } = params.open;
				const agent = agents.find((a) => a.name === agentName);
				if (!agent) {
					const result = unknownAgentResult(agentName, task, agents);
					return { content: [{ type: "text", text: result.stderr }], details: makeRunDetails("single")([result]), isError: true };
				}
				const sessionId = store.newSessionId();
				const handle = store.makeHandle(agent.name);
				const startedAt = Date.now();
				const track = (patch: Partial<SubagentSession>) => {
					const session: SubagentSession = {
						handle,
						sessionId,
						agent: agent.name,
						runtime: agent.runtime,
						mode: "persistent",
						ephemeral: false,
						agentScope,
						cwd: ctx.cwd,
						model: agent.model,
						createdAt: startedAt,
						lastActivity: Date.now(),
						turns: 0,
						lastTask: task,
						lastOutput: "",
						usage: emptyUsage(),
						status: "running",
						...patch,
					};
					store.set(session);
					return session;
				};
				track({});

				let runResult: RunResult;
				try {
					runResult = await runAgent({
						agent,
						task,
						cwd: ctx.cwd,
						dispatchDefaults,
						signal,
						sessionId,
						resume: false,
						onUpdate: (partial) => {
							const session = track({ usage: partial.usage, turns: partial.usage.turns, lastOutput: partial.finalText });
							onUpdate?.({
								content: [{ type: "text", text: partial.finalText || "(running...)" }],
								details: { kind: "session", action: "open", session } satisfies SubagentDetails,
							});
						},
					});
				} catch (err) {
					// Guarantee the session never gets stuck at "running" forever if runAgent throws
					// unexpectedly instead of returning a normal error result.
					const message = err instanceof Error ? err.message : String(err);
					const session = track({ status: "failed", lastOutput: message });
					return {
						content: [{ type: "text", text: `Failed to open session: ${message}` }],
						details: { kind: "session", action: "open", session } satisfies SubagentDetails,
						isError: true,
					};
				}
				const isError = runResult.stopReason === "error" || runResult.stopReason === "aborted";
				const session = track({
					usage: runResult.usage,
					turns: runResult.usage.turns,
					lastOutput: runResult.finalText,
					status: isError ? "failed" : "open",
				});
				const text = isError
					? `Failed to open session (${runResult.stopReason}): ${runResult.errorMessage || runResult.stderr}`
					: `Opened session ${handle} (${agent.name}/${agent.runtime}).\n\n${runResult.finalText || "(no output)"}`;
				return {
					content: [{ type: "text", text }],
					details: { kind: "session", action: "open", session } satisfies SubagentDetails,
					usage: usageStatsToPiUsage(runResult.usage),
					isError,
				};
			}

			// --- send ---
			if (params.send) {
				const { handle, message } = params.send;
				const session = store.get(handle);
				if (!session || session.ephemeral || session.status === "closed") {
					return {
						content: [{ type: "text", text: `No open session with handle "${handle}". Use list to see open sessions.` }],
						details: makeRunDetails("single")([]),
						isError: true,
					};
				}
				if (session.status === "running") {
					return {
						content: [{ type: "text", text: `Session ${handle} is already running a turn. Wait for it to finish before sending another message.` }],
						details: makeRunDetails("single")([]),
						isError: true,
					};
				}
				// Reuse the scope this session was originally opened with — never widen to "both" here,
				// otherwise a session opened with agentScope "user" could later resolve `send` against a
				// same-named project-local agent that was never approved (a privilege-escalation path).
				const sendDiscovery = discoverAgents(session.cwd, session.agentScope);
				const agent = sendDiscovery.agents.find((a) => a.name === session.agent);
				if (!agent) {
					return {
						content: [{ type: "text", text: `Agent "${session.agent}" for session ${handle} is no longer available.` }],
						details: makeRunDetails("single")([]),
						isError: true,
					};
				}
				if (
					agent.source === "project" &&
					(session.agentScope === "project" || session.agentScope === "both") &&
					confirmProjectAgents &&
					ctx.hasUI &&
					!ctx.isProjectTrusted()
				) {
					const ok = await ctx.ui.confirm(
						"Send to project-local agent session?",
						`Agent: ${agent.name}\nSource: ${sendDiscovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
							details: makeRunDetails("single")([]),
						};
					}
				}

				const track = (patch: Partial<SubagentSession>) => {
					const updated: SubagentSession = { ...session, lastActivity: Date.now(), lastTask: message, ...patch };
					store.set(updated);
					return updated;
				};
				track({ status: "running" });

				let runResult: RunResult;
				try {
					runResult = await runAgent({
						agent,
						task: message,
						cwd: session.cwd,
						dispatchDefaults,
						signal,
						sessionId: session.sessionId,
						resume: true,
						onUpdate: (partial) => {
							const updated = track({
								usage: {
									input: session.usage.input + partial.usage.input,
									output: session.usage.output + partial.usage.output,
									cacheRead: session.usage.cacheRead + partial.usage.cacheRead,
									cacheWrite: session.usage.cacheWrite + partial.usage.cacheWrite,
									cost: session.usage.cost + partial.usage.cost,
									contextTokens: partial.usage.contextTokens || session.usage.contextTokens,
									turns: session.turns + partial.usage.turns,
								},
								turns: session.turns + partial.usage.turns,
								lastOutput: partial.finalText,
							});
							onUpdate?.({
								content: [{ type: "text", text: partial.finalText || "(running...)" }],
								details: { kind: "session", action: "send", session: updated } satisfies SubagentDetails,
							});
						},
					});
				} catch (err) {
					// Guarantee the session falls back to "open" (not stuck at "running") if runAgent
					// throws unexpectedly instead of returning a normal error result.
					const message2 = err instanceof Error ? err.message : String(err);
					const updated = track({ status: "failed", lastOutput: message2 });
					return {
						content: [{ type: "text", text: `Session ${handle} errored: ${message2}` }],
						details: { kind: "session", action: "send", session: updated } satisfies SubagentDetails,
						isError: true,
					};
				}

				const isError = runResult.stopReason === "error" || runResult.stopReason === "aborted";
				const updated = track({
					usage: {
						input: session.usage.input + runResult.usage.input,
						output: session.usage.output + runResult.usage.output,
						cacheRead: session.usage.cacheRead + runResult.usage.cacheRead,
						cacheWrite: session.usage.cacheWrite + runResult.usage.cacheWrite,
						cost: session.usage.cost + runResult.usage.cost,
						contextTokens: runResult.usage.contextTokens || session.usage.contextTokens,
						turns: session.turns + runResult.usage.turns,
					},
					turns: session.turns + runResult.usage.turns,
					lastOutput: runResult.finalText,
					status: isError ? "failed" : "open",
				});
				const text = isError
					? `Session ${handle} ${runResult.stopReason}: ${runResult.errorMessage || runResult.stderr}`
					: runResult.finalText || "(no output)";
				return {
					content: [{ type: "text", text }],
					details: { kind: "session", action: "send", session: updated } satisfies SubagentDetails,
					usage: usageStatsToPiUsage(runResult.usage),
					isError,
				};
			}

			// --- chain ---
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const result = await runSingleAgent(store, "chain", agentScope, agents, step.agent, taskWithContext, ctx.cwd, dispatchDefaults, i + 1, signal, (partial) => {
						onUpdate?.({ content: [{ type: "text", text: partial.finalText || "(running...)" }], details: makeRunDetails("chain")([...results, partial]) });
					});
					results.push(result);
					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
							details: makeRunDetails("chain")(results),
							usage: resultUsage(results),
							isError: true,
						};
					}
					previousOutput = result.finalText;
				}
				return {
					content: [{ type: "text", text: results[results.length - 1].finalText || "(no output)" }],
					details: makeRunDetails("chain")(results),
					usage: resultUsage(results),
				};
			}

			// --- parallel ---
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeRunDetails("parallel")([]),
					};
				}
				const allResults: SingleResult[] = params.tasks.map((t) => ({
					agent: t.agent,
					agentSource: "unknown",
					runtime: "unknown",
					task: t.task,
					exitCode: -1,
					items: [],
					finalText: "",
					stderr: "",
					usage: emptyUsage(),
				}));
				const emitParallel = () => {
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.length - running;
					onUpdate?.({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeRunDetails("parallel")([...allResults]),
					});
				};
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(store, "parallel", agentScope, agents, t.agent, t.task, ctx.cwd, dispatchDefaults, undefined, signal, (partial) => {
						allResults[index] = partial;
						emitParallel();
					});
					allResults[index] = result;
					emitParallel();
					return result;
				});
				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r) ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}` : "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeRunDetails("parallel")(results),
					usage: resultUsage(results),
				};
			}

			// --- single ---
			if (params.agent && params.task) {
				const result = await runSingleAgent(store, "single", agentScope, agents, params.agent, params.task, ctx.cwd, dispatchDefaults, undefined, signal, (partial) => {
					onUpdate?.({ content: [{ type: "text", text: partial.finalText || "(running...)" }], details: makeRunDetails("single")([partial]) });
				});
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
						details: makeRunDetails("single")([result]),
						usage: usageStatsToPiUsage(result.usage),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: result.finalText || "(no output)" }],
					details: makeRunDetails("single")([result]),
					usage: usageStatsToPiUsage(result.usage),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source}/${a.runtime})`).join(", ") || "none";
			return { content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }], details: makeRunDetails("single")([]) };
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.list) return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "list sessions"), 0, 0);
			if (args.close) return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `close ${args.close.handle}`), 0, 0);
			if (args.send) {
				const preview = (args.send.message || "").slice(0, 50);
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `send → ${args.send.handle}`) + theme.fg("dim", ` "${preview}"`),
					0,
					0,
				);
			}
			if (args.open) {
				const preview = (args.open.task || "").slice(0, 50);
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `open ${args.open.agent}`) + theme.fg("dim", ` "${preview}"`),
					0,
					0,
				);
			}
			if (args.chain?.length) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks?.length) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			if (details.kind === "list") {
				if (details.sessions.length === 0) return new Text(theme.fg("muted", "No subagent sessions."), 0, 0);
				let text = theme.fg("toolTitle", theme.bold("subagent sessions"));
				for (const s of details.sessions) {
					const icon = statusIcon(s.status, theme.fg.bind(theme));
					const elapsed = formatElapsed(Date.now() - s.lastActivity);
					text += `\n${icon} ${theme.fg("accent", s.handle)} ${theme.fg("dim", `(${s.agent}/${s.runtime}${s.ephemeral ? ", one-shot" : ""})`)} — ${s.turns} turn(s) — ${elapsed} ago`;
					if (expanded) text += `\n  ${theme.fg("dim", `last: ${s.lastTask.slice(0, 80)}`)}`;
				}
				return new Text(text, 0, 0);
			}

			if (details.kind === "session") {
				const s = details.session;
				const icon = statusIcon(s.status, theme.fg.bind(theme));
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(`subagent ${details.action}`))} ${theme.fg("accent", s.handle)} ${theme.fg("dim", `(${s.agent}/${s.runtime})`)}`;
				if (s.status === "running") text += ` ${theme.fg("warning", "running…")}`;
				const out = result.content[0];
				const outputText = out?.type === "text" ? out.text : "";
				if (expanded) {
					const mdTheme = getMarkdownTheme();
					const container = new Container();
					container.addChild(new Text(text, 0, 0));
					container.addChild(new Spacer(1));
					if (outputText) container.addChild(new Markdown(outputText.trim(), 0, 0, mdTheme));
					const usageStr = formatUsageStats(s.usage, s.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}
				const preview = outputText.split("\n").slice(0, 5).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
				const usageStr = formatUsageStats(s.usage, s.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// kind === "run"
			if (details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const renderItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const aggregateUsage = (results: SingleResult[]): UsageStats => {
				const total = emptyUsage();
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}/${r.runtime})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (r.items.length === 0 && !r.finalText) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of r.items) {
							if (item.type === "toolCall")
								container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
						}
						if (r.finalText) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(r.finalText.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}/${r.runtime})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (r.items.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderItems(r.items, COLLAPSED_ITEM_COUNT)}`;
					if (r.items.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`, 0, 0));
					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", `${r.agent} (${r.runtime})`)} ${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const item of r.items) {
							if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
						}
						if (r.finalText) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(r.finalText.trim(), 0, 0, mdTheme));
						}
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					text += r.items.length === 0 ? `\n${theme.fg("muted", "(no output)")}` : `\n${renderItems(r.items, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// parallel
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
			const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
			const isRunning = running > 0;
			const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));
				for (const r of details.results) {
					const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", `${r.agent} (${r.runtime})`)} ${rIcon}`, 0, 0));
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					for (const item of r.items) {
						if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
					}
					if (r.finalText) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(r.finalText.trim(), 0, 0, mdTheme));
					}
					const taskUsage = formatUsageStats(r.usage, r.model);
					if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				text += r.items.length === 0 ? `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}` : `\n${renderItems(r.items, 5)}`;
			}
			if (!isRunning) {
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});

	// /subagents - live dashboard of running/open/recent subagent sessions
	pi.registerCommand("subagents", {
		description: "View subagent sessions (live status while running, plus recent one-shot history)",
		async handler(_args, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				const sessions = store.list();
				if (sessions.length === 0) {
					return { content: "No subagent sessions yet." };
				}
				const lines = sessions.map(
					(s) =>
						`${s.handle} [${s.status}]${s.ephemeral ? " (one-shot)" : ""} ${s.agent}/${s.runtime} — ${s.turns} turn(s) — ${s.lastTask}`,
				);
				pi.appendEntry("subagent-list", { sessions });
				return { content: lines.join("\n") };
			}

			const selected = await ctx.ui.custom<SubagentSession | undefined>((tui, theme, _keybindings, done) => {
				let closed = false;
				const close = (value: SubagentSession | undefined) => {
					if (closed) return;
					closed = true;
					clearInterval(timer);
					clearTimeout(idleTimeout);
					done(value);
				};
				// Auto-refresh so running sessions' status/turns/last-output update live without
				// needing to reopen the command. Auto-close after an idle period as a safety net
				// so the interval can never outlive the session indefinitely.
				const timer = setInterval(() => tui.requestRender(), 1000);
				const idleTimeout = setTimeout(() => close(undefined), 10 * 60 * 1000);

				const component = {
					render(width: number): string[] {
						const sessions = store.list();
						const lines: string[] = [
							theme.fg("toolTitle", theme.bold("Subagent sessions")) +
								theme.fg("dim", "  (live, Esc to close, 1-9 to inspect)"),
						];
						if (sessions.length === 0) {
							lines.push(theme.fg("muted", "No subagent sessions yet."));
						}
						sessions.slice(0, 9).forEach((s, i) => {
							const icon = statusIcon(s.status, theme.fg.bind(theme));
							const elapsed = formatElapsed(Date.now() - s.lastActivity);
							lines.push(
								`${theme.fg("dim", `${i + 1}.`)} ${icon} ${theme.fg("accent", s.handle)} ${theme.fg("dim", `(${s.agent}/${s.runtime}${s.ephemeral ? ", one-shot" : ""})`)} — ${s.turns} turn(s) — ${elapsed} ago`,
							);
							if (s.status === "running" && s.lastOutput) {
								const firstLine = s.lastOutput.split("\n")[0] ?? "";
								const preview = firstLine.length > width - 4 ? `${firstLine.slice(0, width - 7)}...` : firstLine;
								lines.push(`   ${theme.fg("toolOutput", preview)}`);
							}
						});
						return lines;
					},
					invalidate() {},
					handleInput(data: string) {
						if (data === "\x1b" || data === "q") {
							close(undefined);
							return;
						}
						const n = Number(data);
						if (Number.isInteger(n) && n >= 1 && n <= 9) {
							const session = store.list()[n - 1];
							if (session) close(session);
						}
					},
				};
				return component;
			});

			if (selected) pi.appendEntry("subagent-inspect", { session: selected });
		},
	});

	// /cost - unified breakdown of main session cost + every subagent run's cost
	pi.registerCommand("cost", {
		description: "Show a unified cost breakdown: main session + all subagent runs, combined into one total",
		async handler(_args, ctx) {
			const mainCost = getMainSessionCost(ctx);
			const subagentCost = store.totalCost;
			const breakdown = store.costBreakdown();
			const data: CostSummary = { mainCost, subagentCost, runCount: store.runCount, breakdown };

			if (ctx.hasUI && ctx.mode === "tui") {
				pi.appendEntry("cost-summary", data);
				return;
			}
			const lines = [
				`Main session: $${mainCost.toFixed(4)}`,
				`Subagents (${store.runCount} run${store.runCount === 1 ? "" : "s"}): $${subagentCost.toFixed(4)}`,
			];
			for (const b of breakdown) lines.push(`  ${b.agent} (${b.runtime}) — ${b.runs} run(s) — $${b.cost.toFixed(4)}`);
			lines.push(`Total: $${(mainCost + subagentCost).toFixed(4)}`);
			return { content: lines.join("\n") };
		},
	});

	pi.registerEntryRenderer("cost-summary", (entry, _options, theme) => {
		const { mainCost, subagentCost, runCount, breakdown } = entry.data as CostSummary;
		const container = new Container();
		container.addChild(new Text(theme.fg("toolTitle", theme.bold("Session cost")), 0, 0));
		container.addChild(new Text(`${theme.fg("muted", "Main session:")} $${mainCost.toFixed(4)}`, 0, 0));
		container.addChild(
			new Text(`${theme.fg("muted", `Subagents (${runCount} run${runCount === 1 ? "" : "s"}):`)} $${subagentCost.toFixed(4)}`, 0, 0),
		);
		for (const b of breakdown) {
			container.addChild(
				new Text(
					`  ${theme.fg("accent", b.agent)} ${theme.fg("dim", `(${b.runtime})`)} — ${b.runs} run(s) — $${b.cost.toFixed(4)}`,
					0,
					0,
				),
			);
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${theme.fg("toolTitle", theme.bold("Total:"))} $${(mainCost + subagentCost).toFixed(4)}`, 0, 0));
		return container;
	});

	pi.registerEntryRenderer("subagent-list", (entry, _options, theme) => {
		const sessions = (entry.data as { sessions: SubagentSession[] }).sessions;
		let text = theme.fg("toolTitle", theme.bold("Subagent sessions"));
		for (const s of sessions) {
			const icon = statusIcon(s.status, theme.fg.bind(theme));
			text += `\n${icon} ${theme.fg("accent", s.handle)} ${theme.fg("dim", `(${s.agent}/${s.runtime})`)} — ${s.turns} turn(s)`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerEntryRenderer("subagent-inspect", (entry, _options, theme) => {
		const s = (entry.data as { session: SubagentSession }).session;
		const mdTheme = getMarkdownTheme();
		const container = new Container();
		const icon = statusIcon(s.status, theme.fg.bind(theme));
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(s.handle))} ${theme.fg("dim", `(${s.agent}/${s.runtime}${s.ephemeral ? ", one-shot" : ""})`)} ${theme.fg("muted", `[${s.status}]`)}`,
				0,
				0,
			),
		);
		container.addChild(new Text(theme.fg("muted", `cwd: ${s.cwd}`), 0, 0));
		container.addChild(new Text(theme.fg("muted", `session id: ${s.sessionId}`), 0, 0));
		container.addChild(new Text(theme.fg("muted", `created: ${new Date(s.createdAt).toLocaleString()}`), 0, 0));
		container.addChild(new Text(theme.fg("muted", `last activity: ${new Date(s.lastActivity).toLocaleString()}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Last task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", s.lastTask), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Last output ───"), 0, 0));
		container.addChild(new Markdown((s.lastOutput || "(no output)").trim(), 0, 0, mdTheme));
		const usageStr = formatUsageStats(s.usage, s.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	});
}
