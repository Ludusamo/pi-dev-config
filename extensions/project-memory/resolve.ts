/**
 * Resolves where project memory lives for the current working directory:
 * which mode is in effect, the storage root, and whether it's currently
 * readable/writable (repo mode is trust-gated).
 *
 * Identity for a git repo is its remote repository name - parsed from
 * `origin`'s URL if present, otherwise the first remote git reports - falling
 * back to the repo's folder name when there is no remote. Non-git
 * directories use their folder name. Repos (or clones/forks) that happen to
 * share a name intentionally share memory; that's the point of naming
 * identity after something meaningful instead of a random per-clone key.
 *
 * A worktree with no remote configured falls back to the *main* repo's
 * folder name, not the worktree's own directory name, since `git rev-parse
 * --git-common-dir` for a worktree still points at the main repo's `.git`.
 *
 * Names are sanitized into a safe directory-name key (see
 * `sanitizeProjectKey`). Older installs may still have a durable random
 * `g-...` identity file (`.git/pi-project-memory-id`) or the even older
 * commonDir/path hash key from before that; those are never written anymore,
 * but are read as one-time migration sources so existing memory moves onto
 * the new name key automatically instead of appearing to vanish.
 *
 * Identity resolution never throws: a migration *conflict* is reported via
 * `identityReason` rather than blocking access - by the time it's detected,
 * the current (name-based) key has already been resolved and is in use, so
 * the project keeps working; only the leftover data/config under the old key
 * is what's left unmerged.
 *
 * Security note: because identity is name-based rather than tied to a
 * repo's actual history, any directory whose remote/folder name sanitizes to
 * an existing project key gets that project's key - and private mode has no
 * trust gate (unlike repo mode). An untrusted checkout that happens to share
 * a name with one of your projects (accidentally, or crafted on purpose)
 * can read and write that project's existing private memory with no prompt.
 * Be mindful of this when opening untrusted checkouts, especially ones whose
 * name you don't recognize as new.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { readGlobalConfig, readRepoMarker } from "./config.ts";
import { moveProjectKey, type MoveProjectKeyResult } from "./migrate.ts";
import { defaultProjectsDir, pathExists, privateMemoryRoot } from "./paths.ts";
import type { GlobalMemoryConfig, MemoryMode } from "./types.ts";

export { defaultProjectsDir, privateMemoryRoot } from "./paths.ts";

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

/** Legacy project key scheme: a hash of a path. Kept only as a migration source and for non-git directories' relink guesses. */
export function hashKey(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Legacy durable-random-key scheme, from before identity was name-based. Kept only as a migration source. */
export const PROJECT_KEY_PATTERN = /^g-[0-9a-f]{32}$/;

/** Legacy path-hash scheme produced by {@link hashKey}. Kept only as a migration source. */
export const LEGACY_HASH_PATTERN = /^[0-9a-f]{16}$/;

const IDENTITY_FILE_NAME = "pi-project-memory-id";

function gitIdentityFilePath(gitCommonDir: string): string {
	return join(gitCommonDir, IDENTITY_FILE_NAME);
}

/**
 * Reads a git repo's legacy durable-random identity key, if it has a
 * validly-formed one. Read-only - this scheme is no longer created, only
 * consulted as a migration source (and by the `/memory-relink` candidate
 * helper, where the path being inspected is someone else's old repo).
 */
export async function peekGitIdentity(gitCommonDir: string): Promise<string | undefined> {
	let raw: string;
	try {
		raw = (await readFile(gitIdentityFilePath(gitCommonDir), "utf-8")).trim();
	} catch {
		return undefined;
	}
	return PROJECT_KEY_PATTERN.test(raw) ? raw : undefined;
}

/** True if `s` contains any character outside the ASCII range, used to tell a "plain ASCII placeholder" input (e.g. `"..."`) apart from non-ASCII input that sanitized to nothing. */
function hasNonAsciiChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) > 127) return true;
	}
	return false;
}

/** Soft cap on a sanitized project key's length, so an unusually long repo/folder name can't produce an unwieldy (or filesystem-hostile) directory name. */
const MAX_PROJECT_KEY_LENGTH = 100;

/** Length of the disambiguating content-hash suffix appended in the lossy-sanitization and overlength cases below. */
const KEY_HASH_SUFFIX_LENGTH = 8;

