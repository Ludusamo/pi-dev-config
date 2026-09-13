import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { setProjectConfig } from "../config.ts";
import {
	getGitInfo,
	hashKey,
	LEGACY_HASH_PATTERN,
	PROJECT_KEY_PATTERN,
	relinkKeyCandidates,
	resolveMemory,
	sanitizeProjectKey,
} from "../resolve.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd });
	return result.stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
	await git(dir, ["init", "-q"]);
	await git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"]);
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-resolve-test-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface Harness {
	globalConfigPath: string;
	projectsDir: string;
}

function harness(base: string): Harness {
	return { globalConfigPath: join(base, "global-config.json"), projectsDir: join(base, "projects") };
}

async function resolvePrivate(dir: string, h: Harness, allowIdentityWrite = true) {
	return resolveMemory({
		cwd: dir,
		isProjectTrusted: false,
		globalConfigPath: h.globalConfigPath,
		allowIdentityWrite,
		projectsDir: h.projectsDir,
	});
}

test("getGitInfo returns undefined outside a git repository", async () => {
	await withTmpDir(async (dir) => {
		assert.equal(await getGitInfo(dir), undefined);
	});
});

// --- sanitizeProjectKey ---

test("sanitizeProjectKey lowercases and collapses unsafe character runs to a single dash", () => {
	assert.equal(sanitizeProjectKey("My Repo!!"), "my-repo");
	assert.equal(sanitizeProjectKey("foo_bar baz"), "foo_bar-baz");
	assert.equal(sanitizeProjectKey("Owner/Repo"), "owner-repo");
});

test("sanitizeProjectKey trims leading/trailing dots and dashes", () => {
	assert.equal(sanitizeProjectKey("--.foo.--"), "foo");
	assert.equal(sanitizeProjectKey(".hidden-repo"), "hidden-repo");
});

test("sanitizeProjectKey falls back to a fixed name when nothing safe is left", () => {
	assert.equal(sanitizeProjectKey("..."), "project");
	assert.equal(sanitizeProjectKey(""), "project");
	assert.equal(sanitizeProjectKey("---"), "project");
});

test("sanitizeProjectKey avoids colliding with legacy key shapes", () => {
	const gLike = `g-${"a".repeat(32)}`;
	assert.match(gLike, PROJECT_KEY_PATTERN);
	assert.equal(sanitizeProjectKey(gLike), `${gLike}-project`);

	const hashLike = "0123456789abcdef";
	assert.match(hashLike, LEGACY_HASH_PATTERN);
	assert.equal(sanitizeProjectKey(hashLike), `${hashLike}-project`);
});

test("sanitizeProjectKey leaves names that shadow Object.prototype members as valid, ordinary keys", () => {
	assert.equal(sanitizeProjectKey("constructor"), "constructor");
	assert.equal(sanitizeProjectKey("Constructor"), "constructor");
	assert.equal(sanitizeProjectKey("__proto__"), "__proto__");
	assert.equal(sanitizeProjectKey("hasOwnProperty"), "hasownproperty");
	assert.equal(sanitizeProjectKey("toString"), "tostring");
});

test("sanitizeProjectKey preserves Unicode letters/numbers instead of stripping them to dashes", () => {
	assert.equal(sanitizeProjectKey("日本語プロジェクト"), "日本語プロジェクト");
	assert.equal(sanitizeProjectKey("Мой-Проект"), "мой-проект");
	assert.equal(sanitizeProjectKey("café"), "café");
	// Different non-ASCII names stay distinct instead of colliding on a shared fallback.
	assert.notEqual(sanitizeProjectKey("日本語プロジェクトA"), sanitizeProjectKey("日本語プロジェクトB"));
});

test("sanitizeProjectKey normalizes combining-mark and precomposed forms of the same text to the same key", () => {
	const precomposed = "caf\u00e9"; // "cafe" + precomposed e-acute (single code point)
	const combining = "cafe\u0301"; // "cafe" + combining acute accent (two code points)
	assert.notEqual(precomposed, combining);
	assert.equal(sanitizeProjectKey(precomposed), sanitizeProjectKey(combining));
});

