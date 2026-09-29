/**
 * Pure helpers for `/tour start`, kept out of index.ts so they can be unit
 * tested without pulling in the tool-schema (typebox) import chain that
 * index.ts needs but the extension test harness can't resolve standalone.
 * The `../agent-modes/policy.ts` import below is safe for the same reason:
 * it's a dependency-light sibling module, not agent-modes' index.ts (which
 * pulls in @earendil-works/pi-coding-agent and the subagent extension at
 * runtime and would break standalone test resolution the same way).
 */

import { SESSION_ONLY_FLAG, TOUR_MODE_NAME } from "../agent-modes/policy.ts";

/**
 * The exact command dispatched to switch to agent-modes' "tour" mode - see index.ts's "start"
 * case. Uses SESSION_ONLY_FLAG so the switch only applies to the current session: without it,
 * `/mode tour` persists as the default mode for every future session/project, which is not what
 * a one-off `/tour start` should do.
 */
export const MODE_SWITCH_COMMAND = `/mode ${TOUR_MODE_NAME} ${SESSION_ONLY_FLAG}`;

/** The name of the slash command agent-modes registers to switch modes. Used to detect whether it's available before dispatching MODE_SWITCH_COMMAND. */
export const MODE_COMMAND_NAME = "mode";

/**
 * Whether the agent-modes extension's `/mode` command is currently registered.
 * Checks `source === "extension"` and not just the name, so a prompt template
 * or skill that happens to be named "mode" can't be mistaken for the real
 * agent-modes command and cause MODE_SWITCH_COMMAND to be dispatched at
 * something that won't actually switch to (read-only) tour mode.
 */
export function isModeCommandAvailable(commands: { name: string; source: string }[]): boolean {
	return commands.some((c) => c.name === MODE_COMMAND_NAME && c.source === "extension");
}

/**
 * Hint shown after a tour ends, pointing back to agent-modes' `/mode` command so the user
 * knows how to leave the read-only tour mode that `/tour start` switched into. Only
 * meaningful if that command is actually available - see isModeCommandAvailable.
 *
 * Worded conditionally ("if still in tour mode") rather than asserting the current mode
 * outright: this extension has no way to query agent-modes' actual current mode (they
 * communicate one-way, via the `/mode` command dispatch in the "start" case below), so the
 * user may already have switched away manually (or never left pair/auto if agent-modes
 * wasn't available) by the time a tour ends.
 *
 * Suggests SESSION_ONLY_FLAG the same way MODE_SWITCH_COMMAND does, so following this hint
 * can't accidentally change the user's persistent default mode for every future session -
 * only MODE_SWITCH_COMMAND's own session-only tour switch should have been that.
 */
export const MODE_EXIT_HINT =
	`If still in read-only tour mode, run /mode pair ${SESSION_ONLY_FLAG} or /mode auto ${SESSION_ONLY_FLAG} if you want to make edits.`;

export function buildTourKickoffMessage(topic: string): string {
	const focus = topic ? ` focused on: ${topic}` : " of the codebase's overall architecture";
	return (
		`Start a NEW codebase tour${focus} - the user explicitly ran /tour start, so begin fresh ` +
		`and replace any tour already in progress rather than resuming it. Explore the codebase as ` +
		`needed, then call tour_plan with an ordered list of stops, then call tour_advance to move ` +
		`to stop 1 and present it using the mixed Socratic/explain-first teaching style described in ` +
		"the codebase-tour skill."
	);
}