/**
 * Sanitizes an arbitrary name (a remote repo name or a folder name) into a
 * safe, filesystem-friendly project key.
 *
 * The input is Unicode-normalized (NFKC, so e.g. a combining-mark form and
 * its precomposed equivalent sanitize the same way) and lowercased, then any
 * run of characters other than a Unicode letter/number or `._-` is collapsed
 * to a single `-`, and leading/trailing `.`/`-` are trimmed off (guards
 * against e.g. `.` or `..`). Unicode letters and numbers (e.g. CJK,
 * Cyrillic, accented Latin) are preserved rather than stripped, so
 * differently-named non-ASCII repos don't collapse onto the same key.
 *
 * If nothing safe survives, the result falls back to `"project"` - unless
 * the input contained non-ASCII characters (e.g. an emoji-only or
 * CJK-punctuation-only name), in which case a short content-hash suffix is
 * appended instead (`project-<hash>`), so that different such names don't
 * all collide on the exact same generic key. Plain ASCII placeholder input
 * (e.g. `"..."`, `"---"`, `""`) still sanitizes to the bare `"project"`, as
 * before.
 *
 * The result is then capped at `MAX_PROJECT_KEY_LENGTH`: an overlong key is
 * truncated with a content-hash suffix appended, rather than truncated
 * silently (which could otherwise make two long, differently-suffixed names
 * collide once cut to the same prefix).
 *
 * Finally, a result that happens to collide with one of the legacy key
 * shapes (`g-<32 hex>` or a bare 16-hex hash) gets a `-project` suffix
 * appended, so a name key can never be mistaken for - or collide with - a
 * leftover legacy key.
 *
 * A key like `constructor`, `__proto__`, `toString`, or `hasOwnProperty` is
 * left as-is (not suffixed) - those are ordinary, valid project keys. The
 * `projects` config map (see `config.ts`) is null-prototype and looked up
 * with `Object.hasOwn` specifically so such names are never misread as
 * inherited `Object.prototype` members instead of "no entry" for that key.
 */
export function sanitizeProjectKey(raw: string): string {
	const normalized = raw.normalize("NFKC").toLowerCase();
	let key = normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "");

	if (!key) {
		key = hasNonAsciiChar(raw) ? `project-${hashKey(raw).slice(0, KEY_HASH_SUFFIX_LENGTH)}` : "project";
	}

	if (key.length > MAX_PROJECT_KEY_LENGTH) {
		const suffix = hashKey(raw).slice(0, KEY_HASH_SUFFIX_LENGTH);
		// Array.from splits on code points rather than UTF-16 code units, so this can't cut a surrogate pair in half.
		const prefix = Array.from(key).slice(0, MAX_PROJECT_KEY_LENGTH - suffix.length - 1).join("");
		key = `${prefix}-${suffix}`;
	}

	if (PROJECT_KEY_PATTERN.test(key) || LEGACY_HASH_PATTERN.test(key)) key = `${key}-project`;
	return key;
}

interface GitRemote {
	name: string;
	url: string;
}

/** Lists configured remotes (name + url) in the order `git config` reports them. Best-effort: any failure yields no remotes. */
async function listGitRemotes(cwd: string): Promise<GitRemote[]> {
	try {
		const { stdout } = await execFileAsync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd });
		const remotes: GitRemote[] = [];
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) continue;
			const match = /^remote\.(.+)\.url$/.exec(trimmed.slice(0, spaceIdx));
			if (match) remotes.push({ name: match[1], url: trimmed.slice(spaceIdx + 1) });
		}
		return remotes;
	} catch {
		return [];
	}
}

/**
 * Extracts the repo name (last path segment, `.git` suffix stripped) from a
 * remote URL, handling both URL-style and scp-like (`git@host:owner/repo.git`)
 * forms. Backslashes are normalized to forward slashes first (a local
 * Windows-style path used as a remote), and trailing slashes are stripped
 * both before and after removing a `.git` suffix, so `.../repo/`,
 * `.../repo.git/`, and `.../repo/.git` (a bare repo's actual `.git` dir
 * given directly as the remote) all resolve to the same `repo` name.
 */
function repoNameFromRemoteUrl(url: string): string | undefined {
	let u = url.trim().replace(/\\/g, "/").replace(/\/+$/, "");
	if (!u) return undefined;
	if (u.toLowerCase().endsWith(".git")) u = u.slice(0, -4).replace(/\/+$/, "");
	if (!u) return undefined;
	const cut = Math.max(u.lastIndexOf("/"), u.lastIndexOf(":"));
	const name = cut >= 0 ? u.slice(cut + 1) : u;
	return name || undefined;
}

/** The remote repo name to use for identity: `origin` if configured, otherwise the first remote git reports. Undefined when there are no remotes (or none has a usable name). */
async function remoteRepoName(cwd: string): Promise<string | undefined> {
	const remotes = await listGitRemotes(cwd);
	if (remotes.length === 0) return undefined;
	const chosen = remotes.find((r) => r.name === "origin") ?? remotes[0];
	return repoNameFromRemoteUrl(chosen.url);
}

