/**
 * Filesystem locations for project memory that both resolve.ts and
 * migrate.ts need, split out to a leaf module so the two don't have to
 * import each other.
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

export function defaultProjectsDir(): string {
	return join(homedir(), ".pi", "agent", "memory", "projects");
}

/** Root directory for a project's private memory. `projectsDir` is injectable so tests never touch the real home directory. */
export function privateMemoryRoot(projectKey: string, projectsDir: string = defaultProjectsDir()): string {
	return join(projectsDir, projectKey);
}

/**
 * Defense-in-depth check: true only when `privateMemoryRoot(projectKey,
 * projectsDir)` resolves to a direct child of `projectsDir` - not equal to
 * it, not outside it, and not nested more than one level deep. A
 * well-formed key from `sanitizeProjectKey` (or one of the legacy key
 * shapes) can never actually fail this, but any code that's about to
 * move/merge/delete a private-memory directory keyed by a caller-supplied
 * string (e.g. `/memory-relink key:<name>`) should still check this
 * immediately before touching disk, rather than relying solely on upstream
 * validation of that string.
 */
export function isProjectKeyDirContained(projectKey: string, projectsDir: string = defaultProjectsDir()): boolean {
	const root = resolvePath(projectsDir);
	const dir = resolvePath(privateMemoryRoot(projectKey, projectsDir));
	const rel = relative(root, dir);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.includes(sep);
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
