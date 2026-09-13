/**
 * Moves a project's private memory (config entry + on-disk private dir) from
 * one project key to another. Shared by the automatic legacy-hash-key
 * migration in resolve.ts and the manual `/memory-relink` escape hatch in
 * index.ts.
 *
 * Idempotent and conflict-safe:
 * - The config entry is never deleted or overwritten on conflict - if
 *   `newKey` already has a config entry, `oldKey`'s is left in place (see
 *   `migrateProjectConfigKey`).
 * - The private directory is merged entry-by-entry rather than moved
 *   wholesale, so files already present under `newKey` (or a repeat call
 *   after a partial merge) are never overwritten. Anything that can't be
 *   merged because both sides have a file at the same relative path is left
 *   in place under `oldKey` and reported back as a conflict - never deleted,
 *   never silently dropped.
 * - The actual move is done while holding both directories' own store locks
 *   (the same `.lock` that `writeEntry`/`updateEntry` take), not just the
 *   migration lock, so a concurrent store write into either directory can't
 *   land between a conflict check and the rename that acts on it and get
 *   silently clobbered or orphaned.
 */

import { mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ConfigMigrationStatus, migrateProjectConfigKey } from "./config.ts";
import { withLock } from "./lock.ts";
import { isProjectKeyDirContained, pathExists, privateMemoryRoot } from "./paths.ts";
import { lockDir } from "./store.ts";

/** Transient lock directories are never part of the data being merged. */
const SKIP_ENTRY_NAMES = new Set([".lock"]);

async function isErrnoCode(err: unknown, code: string): Promise<boolean> {
	return (err as NodeJS.ErrnoException)?.code === code;
}

/**
 * Recursively moves everything under `oldDir` into `newDir`, skipping (and
 * recording) any relative path that already exists on both sides instead of
 * overwriting it. Directories are merged into each other; only conflicting
 * leaf files/dirs are left behind.
 */
async function mergeDirInto(oldDir: string, newDir: string, conflicts: string[], relBase: string): Promise<void> {
	const entries = await readdir(oldDir, { withFileTypes: true });
	for (const entry of entries) {
		if (SKIP_ENTRY_NAMES.has(entry.name)) continue;
		const oldPath = join(oldDir, entry.name);
		const newPath = join(newDir, entry.name);
		const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			if (!(await pathExists(newPath))) {
				await mkdir(dirname(newPath), { recursive: true });
				try {
					await rename(oldPath, newPath);
					continue;
				} catch (err) {
					if (!(await isErrnoCode(err, "ENOTEMPTY")) && !(await isErrnoCode(err, "EEXIST"))) throw err;
					// Someone else created newPath concurrently; fall through to a per-entry merge.
				}
			}
			await mkdir(newPath, { recursive: true });
			await mergeDirInto(oldPath, newPath, conflicts, relPath);
			const remaining = await readdir(oldPath);
			if (remaining.length === 0) await rm(oldPath, { recursive: true }).catch(() => {});
			continue;
		}

		if (await pathExists(newPath)) {
			conflicts.push(relPath);
			continue;
		}
		await mkdir(dirname(newPath), { recursive: true });
		try {
			await rename(oldPath, newPath);
		} catch (err) {
			if (await isErrnoCode(err, "EEXIST")) {
				conflicts.push(relPath);
				continue;
			}
			throw err;
		}
	}
}

export type DirMigrationStatus = "moved" | "merged" | "conflict" | "none";

export interface DirMigrationResult {
	status: DirMigrationStatus;
	/** Relative paths left behind under `oldDir` because `newDir` already had something there. */
	conflicts: string[];
}

async function mergePrivateDirs(oldDir: string, newDir: string): Promise<DirMigrationResult> {
	if (!(await pathExists(oldDir))) return { status: "none", conflicts: [] };

	return withLock(`${newDir}.migrate.lock`, async () => {
		if (!(await pathExists(oldDir))) return { status: "none", conflicts: [] };

		const hadNewDir = await pathExists(newDir);
		await mkdir(newDir, { recursive: true });
		const conflicts: string[] = [];

		// Hold both directories' store locks for the actual move, in a fixed
		// (sorted) order so a migration running in the opposite direction
		// elsewhere can never deadlock against this one.
		const [firstLock, secondLock] = [lockDir(oldDir), lockDir(newDir)].sort();
		await withLock(firstLock, () =>
			withLock(secondLock, () => mergeDirInto(oldDir, newDir, conflicts, "")),
		);

		// Checked (and removed) only after both store locks above are released,
		// so this can't delete a `.lock` directory a concurrent writer still
		// holds. Plain `rmdir` - rather than a readdir-then-`rm -rf` - is
		// itself an atomic emptiness check: it only succeeds if `oldDir` is
		// truly empty at that instant (a leftover/stale `.lock` from a past
		// crash is gone by now, since acquiring the lock above reclaimed it),
		// and harmlessly fails otherwise instead of racing a concurrent writer.
		await rmdir(oldDir).catch(() => {});

		if (conflicts.length > 0) return { status: "conflict", conflicts };
		return { status: hadNewDir ? "merged" : "moved", conflicts: [] };
	});
}

export interface MoveProjectKeyOptions {
	configPath: string;
	projectsDir: string;
	oldKey: string;
	newKey: string;
}

export interface MoveProjectKeyResult {
	config: ConfigMigrationStatus;
	dir: DirMigrationStatus;
	/** Relative paths (within the private dir) left under `oldKey` due to a naming conflict. */
	dirConflicts: string[];
}

export async function moveProjectKey(options: MoveProjectKeyOptions): Promise<MoveProjectKeyResult> {
	const { configPath, projectsDir, oldKey, newKey } = options;
	if (oldKey === newKey) return { config: "same-key", dir: "none", dirConflicts: [] };

	// Defense-in-depth: both keys' private dirs must resolve to a direct
	// child of `projectsDir` before anything below is allowed to move, merge,
	// or delete a directory keyed by either of them. Callers are expected to
	// have already validated their keys (e.g. `relinkKeyCandidates` rejects
	// an unsafe `key:<name>` outright); this is a last-resort backstop, not
	// the primary check.
	if (!isProjectKeyDirContained(oldKey, projectsDir) || !isProjectKeyDirContained(newKey, projectsDir)) {
		throw new Error(`refusing to move project memory: key resolves outside the projects directory`);
	}

	const configResult = await migrateProjectConfigKey(configPath, oldKey, newKey);

	const oldDir = privateMemoryRoot(oldKey, projectsDir);
	const newDir = privateMemoryRoot(newKey, projectsDir);
	const dirResult = await mergePrivateDirs(oldDir, newDir);

	return { config: configResult.status, dir: dirResult.status, dirConflicts: dirResult.conflicts };
}