/**
 * The (unsanitized) name identifying a git repo: its remote repo name if it
 * has one, otherwise its main working copy's folder name.
 *
 * For the normal case - `commonDir` is `<repo>/.git` - `dirname` of the git
 * common dir is used rather than `gitInfo.toplevel`, so that a worktree with
 * no remote resolves to the *main* repo's folder name, not its own: the
 * common dir (and thus this name) is shared by every worktree of the same
 * repo, matching how they already share memory.
 *
 * That only holds when `commonDir`'s own basename is literally `.git`,
 * though. For a bare repo or one using a separate/custom git dir (e.g.
 * `git init --separate-git-dir=<elsewhere>`, or a submodule's git dir under
 * `.git/modules/...`), `commonDir` doesn't end in `.git` and its *parent*
 * can be an arbitrary shared location (e.g. a directory of bare repos) -
 * `dirname(commonDir)` there would collide across every repo stored under
 * that same parent. In that case, `gitInfo.toplevel`'s own basename - the
 * actual working-copy folder name - is used instead, since it's still
 * specific to this repo.
 */
async function gitProjectName(gitInfo: GitInfo, cwd: string): Promise<string> {
	const remote = await remoteRepoName(cwd);
	if (remote) return remote;
	if (basename(gitInfo.commonDir) === ".git") return basename(dirname(gitInfo.commonDir));
	return basename(gitInfo.toplevel);
}

async function gitProjectKey(gitInfo: GitInfo, cwd: string): Promise<string> {
	return sanitizeProjectKey(await gitProjectName(gitInfo, cwd));
}

export interface ResolveMemoryOptions {
	cwd: string;
	isProjectTrusted: boolean;
	globalConfigPath: string;
	/**
	 * Whether this resolution may migrate legacy key config/data onto the
	 * current name key. The main agent should pass true; subagents pass false
	 * so a burst of parallel subagents can't race to migrate the same legacy
	 * data concurrently - they compute the same name key (it's derived
	 * deterministically from the remote/folder name, not written state) but
	 * leave migration to the main agent.
	 */
	allowIdentityWrite: boolean;
	/** Injectable so tests never touch the real ~/.pi/agent/memory/projects. Defaults to that real root. */
	projectsDir?: string;
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
	/**
	 * Set when legacy-key migration left something unmerged under an old key
	 * even though the current name key resolved fine (a conflict), or when
	 * migration itself failed (e.g. a read-only projects directory). Can
	 * describe more than one such issue (joined one per line) when a repo has
	 * leftovers under multiple legacy keys at once. Surfaced by `/memory-mode`
	 * for visibility; never implies memory is unavailable by itself.
	 */
	identityReason?: string;
}

/**
 * Explains a legacy-key migration's leftover conflicts, if any. Config and
 * directory conflicts need different advice: `/memory-relink` can review and
 * (once the user manually resolves the on-disk clash) finish merging a
 * directory conflict, but it can never clear a config-only conflict by
 * itself - `migrateProjectConfigKey` never picks a winner between two
 * existing config entries, so re-running `/memory-relink` alone would hit
 * the exact same conflict again. `--drop-old-config` is the only thing that
 * actually resolves that case.
 */
function describeMigrationConflict(result: MoveProjectKeyResult, oldKey: string): string | undefined {
	const dirConflict = result.dir === "conflict";
	const configConflict = result.config === "conflict";
	if (!dirConflict && !configConflict) return undefined;

	if (dirConflict) {
		const suffix = configConflict
			? ` (its config entry also conflicts and won't clear this way - add --drop-old-config once you're sure this project's current config is the one to keep)`
			: "";
		return `legacy memory at the old key wasn't fully merged (conflict); run /memory-relink ${oldKey} to review it${suffix}`;
	}

	return `legacy config at the old key conflicts with this project's existing config and was left in place; re-running /memory-relink alone won't clear this - run /memory-relink ${oldKey} --drop-old-config to discard the old entry once you're sure this project's current config is the one to keep`;
}

/**
 * Migrates any of `oldKeys` that still have config or a private dir onto
 * `newKey`, one at a time. `globalConfig.projects` is refreshed in place
 * after each migration that touches config, so the caller's already-read
 * config reflects the move. Returns every conflict/failure description
 * encountered, joined one per line (not just the most recent one - e.g. a
 * repo can have leftovers under *both* a legacy `g-...` identity and a
 * legacy commonDir hash, and a caller only shown the last would silently
 * miss the other) - migration is best-effort and never throws.
 */
