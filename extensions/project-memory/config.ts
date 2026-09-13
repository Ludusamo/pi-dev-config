/**
 * Configuration storage for project memory: the global per-project mode map,
 * and the committed repo marker that lets a repo-mode decision travel with
 * the codebase itself (subject to the trust gate in resolve.ts/index.ts).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withLock } from "./lock.ts";
import type { GlobalMemoryConfig, RepoMemoryMarker, StoredProjectConfig } from "./types.ts";

const DEFAULT_GLOBAL_CONFIG: GlobalMemoryConfig = { defaultMode: "private", projects: {} };

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
		return {
			defaultMode: parsed.defaultMode ?? DEFAULT_GLOBAL_CONFIG.defaultMode,
			projects: parsed.projects ?? {},
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_GLOBAL_CONFIG, projects: {} };
		throw err;
	}
}

export async function writeGlobalConfig(configPath: string, config: GlobalMemoryConfig): Promise<void> {
	await withLock(`${configPath}.lock`, async () => {
		await atomicWriteJson(configPath, config);
	});
}

export async function setProjectConfig(
	configPath: string,
	projectKey: string,
	projectConfig: StoredProjectConfig,
): Promise<GlobalMemoryConfig> {
	return withLock(`${configPath}.lock`, async () => {
		const current = await readGlobalConfig(configPath);
		const next: GlobalMemoryConfig = {
			...current,
			projects: { ...current.projects, [projectKey]: projectConfig },
		};
		await atomicWriteJson(configPath, next);
		return next;
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
