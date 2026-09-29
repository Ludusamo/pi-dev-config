/**
 * Safe, bounded reading of source snippets for tour anchors.
 *
 * "Safe" here means: never reads outside the project root (reuses
 * project-memory's pathguard helpers, the same way resolve.ts reuses its
 * identity scheme - see the note there), never reads a file bigger than
 * MAX_SNIPPET_FILE_BYTES (checked via `stat` before the file is opened),
 * strips ANSI/control characters from what it returns, and never throws - a
 * missing file, an out-of-range line, an oversized file, or a path escape
 * all come back as an error result rather than an exception, since this runs
 * both inside tool `execute` handlers and TUI `renderResult` rendering,
 * neither of which should crash on a bad anchor.
 *
 * Kept free of pi imports so it's independently unit-testable, matching the
 * split used by inject.ts/types.ts.
 */

import { stat, readFile } from "node:fs/promises";
import { isWithinRoot, resolveCandidatePath, resolveGuardedRoot } from "../project-memory/pathguard.ts";
import type { TourAnchor } from "./types.ts";

/** Hard cap on lines returned regardless of the requested range, so a huge or malformed range can't dump an entire large file. */
export const MAX_SNIPPET_LINES = 60;

/** Window used when a line isn't fully pinned down: no lines at all (whole-file preview), or a startLine with no endLine. */
export const DEFAULT_PREVIEW_LINES = 20;

/** Hard cap on the width of a single rendered line, so one absurdly long line can't blow out the panel. */
export const MAX_LINE_WIDTH = 200;

/**
 * Hard cap on the file size read into memory, checked via `stat` before the
 * file is ever opened - a snippet only ever needs MAX_SNIPPET_LINES lines, so
 * there's no reason to read a multi-hundred-megabyte file in full just to
 * throw away all but a handful of lines (or a bogus/malicious huge file).
 */
export const MAX_SNIPPET_FILE_BYTES = 10 * 1024 * 1024;

export interface SnippetOk {
	ok: true;
	file: string;
	label?: string;
	startLine: number;
	endLine: number;
	lines: string[];
	/**
	 * True when the shown range was cut short of what was requested - by
	 * MAX_SNIPPET_LINES for an explicit range, or by DEFAULT_PREVIEW_LINES for
	 * a bare no-range preview that didn't reach the end of the file.
	 */
	truncated: boolean;
	/**
	 * The end line that would have been shown without the cap - the explicit
	 * requested endLine, startLine + the default window, or the file's last
	 * line for a bare no-range preview, whichever applies (see
	 * clampSnippetRange). Equal to `endLine` when `truncated` is false; when
	 * `truncated` is true, always greater than `endLine`, so callers can report
	 * exactly how much of the requested range got cut.
	 */
	requestedEnd: number;
	totalLines: number;
}

export interface SnippetErr {
	ok: false;
	file: string;
	label?: string;
	error: string;
}

export type SnippetResult = SnippetOk | SnippetErr;

/**
 * Clamps a requested [startLine, endLine] against the file's actual line
 * count and the hard line cap. Pure and unit-testable independent of any
 * filesystem access.
 */
export function clampSnippetRange(
	startLine: number | undefined,
	endLine: number | undefined,
	totalLines: number,
	options: { defaultWindow: number; maxLines: number } = { defaultWindow: DEFAULT_PREVIEW_LINES, maxLines: MAX_SNIPPET_LINES },
): { start: number; end: number; truncated: boolean; requestedEnd: number } {
	const total = Math.max(totalLines, 1);
	const start = startLine && startLine >= 1 ? Math.min(startLine, total) : 1;

	// "What was requested": an explicit range as given, a startLine-only window
	// from there, or - when neither is given - the whole file, since a bare
	// preview with no range at all is implicitly asking to see everything.
	// Comparing the final shown end against *this* (rather than against the
	// default-window size itself) is what lets a no-range preview of a file
	// longer than the window correctly report truncation.
	let requestedEnd: number;
	let isWholeFilePreview = false;
	if (endLine && endLine >= start) {
		requestedEnd = endLine;
	} else if (startLine) {
		// A start with no end: show a short window from there, not the rest of the file.
		requestedEnd = start + options.defaultWindow - 1;
	} else {
		isWholeFilePreview = true;
		requestedEnd = total;
	}
	requestedEnd = Math.min(requestedEnd, total);

	// The default preview window (no range given at all) is additionally capped
	// to defaultWindow lines, on top of the general maxLines cap below.
	const windowEnd = isWholeFilePreview ? Math.min(requestedEnd, start + options.defaultWindow - 1) : requestedEnd;
	const cappedEnd = Math.min(windowEnd, start + options.maxLines - 1);
	return { start, end: cappedEnd, truncated: cappedEnd < requestedEnd, requestedEnd };
}

