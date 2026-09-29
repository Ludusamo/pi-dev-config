import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { getGitInfo, gitProjectKey, sanitizeProjectKey } from "../../project-memory/resolve.ts";
import { resolveAnchorRoot, resolveTourProjectKey } from "../resolve.ts";

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
	const dir = await mkdtemp(join(tmpdir(), "pi-tour-resolve-test-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("resolveTourProjectKey sanitizes the folder name outside a git repo", async () => {
	await withTmpDir(async (dir) => {
		const key = await resolveTourProjectKey(dir);
		assert.equal(key, sanitizeProjectKey(basename(dir)));
	});
});

test("resolveTourProjectKey matches project-memory's gitProjectKey inside a git repo", async () => {
	await withTmpDir(async (dir) => {
		await initRepo(dir);
		const key = await resolveTourProjectKey(dir);
		const gitInfo = await getGitInfo(dir);
		assert.ok(gitInfo);
		assert.equal(key, await gitProjectKey(gitInfo, dir));
	});
});

test("resolveTourProjectKey uses the remote repo name when one is configured", async () => {
	await withTmpDir(async (dir) => {
		await initRepo(dir);
		await git(dir, ["remote", "add", "origin", "git@example.com:someone/widgets.git"]);
		const key = await resolveTourProjectKey(dir);
		assert.equal(key, "widgets");
	});
});

test("resolveAnchorRoot returns cwd itself outside a git repo", async () => {
	await withTmpDir(async (dir) => {
		assert.equal(await resolveAnchorRoot(dir), dir);
	});
});

test("resolveAnchorRoot returns the repo toplevel, not cwd, when run from a subdirectory", async () => {
	await withTmpDir(async (dir) => {
		await initRepo(dir);
		const subdir = join(dir, "sub", "deeper");
		await mkdir(subdir, { recursive: true });
		const gitInfo = await getGitInfo(dir);
		assert.ok(gitInfo);
		assert.equal(await resolveAnchorRoot(subdir), gitInfo.toplevel);
	});
});
