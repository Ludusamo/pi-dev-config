/**
 * Runtime backends for the subagent tool.
 *
 * Each backend spawns a CLI (`pi` or `claude`) as a child process, feeds it a
 * task, and normalizes its output into a shared `DisplayItem[]` + `UsageStats`
 * shape so the tool's rendering code doesn't need to know which CLI ran.
 *
 * Both backends support two lifecycles:
 *   - ephemeral (one-shot): no session id is persisted; used by run/tasks/chain
 *   - persistent: a stable session id is created on the first turn and reused
 *     (via `--session-id` / `--resume`) on later turns, so the agent keeps its
 *     own conversation history across separate tool calls.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export interface RunResult {
	exitCode: number;
	items: DisplayItem[];
	finalText: string;
	usage: UsageStats;
	model?: string;
	stopReason?: "end" | "error" | "aborted";
	errorMessage?: string;
	stderr: string;
	/** Resolved session id, present when the run was persistent. */
	sessionId?: string;
}

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RunUpdate {
	items: DisplayItem[];
	usage: UsageStats;
	finalText: string;
}

export interface RunOptions {
	agent: AgentConfig;
	task: string;
	cwd: string;
	dispatchDefaults: DispatchDefaults;
	signal?: AbortSignal;
	onUpdate?: (partial: RunUpdate) => void;
	/** Stable session id to create (first turn) or resume (later turns). Omit for ephemeral runs. */
	sessionId?: string;
	/** true = continue an existing session; false/undefined = first turn (or ephemeral). */
	resume?: boolean;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function cleanupTempFile(dir: string | null, filePath: string | null) {
	if (filePath) {
		try {
			fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}
	if (dir) {
		try {
			fs.rmdirSync(dir);
		} catch {
			/* ignore */
		}
	}
}

function spawnWithAbort(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onLine: (line: string) => void,
	onStderr: (chunk: string) => void,
): Promise<{ exitCode: number; wasAborted: boolean }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let wasAborted = false;
		// `proc.killed` flips to true as soon as `.kill()` is *called*, not once the
		// process has actually exited. Track real exit via the `close` event instead,
		// otherwise the SIGKILL escalation below never fires for a process that
		// ignores SIGTERM.
		let exited = false;
		let killTimeout: ReturnType<typeof setTimeout> | undefined;

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) onLine(line);
		});

		proc.stderr.on("data", (data) => onStderr(data.toString()));

		proc.on("close", (code) => {
			exited = true;
			if (killTimeout) clearTimeout(killTimeout);
			if (buffer.trim()) onLine(buffer);
			resolve({ exitCode: code ?? 0, wasAborted });
		});

		proc.on("error", () => {
			exited = true;
			if (killTimeout) clearTimeout(killTimeout);
			resolve({ exitCode: 1, wasAborted });
		});

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimeout = setTimeout(() => {
					if (!exited) proc.kill("SIGKILL");
				}, 5000);
			};
			// Register the listener *before* checking `aborted` to avoid a TOCTOU gap where
			// the signal aborts between the check and the addEventListener call, which would
			// otherwise leave the child process running forever with nothing to kill it.
			signal.addEventListener("abort", killProc, { once: true });
			if (signal.aborted) killProc();
		}
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/** Runs an agent via the `pi` CLI (JSON mode, isolated context). */
export async function runPiAgent(opts: RunOptions): Promise<RunResult> {
	const { agent, task, cwd, dispatchDefaults, signal, onUpdate, sessionId } = opts;

	const args: string[] = ["--mode", "json", "-p"];
	if (sessionId) args.push("--session-id", sessionId);
	else args.push("--no-session");

	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	const result: RunResult = {
		exitCode: 0,
		items: [],
		finalText: "",
		usage: emptyUsage(),
		model,
		sessionId,
		stderr: "",
	};

	const emit = () => onUpdate?.({ items: result.items, usage: result.usage, finalText: result.finalText });

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpDir = tmp.dir;
			tmpPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPath);
		}
		args.push(`Task: ${task}`);

		const onLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				if (msg.role === "assistant") {
					result.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && msg.model) result.model = msg.model;
					if (msg.stopReason === "error") result.stopReason = "error";
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					for (const part of msg.content) {
						if (part.type === "text") {
							result.items.push({ type: "text", text: part.text });
							result.finalText = part.text;
						} else if (part.type === "toolCall") {
							result.items.push({ type: "toolCall", name: part.name, args: part.arguments });
						}
					}
					emit();
				}
			}
		};

		const { exitCode, wasAborted } = await spawnWithAbort(
			getPiInvocation(args).command,
			getPiInvocation(args).args,
			cwd,
			signal,
			onLine,
			(chunk) => {
				result.stderr += chunk;
			},
		);

		result.exitCode = exitCode;
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		} else if (exitCode !== 0 && !result.stopReason) {
			result.stopReason = "error";
		} else if (!result.stopReason) {
			result.stopReason = "end";
		}
		return result;
	} finally {
		cleanupTempFile(tmpDir, tmpPath);
	}
}

