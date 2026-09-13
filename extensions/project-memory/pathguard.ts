/**
 * Path/command helpers used to keep pi-runtime subagents (PI_SUBAGENT=1
 * child `pi` processes) from touching the memory store through the built-in
 * write/edit/bash tools. Claude-runtime subagents never reach this code at
 * all - they run outside the pi extension system entirely, have no memory
 * tools, and aren't covered by this guard.
 *
 * The write/edit block is fully enforced. The bash check is best-effort,
 * not a sandbox: a subagent that can run bash can still reach the memory
 * store through indirection the string checks here don't catch
 * (environment-variable expansion, `cd` plus a relative path, symlinks
 * created mid-command, etc). See the README/SKILL for the documented
 * limitation.
 */

import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/** Mirrors the ~ and @ stripping pi's built-in write/edit/read tools apply before resolving a path. */
export function expandPathPrefix(rawPath: string): string {
	let p = rawPath;
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return `${homedir()}${p.slice(1)}`;
	return p;
}

/**
 * Resolves the real (symlink-free) path of the closest existing ancestor and
 * rejoins the remaining, possibly-nonexistent tail - so a symlinked parent
 * directory can't be used to disguise a target that doesn't exist yet (e.g.
 * a new file about to be written).
 */
export function realpathClosestAncestor(path: string): string {
	let current = path;
	let suffix = "";
	for (;;) {
		try {
			const real = realpathSync(current);
			return suffix ? join(real, suffix) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			suffix = suffix ? join(basename(current), suffix) : basename(current);
			current = parent;
		}
	}
}

/** Resolves a tool-supplied path the same way pi's write/edit tools would, then canonicalizes it. */
export function resolveCandidatePath(rawPath: string, cwd: string): string {
	const expanded = expandPathPrefix(rawPath);
	const resolved = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(cwd, expanded);
	return realpathClosestAncestor(resolved);
}

export function resolveGuardedRoot(root: string): string {
	return realpathClosestAncestor(resolvePath(root));
}

export function isWithinRoot(candidate: string, resolvedRoot: string): boolean {
	return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + sep);
}

/**
 * Best-effort: true if a bash command literally mentions the memory root
 * path (in either its given or canonicalized form). Does not attempt to
 * parse the command, so it can be evaded by obfuscation - it only stops
 * accidental or unsophisticated access, not a determined bypass.
 */
export function commandMentionsPath(command: string, resolvedRoot: string, rawRoot: string): boolean {
	return command.includes(resolvedRoot) || (rawRoot !== resolvedRoot && command.includes(rawRoot));
}
