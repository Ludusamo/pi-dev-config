/**
 * Configuration storage for project memory: the global per-project mode map,
 * and the committed repo marker that lets a repo-mode decision travel with
 * the codebase itself (subject to the trust gate in resolve.ts/index.ts).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withLock } from "./lock.ts";
import type { GlobalMemoryConfig, RepoMemoryMarker, StoredProjectConfig } from "./types.ts";

const DEFAULT_GLOBAL_CONFIG: GlobalMemoryConfig = { defaultMode: "private", projects: createProjectsMap() };

/**
 * A project key is arbitrary, sanitized user/repo-derived text, so it can
 * legitimately be a name like `constructor`, `__proto__`, `toString`, or
 * `hasOwnProperty` - names that shadow `Object.prototype` members. A plain
 * `{}` map would make those keys unreadable/unwritable via ordinary bracket
 * access or `in` (they'd resolve to the inherited function/accessor instead
 * of "no entry"), so every `projects` map here is created with a null
 * prototype instead, and all membership checks use `Object.hasOwn` rather
 * than `in` or truthiness. This makes bracket access, `in`, and `delete` on
 * `projects` behave correctly for every string key with no special-casing.
 */
function createProjectsMap(): Record<string, StoredProjectConfig> {
	return Object.create(null) as Record<string, StoredProjectConfig>;
}

/** Shallow-copies only `source`'s own keys onto a fresh null-prototype map, regardless of `source`'s own prototype. */
function cloneProjects(source: Record<string, StoredProjectConfig>): Record<string, StoredProjectConfig> {
	const out = createProjectsMap();
	for (const key of Object.keys(source)) out[key] = source[key];
	return out;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	await rename(tmpPath, filePath);
}

export async function readGlobalConfig(configPath: string): Promise<GlobalMemoryConfig> {
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<GlobalMemoryConfig>;
		const projects = createProjectsMap();
		if (parsed.projects && typeof parsed.projects === "object") {
			for (const key of Object.keys(parsed.projects)) projects[key] = parsed.projects[key];
		}
		return {
			defaultMode: parsed.defaultMode ?? DEFAULT_GLOBAL_CONFIG.defaultMode,
			projects,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_GLOBAL_CONFIG, projects: createProjectsMap() };
		throw err;
	}
}

export async function writeGlobalConfig(configPath: string, config: GlobalMemoryConfig): Promise<void> {
	await withLock(`${configPath}.lock`, async () => {
		await atomicWriteJson(configPath, config);
	});
}

/**
 * Read-modify-write the global config under a lock, so concurrent callers
 * can't clobber each other's writes. If `updater` returns the exact same
 * object it was given (a no-op decision), the file is left untouched rather
 * than rewritten with identical contents.
 */
export async function updateGlobalConfig(
	configPath: string,
	updater: (current: GlobalMemoryConfig) => GlobalMemoryConfig,
): Promise<GlobalMemoryConfig> {
	return withLock(`${configPath}.lock`, async () => {
		const current = await readGlobalConfig(configPath);
		const next = updater(current);
		if (next !== current) await atomicWriteJson(configPath, next);
		return next;
	});
}

export async function setProjectConfig(
	configPath: string,
	projectKey: string,
	projectConfig: StoredProjectConfig,
): Promise<GlobalMemoryConfig> {
	return updateGlobalConfig(configPath, (current) => {
		const projects = cloneProjects(current.projects);
		projects[projectKey] = projectConfig;
		return { ...current, projects };
	});
}

/** Outcome of {@link migrateProjectConfigKey}, so callers can report honestly instead of assuming success. */
export type ConfigMigrationStatus =
	| "moved"
	| "conflict"
	| "no-old-entry"
	| "same-key";

export interface ConfigMigrationResult {
	config: GlobalMemoryConfig;
	status: ConfigMigrationStatus;
}

/**
 * Moves a project's config entry from `oldKey` to `newKey`. Idempotent (a
 * second call is a no-op once `oldKey` is gone) and conflict-safe: if an
 * entry already exists under `newKey`, `oldKey`'s entry is left in place
 * (never deleted, never overwritten) and the result reports `"conflict"` so
 * the caller can surface it rather than silently losing the old config.
 */
export async function migrateProjectConfigKey(
	configPath: string,
	oldKey: string,
	newKey: string,
): Promise<ConfigMigrationResult> {
	let status: ConfigMigrationStatus = "no-old-entry";
	const config = await updateGlobalConfig(configPath, (current) => {
		if (oldKey === newKey) {
			status = "same-key";
			return current;
		}
		if (!Object.hasOwn(current.projects, oldKey)) {
			status = "no-old-entry";
			return current;
		}
		if (Object.hasOwn(current.projects, newKey)) {
			status = "conflict";
			return current;
		}
		status = "moved";
		const projects = cloneProjects(current.projects);
		const oldEntry = projects[oldKey];
		delete projects[oldKey];
		projects[newKey] = oldEntry;
		return { ...current, projects };
	});
	return { config, status };
}

/**
 * Unconditionally removes a project's config entry. Unlike
 * `migrateProjectConfigKey`, this is not conflict-safe by design - it exists
 * only for `/memory-relink --drop-old-config`, so a user who has confirmed
 * `newKey`'s config entry is the one they want can explicitly discard a
 * stale `oldKey` entry that a migration left behind rather than overwrite
 * (see `migrateProjectConfigKey`, which never picks a winner on its own).
 */
export async function dropProjectConfigKey(configPath: string, key: string): Promise<GlobalMemoryConfig> {
	return updateGlobalConfig(configPath, (current) => {
		if (!Object.hasOwn(current.projects, key)) return current;
		const projects = cloneProjects(current.projects);
		delete projects[key];
		return { ...current, projects };
	});
}

function repoMarkerPath(repoToplevel: string): string {
	return join(repoToplevel, ".pi", "memory.json");
}

export async function readRepoMarker(repoToplevel: string): Promise<RepoMemoryMarker | undefined> {
	try {
		const raw = await readFile(repoMarkerPath(repoToplevel), "utf-8");
		const parsed = JSON.parse(raw) as Partial<RepoMemoryMarker>;
		if (parsed.mode !== "repo") return undefined;
		return { mode: "repo", version: 1 };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

export async function writeRepoMarker(repoToplevel: string): Promise<void> {
	const markerPath = repoMarkerPath(repoToplevel);
	await withLock(`${markerPath}.lock`, async () => {
		await atomicWriteJson(markerPath, { mode: "repo", version: 1 } satisfies RepoMemoryMarker);
	});
}
