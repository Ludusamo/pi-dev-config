/**
 * Builds the hidden context message that carries the active tour's status,
 * and keeps stale copies of it out of the messages actually sent to the LLM.
 *
 * Kept free of pi imports (uses structural typing) so it's independently
 * unit-testable, matching project-memory/inject.ts.
 */

import { formatAnchorLocation } from "./panel.ts";
import type { Tour } from "./types.ts";

export const TOUR_CONTEXT_CUSTOM_TYPE = "codebase-tour-context";

const NO_TOUR_MESSAGE = "Codebase tour: no tour in progress.";

export interface InjectableMessage {
	customType: string;
	content: string;
	display: boolean;
}

export function buildTourContextMessage(content: string): InjectableMessage {
	return { customType: TOUR_CONTEXT_CUSTOM_TYPE, content, display: false };
}

/** Collapses newlines/control characters so a stop's title/summary can't inject fake lines into the index. */
function sanitizeIndexText(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

/**
 * Formats the current stop's anchors for the index, one per line so a stop
 * with more than one anchor doesn't leave its second+ anchors write-only -
 * only tour_advance's auto-shown first anchor became the tour's `focus`
 * (also listed separately below), but every anchor on the stop is a
 * candidate location worth knowing about. Each label is sanitized the same
 * way stop text is, so an anchor label can't forge extra index lines.
 */
function formatStopAnchorsForIndex(stop: Tour["stops"][number]): string[] {
	if (!stop.anchors || stop.anchors.length === 0) return [];
	return stop.anchors.map((anchor) => {
		const location = formatAnchorLocation(anchor);
		const labelSuffix = anchor.label ? ` - ${sanitizeIndexText(anchor.label)}` : "";
		return `     anchor: ${location}${labelSuffix}`;
	});
}

/** Builds the compact status text injected into context. Empty string when there's no in-progress tour to show. */
export function buildTourIndexText(tour: Tour | undefined): string {
	if (!tour || tour.status !== "in-progress") return "";

	const lines = [
		`Codebase tour in progress: "${sanitizeIndexText(tour.topic)}" (style: ${tour.style}, id: ${tour.id}).`,
	];
	tour.stops.forEach((stop, index) => {
		const isCurrent = index === tour.currentStopIndex;
		const isDone = tour.completedStopIds.includes(stop.id);
		const status = isCurrent ? "current" : isDone ? "done" : "pending";
		const marker = isCurrent ? "->" : "  ";
		const filesSuffix = stop.files.length ? ` (${stop.files.map(sanitizeIndexText).join(", ")})` : "";
		lines.push(`${marker} ${index + 1}. ${sanitizeIndexText(stop.title)} [${status}]${filesSuffix}`);
		if (isCurrent) lines.push(...formatStopAnchorsForIndex(stop));
	});
	if (tour.focus) {
		const labelSuffix = tour.focus.label ? ` - ${sanitizeIndexText(tour.focus.label)}` : "";
		lines.push(`Current focus: ${sanitizeIndexText(formatAnchorLocation(tour.focus))}${labelSuffix}`);
	}
	lines.push(
		"Use tour_status for full details (including recorded notes), tour_advance to move between stops, " +
			"tour_show to look at a specific file/range and update the current focus, and tour_note to record " +
			"a deep dive inline instead of writing a separate doc.",
	);
	return lines.join("\n");
}

/**
 * Decides what hidden status content (if any) should be injected this turn,
 * given the freshly built index and the content last injected. Returns
 * undefined when nothing needs to change: either there's still no tour and
 * never was one shown, or the content is unchanged from last turn.
 */
export function resolveTourContextContent(index: string, lastContent: string | undefined): string | undefined {
	const content = index || (lastContent ? NO_TOUR_MESSAGE : "");
	if (!content || content === lastContent) return undefined;
	return content;
}

interface CustomLikeMessage {
	role?: string;
	customType?: string;
}

function isTourContextMessage(message: unknown): message is CustomLikeMessage {
	const m = message as CustomLikeMessage | null | undefined;
	return !!m && m.role === "custom" && m.customType === TOUR_CONTEXT_CUSTOM_TYPE;
}

/**
 * Keeps only the most recent codebase-tour-context custom message in a
 * message list, dropping earlier duplicates so repeated per-turn injection
 * doesn't bloat every subsequent LLM call with stale status snapshots.
 */
export function dropStaleTourContext<T>(messages: T[]): T[] {
	let lastIndex = -1;
	messages.forEach((message, index) => {
		if (isTourContextMessage(message)) lastIndex = index;
	});
	if (lastIndex === -1) return messages;
	return messages.filter((message, index) => index === lastIndex || !isTourContextMessage(message));
}
