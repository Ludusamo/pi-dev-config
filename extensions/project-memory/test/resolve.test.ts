import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { setProjectConfig } from "../config.ts";
import { getGitInfo, hashKey, resolveMemory } from "../resolve.ts";

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

test("getGitInfo returns undefined outside a git repository", async () => {
	await withTmpDir(async (dir) => {
		assert.equal(await getGitInfo(dir), undefined);
	});
});

test("worktrees of the same repo share a git-common-dir, and thus the same private memory root", async () => {
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

		const globalConfigPath = join(base, "global-config.json");
		const mainResolved = await resolveMemory({ cwd: main, isProjectTrusted: false, globalConfigPath });
		const worktreeResolved = await resolveMemory({ cwd: worktreePath, isProjectTrusted: false, globalConfigPath });

		assert.equal(mainResolved.mode, "private");
		assert.equal(mainResolved.projectKey, worktreeResolved.projectKey);
		assert.equal(mainResolved.root, worktreeResolved.root);
	});
});

test("a separate clone of the same repo does not share private memory with the original", async () => {
	await withTmpDir(async (base) => {
		const original = join(base, "original");
		await mkdir(original);
		await initRepo(original);

		const clonePath = join(base, "clone");
		await git(base, ["clone", "-q", original, clonePath]);

		const globalConfigPath = join(base, "global-config.json");
		const originalResolved = await resolveMemory({ cwd: original, isProjectTrusted: false, globalConfigPath });
		const cloneResolved = await resolveMemory({ cwd: clonePath, isProjectTrusted: false, globalConfigPath });

		assert.notEqual(originalResolved.projectKey, cloneResolved.projectKey);
		assert.notEqual(originalResolved.root, cloneResolved.root);
	});
});

test("repo mode is unreadable/unwritable until the project is trusted", async () => {
	await withTmpDir(async (base) => {
		const repo = join(base, "repo");
		await mkdir(repo);
		await initRepo(repo);

		const globalConfigPath = join(base, "global-config.json");
		const projectKey = hashKey((await getGitInfo(repo))!.commonDir);
		await setProjectConfig(globalConfigPath, projectKey, { mode: "repo" });

		const untrusted = await resolveMemory({ cwd: repo, isProjectTrusted: false, globalConfigPath });
		assert.equal(untrusted.readable, false);
		assert.equal(untrusted.writable, false);
		assert.match(untrusted.reason ?? "", /trusted/);

		const trusted = await resolveMemory({ cwd: repo, isProjectTrusted: true, globalConfigPath });
		assert.equal(trusted.readable, true);
		assert.equal(trusted.root, join(repo, ".pi", "memory"));
	});
});

test("custom mode without a configured path is unreadable/unwritable", async () => {
	await withTmpDir(async (base) => {
		const globalConfigPath = join(base, "global-config.json");
		const projectKey = hashKey(base);
		await setProjectConfig(globalConfigPath, projectKey, { mode: "custom" });
		const resolved = await resolveMemory({ cwd: base, isProjectTrusted: false, globalConfigPath });
		assert.equal(resolved.readable, false);
		assert.ok(resolved.reason);
	});
});

test("off mode disables memory entirely", async () => {
	await withTmpDir(async (base) => {
		const globalConfigPath = join(base, "global-config.json");
		const projectKey = hashKey(base);
		await setProjectConfig(globalConfigPath, projectKey, { mode: "off" });
		const resolved = await resolveMemory({ cwd: base, isProjectTrusted: true, globalConfigPath });
		assert.equal(resolved.mode, "off");
		assert.equal(resolved.readable, false);
		assert.equal(resolved.root, undefined);
	});
});
