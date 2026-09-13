/**
 * File-backed storage for memory entries.
 *
 * Layout under a resolved root:
 *   <root>/short/<id>.md   TTL'd scratch entries
 *   <root>/long/<id>.md    durable, reviewed entries
 *   <root>/.lock/          mkdir-lock directory (see lock.ts)
 *
 * Rot prevention is status-based, not deletion-based: short-term entries past
 * their TTL and explicitly "deleted" entries are marked `status: "archived"`
 * in place. Nothing in this module ever unlinks a memory file.
 */

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { serializeEntry } from "./frontmatter.ts";
import { withLock } from "./lock.ts";
import type { FrontmatterParser, MemoryEntry, MemoryFrontmatter, MemoryStatus, MemoryTerm } from "./types.ts";

export const TERMS: readonly MemoryTerm[] = ["short", "long"];

const STATUSES: readonly MemoryStatus[] = ["active", "pending", "needs-review", "archived"];

/**
 * Strict id shape: starts with a lowercase alphanumeric character, followed
 * by up to 79 more lowercase alphanumeric characters or hyphens (hyphens may
 * repeat), matching everything `generateId` can produce. No dots or slashes,
 * so a validated id can never escape its term directory via path traversal.
 */
const MEMORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isValidMemoryId(id: unknown): id is string {
	return typeof id === "string" && MEMORY_ID_PATTERN.test(id);
}

/** Minimal structural check used to skip corrupt/foreign files instead of throwing. */
function isValidFrontmatterShape(fm: unknown): fm is MemoryFrontmatter {
	if (!fm || typeof fm !== "object") return false;
	const f = fm as Record<string, unknown>;
	if (!isValidMemoryId(f.id)) return false;
	if (typeof f.title !== "string") return false;
	if (f.term !== "short" && f.term !== "long") return false;
	if (typeof f.status !== "string" || !STATUSES.includes(f.status as MemoryStatus)) return false;
	if (typeof f.createdAt !== "string" || typeof f.updatedAt !== "string") return false;
	return true;
}

/**
 * A file's frontmatter id must match its own filename - otherwise an entry
 * could be reached under one id (its filename) while claiming another,
 * confusing anything that indexes or displays it by frontmatter id. Treated
 * the same as a corrupt/foreign file: skipped, not thrown.
 */
function idMatchesFile(fm: MemoryFrontmatter, filePath: string): boolean {
	return fm.id === basename(filePath, ".md");
}

export function termDir(root: string, term: MemoryTerm): string {
	return join(root, term);
}

export function entryPath(root: string, term: MemoryTerm, id: string): string {
	if (!isValidMemoryId(id)) {
		throw new Error(`Invalid memory id: ${JSON.stringify(id)}`);
	}
	return join(termDir(root, term), `${id}.md`);
}

export function generateId(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-+|-+$)/g, "")
		.slice(0, 48);
	const suffix = randomBytes(3).toString("hex");
	return slug ? `${slug}-${suffix}` : `memory-${suffix}`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	await writeFile(tmpPath, content, "utf-8");
	await rename(tmpPath, filePath);
}

/** Writes without acquiring the lock - only safe when the caller already holds it. */
async function writeEntryUnlocked(
	root: string,
	term: MemoryTerm,
	frontmatter: MemoryFrontmatter,
	body: string,
): Promise<MemoryEntry> {
	const filePath = entryPath(root, term, frontmatter.id);
	await atomicWrite(filePath, serializeEntry(frontmatter, body));
	return { frontmatter, body, filePath };
}

/** The mkdir-lock directory guarding writes to `root`. Also used by migrate.ts to hold off concurrent writers while merging a private dir. */
export function lockDir(root: string): string {
	return join(root, ".lock");
}

export async function listEntries(
	root: string,
	term: MemoryTerm,
	parser: FrontmatterParser,
): Promise<MemoryEntry[]> {
	const dir = termDir(root, term);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const entries: MemoryEntry[] = [];
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const filePath = join(dir, file);
		try {
			const raw = await readFile(filePath, "utf-8");
			const { frontmatter, body } = parser<MemoryFrontmatter>(raw);
			if (!isValidFrontmatterShape(frontmatter)) continue;
			if (!idMatchesFile(frontmatter, filePath)) continue;
			entries.push({ frontmatter, body, filePath });
		} catch {
			// One corrupt/unreadable file must not break listing/search/index for the rest.
			continue;
		}
	}
	return entries;
}

export async function readEntry(
	root: string,
	term: MemoryTerm,
	id: string,
	parser: FrontmatterParser,
): Promise<MemoryEntry | undefined> {
	if (!isValidMemoryId(id)) return undefined;
	const filePath = entryPath(root, term, id);
	try {
		const raw = await readFile(filePath, "utf-8");
		const { frontmatter, body } = parser<MemoryFrontmatter>(raw);
		if (!isValidFrontmatterShape(frontmatter)) return undefined;
		if (!idMatchesFile(frontmatter, filePath)) return undefined;
		return { frontmatter, body, filePath };
	} catch {
		// Missing (ENOENT) and corrupt/unparseable files are both treated as
		// "no entry", consistent with listEntries - a bad file must not
		// surface as a thrown error.
		return undefined;
	}
}

