import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readGlobalConfig, readRepoMarker, setProjectConfig, writeRepoMarker } from "../config.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-config-test-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("readGlobalConfig returns defaults when the file doesn't exist", async () => {
	await withTmpDir(async (dir) => {
		const config = await readGlobalConfig(join(dir, "config.json"));
		assert.deepEqual(config, { defaultMode: "private", projects: {} });
	});
});

test("setProjectConfig persists a project entry and readGlobalConfig sees it", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "nested", "config.json");
		await setProjectConfig(configPath, "abc123", { mode: "custom", customPath: "/tmp/foo" });
		const config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["abc123"], { mode: "custom", customPath: "/tmp/foo" });
	});
});

test("setProjectConfig merges rather than clobbering other projects", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "proj-a", { mode: "off" });
		await setProjectConfig(configPath, "proj-b", { mode: "repo" });
		const config = await readGlobalConfig(configPath);
		assert.equal(config.projects["proj-a"].mode, "off");
		assert.equal(config.projects["proj-b"].mode, "repo");
	});
});

test("writeRepoMarker + readRepoMarker round-trip, and no marker is undefined", async () => {
	await withTmpDir(async (dir) => {
		assert.equal(await readRepoMarker(dir), undefined);
		await writeRepoMarker(dir);
		const marker = await readRepoMarker(dir);
		assert.deepEqual(marker, { mode: "repo", version: 1 });

		const raw = await readFile(join(dir, ".pi", "memory.json"), "utf-8");
		assert.deepEqual(JSON.parse(raw), { mode: "repo", version: 1 });
	});
});

test("concurrent setProjectConfig calls don't lose writes", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await Promise.all(
			Array.from({ length: 10 }, (_, i) => setProjectConfig(configPath, `proj-${i}`, { mode: "private" })),
		);
		const config = await readGlobalConfig(configPath);
		assert.equal(Object.keys(config.projects).length, 10);
	});
});