test("sanitizeProjectKey appends a content-hash suffix (rather than colliding on a bare fallback) when non-ASCII input sanitizes to nothing", () => {
	const rocket = sanitizeProjectKey("🚀🚀🚀");
	const wave = sanitizeProjectKey("🌊🌊🌊");
	assert.match(rocket, /^project-[0-9a-f]{8}$/);
	assert.match(wave, /^project-[0-9a-f]{8}$/);
	assert.notEqual(rocket, wave);
});

test("sanitizeProjectKey still falls back to the bare 'project' key for plain ASCII placeholder input", () => {
	// Confirmed behavior: pure-ASCII garbage collapses to "project" with no hash suffix, unlike the non-ASCII case above.
	assert.equal(sanitizeProjectKey("..."), "project");
	assert.equal(sanitizeProjectKey(""), "project");
	assert.equal(sanitizeProjectKey("---"), "project");
	assert.equal(sanitizeProjectKey("???"), "project");
});

test("sanitizeProjectKey caps overlong keys at a reasonable length with a disambiguating hash suffix", () => {
	const longA = `${"a".repeat(200)}-suffix-one`;
	const longB = `${"a".repeat(200)}-suffix-two`;
	const keyA = sanitizeProjectKey(longA);
	const keyB = sanitizeProjectKey(longB);
	assert.ok(keyA.length <= 100);
	assert.ok(keyB.length <= 100);
	// Two long names that only differ near the end (i.e. past a naive truncation point) must not collide.
	assert.notEqual(keyA, keyB);
});

// --- non-git fallback ---

test("non-git directories are keyed by their sanitized folder name", async () => {
	await withTmpDir(async (base) => {
		const dir = join(base, "My Cool Project");
		await mkdir(dir);
		const h = harness(base);
		const resolved = await resolvePrivate(dir, h);
		assert.equal(resolved.projectKey, sanitizeProjectKey(basename(dir)));
	});
});

test("a directory literally named \"constructor\" resolves and reads/writes its own config correctly, not an inherited Object.prototype member", async () => {
	await withTmpDir(async (base) => {
		const dir = join(base, "constructor");
		await mkdir(dir);
		const h = harness(base);
		const resolved = await resolvePrivate(dir, h);
		assert.equal(resolved.projectKey, "constructor");
		assert.equal(resolved.mode, "private");
		assert.equal(resolved.readable, true);

		await setProjectConfig(h.globalConfigPath, "constructor", { mode: "off" });
		const afterOff = await resolvePrivate(dir, h);
		assert.equal(afterOff.mode, "off");
		assert.equal(afterOff.readable, false);
	});
});

test("legacy path-hash config and private dir are migrated onto the new folder-name key for non-git directories", async () => {
	await withTmpDir(async (base) => {
		const dir = join(base, "legacy-folder");
		await mkdir(dir);
		const h = harness(base);
		const legacyKey = hashKey(dir);

		await setProjectConfig(h.globalConfigPath, legacyKey, { mode: "private" });
		await mkdir(join(h.projectsDir, legacyKey), { recursive: true });
		await writeFile(join(h.projectsDir, legacyKey, "marker.txt"), "legacy data", "utf-8");

		const resolved = await resolvePrivate(dir, h);
		const newKey = sanitizeProjectKey(basename(dir));
		assert.equal(resolved.projectKey, newKey);

		const configRaw = JSON.parse(await readFile(h.globalConfigPath, "utf-8"));
		assert.equal(configRaw.projects[legacyKey], undefined);
		assert.deepEqual(configRaw.projects[newKey], { mode: "private" });

		const movedMarker = await readFile(join(h.projectsDir, newKey, "marker.txt"), "utf-8");
		assert.equal(movedMarker, "legacy data");
	});
});

// --- git repos: remote-based naming ---

test("a git repo with an origin remote is keyed by the remote's repo name", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "some-folder-name");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/some-owner/actual-repo-name.git"]);

		const h = harness(base);
		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, "actual-repo-name");
	});
});