async function migrateLegacyKeys(params: {
	globalConfigPath: string;
	projectsDir: string;
	newKey: string;
	oldKeys: string[];
	globalConfig: GlobalMemoryConfig;
}): Promise<string | undefined> {
	const { globalConfigPath, projectsDir, newKey, globalConfig } = params;
	const reasons: string[] = [];
	for (const oldKey of params.oldKeys) {
		if (oldKey === newKey) continue;
		try {
			const hasLegacyConfig = Object.hasOwn(globalConfig.projects, oldKey);
			const hasLegacyDir = await pathExists(privateMemoryRoot(oldKey, projectsDir));
			if (!hasLegacyConfig && !hasLegacyDir) continue;

			const result = await moveProjectKey({ configPath: globalConfigPath, projectsDir, oldKey, newKey });
			if (hasLegacyConfig) {
				const refreshed = await readGlobalConfig(globalConfigPath);
				globalConfig.projects = refreshed.projects;
			}
			const conflictReason = describeMigrationConflict(result, oldKey);
			if (conflictReason) reasons.push(conflictReason);
		} catch (err) {
			// Migration is best-effort - a failure here (e.g. a read-only
			// projects directory) must not break memory for the name key that
			// already resolved successfully.
			reasons.push(`legacy memory migration failed (${(err as Error).message}); run /memory-relink ${oldKey} to retry`);
		}
	}
	return reasons.length > 0 ? reasons.join("\n") : undefined;
}

export async function resolveMemory(options: ResolveMemoryOptions): Promise<ResolvedMemory> {
	const { cwd, isProjectTrusted, globalConfigPath, allowIdentityWrite } = options;
	const projectsDir = options.projectsDir ?? defaultProjectsDir();
	const gitInfo = await getGitInfo(cwd);

	const [globalConfig, repoMarker] = await Promise.all([
		readGlobalConfig(globalConfigPath),
		gitInfo ? readRepoMarker(gitInfo.toplevel) : Promise.resolve(undefined),
	]);

	let projectKey: string;
	let identityReason: string | undefined;

	if (gitInfo) {
		projectKey = await gitProjectKey(gitInfo, cwd);

		if (allowIdentityWrite) {
			const legacyGKey = await peekGitIdentity(gitInfo.commonDir);
			const oldKeys = legacyGKey ? [legacyGKey, hashKey(gitInfo.commonDir)] : [hashKey(gitInfo.commonDir)];
			identityReason = await migrateLegacyKeys({ globalConfigPath, projectsDir, newKey: projectKey, oldKeys, globalConfig });
		}
	} else {
		projectKey = sanitizeProjectKey(basename(resolvePath(cwd)));

		if (allowIdentityWrite) {
			identityReason = await migrateLegacyKeys({
				globalConfigPath,
				projectsDir,
				newKey: projectKey,
				oldKeys: [hashKey(resolvePath(cwd))],
				globalConfig,
			});
		}
	}

	const stored = globalConfig.projects[projectKey];
	const mode: MemoryMode = stored?.mode ?? (repoMarker ? "repo" : globalConfig.defaultMode);

	if (mode === "off") {
		return { mode, readable: false, writable: false, projectKey, identityReason };
	}

	if (mode === "repo") {
		if (!gitInfo) {
			return {
				mode,
				readable: false,
				writable: false,
				projectKey,
				reason: "repo mode requires a git repository",
				identityReason,
			};
		}
		if (!isProjectTrusted) {
			return {
				mode,
				readable: false,
				writable: false,
				projectKey,
				reason: "project is not trusted; repo memory is disabled until the project is trusted",
				identityReason,
			};
		}
		return {
			mode,
			root: join(gitInfo.toplevel, ".pi", "memory"),
			readable: true,
			writable: true,
			projectKey,
			identityReason,
		};
	}

	if (mode === "custom") {
		if (!stored?.customPath) {
			return {
				mode,
				readable: false,
				writable: false,
				projectKey,
				reason: "custom mode has no configured path",
				identityReason,
			};
		}
		return { mode, root: resolvePath(stored.customPath), readable: true, writable: true, projectKey, identityReason };
	}

	return {
		mode: "private",
		root: privateMemoryRoot(projectKey, projectsDir),
		readable: true,
		writable: true,
		projectKey,
		identityReason,
	};
}

/**
 * Prefix that forces `relinkKeyCandidates` to treat its argument as a
 * literal project key rather than (possibly) a path - `/memory-relink
 * key:<name>` always looks up `<name>` verbatim, with no path resolution or
 * sanitization guessing at all. This is the reliable way to target a key
 * when a same-named local file or directory would otherwise get in the way
 * of path-based guessing (see the "looks like a bare name" case below).
 */
