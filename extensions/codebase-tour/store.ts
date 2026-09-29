/**
 * File-backed storage for tour state.
 *
 * There is at most one active tour per project (`active.json`); starting a
 * new one archives whatever was active into `history/<id>.json` first -
 * nothing is ever deleted, only moved out of the active slot. Unlike
 * project-memory's store, this has no mkdir-lock: subagents are read-only
 * (gated in index.ts), but two main interactive agents on the same project
 * (e.g. separate terminal sessions) can still both mutate `active.json`
 * concurrently - that case is unsupported and simply last-write-wins.
 */

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { activeTourPath, historyDir, historyTourPath } from "./paths.ts";
import type { Tour, TourAnchor, TourStatus, TourStop, TourStyle, TourSummary } from "./types.ts";

const STYLES: readonly TourStyle[] = ["socratic", "explain-first", "mixed"];
const STATUSES: readonly TourStatus[] = ["in-progress", "completed", "abandoned"];

/**
 * Strict id shape shared by tour and stop ids: starts with a lowercase
 * alphanumeric character, followed by up to 79 more lowercase alphanumeric
 * characters or hyphens, matching everything generateTourId/generateStopId
 * can produce. No dots or slashes, so a validated id can never escape its
 * directory via path traversal.
 */
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function isSafeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** A valid line number: a positive integer. Absent is also valid (see isValidAnchorShape) - "no line range" is meaningful, not an error. */
function isValidLineNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isValidAnchorShape(value: unknown): value is TourAnchor {
	if (!value || typeof value !== "object") return false;
	const a = value as Record<string, unknown>;
	if (typeof a.file !== "string" || a.file.length === 0) return false;
	if (a.startLine !== undefined && !isValidLineNumber(a.startLine)) return false;
	if (a.endLine !== undefined && !isValidLineNumber(a.endLine)) return false;
	if (a.label !== undefined && typeof a.label !== "string") return false;
	return true;
}

/** Undefined is valid here too - `anchors`/`focus` didn't exist before this field was added, so old stored tours must still load. */
function isValidAnchorArray(value: unknown): value is TourAnchor[] {
	return value === undefined || (Array.isArray(value) && value.every(isValidAnchorShape));
}

function isValidStopShape(value: unknown): value is TourStop {
	if (!value || typeof value !== "object") return false;
	const s = value as Record<string, unknown>;
	return (
		isSafeId(s.id) &&
		typeof s.title === "string" &&
		typeof s.summary === "string" &&
		isStringArray(s.files) &&
		isValidAnchorArray(s.anchors) &&
		isStringArray(s.notes)
	);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	await writeFile(tmpPath, content, "utf-8");
	await rename(tmpPath, filePath);
}

function slugify(text: string, maxLength: number): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-+|-+$)/g, "")
		.slice(0, maxLength);
}

export function generateTourId(topic: string): string {
	const slug = slugify(topic, 48);
	const suffix = randomBytes(3).toString("hex");
	return slug ? `${slug}-${suffix}` : `tour-${suffix}`;
}

export function generateStopId(title: string, index: number): string {
	const slug = slugify(title, 32);
	return slug ? `stop-${index + 1}-${slug}` : `stop-${index + 1}`;
}

/** Minimal structural check so a corrupt/foreign file is skipped rather than thrown on. */
function isValidTourShape(value: unknown): value is Tour {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	if (!isSafeId(t.id) || typeof t.topic !== "string") return false;
	if (typeof t.style !== "string" || !STYLES.includes(t.style as TourStyle)) return false;
	if (typeof t.status !== "string" || !STATUSES.includes(t.status as TourStatus)) return false;
	if (typeof t.createdAt !== "string" || typeof t.updatedAt !== "string") return false;
	if (!Array.isArray(t.stops) || t.stops.length === 0 || !t.stops.every(isValidStopShape)) return false;
	if (!Number.isInteger(t.currentStopIndex) || (t.currentStopIndex as number) < -1 || (t.currentStopIndex as number) >= t.stops.length) {
		return false;
	}
	if (!isStringArray(t.completedStopIds)) return false;
	if (t.focus !== undefined && !isValidAnchorShape(t.focus)) return false;
	return true;
}

async function readTourFile(filePath: string): Promise<Tour | undefined> {
	try {
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		return isValidTourShape(parsed) ? parsed : undefined;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		// A corrupt/unreadable file must not surface as a thrown error - treat it as "no tour", same as a missing file.
		return undefined;
	}
}

export async function loadActiveTour(root: string): Promise<Tour | undefined> {
	return readTourFile(activeTourPath(root));
}

export async function saveActiveTour(root: string, tour: Tour): Promise<void> {
	await atomicWrite(activeTourPath(root), `${JSON.stringify(tour, null, 2)}\n`);
}

export function toSummary(tour: Tour): TourSummary {
	return {
		id: tour.id,
		topic: tour.topic,
		status: tour.status,
		updatedAt: tour.updatedAt,
		stopCount: tour.stops.length,
		completedStopCount: tour.completedStopIds.length,
	};
}

/**
 * Moves the current active tour into history under the given final status,
 * freeing up the active slot. A no-op (returns undefined) when there is no
 * active tour. History files are never overwritten or removed by this
 * extension - archiving is the only "done with this tour" operation there is.
 */
export async function archiveActiveTour(
	root: string,
	finalStatus: Extract<Tour["status"], "completed" | "abandoned">,
): Promise<Tour | undefined> {
	const active = await loadActiveTour(root);
	if (!active) return undefined;
	const archived: Tour = { ...active, status: finalStatus, updatedAt: new Date().toISOString() };
	await atomicWrite(historyTourPath(root, archived.id), `${JSON.stringify(archived, null, 2)}\n`);
	await unlink(activeTourPath(root)).catch(() => {});
	return archived;
}

export async function listHistory(root: string): Promise<TourSummary[]> {
	let files: string[];
	try {
		files = await readdir(historyDir(root));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const summaries: TourSummary[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const tour = await readTourFile(join(historyDir(root), file));
		if (tour) summaries.push(toSummary(tour));
	}
	// Tiebreak on id when updatedAt is identical so the order is deterministic
	// rather than depending on readdir's (unspecified) file order.
	summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
	return summaries;
}

export interface NewStopInput {
	title: string;
	summary: string;
	files?: string[];
	anchors?: TourAnchor[];
}

export function buildStops(inputs: NewStopInput[]): TourStop[] {
	return inputs.map((input, index) => ({
		id: generateStopId(input.title, index),
		title: input.title,
		summary: input.summary,
		files: input.files ?? [],
		// Only set the key when given - an own `anchors: undefined` property would
		// round-trip through JSON without it, so a freshly built and a reloaded
		// tour would no longer be deep-equal.
		...(input.anchors ? { anchors: input.anchors } : {}),
		notes: [],
	}));
}
