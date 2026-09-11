/**
 * Cost ledger for the subagent tool.
 *
 * `SubagentSession.usage.cost` (see store.ts) is *cumulative* per handle: it
 * grows across turns for persistent sessions (open/send) and is set once for
 * one-shot runs. Summing `usage.cost` across all sessions currently in the
 * store would therefore double-count persistent sessions on every `send`,
 * and would lose history once finished ephemeral sessions are pruned
 * (MAX_EPHEMERAL_HISTORY in store.ts). The ledger instead tracks only the
 * last-seen cumulative cost per handle and accumulates the *delta* into a
 * running total that survives pruning, giving a single running number that
 * can be combined with the main session's own cost for a unified total.
 */

import type { AgentRuntime } from "./agents.ts";

export interface AgentCostBreakdown {
	agent: string;
	runtime: AgentRuntime;
	cost: number;
	runs: number;
}

export class CostLedger {
	private lastCost = new Map<string, number>();
	private seenHandles = new Set<string>();
	private breakdown = new Map<string, AgentCostBreakdown>();
	private runningTotal = 0;

	/** Record a handle's latest cumulative cost; only the delta since the last call is added to the total. */
	record(handle: string, agent: string, runtime: AgentRuntime, cumulativeCost: number): void {
		const isNewHandle = !this.seenHandles.has(handle);
		this.seenHandles.add(handle);

		const previous = this.lastCost.get(handle) ?? 0;
		const delta = cumulativeCost - previous;

		const key = `${runtime}:${agent}`;
		const entry = this.breakdown.get(key) ?? { agent, runtime, cost: 0, runs: 0 };
		if (isNewHandle) entry.runs++;
		if (delta > 0) {
			this.lastCost.set(handle, cumulativeCost);
			this.runningTotal += delta;
			entry.cost += delta;
		}
		this.breakdown.set(key, entry);
	}

	get total(): number {
		return this.runningTotal;
	}

	get runCount(): number {
		return this.seenHandles.size;
	}

	list(): AgentCostBreakdown[] {
		return Array.from(this.breakdown.values()).sort((a, b) => b.cost - a.cost);
	}

	clear(): void {
		this.lastCost.clear();
		this.seenHandles.clear();
		this.breakdown.clear();
		this.runningTotal = 0;
	}
}
