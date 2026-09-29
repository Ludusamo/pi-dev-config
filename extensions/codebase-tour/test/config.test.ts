import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_PANE_ENABLED, loadPaneEnabled, resolveNextPaneState, savePaneEnabled, tourConfigPath } from "../config.ts";

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-tour-config-test-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("loadPaneEnabled defaults to true (DEFAULT_PANE_ENABLED) when no config file exists", async () => {
	await withTmpRoot(async (root) => {
		assert.equal(DEFAULT_PANE_ENABLED, true);
		assert.equal(await loadPaneEnabled(root), true);
	});
});

test("savePaneEnabled persists false, and a later load reflects it", async () => {
	await withTmpRoot(async (root) => {
		await savePaneEnabled(root, false);
		assert.equal(await loadPaneEnabled(root), false);
	});
});

test("savePaneEnabled persists true after having been turned off", async () => {
	await withTmpRoot(async (root) => {
		await savePaneEnabled(root, false);
		await savePaneEnabled(root, true);
		assert.equal(await loadPaneEnabled(root), true);
	});
});

test("loadPaneEnabled falls back to the default on a corrupt config file", async () => {
	await withTmpRoot(async (root) => {
		await writeFile(tourConfigPath(root), "not json", "utf-8");
		assert.equal(await loadPaneEnabled(root), DEFAULT_PANE_ENABLED);
	});
});

test("loadPaneEnabled falls back to the default when paneEnabled is missing or not a boolean", async () => {
	await withTmpRoot(async (root) => {
		await writeFile(tourConfigPath(root), JSON.stringify({}), "utf-8");
		assert.equal(await loadPaneEnabled(root), DEFAULT_PANE_ENABLED);

		await writeFile(tourConfigPath(root), JSON.stringify({ paneEnabled: "off" }), "utf-8");
		assert.equal(await loadPaneEnabled(root), DEFAULT_PANE_ENABLED);
	});
});

test("tourConfigPath nests config.json directly under the project root, alongside active.json", async () => {
	assert.equal(tourConfigPath("/tmp/x"), join("/tmp/x", "config.json"));
});

test("resolveNextPaneState: 'on' sets enabled regardless of current", () => {
	assert.deepEqual(resolveNextPaneState("on", false), { kind: "set", enabled: true });
	assert.deepEqual(resolveNextPaneState("on", true), { kind: "set", enabled: true });
});

test("resolveNextPaneState: 'off' sets disabled regardless of current", () => {
	assert.deepEqual(resolveNextPaneState("off", true), { kind: "set", enabled: false });
	assert.deepEqual(resolveNextPaneState("off", false), { kind: "set", enabled: false });
});

test("resolveNextPaneState: 'toggle' flips current", () => {
	assert.deepEqual(resolveNextPaneState("toggle", true), { kind: "set", enabled: false });
	assert.deepEqual(resolveNextPaneState("toggle", false), { kind: "set", enabled: true });
});

test("resolveNextPaneState: 'status' reports current without changing it", () => {
	assert.deepEqual(resolveNextPaneState("status", true), { kind: "report", enabled: true });
	assert.deepEqual(resolveNextPaneState("status", false), { kind: "report", enabled: false });
});

test("resolveNextPaneState: a bare/empty argument is treated the same as 'status'", () => {
	assert.deepEqual(resolveNextPaneState("", true), { kind: "report", enabled: true });
	assert.deepEqual(resolveNextPaneState("   ", false), { kind: "report", enabled: false });
});

test("resolveNextPaneState: an unrecognized argument is invalid", () => {
	assert.deepEqual(resolveNextPaneState("nonsense", true), { kind: "invalid" });
	assert.deepEqual(resolveNextPaneState("on off", true), { kind: "invalid" });
});

test("resolveNextPaneState: arguments are case-insensitive", () => {
	assert.deepEqual(resolveNextPaneState("ON", false), { kind: "set", enabled: true });
	assert.deepEqual(resolveNextPaneState("Toggle", true), { kind: "set", enabled: false });
});
