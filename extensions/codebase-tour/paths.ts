/**
 * Filesystem locations for codebase-tour storage.
 *
 * Layout:
 *   ~/.pi/agent/tours/<projectKey>/active.json      the current tour, if any
 *   ~/.pi/agent/tours/<projectKey>/history/<id>.json  past tours (never deleted)
 *
 * `projectKey` is the same repo-identity key project-memory uses (see
 * resolve.ts in this directory), so a project's tours and its memory land
 * under a matching name without this extension needing its own identity
 * scheme. Storage is private-only for now (no repo/custom modes like
 * project-memory) - a codebase tour is a personal onboarding aid, not
 * something a team needs to share or commit.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function defaultToursDir(): string {
	return join(homedir(), ".pi", "agent", "tours");
}

/** Root directory for one project's tours. `toursDir` is injectable so tests never touch the real home directory. */
export function tourProjectRoot(projectKey: string, toursDir: string = defaultToursDir()): string {
	return join(toursDir, projectKey);
}

export function activeTourPath(root: string): string {
	return join(root, "active.json");
}

export function historyDir(root: string): string {
	return join(root, "history");
}

export function historyTourPath(root: string, tourId: string): string {
	return join(historyDir(root), `${tourId}.json`);
}