// Maps common pi-style tool names (used in agent frontmatter) to Claude Code's
// built-in tool names, so the same `tools:` list works for either runtime.
const CLAUDE_TOOL_MAP: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	ls: "Bash",
};

function toClaudeTools(tools: string[]): string[] {
	const mapped = new Set<string>();
	for (const t of tools) {
		mapped.add(CLAUDE_TOOL_MAP[t.toLowerCase()] ?? t);
	}
	return Array.from(mapped);
}

/** Runs an agent via the `claude` CLI (stream-json mode, isolated context). */
export async function runClaudeAgent(opts: RunOptions): Promise<RunResult> {
	const { agent, task, cwd, dispatchDefaults, signal, onUpdate, sessionId, resume } = opts;

	const args: string[] = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];

	if (sessionId && resume) args.push("--resume", sessionId);
	else if (sessionId) args.push("--session-id", sessionId);
	else args.push("--no-session-persistence");

	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	// `--tools` actually restricts which tools exist for this run. `--allowedTools` only
	// pre-approves permission prompts and is a no-op once `--permission-mode bypassPermissions`
	// disables prompting entirely, which would silently grant the full default tool set.
	if (agent.tools && agent.tools.length > 0) args.push("--tools", ...toClaudeTools(agent.tools));
	else args.push("--tools", "default");

	const result: RunResult = {
		exitCode: 0,
		items: [],
		finalText: "",
		usage: emptyUsage(),
		model,
		sessionId,
		stderr: "",
	};

	const emit = () => onUpdate?.({ items: result.items, usage: result.usage, finalText: result.finalText });

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		// Pass the system prompt via a 0600 temp file rather than argv: argv is world-readable
		// through /proc/<pid>/cmdline and `ps`, and very long prompts can hit the OS argv size
		// limit (E2BIG), which would otherwise surface as a bare non-zero exit with no stderr.
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt-file", tmpPath);
	}
	// `--` stops flag parsing so the prompt text is never swallowed by a
	// preceding variadic option like --tools.
	args.push("--", `Task: ${task}`);

	const onLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "assistant" && event.message?.content) {
			for (const part of event.message.content) {
				if (part.type === "text" && part.text) {
					result.items.push({ type: "text", text: part.text });
					result.finalText = part.text;
				} else if (part.type === "tool_use") {
					result.items.push({ type: "toolCall", name: part.name, args: part.input ?? {} });
				}
			}
			result.usage.turns++;
			const usage = event.message.usage;
			if (usage) {
				result.usage.input += usage.input_tokens || 0;
				result.usage.output += usage.output_tokens || 0;
				result.usage.cacheRead += usage.cache_read_input_tokens || 0;
				result.usage.cacheWrite += usage.cache_creation_input_tokens || 0;
			}
			emit();
		} else if (event.type === "result") {
			if (typeof event.result === "string" && event.result) result.finalText = event.result;
			if (typeof event.total_cost_usd === "number") result.usage.cost = event.total_cost_usd;
			if (event.usage) {
				result.usage.input = event.usage.input_tokens ?? result.usage.input;
				result.usage.output = event.usage.output_tokens ?? result.usage.output;
				result.usage.cacheRead = event.usage.cache_read_input_tokens ?? result.usage.cacheRead;
				result.usage.cacheWrite = event.usage.cache_creation_input_tokens ?? result.usage.cacheWrite;
			}
			if (typeof event.num_turns === "number") result.usage.turns = event.num_turns;
			if (event.is_error) {
				result.stopReason = "error";
				result.errorMessage = typeof event.result === "string" ? event.result : "Claude agent reported an error";
			}
			if (typeof event.session_id === "string") result.sessionId = event.session_id;
			emit();
		} else if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
			result.sessionId = event.session_id;
		}
	};

	try {
		const { exitCode, wasAborted } = await spawnWithAbort("claude", args, cwd, signal, onLine, (chunk) => {
			result.stderr += chunk;
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted";
		} else if (exitCode !== 0 && !result.stopReason) {
			result.stopReason = "error";
			result.errorMessage = result.errorMessage || result.stderr.trim() || "claude exited with a non-zero status";
		} else if (!result.stopReason) {
			result.stopReason = "end";
		}
		return result;
	} finally {
		cleanupTempFile(tmpDir, tmpPath);
	}
}

/** Dispatches to the correct backend based on `agent.runtime`. */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
	return opts.agent.runtime === "claude" ? runClaudeAgent(opts) : runPiAgent(opts);
}
