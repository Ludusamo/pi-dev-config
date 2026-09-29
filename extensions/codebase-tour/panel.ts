/**
 * Pure text formatting for tour anchors/snippets - the plain-text renderings
 * used in tool result content (every run mode), the persistent location
 * widget, and the hidden per-turn context. No pi or theme/color dependency,
 * so it stays independently unit-testable and importable from inject.ts
 * without pulling in TUI code; index.ts wraps these in theme colors for the
 * widget and builds a syntax-highlighted Component for renderResult on top
 * of the same SnippetResult.
 */

import type { SnippetResult } from "./snippet.ts";
import type { TourAnchor } from "./types.ts";

/** Formats a location like "src/index.ts:12-30", "src/index.ts:12", or bare "src/index.ts" when there's no line range. */
export function formatAnchorLocation(anchor: Pick<TourAnchor, "file" | "startLine" | "endLine">): string {
	if (anchor.startLine && anchor.endLine && anchor.endLine !== anchor.startLine) {
		return `${anchor.file}:${anchor.startLine}-${anchor.endLine}`;
	}
	if (anchor.startLine) return `${anchor.file}:${anchor.startLine}`;
	return anchor.file;
}

/** Plain-text snippet block (no color codes), safe for tool result `content` text in every run mode. */
export function formatSnippetText(snippet: SnippetResult): string {
	if (!snippet.ok) {
		return `${snippet.file}: ${snippet.error}`;
	}
	const location = formatAnchorLocation(snippet);
	const header = snippet.label ? `${location} - ${snippet.label}` : location;
	const numbered = snippet.lines.map((line, i) => `${snippet.startLine + i}| ${line}`);
	const footer = snippet.truncated
		? `... (truncated at line ${snippet.endLine}; requested through line ${snippet.requestedEnd}, ${snippet.totalLines} lines total)`
		: undefined;
	return [header, ...numbered, footer].filter((line): line is string => line !== undefined).join("\n");
}

/**
 * Formats every one of a stop's anchors as a compact comma-separated list,
 * e.g. "src/a.ts:1-10, src/b.ts:20 (helper)" - so a stop's second and later
 * anchors (only the first of which is ever auto-shown as a snippet) still
 * show up somewhere instead of being write-only. Empty string when there are
 * no anchors.
 */
export function formatAnchorList(anchors: TourAnchor[] | undefined): string {
	if (!anchors || anchors.length === 0) return "";
	return anchors
		.map((anchor) => {
			const location = formatAnchorLocation(anchor);
			return anchor.label ? `${location} (${anchor.label})` : location;
		})
		.join(", ");
}

/** Collapses newlines/control characters so a label can't inject fake lines into the widget or hidden context. */
function sanitizeLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

/** Single-line summary of the current focus, e.g. `Tour: Auth flow @ src/index.ts:12-30 - request entry point`. Empty array when there's no focus to show. */
export function formatLocationWidgetLines(focus: TourAnchor | undefined, tourTopic: string | undefined): string[] {
	if (!focus) return [];
	const location = sanitizeLine(formatAnchorLocation(focus));
	const suffix = focus.label ? ` - ${sanitizeLine(focus.label)}` : "";
	const prefix = tourTopic ? `Tour: ${sanitizeLine(tourTopic)} @ ` : "Tour location: ";
	return [`${prefix}${location}${suffix}`];
}