test("remote URL parsing handles scp-like ssh syntax, missing .git suffix, and trailing slashes", async () => {
	const cases: Array<[string, string]> = [
		["git@github.com:owner/repo-name.git", "repo-name"],
		["https://github.com/owner/repo-name", "repo-name"],
		["https://github.com/owner/repo-name/", "repo-name"],
		["ssh://git@example.com/owner/repo-name.git", "repo-name"],
		["git@example.com:repo-name.git", "repo-name"],
		// A bare repo's own .git dir given directly as the remote.
		["https://example.com/owner/repo-name/.git", "repo-name"],
		// Multiple trailing slashes, and a trailing slash after the .git suffix.
		["https://github.com/owner/repo-name//", "repo-name"],
		["https://github.com/owner/repo-name.git/", "repo-name"],
		// A local Windows-style path (backslashes) used as a remote.
		["C:\\repos\\repo-name.git", "repo-name"],
		["C:\\repos\\repo-name", "repo-name"],
	];

	for (const [url, expectedName] of cases) {
		await withTmpDir(async (base) => {
			const repo = join(base, "unrelated-folder");
			await mkdir(repo);
			await initRepo(repo);
			await git(repo, ["remote", "add", "origin", url]);

			const h = harness(base);
			const resolved = await resolvePrivate(repo, h);
			assert.equal(resolved.projectKey, expectedName, `for remote url ${url}`);
		});
	}
});

test("origin is preferred over other remotes", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "upstream", "https://github.com/other/upstream-name.git"]);
		await git(repo, ["remote", "add", "origin", "https://github.com/mine/origin-name.git"]);

		const h = harness(base);
		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, "origin-name");
	});
});

test("the first remote is used when there is no origin", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "upstream", "https://github.com/other/upstream-name.git"]);

		const h = harness(base);
		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, "upstream-name");
	});
});

test("a git repo with no remote falls back to its folder name", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "no-remote-repo");
		await mkdir(repo);
		await initRepo(repo);

		const h = harness(base);
		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, sanitizeProjectKey(basename(repo)));
	});
});

test("two unrelated repos that share a remote repo name intentionally share the same key and private root", async () => {
	await withTmpDir(async (base) => {
		const repoA = join(base, "repo-a");
		const repoB = join(base, "repo-b");
		await mkdir(repoA);
		await mkdir(repoB);
		await initRepo(repoA);
		await initRepo(repoB);
		await git(repoA, ["remote", "add", "origin", "https://github.com/owner-a/shared-name.git"]);
		await git(repoB, ["remote", "add", "origin", "https://github.com/owner-b/shared-name.git"]);

		const h = harness(base);
		const resolvedA = await resolvePrivate(repoA, h);
		const resolvedB = await resolvePrivate(repoB, h);

		assert.equal(resolvedA.projectKey, "shared-name");
		assert.equal(resolvedA.projectKey, resolvedB.projectKey);
		assert.equal(resolvedA.root, resolvedB.root);
	});
});

test("a separate clone of the same repo shares the key when it has the same remote name", async () => {
	await withTmpDir(async (base) => {
		const original = join(base, "original");
		await mkdir(original);
		await initRepo(original);
		await git(original, ["remote", "add", "origin", "https://github.com/owner/some-repo.git"]);

		const clonePath = join(base, "clone");
		await git(base, ["clone", "-q", original, clonePath]);
		// The clone's "origin" points at the local `original` path, not a name-bearing URL,
		// so give it the same kind of remote a real fork/clone off the same upstream would have.
		await git(clonePath, ["remote", "set-url", "origin", "https://github.com/someone-else/some-repo.git"]);

		const h = harness(base);
		const originalResolved = await resolvePrivate(original, h);
		const cloneResolved = await resolvePrivate(clonePath, h);

		assert.equal(originalResolved.projectKey, "some-repo");
		assert.equal(originalResolved.projectKey, cloneResolved.projectKey);
		assert.equal(originalResolved.root, cloneResolved.root);
	});
});

// --- worktrees ---

test("worktrees of the same repo share a git-common-dir, and thus the same key and private memory root", async () => {
	await withTmpDir(async (base) => {
		const main = join(base, "main");
		await mkdir(main);
		await initRepo(main);

		const worktreePath = join(base, "worktree");
		await git(main, ["worktree", "add", "-q", "-b", "wt-branch", worktreePath]);

		const mainInfo = await getGitInfo(main);
		const worktreeInfo = await getGitInfo(worktreePath);

		assert.ok(mainInfo);
		assert.ok(worktreeInfo);
		assert.equal(mainInfo?.commonDir, worktreeInfo?.commonDir);
		assert.notEqual(mainInfo?.toplevel, worktreeInfo?.toplevel);

		const h = harness(base);
		const mainResolved = await resolvePrivate(main, h);
		const worktreeResolved = await resolvePrivate(worktreePath, h);

		assert.equal(mainResolved.mode, "private");
		assert.equal(mainResolved.projectKey, worktreeResolved.projectKey);
		assert.equal(mainResolved.root, worktreeResolved.root);
	});
});

