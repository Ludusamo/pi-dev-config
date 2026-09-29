/**
 * codebase-tour - a guided, read-only walkthrough of a codebase.
 *
 * - The LLM explores the codebase and drafts a short list of "stops"
 *   (`tour_plan`), then walks through them one at a time (`tour_advance`),
 *   optionally recording a short breadcrumb from a deep dive inline on a
 *   stop (`tour_note`) rather than writing it out to a separate file.
 * - A stop can carry tight anchors (file + line range) shown as a snippet
 *   when the tour reaches it; `tour_show` shows an arbitrary file/range
 *   ad hoc, without moving stops. Either way the anchor becomes the tour's
 *   current "focus" - see snippet.ts (bounded, non-throwing file reads) and
 *   panel.ts (pure text formatting shared by tool output, the hidden context,
 *   and the location widget).
 * - State is private per project, stored under
 *   `~/.pi/agent/tours/<projectKey>/` - see paths.ts and resolve.ts. There is
 *   at most one active tour per project; starting a new one archives
 *   whatever was active (never deletes it).
 * - The active tour's status, including the current focus, is injected as a
 *   hidden per-turn context message (see inject.ts), so a new session can
 *   pick up where a previous one left off without an extra tool round-trip.
 *   The same focus also drives a persistent location widget in UI-capable
 *   modes (`ctx.ui.setWidget`, guarded by `ctx.hasUI` - TUI/RPC, not
 *   print/json) kept in sync on session start, every turn, and whenever a
 *   tour tool or `/tour` command changes the focus. The widget is optional:
 *   `/tour pane on|off|toggle|status` persists a per-project preference (see
 *   config.ts, stored alongside the tour itself) that gates it - off clears
 *   any existing widget immediately and keeps it from being recreated
 *   anywhere; the hidden context injection is unaffected either way, so the
 *   model stays oriented even with the pane off.
 * - Read-only enforcement (no edits, no git writes) while touring is handled
 *   entirely by the `agent-modes` extension's "tour" mode; these tools work
 *   in any mode, and `/mode tour` is what makes edits blocked while touring.
 *   `/tour start` switches to it automatically by dispatching that same
 *   `/mode tour` command with agent-modes' SESSION_ONLY_FLAG (see the "start"
 *   case below and start.ts) rather than duplicating agent-modes' mode-
 *   switching logic here - the flag keeps the switch scoped to this session
 *   only, so a one-off tour never becomes every future session's default
 *   mode. If agent-modes isn't available, the mode switch is skipped with a
 *   visible warning instead of silently starting a tour that isn't actually
 *   read-only.
 *   This extension only gates its own mutating tools (tour_plan,
 *   tour_advance, tour_note, tour_show, tour_end) away from pi-runtime
 *   subagents, matching project-memory's PI_SUBAGENT handling.
 * - See skills/codebase-tour/SKILL.md for the actual teaching loop (mixed
 *   Socratic/explain-first).
 */

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_PANE_ENABLED, loadPaneEnabled, resolveNextPaneState, savePaneEnabled } from "./config.ts";
import { buildTourContextMessage, dropStaleTourContext, buildTourIndexText, resolveTourContextContent } from "./inject.ts";
import { tourProjectRoot } from "./paths.ts";
import { formatAnchorLocation, formatAnchorList, formatLocationWidgetLines, formatSnippetText } from "./panel.ts";
import { resolveAnchorRoot, resolveTourProjectKey } from "./resolve.ts";
import { MAX_SNIPPET_LINES, readSnippet } from "./snippet.ts";
import type { SnippetResult } from "./snippet.ts";
import { buildTourKickoffMessage, isModeCommandAvailable, MODE_EXIT_HINT, MODE_SWITCH_COMMAND } from "./start.ts";
import * as store from "./store.ts";
import type { Tour, TourAnchor, TourStop, TourSummary } from "./types.ts";

