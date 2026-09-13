import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	commandMentionsPath,
	expandPathPrefix,
	isWithinRoot,
	resolveCandidatePath,
	resolveGuardedRoot,
} from "../pathguard.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-pathguard-test-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("expandPathPrefix strips a leading @ and expands ~", () => {
	assert.equal(expandPathPrefix("@/abs/path"), "/abs/path");
	assert.equal(expandPathPrefix("~"), homedir());
	assert.equal(expandPathPrefix("~/notes.md"), join(homedir(), "notes.md"));
	assert.equal(expandPathPrefix("relative/path.md"), "relative/path.md");
	// A username-style ~user is not expanded (matches pi's own write/edit tools).
	assert.equal(expandPathPrefix("~user/notes.md"), "~user/notes.md");
});

test("resolveCandidatePath resolves relative, @, and ~ paths the same way pi's write/edit tools would", async () => {
	await withTmpDir(async (dir) => {
		const root = join(dir, "memory");
		await mkdir(root, { recursive: true });

		const relative = resolveCandidatePath("memory/long/x.md", dir);
		assert.equal(relative, join(root, "long", "x.md"));

		const atPrefixed = resolveCandidatePath(`@${root}/long/x.md`, dir);
		assert.equal(atPrefixed, join(root, "long", "x.md"));
	});
});

test("isWithinRoot matches the root itself and anything nested under it, but not lookalike siblings", () => {
	const root = "/home/user/.pi/agent/memory/projects/abc";
	assert.equal(isWithinRoot(root, root), true);
	assert.equal(isWithinRoot(join(root, "long", "x.md"), root), true);
	assert.equal(isWithinRoot(`${root}-evil`, root), false);
	assert.equal(isWithinRoot("/home/user/.pi/agent/memory/projects/other", root), false);
});

test("resolveGuardedRoot and resolveCandidatePath see through a symlinked directory", async () => {
	await withTmpDir(async (dir) => {
		const realRoot = join(dir, "real-memory");
		await mkdir(join(realRoot, "long"), { recursive: true });
		const linkPath = join(dir, "link-to-memory");
		await symlink(realRoot, linkPath);

		const guardedRoot = resolveGuardedRoot(realRoot);
		// A write through the symlink, including to a file that doesn't exist yet,
		// still canonicalizes into the real root.
		const candidate = resolveCandidatePath(join(linkPath, "long", "new-file.md"), dir);
		assert.equal(isWithinRoot(candidate, guardedRoot), true);
	});
});

test("commandMentionsPath flags a command that literally mentions the resolved or raw root path", () => {
	const root = "/home/user/.pi/agent/memory/projects/abc";
	assert.equal(commandMentionsPath(`cat ${root}/long/x.md`, root, root), true);
	assert.equal(commandMentionsPath("ls /tmp", root, root), false);
});