test("a worktree with no remote is keyed by the main repo's folder name, not the worktree's own folder name", async () => {
	await withTmpDir(async (base) => {
		const main = join(base, "main-repo-name");
		await mkdir(main);
		await initRepo(main);

		const worktreePath = join(base, "totally-different-worktree-name");
		await git(main, ["worktree", "add", "-q", "-b", "wt-branch", worktreePath]);

		const h = harness(base);
		const worktreeResolved = await resolvePrivate(worktreePath, h);
		assert.equal(worktreeResolved.projectKey, sanitizeProjectKey(basename(main)));
		assert.notEqual(worktreeResolved.projectKey, sanitizeProjectKey(basename(worktreePath)));
	});
});

test("a repo with no remote and a separate/custom git dir (commonDir not ending in .git) is keyed by its own toplevel folder name, not its git dir's parent", async () => {
	await withTmpDir(async (base) => {
		// A shared parent holding multiple repos' separate git dirs - the bug this
		// guards against is every such repo collapsing onto that shared parent's
		// name (`dirname(commonDir)`) instead of each repo's own folder name.
		const gitDirsParent = join(base, "git-dirs");
		await mkdir(gitDirsParent, { recursive: true });

		const repoA = join(base, "repo-a");
		const repoB = join(base, "repo-b");
		await mkdir(repoA);
		await mkdir(repoB);
		await git(repoA, ["init", "-q", `--separate-git-dir=${join(gitDirsParent, "repo-a.gitdir")}`]);
		await git(repoB, ["init", "-q", `--separate-git-dir=${join(gitDirsParent, "repo-b.gitdir")}`]);
		await git(repoA, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"]);
		await git(repoB, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"]);

		const gitInfoA = await getGitInfo(repoA);
		const gitInfoB = await getGitInfo(repoB);
		assert.ok(gitInfoA && gitInfoB);
		assert.notEqual(basename(gitInfoA!.commonDir), ".git");
		assert.equal(dirname(gitInfoA!.commonDir), gitDirsParent);

		const h = harness(base);
		const resolvedA = await resolvePrivate(repoA, h);
		const resolvedB = await resolvePrivate(repoB, h);

		assert.equal(resolvedA.projectKey, sanitizeProjectKey("repo-a"));
		assert.equal(resolvedB.projectKey, sanitizeProjectKey("repo-b"));
		assert.notEqual(resolvedA.projectKey, resolvedB.projectKey);
		// Neither collapsed onto the shared git-dirs parent's own name.
		assert.notEqual(resolvedA.projectKey, sanitizeProjectKey(basename(gitDirsParent)));
	});
});

// --- legacy migration (git) ---

test("legacy commonDir-hash config and private dir are migrated onto the new name key", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

		const h = harness(base);
		const gitInfo = await getGitInfo(repo);
		const legacyKey = hashKey(gitInfo!.commonDir);

		// Simulate pre-migration state: config and private dir keyed by the old hash.
		await setProjectConfig(h.globalConfigPath, legacyKey, { mode: "private" });
		const legacyDir = join(h.projectsDir, legacyKey);
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "marker.txt"), "legacy data", "utf-8");

		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, "named-repo");

		const configRaw = JSON.parse(await readFile(h.globalConfigPath, "utf-8"));
		assert.equal(configRaw.projects[legacyKey], undefined);
		assert.deepEqual(configRaw.projects["named-repo"], { mode: "private" });

		const movedMarker = await readFile(join(h.projectsDir, "named-repo", "marker.txt"), "utf-8");
		assert.equal(movedMarker, "legacy data");
		await assert.rejects(readFile(join(legacyDir, "marker.txt"), "utf-8"));

		// Idempotent: resolving again doesn't error or change the key.
		const resolvedAgain = await resolvePrivate(repo, h);
		assert.equal(resolvedAgain.projectKey, resolved.projectKey);
	});
});