const DEFAULT_STYLE = "mixed";
const MAX_STOPS = 12;
const MAX_HISTORY_SHOWN = 5;
const LOCATION_WIDGET_KEY = "codebase-tour-location";

const ANCHOR_RANGE_DESCRIPTION =
	`1-based end line (inclusive). Ranges longer than ${MAX_SNIPPET_LINES} lines are truncated to the first ` +
	`${MAX_SNIPPET_LINES} - prefer a tight range around the specific function/block over a whole file.`;

const ANCHOR_SCHEMA = Type.Object(
	{
		file: Type.String({ description: "Path relative to the project root" }),
		startLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line" })),
		endLine: Type.Optional(Type.Integer({ minimum: 1, description: ANCHOR_RANGE_DESCRIPTION })),
		label: Type.Optional(Type.String({ description: "Short label for what this anchor shows, e.g. a function name" })),
	},
	{ description: "A tight pointer at a specific file and, optionally, a line range within it" },
);

function formatStopLine(stop: TourStop, index: number, tour: Tour): string {
	const isCurrent = index === tour.currentStopIndex;
	const isDone = tour.completedStopIds.includes(stop.id);
	const status = isCurrent ? "current" : isDone ? "done" : "pending";
	const marker = isCurrent ? "->" : "  ";
	const lines = [`${marker} ${index + 1}. [${status}] ${stop.title} - ${stop.summary}`];
	if (stop.files.length > 0) lines.push(`      files: ${stop.files.join(", ")}`);
	const anchorList = formatAnchorList(stop.anchors);
	if (anchorList) lines.push(`      anchors: ${anchorList}`);
	if (stop.notes.length > 0) lines.push(`      notes: ${stop.notes.join(" | ")}`);
	return lines.join("\n");
}

function formatTourStatus(tour: Tour): string {
	const header = `Tour "${tour.topic}" (style: ${tour.style}, status: ${tour.status}, id: ${tour.id})`;
	const body = tour.stops.map((stop, index) => formatStopLine(stop, index, tour)).join("\n");
	const progress = `Progress: ${tour.completedStopIds.length}/${tour.stops.length} stops complete.`;
	const focus = tour.focus
		? `Current focus: ${formatAnchorLocation(tour.focus)}${tour.focus.label ? ` - ${tour.focus.label}` : ""}`
		: undefined;
	return [header, body, progress, focus].filter((part): part is string => !!part).join("\n");
}

function formatHistoryList(summaries: TourSummary[]): string {
	if (summaries.length === 0) return "No past tours.";
	return summaries
		.slice(0, MAX_HISTORY_SHOWN)
		.map((s) => `- ${s.id} (${s.status}): "${s.topic}" - ${s.completedStopCount}/${s.stopCount} stops complete`)
		.join("\n");
}

function inferEndStatus(tour: Tour): Extract<Tour["status"], "completed" | "abandoned"> {
	return tour.completedStopIds.length >= tour.stops.length && tour.stops.length > 0 ? "completed" : "abandoned";
}

/**
 * Builds a syntax-highlighted panel for a snippet result, for tour_advance/
 * tour_show's `renderResult`. TUI-only rendering on top of the same
 * SnippetResult the plain-text `formatSnippetText` (panel.ts) renders for
 * every other run mode - a failure here (e.g. an unsupported language) falls
 * back to the unhighlighted lines rather than throwing mid-render.
 */
function buildSnippetComponent(snippet: SnippetResult, theme: Theme): Component {
	if (!snippet.ok) {
		return new Text(theme.fg("warning", `${snippet.file}: ${snippet.error}`), 0, 0);
	}
	const location = formatAnchorLocation(snippet);
	const header = theme.fg("dim", snippet.label ? `${location} - ${snippet.label}` : location);
	let codeLines: string[];
	try {
		codeLines = highlightCode(snippet.lines.join("\n"), getLanguageFromPath(snippet.file));
	} catch {
		codeLines = snippet.lines;
	}
	const gutterWidth = String(snippet.startLine + codeLines.length - 1).length;
	const body = codeLines.map((line, i) => `${theme.fg("dim", String(snippet.startLine + i).padStart(gutterWidth))} ${line}`).join("\n");
	const footer = snippet.truncated
		? theme.fg("dim", `... (truncated at line ${snippet.endLine}; requested through line ${snippet.requestedEnd}, ${snippet.totalLines} lines total)`)
		: undefined;
	const text = [header, body, footer].filter((part): part is string => !!part).join("\n");
	return new Text(text, 0, 0);
}