export async function findEntry(
	root: string,
	id: string,
	parser: FrontmatterParser,
): Promise<{ term: MemoryTerm; entry: MemoryEntry } | undefined> {
	if (!isValidMemoryId(id)) return undefined;
	for (const term of TERMS) {
		const entry = await readEntry(root, term, id, parser);
		if (entry) return { term, entry };
	}
	return undefined;
}

export async function writeEntry(
	root: string,
	term: MemoryTerm,
	frontmatter: MemoryFrontmatter,
	body: string,
): Promise<MemoryEntry> {
	return withLock(lockDir(root), () => writeEntryUnlocked(root, term, frontmatter, body));
}

/** Generates an id for a new entry, retrying on the (astronomically unlikely) chance of a collision. */
export async function generateUniqueId(root: string, title: string, parser: FrontmatterParser): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = generateId(title);
		if (!(await findEntry(root, id, parser))) return id;
	}
	throw new Error("Failed to generate a unique memory id");
}

export async function updateEntry(
	root: string,
	id: string,
	patch: Partial<Omit<MemoryFrontmatter, "id">> & { body?: string },
	parser: FrontmatterParser,
): Promise<MemoryEntry | undefined> {
	if (!isValidMemoryId(id)) return undefined;
	return withLock(lockDir(root), async () => {
		// Re-read under the lock so concurrent updates read-modify-write against
		// the latest state instead of racing and silently losing one update.
		const found = await findEntry(root, id, parser);
		if (!found) return undefined;
		const { term, entry } = found;
		const { body: bodyPatch, ...frontmatterPatch } = patch;
		const nextFrontmatter: MemoryFrontmatter = {
			...entry.frontmatter,
			...frontmatterPatch,
			id: entry.frontmatter.id,
			updatedAt: new Date().toISOString(),
		};
		return writeEntryUnlocked(root, term, nextFrontmatter, bodyPatch ?? entry.body);
	});
}

export type PromoteError = "not-found" | "not-active";

export type PromoteResult = { ok: true; entry: MemoryEntry } | { ok: false; error: PromoteError };

/**
 * Promotes an active short-term entry to long-term under a brand new id
 * (never reusing the short-term id) so the archived short-term stub can
 * never shadow the promoted long-term entry in `findEntry`, which prefers
 * short-term matches. Refuses non-active entries so pending/needs-review/
 * archived short-term entries can't be promoted out from under review.
 */
export async function promoteEntry(
	root: string,
	id: string,
	status: Extract<MemoryStatus, "active" | "pending">,
	parser: FrontmatterParser,
): Promise<PromoteResult> {
	if (!isValidMemoryId(id)) return { ok: false, error: "not-found" };
	return withLock(lockDir(root), async () => {
		const found = await findEntry(root, id, parser);
		if (!found || found.term !== "short") return { ok: false, error: "not-found" };
		if (found.entry.frontmatter.status !== "active") return { ok: false, error: "not-active" };

		const now = new Date().toISOString();
		let newId: string | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			const candidate = generateId(found.entry.frontmatter.title);
			if (!(await findEntry(root, candidate, parser))) {
				newId = candidate;
				break;
			}
		}
		if (!newId) throw new Error("Failed to generate a unique memory id");

		const promoted: MemoryFrontmatter = {
			...found.entry.frontmatter,
			id: newId,
			term: "long",
			status,
			updatedAt: now,
			expiresAt: undefined,
		};
		const entry = await writeEntryUnlocked(root, "long", promoted, found.entry.body);
		await writeEntryUnlocked(
			root,
			"short",
			{ ...found.entry.frontmatter, status: "archived", updatedAt: now, promotedTo: newId },
			found.entry.body,
		);
		return { ok: true, entry };
	});
}