test("a legacy g-... identity file's config and private dir are migrated onto the new name key", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

		const gitInfo = await getGitInfo(repo);
		const gKey = `g-${"b".repeat(32)}`;
		await writeFile(join(gitInfo!.commonDir, "pi-project-memory-id"), `${gKey}\n`, "utf-8");

		const h = harness(base);
		await setProjectConfig(h.globalConfigPath, gKey, { mode: "private" });
		const gDir = join(h.projectsDir, gKey);
		await mkdir(gDir, { recursive: true });
		await writeFile(join(gDir, "marker.txt"), "g-key data", "utf-8");

		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, "named-repo");

		const configRaw = JSON.parse(await readFile(h.globalConfigPath, "utf-8"));
		assert.equal(configRaw.projects[gKey], undefined);
		assert.deepEqual(configRaw.projects["named-repo"], { mode: "private" });

		const movedMarker = await readFile(join(h.projectsDir, "named-repo", "marker.txt"), "utf-8");
		assert.equal(movedMarker, "g-key data");

		// The identity file itself is left untouched - migration only reads it, never deletes/modifies it.
		const stillThere = (await readFile(join(gitInfo!.commonDir, "pi-project-memory-id"), "utf-8")).trim();
		assert.equal(stillThere, gKey);
	});
});

test("legacy migration never overwrites data already present under the new key", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

		const h = harness(base);
		const first = await resolvePrivate(repo, h);
		await setProjectConfig(h.globalConfigPath, first.projectKey, { mode: "private" });
		await mkdir(join(h.projectsDir, first.projectKey), { recursive: true });
		await writeFile(join(h.projectsDir, first.projectKey, "current.txt"), "current data", "utf-8");

		// Now simulate leftover legacy data that would otherwise migrate on top of it.
		const gitInfo = await getGitInfo(repo);
		const legacyKey = hashKey(gitInfo!.commonDir);
		const legacyDir = join(h.projectsDir, legacyKey);
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "marker.txt"), "legacy data", "utf-8");
		await setProjectConfig(h.globalConfigPath, legacyKey, { mode: "custom", customPath: "/should/not/apply" });

		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, first.projectKey);

		// Current data under the new key is untouched.
		const current = await readFile(join(h.projectsDir, first.projectKey, "current.txt"), "utf-8");
		assert.equal(current, "current data");
		// Config entry under the new key is untouched (still private, not clobbered by the legacy "custom" entry).
		const configRaw = JSON.parse(await readFile(h.globalConfigPath, "utf-8"));
		assert.deepEqual(configRaw.projects[first.projectKey], { mode: "private" });
	});
});

test("automatic legacy migration reports a conflict (and preserves both sides) when the new key already has its own config/private dir", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

		const h = harness(base);
		const first = await resolvePrivate(repo, h);
		await setProjectConfig(h.globalConfigPath, first.projectKey, { mode: "custom", customPath: "/current" });
		await mkdir(join(h.projectsDir, first.projectKey), { recursive: true });
		await writeFile(join(h.projectsDir, first.projectKey, "marker.txt"), "current data", "utf-8");

		const gitInfo = await getGitInfo(repo);
		const legacyKey = hashKey(gitInfo!.commonDir);
		await setProjectConfig(h.globalConfigPath, legacyKey, { mode: "private" });
		await mkdir(join(h.projectsDir, legacyKey), { recursive: true });
		await writeFile(join(h.projectsDir, legacyKey, "marker.txt"), "legacy data", "utf-8");

		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, first.projectKey);
		assert.ok(resolved.identityReason);

		// Nothing under either key was lost: current data untouched, legacy data left in place, not overwritten.
		const config = JSON.parse(await readFile(h.globalConfigPath, "utf-8"));
		assert.deepEqual(config.projects[first.projectKey], { mode: "custom", customPath: "/current" });
		assert.deepEqual(config.projects[legacyKey], { mode: "private" });
		const currentMarker = await readFile(join(h.projectsDir, first.projectKey, "marker.txt"), "utf-8");
		assert.equal(currentMarker, "current data");
		const legacyMarker = await readFile(join(h.projectsDir, legacyKey, "marker.txt"), "utf-8");
		assert.equal(legacyMarker, "legacy data");
	});
});

