/**
 * /usage - mark pi usage-report recommendations as done, kept, reverted or dropped,
 * without knowing where the ledger script lives.
 *
 * The changes log (~/pi-artifacts/pi-usage/changes.jsonl) is owned by
 * skills/shared/usage_ledger.py; this command only wraps its `change list/set`.
 *
 *   /usage                      pick a change, then what happened to it
 *   /usage C2                   what happened to C2?
 *   /usage done C2 [note]       started doing it (also: apply)
 *   /usage keep|revert|drop C2 [note]
 *   /usage list                 open changes (all: /usage list all)
 *   /usage check                ask the agent to run a usage check now
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const LEDGER = join(homedir(), ".pi", "agent", "skills", "shared", "usage_ledger.py");

interface Change {
	id: string;
	title: string;
	detail?: string | null;
	status: string;
	metrics?: string[];
	baseline_report?: string | null;
}

const VERBS: Record<string, string> = {
	done: "applied",
	apply: "applied",
	applied: "applied",
	keep: "kept",
	kept: "kept",
	revert: "reverted",
	reverted: "reverted",
	drop: "dropped",
	dropped: "dropped",
};

const CHECK_PROMPT =
	"Run a pi usage check: cost-analysis skill, Step 0 (usage ledger), covering the time since the last report.";

export default function usageLedger(pi: ExtensionAPI) {
	async function ledger(args: string[]): Promise<{ ok: boolean; out: string }> {
		const r = await pi.exec("python3", [LEDGER, ...args]);
		return { ok: r.code === 0, out: (r.code === 0 ? r.stdout : r.stderr || r.stdout).trim() };
	}

	async function load(all = true): Promise<Change[] | string> {
		const r = await ledger(["change", "list", "--json", ...(all ? [] : ["--open"])]);
		if (!r.ok) return r.out;
		try {
			return JSON.parse(r.out) as Change[];
		} catch {
			return `could not parse the changes log: ${r.out.slice(0, 200)}`;
		}
	}

	const line = (c: Change) => `${c.id} [${c.status}] ${c.title}`;

	async function setStatus(ctx: ExtensionCommandContext, id: string, status: string, note?: string, since?: string) {
		const args = ["change", "set", id, "--status", status];
		if (note) args.push("--note", note);
		if (since) args.push("--since", since);
		const r = await ledger(args);
		ctx.ui.notify(r.out || (r.ok ? "done" : "failed"), r.ok ? "info" : "error");
	}

	/** Interactive: what happened to this change? */
	async function decide(ctx: ExtensionCommandContext, c: Change) {
		const options: Array<[string, string, boolean]> =
			c.status === "proposed"
				? [
						["Done - I've started doing this", "applied", false],
						["Done - but I started earlier (enter a date)", "applied", true],
						["Drop - not going to do it", "dropped", false],
					]
				: c.status === "applied"
					? [
							["Keep - it worked, it's permanent now", "kept", false],
							["Revert - it didn't help, I undid it", "reverted", false],
							["Drop - stopped tracking it", "dropped", false],
							["Fix the start date", "applied", true],
						]
					: [
							["Reopen as done (applied)", "applied", false],
							["Reopen as proposed", "proposed", false],
						];
		const detail = c.detail ? `\n${c.detail}` : "";
		const pick = await ctx.ui.select(`${line(c)}${detail}`, options.map((o) => o[0]));
		const opt = options.find((o) => o[0] === pick);
		if (!opt) return;
		let since: string | undefined;
		if (opt[2]) {
			since = (await ctx.ui.input("When did it take effect? (YYYY-MM-DD or ISO time)", ""))?.trim();
			if (!since) return;
		}
		const note = (await ctx.ui.input("Note (optional, Enter to skip)", ""))?.trim();
		await setStatus(ctx, c.id, opt[1], note || undefined, since);
	}

	pi.registerCommand("usage", {
		description: "pi usage changes log: mark recommendations done/kept/reverted/dropped, list them, or run a check",
		getArgumentCompletions: async (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const changes = await load(false);
				const ids = Array.isArray(changes) ? changes.map((c) => ({ value: c.id, label: line(c) })) : [];
				return [
					...ids,
					...["done", "keep", "revert", "drop", "list", "check"].map((v) => ({ value: v, label: v })),
				].filter((i) => i.value.toLowerCase().startsWith(parts[0].toLowerCase()));
			}
			if (parts.length === 2 && VERBS[parts[0].toLowerCase()]) {
				const changes = await load(true);
				if (!Array.isArray(changes)) return null;
				return changes
					.filter((c) => c.id.toLowerCase().startsWith(parts[1].toLowerCase()))
					.map((c) => ({ value: `${parts[0]} ${c.id}`, label: line(c) }));
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			const [first = "", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
			const verb = first.toLowerCase();

			if (verb === "check") {
				pi.sendUserMessage(CHECK_PROMPT, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return;
			}

			if (verb === "list" || (!verb && !ctx.hasUI)) {
				const changes = await load(rest[0] === "all");
				if (!Array.isArray(changes)) return ctx.ui.notify(changes, "error");
				ctx.ui.notify(
					changes.length
						? changes.map(line).join("\n")
						: "No open changes. Usage checks log recommendations here.",
					"info",
				);
				return;
			}

			if (VERBS[verb]) {
				const id = rest[0]?.toUpperCase();
				if (!id) return ctx.ui.notify(`Usage: /usage ${verb} <ID> [note]`, "error");
				await setStatus(ctx, id, VERBS[verb], rest.slice(1).join(" ") || undefined);
				return;
			}

			const changes = await load(true);
			if (!Array.isArray(changes)) return ctx.ui.notify(changes, "error");

			if (/^c\d+$/i.test(verb)) {
				const c = changes.find((x) => x.id === verb.toUpperCase());
				if (!c) return ctx.ui.notify(`No change ${verb.toUpperCase()}`, "error");
				if (!ctx.hasUI) return ctx.ui.notify(`${line(c)}\nUse /usage done|keep|revert|drop ${c.id}`, "info");
				await decide(ctx, c);
				return;
			}

			if (verb) {
				ctx.ui.notify("Usage: /usage [ID | done|keep|revert|drop ID [note] | list [all] | check]", "error");
				return;
			}

			// No arguments, with UI: pick a change.
			const open = changes.filter((c) => c.status === "proposed" || c.status === "applied");
			const CHECK = "Run a usage check now";
			const ALL = "Show closed changes too";
			let pool = open;
			for (;;) {
				const labels = [...pool.map(line), CHECK, ...(pool === open ? [ALL] : [])];
				const pick = await ctx.ui.select(
					pool.length ? "Which change? (proposed = not started, applied = in progress)" : "No open changes",
					labels,
				);
				if (!pick) return;
				if (pick === CHECK) {
					pi.sendUserMessage(CHECK_PROMPT, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
					return;
				}
				if (pick === ALL) {
					pool = changes;
					continue;
				}
				const c = pool.find((x) => line(x) === pick);
				if (c) await decide(ctx, c);
				return;
			}
		},
	});
}