/** Archives (never deletes) short-term entries past their TTL. Returns the count archived. */
export async function archiveExpiredShortTerm(root: string, parser: FrontmatterParser): Promise<number> {
	const candidates = await listEntries(root, "short", parser);
	let archived = 0;
	for (const candidate of candidates) {
		if (candidate.frontmatter.status === "archived") continue;
		// Cheap pre-check against the already-in-memory listing so a sweep over
		// mostly-unexpired entries doesn't acquire the lock (mkdir/rmdir) for
		// every single one; the lock is only taken for candidates that look
		// expired, then re-verified under it below.
		const precheckExpiresAt = candidate.frontmatter.expiresAt ? Date.parse(candidate.frontmatter.expiresAt) : Number.NaN;
		if (Number.isNaN(precheckExpiresAt) || precheckExpiresAt >= Date.now()) continue;
		const archivedNow = await withLock(lockDir(root), async () => {
			// Re-read the single entry under the lock right before writing so a
			// concurrent update made after the initial listing isn't clobbered.
			const fresh = await readEntry(root, "short", candidate.frontmatter.id, parser);
			if (!fresh || fresh.frontmatter.status === "archived") return false;
			const expiresAt = fresh.frontmatter.expiresAt ? Date.parse(fresh.frontmatter.expiresAt) : Number.NaN;
			if (Number.isNaN(expiresAt) || expiresAt >= Date.now()) return false;
			await writeEntryUnlocked(
				root,
				"short",
				{ ...fresh.frontmatter, status: "archived", updatedAt: new Date().toISOString() },
				fresh.body,
			);
			return true;
		});
		if (archivedNow) archived++;
	}
	return archived;
}

export interface SearchQuery {
	query?: string;
	term?: MemoryTerm | "all";
	tags?: string[];
	limit?: number;
}

export async function searchEntries(
	root: string,
	parser: FrontmatterParser,
	query: SearchQuery = {},
): Promise<MemoryEntry[]> {
	const terms: MemoryTerm[] = query.term && query.term !== "all" ? [query.term] : [...TERMS];
	const all: MemoryEntry[] = [];
	for (const term of terms) all.push(...(await listEntries(root, term, parser)));

	let filtered = all.filter((e) => e.frontmatter.status !== "archived");

	if (query.tags?.length) {
		const wantedTags = query.tags;
		filtered = filtered.filter((e) => wantedTags.every((t) => e.frontmatter.tags?.includes(t)));
	}

	if (query.query) {
		const q = query.query.toLowerCase();
		filtered = filtered.filter(
			(e) =>
				e.frontmatter.title.toLowerCase().includes(q) ||
				e.body.toLowerCase().includes(q) ||
				e.frontmatter.tags?.some((t) => t.toLowerCase().includes(q)),
		);
	}

	filtered.sort((a, b) => Date.parse(b.frontmatter.updatedAt) - Date.parse(a.frontmatter.updatedAt));
	return filtered.slice(0, query.limit ?? 20);
}

const MAX_INDEX_ENTRIES = 50;
const MAX_INDEX_CHARS = 4000;

/** Collapses newlines/control characters so an entry can't inject fake index lines. */
function sanitizeIndexText(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").trim();
}

function formatIndexLine(e: MemoryEntry, statusSuffix?: string): string {
	const title = sanitizeIndexText(e.frontmatter.title);
	const tagList = e.frontmatter.tags?.map(sanitizeIndexText).filter(Boolean) ?? [];
	const tags = tagList.length ? ` [${tagList.join(", ")}]` : "";
	return `- ${e.frontmatter.id}${statusSuffix ?? ""}: ${title}${tags}`;
}

/** Builds the compact index text injected into context. Empty string when there's nothing to show. */
export async function buildCompactIndex(root: string, parser: FrontmatterParser): Promise<string> {
	const now = Date.now();
	const [shortEntries, longEntries] = await Promise.all([
		listEntries(root, "short", parser),
		listEntries(root, "long", parser),
	]);

	const activeShort = shortEntries.filter((e) => {
		if (e.frontmatter.status !== "active") return false;
		const expiresAt = e.frontmatter.expiresAt ? Date.parse(e.frontmatter.expiresAt) : Number.NaN;
		return Number.isNaN(expiresAt) || expiresAt >= now;
	});
	// Pending/archived long entries haven't been (or are no longer) approved -
	// they must not be surfaced as if they were established facts.
	const visibleLong = longEntries.filter((e) => e.frontmatter.status === "active" || e.frontmatter.status === "needs-review");

	if (activeShort.length === 0 && visibleLong.length === 0) return "";

	const lines: string[] = ["Project memory index (use memory_get <id> for full details):"];
	let entryCount = 0;
	let truncated = false;

	if (visibleLong.length > 0) {
		lines.push("Long-term:");
		for (const e of visibleLong) {
			if (entryCount >= MAX_INDEX_ENTRIES) {
				truncated = true;
				break;
			}
			lines.push(formatIndexLine(e, ` (${e.frontmatter.status})`));
			entryCount++;
		}
	}

	if (!truncated && activeShort.length > 0) {
		lines.push("Short-term:");
		for (const e of activeShort) {
			if (entryCount >= MAX_INDEX_ENTRIES) {
				truncated = true;
				break;
			}
			lines.push(formatIndexLine(e));
			entryCount++;
		}
	}

	if (truncated) lines.push("(index truncated; use memory_search for the rest)");

	let text = lines.join("\n");
	if (text.length > MAX_INDEX_CHARS) {
		text = `${text.slice(0, MAX_INDEX_CHARS)}\n(index truncated; use memory_search for the rest)`;
	}
	return text;
}