test("automatic legacy migration reports every conflict it hits, not just the last one, when both a g-... identity and a commonDir hash conflict", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

		const h = harness(base);
		const first = await resolvePrivate(repo, h);
		await setProjectConfig(h.globalConfigPath, first.projectKey, { mode: "custom", customPath: "/current" });
		await mkdir(join(h.projectsDir, first.projectKey), { recursive: true });
		await writeFile(join(h.projectsDir, first.projectKey, "marker.txt"), "current data", "utf-8");

		const gitInfo = await getGitInfo(repo);
		const hashLegacyKey = hashKey(gitInfo!.commonDir);
		await mkdir(join(h.projectsDir, hashLegacyKey), { recursive: true });
		await writeFile(join(h.projectsDir, hashLegacyKey, "marker.txt"), "hash-legacy data", "utf-8");

		const gKey = `g-${"d".repeat(32)}`;
		await writeFile(join(gitInfo!.commonDir, "pi-project-memory-id"), `${gKey}\n`, "utf-8");
		await mkdir(join(h.projectsDir, gKey), { recursive: true });
		await writeFile(join(h.projectsDir, gKey, "marker.txt"), "g-legacy data", "utf-8");

		const resolved = await resolvePrivate(repo, h);
		assert.equal(resolved.projectKey, first.projectKey);
		assert.ok(resolved.identityReason);
		// Both conflicting old keys are mentioned - neither is silently dropped in favor of the other.
		assert.match(resolved.identityReason ?? "", new RegExp(hashLegacyKey));
		assert.match(resolved.identityReason ?? "", new RegExp(gKey));
	});
});

// --- subagents ---

test("subagents (allowIdentityWrite: false) compute the same name key as the main agent, without migrating anything", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

		const h = harness(base);
		const gitInfo = await getGitInfo(repo);
		const legacyKey = hashKey(gitInfo!.commonDir);
		await setProjectConfig(h.globalConfigPath, legacyKey, { mode: "private" });
		await mkdir(join(h.projectsDir, legacyKey), { recursive: true });
		await writeFile(join(h.projectsDir, legacyKey, "marker.txt"), "legacy data", "utf-8");

		const subagentResolved = await resolvePrivate(repo, h, false);
		assert.equal(subagentResolved.projectKey, "named-repo");

		// Nothing migrated - the legacy dir/config are both still exactly where they were.
		const legacyStillThere = await readFile(join(h.projectsDir, legacyKey, "marker.txt"), "utf-8");
		assert.equal(legacyStillThere, "legacy data");
		const config = JSON.parse(await readFile(h.globalConfigPath, "utf-8"));
		assert.deepEqual(config.projects[legacyKey], { mode: "private" });
		assert.equal(config.projects["named-repo"], undefined);
	});
});

test("subagents read the same key the main agent already migrated onto", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);

		const h = harness(base);
		const mainResolved = await resolvePrivate(repo, h, true);
		const subagentResolved = await resolvePrivate(repo, h, false);
		assert.equal(subagentResolved.projectKey, mainResolved.projectKey);
	});
});

// --- modes ---

test("repo mode is unreadable/unwritable until the project is trusted", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);

		const h = harness(base);
		const initial = await resolveMemory({
			cwd: repo,
			isProjectTrusted: false,
			globalConfigPath: h.globalConfigPath,
			allowIdentityWrite: true,
			projectsDir: h.projectsDir,
		});
		await setProjectConfig(h.globalConfigPath, initial.projectKey, { mode: "repo" });

		const untrusted = await resolvePrivate(repo, h);
		assert.equal(untrusted.readable, false);
		assert.equal(untrusted.writable, false);
		assert.match(untrusted.reason ?? "", /trusted/);

		const trusted = await resolveMemory({
			cwd: repo,
			isProjectTrusted: true,
			globalConfigPath: h.globalConfigPath,
			allowIdentityWrite: true,
			projectsDir: h.projectsDir,
		});
		assert.equal(trusted.readable, true);
		assert.equal(trusted.root, join(repo, ".pi", "memory"));
	});
});