const RELINK_KEY_PREFIX = "key:";

/**
 * True when `key` is safe to use verbatim as a project key: it's exactly
 * what `sanitizeProjectKey` would have produced for itself (so it can't be
 * empty, contain `/` or `\`, or contain a `.`/`..` path segment - any of
 * those would make it sanitize to something else), or it's one of the
 * legacy key shapes that are never written to config/disk with a path
 * separator in them either. Used to validate `key:<name>` - the one
 * `relinkKeyCandidates` input that skips path resolution entirely - before
 * it's ever joined onto `projectsDir` and used to move/delete a directory.
 */
function isLiteralKeySafe(key: string): boolean {
	if (!key) return false;
	if (PROJECT_KEY_PATTERN.test(key) || LEGACY_HASH_PATTERN.test(key)) return true;
	return sanitizeProjectKey(key) === key;
}

/**
 * Candidate project keys for `/memory-relink <oldPathOrKey>` - the current
 * (live) name key a same-named project would have today, as well as its
 * possible legacy key shapes - tried in priority order:
 * 1. If `oldPathOrKey` starts with `key:`, the rest of it, taken as a
 *    literal key with no path resolution attempted at all - but only if
 *    it's already a safe, well-formed key (see `isLiteralKeySafe`);
 *    otherwise no candidates are returned at all, rather than sanitizing it
 *    into *some* key or guessing what the caller meant. `key:` exists to
 *    name a key exactly, with no ambiguity - an unsafe literal (empty, or
 *    containing `/`, `\`, or a `.`/`..` segment, e.g. `key:../../etc`) is
 *    rejected outright instead of silently being coerced into a path that
 *    could resolve outside the projects directory.
 * 2. If `oldPathOrKey` is already a bare key (a legacy `g-...` identity or a
 *    legacy 16-hex path hash), that key as-is.
 * 3. If `oldPathOrKey` has no path separator (it "looks like a bare name"
 *    rather than a path - e.g. a project name someone typed by hand), its
 *    own sanitized form is tried first, *before* any path-based guess below.
 *    This is what makes a literal name key reliably win even when a
 *    same-named local file or directory happens to exist relative to `cwd` -
 *    without this, `oldPathOrKey` would only ever be interpreted as a path.
 * 4. If `oldPath` still exists and is a git repo, its current name key (the
 *    same thing `resolveMemory` would compute for it today), then its legacy
 *    `g-...` identity if it still has one, then its legacy commonDir hash.
 * 5. If `oldPath` isn't (or is no longer) a git repo - for example its root
 *    was deleted or moved away - the sanitized folder-name key it would get
 *    today, plus a best-effort guess at the legacy commonDir hash a plain
 *    (non-worktree) repo at that path would have had, plus the original
 *    path-hash scheme used for non-git directories.
 *
 * Duplicate candidates (e.g. step 3's guess matching step 4/5's) are
 * collapsed, keeping the first (highest-priority) occurrence.
 *
 * Relative paths are resolved against `cwd` (the caller's working directory,
 * not `process.cwd()`).
 */
export async function relinkKeyCandidates(oldPathOrKey: string, cwd: string): Promise<string[]> {
	if (oldPathOrKey.startsWith(RELINK_KEY_PREFIX)) {
		const literal = oldPathOrKey.slice(RELINK_KEY_PREFIX.length);
		return isLiteralKeySafe(literal) ? [literal] : [];
	}
	if (PROJECT_KEY_PATTERN.test(oldPathOrKey) || LEGACY_HASH_PATTERN.test(oldPathOrKey)) return [oldPathOrKey];

	const candidates: string[] = [];
	const looksLikePath = /[/\\]/.test(oldPathOrKey) || oldPathOrKey === "." || oldPathOrKey === "..";
	if (!looksLikePath) candidates.push(sanitizeProjectKey(oldPathOrKey));

	const oldPath = resolvePath(cwd, oldPathOrKey);
	const gitInfo = await getGitInfo(oldPath);
	if (gitInfo) {
		candidates.push(await gitProjectKey(gitInfo, oldPath));
		const identity = await peekGitIdentity(gitInfo.commonDir);
		if (identity) candidates.push(identity);
		candidates.push(hashKey(gitInfo.commonDir));
	} else {
		candidates.push(sanitizeProjectKey(basename(oldPath)), hashKey(join(oldPath, ".git")), hashKey(oldPath));
	}

	return [...new Set(candidates)];
}
