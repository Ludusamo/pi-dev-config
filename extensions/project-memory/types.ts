/**
 * Shared types for the project-memory extension.
 *
 * This module has no runtime dependencies (pi or otherwise) so it can be
 * imported from both the extension wiring (index.ts) and plain unit tests.
 */

/** Where memory entries are stored. */
export type MemoryMode = "private" | "repo" | "custom" | "off";

/** Short-term memory is TTL'd scratch context; long-term memory is durable and reviewed. */
export type MemoryTerm = "short" | "long";

/**
 * Lifecycle status of an entry.
 *
 * - active: currently valid and shown in the compact index.
 * - pending: proposed but not yet approved by a human (long-term only).
 * - needs-review: flagged as possibly stale/contradicted; awaiting human review (long-term only).
 * - archived: retired. Never removed automatically - archiving is the only
 *   form of automatic rot prevention; hard deletion is a manual, explicit action.
 */
export type MemoryStatus = "active" | "pending" | "needs-review" | "archived";

export interface MemoryFrontmatter {
	id: string;
	title: string;
	term: MemoryTerm;
	status: MemoryStatus;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	/** Who authored this entry, e.g. "main" or a subagent name (for provenance only; subagents cannot write). */
	source: string;
	/** Short-term only: ISO timestamp after which the entry is eligible for automatic archiving. */
	expiresAt?: string;
	/** Long-term only: ISO timestamp of the last human review. */
	reviewedAt?: string;
	/** Set on an archived short-term entry that was promoted, pointing at the resulting long-term id. */
	promotedTo?: string;
}

export interface MemoryEntry {
	frontmatter: MemoryFrontmatter;
	body: string;
	filePath: string;
}

export interface StoredProjectConfig {
	mode: MemoryMode;
	/** Absolute path, only meaningful when mode is "custom". */
	customPath?: string;
}

export interface GlobalMemoryConfig {
	defaultMode: MemoryMode;
	projects: Record<string, StoredProjectConfig>;
}

export interface RepoMemoryMarker {
	mode: "repo";
	version: 1;
}

/**
 * Matches the shape of pi's exported `parseFrontmatter`. Injected rather than
 * imported directly so core modules stay importable outside the pi runtime.
 */
export type FrontmatterParser = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
) => { frontmatter: T; body: string };