test("custom mode without a configured path is unreadable/unwritable", async () => {
	await withTmpDir(async (base) => {
		const dir = join(base, "plain-dir");
		await mkdir(dir);
		const h = harness(base);
		const projectKey = sanitizeProjectKey(basename(dir));
		await setProjectConfig(h.globalConfigPath, projectKey, { mode: "custom" });
		const resolved = await resolveMemory({
			cwd: dir,
			isProjectTrusted: false,
			globalConfigPath: h.globalConfigPath,
			allowIdentityWrite: true,
			projectsDir: h.projectsDir,
		});
		assert.equal(resolved.readable, false);
		assert.ok(resolved.reason);
	});
});

test("off mode disables memory entirely", async () => {
	await withTmpDir(async (base) => {
		const dir = join(base, "plain-dir");
		await mkdir(dir);
		const h = harness(base);
		const projectKey = sanitizeProjectKey(basename(dir));
		await setProjectConfig(h.globalConfigPath, projectKey, { mode: "off" });
		const resolved = await resolveMemory({
			cwd: dir,
			isProjectTrusted: true,
			globalConfigPath: h.globalConfigPath,
			allowIdentityWrite: true,
			projectsDir: h.projectsDir,
		});
		assert.equal(resolved.mode, "off");
		assert.equal(resolved.readable, false);
		assert.equal(resolved.root, undefined);
	});
});

const canTestUnwritableDirs = platform() !== "win32" && process.getuid?.() !== 0;

test(
	"an unwritable projects directory doesn't break resolution even though legacy migration can't complete",
	{ skip: !canTestUnwritableDirs },
	async () => {
		await withTmpDir(async (base) => {
			const repo = join(base, "repo");
			await mkdir(repo);
			await initRepo(repo);
			await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);

			const h = harness(base);
			const gitInfo = await getGitInfo(repo);
			const legacyKey = hashKey(gitInfo!.commonDir);

			// Legacy private dir exists, but its parent (the projects dir) is read-only,
			// so the migration rename can't create anything under the new key.
			await mkdir(h.projectsDir, { recursive: true });
			await mkdir(join(h.projectsDir, legacyKey), { recursive: true });
			await writeFile(join(h.projectsDir, legacyKey, "marker.txt"), "legacy data", "utf-8");
			await chmod(h.projectsDir, 0o555);
			try {
				const resolved = await resolvePrivate(repo, h, true);
				assert.equal(resolved.projectKey, "named-repo");
				assert.ok(resolved.identityReason);
			} finally {
				await chmod(h.projectsDir, 0o755);
			}
		});
	},
);

// --- relinkKeyCandidates ---

test("relinkKeyCandidates passes through a bare legacy key unchanged", async () => {
	await withTmpDir(async (base) => {
		assert.deepEqual(await relinkKeyCandidates("g-" + "a".repeat(32), base), ["g-" + "a".repeat(32)]);
		assert.deepEqual(await relinkKeyCandidates("0123456789abcdef", base), ["0123456789abcdef"]);
	});
});

test("relinkKeyCandidates for an existing git repo tries its current name key, then a leftover g-... identity, then its legacy commonDir hash", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		await git(repo, ["remote", "add", "origin", "https://github.com/owner/named-repo.git"]);
		const gitInfo = await getGitInfo(repo);
		const legacyKey = hashKey(gitInfo!.commonDir);

		// No leftover g-... identity file: just the name key and the legacy hash.
		assert.deepEqual(await relinkKeyCandidates(repo, base), ["named-repo", legacyKey]);

		// A leftover g-... identity file (never written by this codebase anymore, but may
		// still exist from an older install) is offered as a middle candidate.
		const gKey = `g-${"c".repeat(32)}`;
		await writeFile(join(gitInfo!.commonDir, "pi-project-memory-id"), `${gKey}\n`, "utf-8");
		assert.deepEqual(await relinkKeyCandidates(repo, base), ["named-repo", gKey, legacyKey]);
	});
});

test("relinkKeyCandidates resolves relative paths against the given cwd, not process.cwd()", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);
		const gitInfo = await getGitInfo(repo);
		const legacyKey = hashKey(gitInfo!.commonDir);

		assert.deepEqual(await relinkKeyCandidates("repo", base), [sanitizeProjectKey("repo"), legacyKey]);
	});
});

test("relinkKeyCandidates guesses the folder-name key, the plain-repo git hash, and the legacy directory hash when the old root is missing", async () => {
	await withTmpDir(async (base) => {
		const goneRepo = join(base, "gone");
		const candidates = await relinkKeyCandidates(goneRepo, base);
		assert.deepEqual(candidates, [sanitizeProjectKey("gone"), hashKey(join(goneRepo, ".git")), hashKey(goneRepo)]);
	});
});

