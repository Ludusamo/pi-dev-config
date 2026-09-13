import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	dropProjectConfigKey,
	migrateProjectConfigKey,
	readGlobalConfig,
	readRepoMarker,
	setProjectConfig,
	writeRepoMarker,
} from "../config.ts";

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
		assert.equal(config.defaultMode, "private");
		assert.deepEqual(Object.keys(config.projects), []);
	});
});

test("readGlobalConfig's projects map has a null prototype, so dangerous keys never resolve to inherited members", async () => {
	await withTmpDir(async (dir) => {
		const config = await readGlobalConfig(join(dir, "config.json"));
		assert.equal(Object.getPrototypeOf(config.projects), null);
		assert.equal(config.projects.constructor, undefined);
		assert.equal(config.projects.hasOwnProperty, undefined);
		assert.equal(config.projects.toString, undefined);
		assert.equal((config.projects as Record<string, unknown>).__proto__, undefined);
		assert.equal(Object.hasOwn(config.projects, "constructor"), false);
		assert.equal("constructor" in config.projects, false);
	});
});

test("readGlobalConfig keeps dangerously-named keys as own properties, not inherited members, when the file has them", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		// A computed key is required for "__proto__" here - a literal `__proto__:`
		// property in an object initializer sets the object's actual prototype
		// instead of creating an own property, which would vanish from
		// JSON.stringify's output entirely instead of round-tripping as data.
		await writeFile(
			configPath,
			JSON.stringify({
				defaultMode: "private",
				projects: {
					constructor: { mode: "repo" },
					["__proto__"]: { mode: "custom", customPath: "/tmp/x" },
					hasOwnProperty: { mode: "off" },
				},
			}),
			"utf-8",
		);
		const config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["constructor"], { mode: "repo" });
		assert.deepEqual(config.projects["hasOwnProperty"], { mode: "off" });
		assert.deepEqual(config.projects["__proto__"], { mode: "custom", customPath: "/tmp/x" });
		assert.equal(Object.getPrototypeOf(config.projects), null);
		// Real prototype pollution must never occur - Object.prototype itself must be untouched.
		assert.equal(({} as Record<string, unknown>).mode, undefined);
	});
});

test("setProjectConfig, migrateProjectConfigKey, and dropProjectConfigKey all treat dangerous key names as ordinary own keys", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "constructor", { mode: "repo" });
		await setProjectConfig(configPath, "__proto__", { mode: "off" });

		let config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["constructor"], { mode: "repo" });
		assert.deepEqual(config.projects["__proto__"], { mode: "off" });
		assert.equal(({} as Record<string, unknown>).mode, undefined);

		const migrated = await migrateProjectConfigKey(configPath, "constructor", "hasOwnProperty");
		assert.equal(migrated.status, "moved");
		config = await readGlobalConfig(configPath);
		assert.equal(config.projects["constructor"], undefined);
		assert.deepEqual(config.projects["hasOwnProperty"], { mode: "repo" });

		await dropProjectConfigKey(configPath, "toString");
		config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["__proto__"], { mode: "off" });
		assert.deepEqual(config.projects["hasOwnProperty"], { mode: "repo" });

		await dropProjectConfigKey(configPath, "__proto__");
		config = await readGlobalConfig(configPath);
		assert.equal(config.projects["__proto__"], undefined);
		assert.deepEqual(config.projects["hasOwnProperty"], { mode: "repo" });
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

test("setProjectConfig preserves defaultMode and other projects' entries", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "proj-a", { mode: "custom", customPath: "/tmp/a" });
		const withDefault = await readGlobalConfig(configPath);
		assert.equal(withDefault.defaultMode, "private");

		await setProjectConfig(configPath, "proj-b", { mode: "off" });
		const config = await readGlobalConfig(configPath);
		assert.equal(config.defaultMode, "private");
		assert.deepEqual(config.projects["proj-a"], { mode: "custom", customPath: "/tmp/a" });
		assert.deepEqual(config.projects["proj-b"], { mode: "off" });
	});
});

test("migrateProjectConfigKey moves an entry from the old key to the new key", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "old-key", { mode: "repo" });
		await setProjectConfig(configPath, "unrelated", { mode: "off" });

		await migrateProjectConfigKey(configPath, "old-key", "new-key");
		const config = await readGlobalConfig(configPath);
		assert.equal(config.projects["old-key"], undefined);
		assert.deepEqual(config.projects["new-key"], { mode: "repo" });
		assert.deepEqual(config.projects["unrelated"], { mode: "off" });
	});
});

test("migrateProjectConfigKey is idempotent", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "old-key", { mode: "repo" });

		await migrateProjectConfigKey(configPath, "old-key", "new-key");
		await migrateProjectConfigKey(configPath, "old-key", "new-key");

		const config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["new-key"], { mode: "repo" });
		assert.equal(Object.keys(config.projects).length, 1);
	});
});

test("migrateProjectConfigKey never overwrites an existing entry under the new key, and leaves old-key's entry in place on conflict", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "old-key", { mode: "repo" });
		await setProjectConfig(configPath, "new-key", { mode: "off" });

		const result = await migrateProjectConfigKey(configPath, "old-key", "new-key");
		assert.equal(result.status, "conflict");

		const config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["old-key"], { mode: "repo" });
		assert.deepEqual(config.projects["new-key"], { mode: "off" });
	});
});

test("migrateProjectConfigKey reports \"moved\" and does not rewrite the file again on a repeat call", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "old-key", { mode: "repo" });

		const first = await migrateProjectConfigKey(configPath, "old-key", "new-key");
		assert.equal(first.status, "moved");

		const second = await migrateProjectConfigKey(configPath, "old-key", "new-key");
		assert.equal(second.status, "no-old-entry");

		const config = await readGlobalConfig(configPath);
		assert.deepEqual(config.projects["new-key"], { mode: "repo" });
		assert.equal(config.projects["old-key"], undefined);
	});
});

test("migrateProjectConfigKey is a no-op when there is no entry under the old key", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "unrelated", { mode: "private" });
		await migrateProjectConfigKey(configPath, "old-key", "new-key");
		const config = await readGlobalConfig(configPath);
		assert.deepEqual(Object.keys(config.projects), ["unrelated"]);
	});
});

test("dropProjectConfigKey removes the old key's entry but leaves the new key's entry (and other projects) alone", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "old-key", { mode: "repo" });
		await setProjectConfig(configPath, "new-key", { mode: "off" });
		await setProjectConfig(configPath, "unrelated", { mode: "private" });

		// Same conflict migrateProjectConfigKey refuses to resolve on its own.
		const migrated = await migrateProjectConfigKey(configPath, "old-key", "new-key");
		assert.equal(migrated.status, "conflict");

		await dropProjectConfigKey(configPath, "old-key");

		const config = await readGlobalConfig(configPath);
		assert.equal(config.projects["old-key"], undefined);
		assert.deepEqual(config.projects["new-key"], { mode: "off" });
		assert.deepEqual(config.projects["unrelated"], { mode: "private" });
	});
});

test("dropProjectConfigKey is a harmless no-op when the key has no entry", async () => {
	await withTmpDir(async (dir) => {
		const configPath = join(dir, "config.json");
		await setProjectConfig(configPath, "unrelated", { mode: "private" });
		await dropProjectConfigKey(configPath, "missing-key");
		const config = await readGlobalConfig(configPath);
		assert.deepEqual(Object.keys(config.projects), ["unrelated"]);
	});
});
