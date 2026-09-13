import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readGlobalConfig, setProjectConfig } from "../config.ts";
import { acquireLock } from "../lock.ts";
import { moveProjectKey } from "../migrate.ts";
import { lockDir } from "../store.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-migrate-test-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("moveProjectKey moves both config and the private dir contents", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await setProjectConfig(configPath, "old-key", { mode: "private" });
		await mkdir(join(projectsDir, "old-key"), { recursive: true });
		await writeFile(join(projectsDir, "old-key", "note.txt"), "hello", "utf-8");

		await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });

		const config = await readGlobalConfig(configPath);
		assert.equal(config.projects["old-key"], undefined);
		assert.deepEqual(config.projects["new-key"], { mode: "private" });

		const moved = await readFile(join(projectsDir, "new-key", "note.txt"), "utf-8");
		assert.equal(moved, "hello");
		await assert.rejects(readFile(join(projectsDir, "old-key", "note.txt"), "utf-8"));
	});
});

test("moveProjectKey refuses a path-traversal oldKey instead of moving/deleting anything outside projectsDir", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");
		await mkdir(projectsDir, { recursive: true });

		// A sibling directory outside projectsDir that a "../escaped" key would
		// resolve into - it must be left completely untouched.
		const outside = join(base, "escaped");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.txt"), "do-not-touch", "utf-8");

		await assert.rejects(
			moveProjectKey({ configPath, projectsDir, oldKey: "../escaped", newKey: "new-key" }),
			/outside the projects directory/,
		);

		assert.equal(await readFile(join(outside, "secret.txt"), "utf-8"), "do-not-touch");
		await assert.rejects(readFile(join(projectsDir, "new-key", "secret.txt"), "utf-8"));
	});
});

test("moveProjectKey refuses an empty oldKey, which would otherwise resolve to projectsDir itself", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");
		await mkdir(join(projectsDir, "some-other-project"), { recursive: true });
		await writeFile(join(projectsDir, "some-other-project", "note.txt"), "hello", "utf-8");

		await assert.rejects(
			moveProjectKey({ configPath, projectsDir, oldKey: "", newKey: "new-key" }),
			/outside the projects directory/,
		);

		// projectsDir's other contents must be untouched.
		assert.equal(await readFile(join(projectsDir, "some-other-project", "note.txt"), "utf-8"), "hello");
	});
});

test("moveProjectKey is a no-op when oldKey === newKey", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");
		await setProjectConfig(configPath, "same-key", { mode: "private" });
		await mkdir(join(projectsDir, "same-key"), { recursive: true });
		await writeFile(join(projectsDir, "same-key", "note.txt"), "hello", "utf-8");

		await moveProjectKey({ configPath, projectsDir, oldKey: "same-key", newKey: "same-key" });

		const moved = await readFile(join(projectsDir, "same-key", "note.txt"), "utf-8");
		assert.equal(moved, "hello");
	});
});

test("moveProjectKey never overwrites an existing private dir under the new key, and leaves the conflicting file behind (reported, not orphaned)", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await mkdir(join(projectsDir, "old-key"), { recursive: true });
		await writeFile(join(projectsDir, "old-key", "note.txt"), "legacy", "utf-8");
		await mkdir(join(projectsDir, "new-key"), { recursive: true });
		await writeFile(join(projectsDir, "new-key", "note.txt"), "current", "utf-8");

		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });
		assert.equal(result.dir, "conflict");
		assert.deepEqual(result.dirConflicts, ["note.txt"]);

		const current = await readFile(join(projectsDir, "new-key", "note.txt"), "utf-8");
		assert.equal(current, "current");
		const legacy = await readFile(join(projectsDir, "old-key", "note.txt"), "utf-8");
		assert.equal(legacy, "legacy");
	});
});

test("moveProjectKey handles dangerous key names (constructor, __proto__) as ordinary keys, on both config and disk", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await setProjectConfig(configPath, "constructor", { mode: "private" });
		await mkdir(join(projectsDir, "constructor"), { recursive: true });
		await writeFile(join(projectsDir, "constructor", "note.txt"), "hello", "utf-8");

		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "constructor", newKey: "__proto__" });
		assert.equal(result.config, "moved");
		assert.equal(result.dir, "moved");

		const config = await readGlobalConfig(configPath);
		assert.equal(config.projects["constructor"], undefined);
		assert.deepEqual(config.projects["__proto__"], { mode: "private" });
		assert.equal(({} as Record<string, unknown>).mode, undefined);

		const moved = await readFile(join(projectsDir, "__proto__", "note.txt"), "utf-8");
		assert.equal(moved, "hello");
		await assert.rejects(readFile(join(projectsDir, "constructor", "note.txt"), "utf-8"));
	});
});

test("moveProjectKey with nothing under the old key is a harmless no-op", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");
		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });
		assert.equal(result.config, "no-old-entry");
		assert.equal(result.dir, "none");
		const config = await readGlobalConfig(configPath);
		assert.deepEqual(Object.keys(config.projects), []);
	});
});