test("relinkKeyCandidates with a key:<name> prefix returns only the literal name, with no path resolution at all", async () => {
	await withTmpDir(async (base) => {
		// Even though a directory of this exact name exists at cwd, key:-prefixed
		// input is never treated as a path.
		await mkdir(join(base, "some-project-name"));
		assert.deepEqual(await relinkKeyCandidates("key:some-project-name", base), ["some-project-name"]);
	});
});

test("relinkKeyCandidates with a key:<name> prefix rejects anything that isn't already a well-formed key, rather than sanitizing or guessing it", async () => {
	await withTmpDir(async (base) => {
		// Not already in sanitized form (spaces, punctuation, mixed case) -
		// rejected outright instead of silently sanitized to some other key.
		assert.deepEqual(await relinkKeyCandidates("key:Weird Name!!", base), []);
		// Empty key.
		assert.deepEqual(await relinkKeyCandidates("key:", base), []);
		// Path traversal / separators - must never reach `join(projectsDir, key)`.
		assert.deepEqual(await relinkKeyCandidates("key:../../etc/passwd", base), []);
		assert.deepEqual(await relinkKeyCandidates("key:../other-project", base), []);
		assert.deepEqual(await relinkKeyCandidates("key:sub/dir", base), []);
		assert.deepEqual(await relinkKeyCandidates("key:sub\\dir", base), []);
		// Bare `.`/`..` are already caught by sanitizeProjectKey's own trim, but
		// confirm they're rejected here too rather than resolving to "project".
		assert.deepEqual(await relinkKeyCandidates("key:.", base), []);
		assert.deepEqual(await relinkKeyCandidates("key:..", base), []);
		// Already-sanitized legacy shapes still pass through unchanged.
		assert.deepEqual(await relinkKeyCandidates(`key:g-${"a".repeat(32)}`, base), [`g-${"a".repeat(32)}`]);
		assert.deepEqual(await relinkKeyCandidates("key:0123456789abcdef", base), ["0123456789abcdef"]);
	});
});

test("relinkKeyCandidates tries a bare (slash-free) argument's own sanitized name first, ahead of what a same-named local directory would resolve to", async () => {
	await withTmpDir(async (base) => {
		// A local, unrelated git repo that happens to be named the same as the
		// literal key the caller is asking about - its own current name key
		// would normally be a fine guess, but the literal name candidate must
		// still be tried first so a same-named local repo can't shadow it.
		const shadowRepo = join(base, "old-project");
		await mkdir(shadowRepo);
		await initRepo(shadowRepo);
		await git(shadowRepo, ["remote", "add", "origin", "https://github.com/someone/unrelated-name.git"]);

		const candidates = await relinkKeyCandidates("old-project", base);
		assert.equal(candidates[0], sanitizeProjectKey("old-project"));
		assert.ok(candidates.includes("unrelated-name"));
		assert.equal(candidates.indexOf(sanitizeProjectKey("old-project")), 0);
	});
});

test("relinkKeyCandidates does not add a literal-name candidate for path-like arguments (containing a slash)", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "sub", "repo");
		await mkdir(repo, { recursive: true });
		await initRepo(repo);

		const candidates = await relinkKeyCandidates("sub/repo", base);
		// The literal argument "sub/repo" sanitized would be "sub-repo" - that must
		// not appear, since a slash-containing argument is only ever resolved as a path.
		assert.ok(!candidates.includes(sanitizeProjectKey("sub/repo")));
		assert.equal(candidates[0], sanitizeProjectKey("repo"));
	});
});

test("relinkKeyCandidates dedupes when the literal-name guess and the path-based guess coincide", async () => {
	await withTmpDir(async (base) => {
		const goneRepo = join(base, "gone-thing");
		const candidates = await relinkKeyCandidates("gone-thing", base);
		// sanitizeProjectKey("gone-thing") appears once, not twice, even though both
		// the literal-name step and the non-git-fallback step would produce it.
		assert.equal(candidates.filter((c) => c === sanitizeProjectKey("gone-thing")).length, 1);
	});
});
