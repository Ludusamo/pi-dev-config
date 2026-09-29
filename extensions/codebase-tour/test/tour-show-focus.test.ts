/**
 * Regression coverage for tour_show's focus handling: a failed readSnippet
 * (missing file, out-of-root path, etc.) must not clobber the tour's current
 * focus with an anchor that couldn't actually be shown. Drives store.ts and
 * snippet.ts together the same way index.ts's tour_show handler does, rather
 * than importing index.ts directly - see sentinel-lifecycle.test.ts for why
 * (index.ts pulls in pi-coding-agent/typebox, which the test harness can't
 * resolve standalone).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSnippet } from "../snippet.ts";
import * as store from "../store.ts";
import type { Tour, TourAnchor } from "./../types.ts";

async function withTmpDirs(fn: (storeRoot: string, anchorRoot: string) => Promise<void>): Promise<void> {
	const storeRoot = await mkdtemp(join(tmpdir(), "pi-tour-show-store-test-"));
	const anchorRoot = await mkdtemp(join(tmpdir(), "pi-tour-show-anchor-test-"));
	try {
		await fn(storeRoot, anchorRoot);
	} finally {
		await rm(storeRoot, { recursive: true, force: true });
		await rm(anchorRoot, { recursive: true, force: true });
	}
}

function makeTour(focus?: TourAnchor): Tour {
	const now = new Date().toISOString();
	return {
		id: store.generateTourId("Auth flow"),
		topic: "Auth flow",
		style: "mixed",
		status: "in-progress",
		createdAt: now,
		updatedAt: now,
		stops: store.buildStops([{ title: "Entry point", summary: "Where requests come in" }]),
		currentStopIndex: -1,
		completedStopIds: [],
		focus,
	};
}

/** Mimics tour_show's execute handler: only sets/persists focus when readSnippet succeeds. */
async function simulateTourShow(storeRoot: string, anchorRoot: string, anchor: TourAnchor) {
	const tour = await store.loadActiveTour(storeRoot);
	if (!tour) throw new Error("no active tour");
	const snippet = await readSnippet(anchor, anchorRoot);
	if (snippet.ok) {
		tour.focus = anchor;
		tour.updatedAt = new Date().toISOString();
		await store.saveActiveTour(storeRoot, tour);
	}
	return snippet;
}

test("tour_show keeps the previous focus when readSnippet fails", async () => {
	await withTmpDirs(async (storeRoot, anchorRoot) => {
		const previousFocus: TourAnchor = { file: "src/index.ts", startLine: 1, endLine: 5 };
		await store.saveActiveTour(storeRoot, makeTour(previousFocus));

		const snippet = await simulateTourShow(storeRoot, anchorRoot, { file: "does-not-exist.ts" });
		assert.equal(snippet.ok, false);

		const reloaded = await store.loadActiveTour(storeRoot);
		assert.deepEqual(reloaded?.focus, previousFocus);
	});
});

test("tour_show updates the focus when readSnippet succeeds", async () => {
	await withTmpDirs(async (storeRoot, anchorRoot) => {
		const previousFocus: TourAnchor = { file: "old.ts", startLine: 1 };
		await writeFile(join(anchorRoot, "new.ts"), "a\nb\nc", "utf-8");
		await store.saveActiveTour(storeRoot, makeTour(previousFocus));

		const newAnchor: TourAnchor = { file: "new.ts", startLine: 1, endLine: 2 };
		const snippet = await simulateTourShow(storeRoot, anchorRoot, newAnchor);
		assert.equal(snippet.ok, true);

		const reloaded = await store.loadActiveTour(storeRoot);
		assert.deepEqual(reloaded?.focus, newAnchor);
	});
});
