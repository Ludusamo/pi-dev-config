/**
 * Resolves where project memory lives for the current working directory:
 * which mode is in effect, the storage root, and whether it's currently
 * readable/writable (repo mode is trust-gated).
 *
 * Identity is keyed off git's *common* dir (`git rev-parse --git-common-dir`),
 * which is shared by every worktree of the same repository but differs
 * between separate clones - so private/custom memory for one repo is shared
 * across its worktrees without being shared across unrelated checkouts.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { readGlobalConfig, readRepoMarker } from "./config.ts";
import type { MemoryMode } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface GitInfo {
	/** Absolute path to the shared .git directory (identical across worktrees of one repo). */
	commonDir: string;
	/** Absolute path to this worktree's own working directory. */
	toplevel: string;
}

export async function getGitInfo(cwd: string): Promise<GitInfo | undefined> {
	try {
		const [common, top] = await Promise.all([
			execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd }),
			execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd }),
		]);
		return {
			commonDir: resolvePath(cwd, common.stdout.trim()),
			toplevel: resolvePath(cwd, top.stdout.trim()),
		};
	} catch {
		return undefined;
	}
}

export function hashKey(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function privateMemoryRoot(projectKey: string): string {
	return join(homedir(), ".pi", "agent", "memory", "projects", projectKey);
}

export interface ResolveMemoryOptions {
	cwd: string;
	isProjectTrusted: boolean;
	globalConfigPath: string;
}

export interface ResolvedMemory {
	mode: MemoryMode;
	/** Absolute storage root. Undefined when memory is disabled or misconfigured. */
	root?: string;
	readable: boolean;
	writable: boolean;
	/** Stable identity for this repo (or bare directory) used as the config/private-root key. */
	projectKey: string;
	/** Human-readable explanation when readable/writable is false. */
	reason?: string;
}

export async function resolveMemory(options: ResolveMemoryOptions): Promise<ResolvedMemory> {
	const { cwd, isProjectTrusted, globalConfigPath } = options;
	const gitInfo = await getGitInfo(cwd);
	const projectKey = hashKey(gitInfo ? gitInfo.commonDir : resolvePath(cwd));

	const [globalConfig, repoMarker] = await Promise.all([
		readGlobalConfig(globalConfigPath),
		gitInfo ? readRepoMarker(gitInfo.toplevel) : Promise.resolve(undefined),
	]);

	const stored = globalConfig.projects[projectKey];
	const mode: MemoryMode = stored?.mode ?? (repoMarker ? "repo" : globalConfig.defaultMode);

	if (mode === "off") {
		return { mode, readable: false, writable: false, projectKey };
	}

	if (mode === "repo") {
		if (!gitInfo) {
			return { mode, readable: false, writable: false, projectKey, reason: "repo mode requires a git repository" };
		}
		if (!isProjectTrusted) {
			return {
				mode,
				readable: false,
				writable: false,
				projectKey,
				reason: "project is not trusted; repo memory is disabled until the project is trusted",
			};
		}
		return { mode, root: join(gitInfo.toplevel, ".pi", "memory"), readable: true, writable: true, projectKey };
	}

	if (mode === "custom") {
		if (!stored?.customPath) {
			return { mode, readable: false, writable: false, projectKey, reason: "custom mode has no configured path" };
		}
		return { mode, root: resolvePath(stored.customPath), readable: true, writable: true, projectKey };
	}

	return {
		mode: "private",
		root: privateMemoryRoot(projectKey),
		readable: true,
		writable: true,
		projectKey,
	};
}