test("moveProjectKey merges non-conflicting entries from both term dirs and removes the now-empty old dir", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await mkdir(join(projectsDir, "old-key", "short"), { recursive: true });
		await mkdir(join(projectsDir, "old-key", "long"), { recursive: true });
		await writeFile(join(projectsDir, "old-key", "short", "a.md"), "old short", "utf-8");
		await writeFile(join(projectsDir, "old-key", "long", "b.md"), "old long", "utf-8");

		await mkdir(join(projectsDir, "new-key", "short"), { recursive: true });
		await writeFile(join(projectsDir, "new-key", "short", "c.md"), "new short", "utf-8");

		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });
		assert.equal(result.dir, "merged");
		assert.deepEqual(result.dirConflicts, []);

		assert.equal(await readFile(join(projectsDir, "new-key", "short", "a.md"), "utf-8"), "old short");
		assert.equal(await readFile(join(projectsDir, "new-key", "short", "c.md"), "utf-8"), "new short");
		assert.equal(await readFile(join(projectsDir, "new-key", "long", "b.md"), "utf-8"), "old long");

		// Fully merged with no conflicts left behind - the old dir is cleaned up rather than left as stale, empty clutter.
		await assert.rejects(readdir(join(projectsDir, "old-key")));
	});
});

test("moveProjectKey merges what it can and leaves only the conflicting file behind when a same-named entry collides", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await mkdir(join(projectsDir, "old-key", "short"), { recursive: true });
		await writeFile(join(projectsDir, "old-key", "short", "a.md"), "old a", "utf-8");
		await writeFile(join(projectsDir, "old-key", "short", "shared.md"), "old shared", "utf-8");

		await mkdir(join(projectsDir, "new-key", "short"), { recursive: true });
		await writeFile(join(projectsDir, "new-key", "short", "shared.md"), "new shared", "utf-8");

		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });
		assert.equal(result.dir, "conflict");
		assert.deepEqual(result.dirConflicts, ["short/shared.md"]);

		// The non-conflicting entry made it across...
		assert.equal(await readFile(join(projectsDir, "new-key", "short", "a.md"), "utf-8"), "old a");
		// ...the conflicting one was left untouched on both sides, not overwritten or dropped.
		assert.equal(await readFile(join(projectsDir, "new-key", "short", "shared.md"), "utf-8"), "new shared");
		assert.equal(await readFile(join(projectsDir, "old-key", "short", "shared.md"), "utf-8"), "old shared");
	});
});

test("moveProjectKey holds off until a concurrent store write to the destination dir releases its lock, instead of racing it", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await mkdir(join(projectsDir, "old-key"), { recursive: true });
		await writeFile(join(projectsDir, "old-key", "note.txt"), "legacy", "utf-8");
		await mkdir(join(projectsDir, "new-key"), { recursive: true });

		// Simulate a concurrent store write (writeEntry/updateEntry) already
		// holding the destination's own store lock.
		const held = await acquireLock(lockDir(join(projectsDir, "new-key")));

		let settled = false;
		const movePromise = moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" }).then((r) => {
			settled = true;
			return r;
		});

		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(settled, false, "merge must wait for the destination's store lock rather than proceeding around it");

		await held.release();
		const result = await movePromise;
		assert.equal(settled, true);
		assert.equal(result.dir, "merged");
		assert.equal(await readFile(join(projectsDir, "new-key", "note.txt"), "utf-8"), "legacy");
	});
});

test("a leftover empty .lock dir in the old dir (e.g. from a past crash) doesn't block cleanup or count as data left behind", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		const staleLock = join(projectsDir, "old-key", ".lock");
		await mkdir(staleLock, { recursive: true });
		const longAgo = new Date(Date.now() - 60_000);
		await utimes(staleLock, longAgo, longAgo);

		await mkdir(join(projectsDir, "new-key"), { recursive: true });
		await writeFile(join(projectsDir, "new-key", "note.txt"), "current", "utf-8");

		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });
		assert.equal(result.dir, "merged");
		assert.deepEqual(result.dirConflicts, []);

		// Fully cleaned up rather than left behind forever just because a stale lock dir was the only thing in it
		// (which would otherwise make every future resolveMemory call re-attempt this same no-op migration).
		await assert.rejects(readdir(join(projectsDir, "old-key")));
	});
});

test("moveProjectKey never deletes old-key's config entry when new-key already has one", async () => {
	await withTmpDir(async (base) => {
		const configPath = join(base, "config.json");
		const projectsDir = join(base, "projects");

		await setProjectConfig(configPath, "old-key", { mode: "custom", customPath: "/old/path" });
		await setProjectConfig(configPath, "new-key", { mode: "private" });

		const result = await moveProjectKey({ configPath, projectsDir, oldKey: "old-key", newKey: "new-key" });
		assert.equal(result.config, "conflict");

		const config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["old-key"], { mode: "custom", customPath: "/old/path" });
		assert.deepEqual(config.projects["new-key"], { mode: "private" });
	});
});
