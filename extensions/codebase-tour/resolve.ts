/**
 * Resolves the project identity key used to key tour storage - the same
 * repo-identity scheme project-memory uses (remote repo name, falling back
 * to the folder name), so a project's tours land under the same key its
 * memory does. This intentionally imports project-memory's resolve module
 * rather than re-deriving the key itself, so the trickier edge cases
 * (worktrees, bare repos, custom git dirs) can't drift between the two
 * extensions - see resolve.ts in extensions/project-memory for the details.
 */

import { basename, resolve as resolvePath } from "node:path";
import { getGitInfo, gitProjectKey, sanitizeProjectKey } from "../project-memory/resolve.ts";

export async function resolveTourProjectKey(cwd: string): Promise<string> {
	const gitInfo = await getGitInfo(cwd);
	if (gitInfo) return gitProjectKey(gitInfo, cwd);
	return sanitizeProjectKey(basename(resolvePath(cwd)));
}

/**
 * Resolves the root that a tour anchor's `file` (documented as "relative to
 * the project root") should be read and confined against. Anchors are
 * recorded once (typically by `tour_plan`) but can be read back from a
 * session resumed in a different subdirectory of the same repo - resolving
 * against the git toplevel rather than the current `cwd` keeps that reading
 * consistent no matter where in the repo the session happens to be. Falls
 * back to `cwd` itself outside a git repo, same as before this existed.
 * Never throws: `getGitInfo` already treats a failed git lookup as "not a
 * git repo" rather than an error.
 */
export async function resolveAnchorRoot(cwd: string): Promise<string> {
	const gitInfo = await getGitInfo(cwd);
	return gitInfo?.toplevel ?? cwd;
}
