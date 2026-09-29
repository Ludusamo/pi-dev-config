/**
 * Shared types for the codebase-tour extension.
 *
 * This module has no runtime dependencies (pi or otherwise) so it can be
 * imported from both the extension wiring (index.ts) and plain unit tests,
 * matching the split used by project-memory/types.ts.
 */

/** How a stop is taught. "mixed" (the default) blends both per-stop, based on the user's signals. */
export type TourStyle = "socratic" | "explain-first" | "mixed";

export type TourStatus = "in-progress" | "completed" | "abandoned";

/**
 * A pointer at a specific piece of code: a file and, optionally, a tight
 * line range within it. Used both on a stop (candidate snippets to show) and
 * as a tour's `focus` (the location currently being discussed). `startLine`/
 * `endLine` are 1-based and inclusive; omitting both means "the file itself"
 * rather than any particular line range.
 */
export interface TourAnchor {
	/** Path relative to the project root. */
	file: string;
	startLine?: number;
	endLine?: number;
	/** Short human label for what this anchor shows, e.g. a function name. */
	label?: string;
}

export interface TourStop {
	id: string;
	title: string;
	/** Short description of what this stop covers and why it matters, drafted when the tour is planned. */
	summary: string;
	/** Paths (relative to the project root) relevant to this stop. May be empty for a conceptual/overview stop. */
	files: string[];
	/**
	 * Optional tight code anchors for this stop's key snippet(s), shown inline
	 * when the tour advances to this stop. Absent on stops planned before this
	 * field existed, and optional on new stops (a purely conceptual stop has
	 * nothing to anchor). Prefer a handful of lines over a whole file.
	 */
	anchors?: TourAnchor[];
	/**
	 * Short notes accumulated from deep dives taken at this stop while touring.
	 * Deep dives stay inline here rather than being written out to separate
	 * files - the point is a lightweight breadcrumb ("we looked at X, found Y")
	 * for resuming later, not a durable doc.
	 */
	notes: string[];
}

export interface Tour {
	id: string;
	topic: string;
	style: TourStyle;
	status: TourStatus;
	createdAt: string;
	updatedAt: string;
	stops: TourStop[];
	/** Index into `stops` of the stop currently being presented. -1 before the first stop has been presented. */
	currentStopIndex: number;
	/** Ids of stops the tour has moved past via `tour_advance` (direction "next"). Revisiting a stop does not remove it. */
	completedStopIds: string[];
	/**
	 * The code location currently being discussed, if any - set from a stop's
	 * first anchor on `tour_advance`, or directly by `tour_show`. Surfaced in
	 * the persistent location widget and the hidden per-turn context so both
	 * the user and the model stay oriented. Absent when the current stop has
	 * no anchors, or before any anchor has been shown.
	 */
	focus?: TourAnchor;
}

/** Lightweight summary of a tour, e.g. for `/tour list` - no stop bodies or notes. */
export interface TourSummary {
	id: string;
	topic: string;
	status: TourStatus;
	updatedAt: string;
	stopCount: number;
	completedStopCount: number;
}
