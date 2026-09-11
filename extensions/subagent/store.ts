/**
 * In-memory store for subagent sessions ("handles").
 *
 * A handle is a short, human-readable id (e.g. `scout-a1b2c3`) used to refer
 * to a subagent run. Two kinds of runs are tracked, both for visibility via
 * the `list` tool action and the `/subagents` command:
 *
 *   - persistent (`ephemeral: false`): created by the `open` action, kept
 *     alive (and resumable via `send`) until explicitly `close`d. Survives
 *     session resume/fork because open/send/close tool results are
 *     replayed on `session_start` (see index.ts).
 *   - ephemeral (`ephemeral: true`): one-shot single/parallel/chain runs.
 *     Tracked only for the lifetime of the pi process so you can see what a
 *     subagent is doing *while it runs*; a bounded number of finished ones
 *     are kept afterward for recent history, then pruned.
 *
 * The actual CLI session id (a UUID) used for `--session-id` / `--resume` is
 * stored alongside the handle, empty for ephemeral runs that never resume.
 */

import * as crypto from "node:crypto";
import type { AgentRuntime } from "./agents.ts";
import { CostLedger, type AgentCostBreakdown } from "./cost.ts";
import type { UsageStats } from "./runners.ts";

export type SessionStatus = "running" | "open" | "closed" | "done" | "failed";
export type SessionMode = "single" | "parallel" | "chain" | "persistent";

export interface SubagentSession {
	handle: string;
	sessionId: string;
	agent: string;
	runtime: AgentRuntime;
	mode: SessionMode;
	ephemeral: boolean;
	/** Agent discovery scope this session was opened with; reused on `send` so a follow-up
	 * can never silently resolve to a different (e.g. project-local) agent than was approved. */
	agentScope: "user" | "project" | "both";
	cwd: string;
	model?: string;
	createdAt: number;
	lastActivity: number;
	turns: number;
	lastTask: string;
	lastOutput: string;
	usage: UsageStats;
	status: SessionStatus;
}

const MAX_EPHEMERAL_HISTORY = 25;

export class SubagentStore {
	private sessions = new Map<string, SubagentSession>();
	private readonly costLedger = new CostLedger();

	makeHandle(agentName: string): string {
		const suffix = crypto.randomBytes(3).toString("hex");
		let handle = `${agentName}-${suffix}`;
		while (this.sessions.has(handle)) {
			handle = `${agentName}-${crypto.randomBytes(3).toString("hex")}`;
		}
		return handle;
	}

	newSessionId(): string {
		return crypto.randomUUID();
	}

	set(session: SubagentSession) {
		this.sessions.set(session.handle, session);
		this.costLedger.record(session.handle, session.agent, session.runtime, session.usage.cost);
		this.pruneEphemeral();
	}

	/** Running total of all subagent runtime cost recorded so far, immune to ephemeral-session pruning. */
	get totalCost(): number {
		return this.costLedger.total;
	}

	/** Number of distinct subagent handles (one-shot or persistent) recorded so far. */
	get runCount(): number {
		return this.costLedger.runCount;
	}

	costBreakdown(): AgentCostBreakdown[] {
		return this.costLedger.list();
	}

	/**
	 * Record cost for a run that isn't tracked as a session, e.g. a one-shot single/parallel/chain
	 * result replayed from session history on resume (only `open`/`send`/`close` are replayed into
	 * `set()` — see index.ts's `session_start` handler). `handle` just needs to be stable and unique
	 * per historical run so a later replay doesn't double-count it.
	 */
	recordHistoricalCost(handle: string, agent: string, runtime: AgentRuntime, cumulativeCost: number) {
		this.costLedger.record(handle, agent, runtime, cumulativeCost);
	}

	get(handle: string): SubagentSession | undefined {
		return this.sessions.get(handle);
	}

	remove(handle: string) {
		this.sessions.delete(handle);
	}

	list(): SubagentSession[] {
		return Array.from(this.sessions.values()).sort((a, b) => b.lastActivity - a.lastActivity);
	}

	/** Sessions that are actively running right now (single/parallel/chain tasks or open/send calls in flight). */
	listRunning(): SubagentSession[] {
		return this.list().filter((s) => s.status === "running");
	}

	clear() {
		this.sessions.clear();
		this.costLedger.clear();
	}

	private pruneEphemeral() {
		const finished = Array.from(this.sessions.values())
			.filter((s) => s.ephemeral && (s.status === "done" || s.status === "failed"))
			.sort((a, b) => a.lastActivity - b.lastActivity);
		const excess = finished.length - MAX_EPHEMERAL_HISTORY;
		for (let i = 0; i < excess; i++) this.sessions.delete(finished[i].handle);
	}
}