/** Truncates a single line to a bounded width, stripping a trailing \r left over from CRLF line endings. */
export function truncateLineWidth(line: string, maxWidth: number = MAX_LINE_WIDTH): string {
	const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (clean.length <= maxWidth) return clean;
	return `${clean.slice(0, Math.max(maxWidth - 3, 0))}...`;
}

/**
 * Matches ANSI/terminal escape sequences (CSI, OSC, and bare single-character
 * escapes) so source content can't smuggle cursor moves, color resets, or
 * hidden/overwritten text into a tool result or the TUI panel.
 */
const ANSI_ESCAPE_PATTERN =
	// eslint-disable-next-line no-control-regex
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Strips ANSI escape sequences and other C0 control characters (besides tab, which is preserved) from a line of file content, so it can't forge terminal control codes when rendered in tool text or the TUI. */
export function sanitizeSnippetLine(line: string): string {
	const withoutAnsi = line.replace(ANSI_ESCAPE_PATTERN, "");
	// eslint-disable-next-line no-control-regex
	return withoutAnsi.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Reads a bounded snippet for an anchor. Never throws: filesystem errors, an
 * out-of-root path, and an oversized file all come back as a SnippetErr.
 * `root` is the directory anchor paths are resolved and confined against
 * (the project root, not necessarily the session's current cwd - see
 * resolveAnchorRoot in resolve.ts). `options.maxFileBytes` overrides
 * MAX_SNIPPET_FILE_BYTES, for tests that need a small cap without allocating
 * a multi-megabyte fixture file.
 */
export async function readSnippet(
	anchor: TourAnchor,
	root: string,
	options: { maxFileBytes?: number } = {},
): Promise<SnippetResult> {
	const maxFileBytes = options.maxFileBytes ?? MAX_SNIPPET_FILE_BYTES;
	try {
		const guardedRoot = resolveGuardedRoot(root);
		const resolved = resolveCandidatePath(anchor.file, root);
		if (!isWithinRoot(resolved, guardedRoot)) {
			return { ok: false, file: anchor.file, label: anchor.label, error: "path is outside the project directory" };
		}

		try {
			const stats = await stat(resolved);
			if (!stats.isFile()) {
				return { ok: false, file: anchor.file, label: anchor.label, error: "not a regular file" };
			}
			if (stats.size > maxFileBytes) {
				return {
					ok: false,
					file: anchor.file,
					label: anchor.label,
					error: `file too large to preview (${Math.ceil(stats.size / (1024 * 1024))} MB, limit ${Math.ceil(maxFileBytes / (1024 * 1024))} MB)`,
				};
			}
		} catch {
			return { ok: false, file: anchor.file, label: anchor.label, error: "could not read file" };
		}

		let raw: string;
		try {
			raw = await readFile(resolved, "utf-8");
		} catch {
			return { ok: false, file: anchor.file, label: anchor.label, error: "could not read file" };
		}

		// A single trailing newline is the file's EOF marker, not a distinct
		// trailing blank line - without stripping it, split("\n") reports one
		// phantom extra line (and totalLines overcounts by one) for the common
		// case of a file that ends with a newline.
		const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
		const allLines = normalized.split("\n");
		const { start, end, truncated, requestedEnd } = clampSnippetRange(anchor.startLine, anchor.endLine, allLines.length);
		const lines = allLines.slice(start - 1, end).map((line) => truncateLineWidth(sanitizeSnippetLine(line)));
		return {
			ok: true,
			file: anchor.file,
			label: anchor.label,
			startLine: start,
			endLine: end,
			lines,
			truncated,
			requestedEnd,
			totalLines: allLines.length,
		};
	} catch {
		return { ok: false, file: anchor.file, label: anchor.label, error: "could not resolve path" };
	}
}