export default function codebaseTour(pi: ExtensionAPI) {
	// pi-runtime subagents (PI_SUBAGENT=1 child `pi` processes) get read-only
	// access to the active tour's status but not the tools that mutate it -
	// only the main interactive agent drives a tour. Matches project-memory's
	// isSubagent gating.
	const isSubagent = process.env.PI_SUBAGENT === "1";

	// Cached per session; invalidated on session_start since cwd/project
	// identity can change across sessions but not within one.
	let rootPromise: Promise<string> | undefined;
	let anchorRootPromise: Promise<string> | undefined;
	let paneEnabledPromise: Promise<boolean> | undefined;
	let lastIndexContent: string | undefined;
	// Whether the location widget is currently showing something, so a clear
	// (setWidget(undefined)) isn't repeated every turn once it's already
	// cleared - reset on session_start since a new session's UI starts with
	// nothing shown regardless of what the last one left behind.
	let widgetShown = false;

	function ensureRoot(ctx: ExtensionContext): Promise<string> {
		if (!rootPromise) {
			const promise = resolveTourProjectKey(ctx.cwd).then((projectKey) => tourProjectRoot(projectKey));
			// resolveTourProjectKey shouldn't reject in practice, but if it does,
			// don't cache the rejection - the next call should get a fresh attempt
			// rather than being stuck failing for the rest of the session.
			promise.catch(() => {
				if (rootPromise === promise) rootPromise = undefined;
			});
			rootPromise = promise;
		}
		return rootPromise;
	}

	// The root anchor file paths are read/confined against - the repo's
	// toplevel when cwd is inside one, so a session resumed from a
	// subdirectory still reads anchors relative to the project root they were
	// recorded against (see resolveAnchorRoot). Cached separately from
	// ensureRoot's tour-storage root since the two can differ (storage is
	// keyed by project identity; anchors resolve against the git worktree).
	function ensureAnchorRoot(ctx: ExtensionContext): Promise<string> {
		if (!anchorRootPromise) {
			const promise = resolveAnchorRoot(ctx.cwd);
			promise.catch(() => {
				if (anchorRootPromise === promise) anchorRootPromise = undefined;
			});
			anchorRootPromise = promise;
		}
		return anchorRootPromise;
	}

	// The pane on/off preference, cached the same way as the roots above - a
	// per-project boolean that only changes via /tour pane, which updates the
	// cache itself (see the "pane" case below) rather than invalidating it.
	function ensurePaneEnabled(ctx: ExtensionContext): Promise<boolean> {
		if (!paneEnabledPromise) {
			const promise = ensureRoot(ctx).then((root) => loadPaneEnabled(root));
			promise.catch(() => {
				if (paneEnabledPromise === promise) paneEnabledPromise = undefined;
			});
			paneEnabledPromise = promise;
		}
		return paneEnabledPromise;
	}

	/**
	 * Keeps the persistent "where are we" widget in sync with the active
	 * tour's current focus. Guarded by ctx.hasUI since setWidget is TUI/RPC-
	 * only - the hidden context injection (inject.ts) is what carries this
	 * same information to the model in every run mode, unaffected by
	 * paneEnabled. A no-op in print/json modes, and a no-op (clears the
	 * widget) once the tour ends, the current stop has no anchor, or the user
	 * has turned the pane off with `/tour pane off` - skipping the redundant
	 * setWidget(undefined) call in that last case once the widget is already
	 * cleared, since this runs on every turn.
	 */
	function updateLocationWidget(ctx: ExtensionContext, tour: Tour | undefined, paneEnabled: boolean): void {
		if (!ctx.hasUI) return;
		if (!paneEnabled || !tour || tour.status !== "in-progress" || !tour.focus) {
			if (!widgetShown) return;
			ctx.ui.setWidget(LOCATION_WIDGET_KEY, undefined);
			widgetShown = false;
			return;
		}
		const lines = formatLocationWidgetLines(tour.focus, tour.topic).map((line) => ctx.ui.theme.fg("accent", line));
		ctx.ui.setWidget(LOCATION_WIDGET_KEY, lines);
		widgetShown = true;
	}

	pi.on("session_start", async (_event, ctx) => {
		rootPromise = undefined;
		anchorRootPromise = undefined;
		paneEnabledPromise = undefined;
		lastIndexContent = undefined;
		widgetShown = false;
		if (!ctx.hasUI) return;
		const [tour, paneEnabled] = await Promise.all([
			ensureRoot(ctx)
				.then((root) => store.loadActiveTour(root))
				.catch(() => undefined),
			ensurePaneEnabled(ctx).catch(() => DEFAULT_PANE_ENABLED),
		]);
		updateLocationWidget(ctx, tour, paneEnabled);
	});

	// Compaction/branch navigation can drop the previously injected hidden
	// status message from the message list; forget what we last injected so
	// the next turn re-injects even if the tour itself hasn't changed since.
	pi.on("session_compact", async () => {
		lastIndexContent = undefined;
	});
	pi.on("session_tree", async () => {
		lastIndexContent = undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// Root resolution or the active-tour read failing must not break the
		// turn - degrade to "no tour context" rather than throwing every time.
		const [tour, paneEnabled] = await Promise.all([
			ensureRoot(ctx)
				.then((root) => store.loadActiveTour(root))
				.catch(() => undefined),
			ensurePaneEnabled(ctx).catch(() => DEFAULT_PANE_ENABLED),
		]);
		updateLocationWidget(ctx, tour, paneEnabled);
		const index = buildTourIndexText(tour);
		const content = resolveTourContextContent(index, lastIndexContent);
		if (content === undefined) return;
		lastIndexContent = content;
		return { message: buildTourContextMessage(content) };
	});

	pi.on("context", async (event) => {
		return { messages: dropStaleTourContext(event.messages) };
	});

	// Mutating tools are only exposed to the main interactive agent - only it
	// drives a tour, and a subagent mutating the active tour out from under it
	// would be surprising. tour_status stays available everywhere since it's
	// read-only, matching project-memory's read tools.
	if (!isSubagent) pi.registerTool({
		name: "tour_plan",
		label: "Tour Plan",
		description:
			"Create (or replace) the active codebase tour's plan: a topic and an ordered list of stops. " +
			"Call this once you've explored enough of the codebase to lay out a sensible walkthrough. " +
			"Replacing an in-progress tour archives it (never deletes it) before creating the new one.",
		promptSnippet: "Create or replace the active codebase tour's plan",
		promptGuidelines: [
			"Explore the codebase first (read/grep/glob) - don't call tour_plan before you actually know what's there.",
			`Aim for 4-8 stops for most tours; the hard limit is ${MAX_STOPS}. Order them so each stop builds on the last.`,
			"Give a stop one or two tight anchors (file plus line range) when there's a specific snippet worth showing - " +
				"a single function or block, not a whole file - so tour_advance can surface a focused example automatically.",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Short description of what this tour covers" }),
			style: Type.Optional(
				Type.Union(
					[Type.Literal("socratic"), Type.Literal("explain-first"), Type.Literal("mixed")],
					{ description: `Teaching style for this tour (default "${DEFAULT_STYLE}")` },
				),
			),
			stops: Type.Array(
				Type.Object({
					title: Type.String({ description: "Short stop title" }),
					summary: Type.String({ description: "What this stop covers and why it matters" }),
					files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths, relative to the project root" })),
					anchors: Type.Optional(
						Type.Array(ANCHOR_SCHEMA, {
							description:
								"Optional tight code anchors shown when the tour reaches this stop. Prefer a specific " +
								"function/block over a whole file.",
						}),
					),
				}),
				{ minItems: 1, maxItems: MAX_STOPS, description: "Ordered stops for the walkthrough" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await ensureRoot(ctx);
			const previous = await store.loadActiveTour(root);
			const superseded = previous ? await store.archiveActiveTour(root, inferEndStatus(previous)) : undefined;
			const now = new Date().toISOString();
			const tour: Tour = {
				id: store.generateTourId(params.topic),
				topic: params.topic,
				style: params.style ?? DEFAULT_STYLE,
				status: "in-progress",
				createdAt: now,
				updatedAt: now,
				stops: store.buildStops(params.stops),
				currentStopIndex: -1,
				completedStopIds: [],
			};
			await store.saveActiveTour(root, tour);
			updateLocationWidget(ctx, tour, await ensurePaneEnabled(ctx));
			const supersededNote = superseded ? ` (superseded and archived the previous tour "${superseded.topic}")` : "";
			const text =
				`Created tour "${tour.topic}" with ${tour.stops.length} stop(s)${supersededNote}.\n` +
				`Call tour_advance to move to stop 1 and present it to the user.`;
			return { content: [{ type: "text", text }], details: { id: tour.id, stopCount: tour.stops.length } };
		},
	});

	if (!isSubagent) pi.registerTool({
		name: "tour_advance",
		label: "Tour Advance",
		description:
			'Move the active tour to another stop. direction "next" (the default) marks the current stop ' +
			'complete and moves forward; "prev" moves back without affecting completion; "goto" jumps to a ' +
			"specific stop index (0-based) without affecting completion. Returns the new current stop's " +
			"content so you know what to present next.",
		promptSnippet: "Move the active tour to another stop",
		parameters: Type.Object({
			direction: Type.Optional(
				Type.Union([Type.Literal("next"), Type.Literal("prev"), Type.Literal("goto")], {
					description: 'Which way to move (default "next")',
				}),
			),
			index: Type.Optional(Type.Integer({ minimum: 0, description: 'Target stop index (0-based), required when direction is "goto"' })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await ensureRoot(ctx);
			const tour = await store.loadActiveTour(root);
			if (!tour || tour.status !== "in-progress") {
				return {
					content: [{ type: "text", text: "No in-progress tour. Call tour_plan first." }],
					details: {},
					isError: true,
				};
			}

			const direction = params.direction ?? "next";
			const lastIndex = tour.stops.length - 1;
			let note = "";

			if (direction === "goto") {
				if (params.index === undefined || params.index < 0 || params.index > lastIndex) {
					return {
						content: [{ type: "text", text: `index must be between 0 and ${lastIndex} for direction "goto".` }],
						details: {},
						isError: true,
					};
				}
				tour.currentStopIndex = params.index;
			} else if (direction === "prev") {
				tour.currentStopIndex = Math.max(tour.currentStopIndex - 1, 0);
			} else {
				if (tour.currentStopIndex === -1) {
					tour.currentStopIndex = 0;
				} else {
					const currentStop = tour.stops[tour.currentStopIndex];
					if (!tour.completedStopIds.includes(currentStop.id)) tour.completedStopIds.push(currentStop.id);
					if (tour.currentStopIndex >= lastIndex) {
						note = " Already at the last stop; call tour_end when the tour is done.";
					} else {
						tour.currentStopIndex += 1;
					}
				}
			}

			const stop = tour.stops[tour.currentStopIndex];
			const firstAnchor = stop.anchors?.[0];
			tour.focus = firstAnchor;
			const snippet = firstAnchor ? await readSnippet(firstAnchor, await ensureAnchorRoot(ctx)) : undefined;

			tour.updatedAt = new Date().toISOString();
			await store.saveActiveTour(root, tour);
			updateLocationWidget(ctx, tour, await ensurePaneEnabled(ctx));

			const progress = `${tour.completedStopIds.length}/${tour.stops.length} stops complete`;
			let text = `${formatStopLine(stop, tour.currentStopIndex, tour)}\n(${progress})${note}`;
			if (snippet) text += `\n\n${formatSnippetText(snippet)}`;
			return { content: [{ type: "text", text }], details: { currentStopIndex: tour.currentStopIndex, stopId: stop.id, snippet } };
		},
		renderResult(result, _options, theme) {
			const details = result.details as { snippet?: SnippetResult } | undefined;
			const text = result.content[0];
			const plain = text?.type === "text" ? text.text : "(no output)";
			if (!details?.snippet) return new Text(plain, 0, 0);
			const header = plain.split("\n\n")[0] ?? plain;
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(buildSnippetComponent(details.snippet, theme));
			return container;
		},
	});

	if (!isSubagent) pi.registerTool({
		name: "tour_note",
		label: "Tour Note",
		description:
			"Append a short note to a tour stop - a breadcrumb for a deep dive taken inline during the tour " +
			'(e.g. "looked at the retry logic in client.ts, it backs off exponentially"). Kept inline on the ' +
			"stop rather than written out to a separate file, so it's there if the tour is resumed later.",
		promptSnippet: "Record a short inline note on a tour stop",
		parameters: Type.Object({
			note: Type.String({ description: "Short note to record" }),
			stopId: Type.Optional(Type.String({ description: "Stop id to attach the note to (default: the current stop)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await ensureRoot(ctx);
			const tour = await store.loadActiveTour(root);
			if (!tour || tour.status !== "in-progress") {
				return { content: [{ type: "text", text: "No in-progress tour." }], details: {}, isError: true };
			}
			if (params.stopId === undefined && tour.currentStopIndex === -1) {
				return {
					content: [{ type: "text", text: "No current stop to attach a note to; call tour_advance first, or pass stopId explicitly." }],
					details: {},
					isError: true,
				};
			}
			const targetId = params.stopId ?? tour.stops[tour.currentStopIndex]?.id;
			const stop = tour.stops.find((s) => s.id === targetId);
			if (!stop) {
				return { content: [{ type: "text", text: `No stop found with id ${targetId}.` }], details: {}, isError: true };
			}
			stop.notes.push(params.note);
			tour.updatedAt = new Date().toISOString();
			await store.saveActiveTour(root, tour);
			return { content: [{ type: "text", text: `Noted on ${stop.id}.` }], details: { stopId: stop.id } };
		},
	});

	if (!isSubagent) pi.registerTool({
		name: "tour_show",
		label: "Tour Show",
		description:
			"Show a snippet from a specific file (optionally a line range) and set it as the tour's current " +
			"focus, so the persistent location widget and the hidden per-turn context reflect where the " +
			"discussion is - even without moving to a different stop. Use this for an ad hoc look at a file " +
			"during a stop's discussion; use tour_advance for a planned stop transition.",
		promptSnippet: "Show a file/range snippet and set the tour's current focus",
		parameters: Type.Object({
			file: Type.String({ description: "Path relative to the project root" }),
			startLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line" })),
			endLine: Type.Optional(Type.Integer({ minimum: 1, description: ANCHOR_RANGE_DESCRIPTION })),
			label: Type.Optional(Type.String({ description: "Short label for what this shows, e.g. a function name" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await ensureRoot(ctx);
			const tour = await store.loadActiveTour(root);
			if (!tour || tour.status !== "in-progress") {
				return { content: [{ type: "text", text: "No in-progress tour. Call tour_plan first." }], details: {}, isError: true };
			}
			const anchor: TourAnchor = { file: params.file, startLine: params.startLine, endLine: params.endLine, label: params.label };
			const snippet = await readSnippet(anchor, await ensureAnchorRoot(ctx));
			if (snippet.ok) {
				tour.focus = anchor;
				tour.updatedAt = new Date().toISOString();
				await store.saveActiveTour(root, tour);
				updateLocationWidget(ctx, tour, await ensurePaneEnabled(ctx));
			}
			return { content: [{ type: "text", text: formatSnippetText(snippet) }], details: { anchor, snippet }, isError: !snippet.ok };
		},
		renderResult(result, _options, theme) {
			const details = result.details as { snippet?: SnippetResult } | undefined;
			if (!details?.snippet) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			return buildSnippetComponent(details.snippet, theme);
		},
	});

	pi.registerTool({
		name: "tour_status",
		label: "Tour Status",
		description: "Get the active tour's full status: topic, style, every stop with its state and notes, and progress.",
		promptSnippet: "Get the active tour's full status",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const root = await ensureRoot(ctx);
			const tour = await store.loadActiveTour(root);
			if (!tour) {
				const history = await store.listHistory(root);
				const text = `No active tour.\n\nPast tours:\n${formatHistoryList(history)}`;
				return { content: [{ type: "text", text }], details: {} };
			}
			return { content: [{ type: "text", text: formatTourStatus(tour) }], details: { id: tour.id } };
		},
	});

	if (!isSubagent) pi.registerTool({
		name: "tour_end",
		label: "Tour End",
		description:
			'End the active tour, archiving it. Pass outcome "completed" or "abandoned"; if omitted, it is ' +
			"inferred from whether every stop was marked complete.",
		promptSnippet: "End the active tour",
		parameters: Type.Object({
			outcome: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("abandoned")])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = await ensureRoot(ctx);
			const tour = await store.loadActiveTour(root);
			if (!tour) {
				return { content: [{ type: "text", text: "No active tour." }], details: {}, isError: true };
			}
			const outcome = params.outcome ?? inferEndStatus(tour);
			await store.archiveActiveTour(root, outcome);
			// paneEnabled doesn't matter here - clearing the widget for a gone tour
			// is correct either way (updateLocationWidget clears it when !tour too).
			updateLocationWidget(ctx, undefined, true);
			const hint = isModeCommandAvailable(pi.getCommands()) ? ` ${MODE_EXIT_HINT}` : "";
			return {
				content: [{ type: "text", text: `Ended tour "${tour.topic}" (${outcome}).${hint}` }],
				details: { id: tour.id, outcome },
			};
		},
	});

	pi.registerCommand("tour", {
		description:
			"Manage codebase tours: status (default) | start [topic] | list | where | pane [on|off|toggle|status] | end [completed|abandoned]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = (tokens[0] ?? "status").toLowerCase();
			const rest = tokens.slice(1).join(" ");
			const root = await ensureRoot(ctx);

			if (sub === "status" || sub === "") {
				const tour = await store.loadActiveTour(root);
				ctx.ui.notify(tour ? formatTourStatus(tour) : "No active tour. Try /tour start [topic].", "info");
				return;
			}

			if (sub === "list") {
				const [tour, history] = await Promise.all([store.loadActiveTour(root), store.listHistory(root)]);
				const activeLine = tour ? `Active: ${tour.id} - "${tour.topic}"` : "Active: none";
				ctx.ui.notify(`${activeLine}\n\nPast tours:\n${formatHistoryList(history)}`, "info");
				return;
			}

			if (sub === "where") {
				const tour = await store.loadActiveTour(root);
				updateLocationWidget(ctx, tour, await ensurePaneEnabled(ctx));
				if (!tour || !tour.focus) {
					ctx.ui.notify("No current tour location set. tour_advance to a stop with anchors, or tour_show, sets one.", "info");
					return;
				}
				const snippet = await readSnippet(tour.focus, await ensureAnchorRoot(ctx));
				ctx.ui.notify(formatSnippetText(snippet), "info");
				return;
			}

			if (sub === "pane") {
				// Read straight from disk (not the session-cached ensurePaneEnabled)
				// so a change made by another session is reflected here instead of
				// this session's stale in-memory value.
				const current = await loadPaneEnabled(root);
				const decision = resolveNextPaneState(rest, current);
				if (decision.kind === "invalid") {
					ctx.ui.notify("Usage: /tour pane [on|off|toggle|status]", "error");
					return;
				}
				paneEnabledPromise = Promise.resolve(decision.enabled);
				if (decision.kind === "report") {
					ctx.ui.notify(`Tour location pane is ${decision.enabled ? "on" : "off"}.`, "info");
					return;
				}
				await savePaneEnabled(root, decision.enabled);
				const tour = await store.loadActiveTour(root);
				updateLocationWidget(ctx, tour, decision.enabled);
				ctx.ui.notify(`Tour location pane turned ${decision.enabled ? "on" : "off"}.`, "info");
				return;
			}

			if (sub === "start") {
				// Dispatch the existing /mode command the same way a typed slash
				// command would be, rather than reimplementing agent-modes' mode
				// switch here. before_agent_start reads the mode fresh each turn,
				// so this must land before the kickoff message below triggers one.
				// MODE_SWITCH_COMMAND carries agent-modes' SESSION_ONLY_FLAG so this
				// only affects the current session - it must never persist as the
				// default mode for every future session/project.
				//
				// No deliverAs here (unlike the kickoff below): this command handler
				// is itself running because the user just typed /tour start, so the
				// agent is not streaming and there's nothing to queue behind - the
				// default (immediate) delivery is fine. agent-modes' /mode handler
				// does no I/O (it's a synchronous in-memory mode switch), so by the
				// time this call returns, currentMode has already flipped to "tour"
				// and the kickoff's before_agent_start below is guaranteed to see it.
				// If /mode's handler ever became async, this ordering guarantee would
				// break and the two sendUserMessage calls would need to be sequenced
				// explicitly (e.g. by awaiting a completion signal) instead.
				if (isModeCommandAvailable(pi.getCommands())) {
					pi.sendUserMessage(MODE_SWITCH_COMMAND, { expandPromptTemplates: true });
				} else {
					// agent-modes isn't loaded (or was removed) - say so plainly rather
					// than silently starting a tour that isn't actually read-only, since
					// the README/skill both promise edit/git-write blocking here.
					ctx.ui.notify(
						"agent-modes extension (/mode command) is not available - starting the tour " +
							"without switching to read-only tour mode. Edits and git writes will not be " +
							"blocked automatically.",
						"warning",
					);
				}
				// deliverAs: "followUp" so this doesn't throw if /tour start is run
				// while the agent is already streaming (sendUserMessage requires a
				// streamingBehavior in that case); harmless when idle.
				pi.sendUserMessage(buildTourKickoffMessage(rest.trim()), { deliverAs: "followUp" });
				return;
			}

			if (sub === "end") {
				const outcomeArg = rest.trim().toLowerCase();
				if (outcomeArg && outcomeArg !== "completed" && outcomeArg !== "abandoned") {
					ctx.ui.notify("Usage: /tour end [completed|abandoned]", "error");
					return;
				}
				const tour = await store.loadActiveTour(root);
				if (!tour) {
					ctx.ui.notify("No active tour.", "info");
					return;
				}
				const outcome = (outcomeArg as "completed" | "abandoned" | "") || inferEndStatus(tour);
				await store.archiveActiveTour(root, outcome);
				updateLocationWidget(ctx, undefined, true);
				const hint = isModeCommandAvailable(pi.getCommands()) ? ` ${MODE_EXIT_HINT}` : "";
				ctx.ui.notify(`Ended tour "${tour.topic}" (${outcome}).${hint}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /tour [status|start [topic]|list|where|pane [on|off|toggle|status]|end [completed|abandoned]]", "error");
		},
	});
}
