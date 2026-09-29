/**
 * Regression coverage for the stale-sentinel bug: index.ts's mutating tool/
 * command handlers used to reset the cached `lastIndexContent` themselves
 * right after a mutation, including tour_end and `/tour end`. That meant the
 * very next before_agent_start call saw `lastContent === undefined`, and
 * `resolveTourContextContent("", undefined)` stays quiet (see inject.test.ts)
 * - so the "no tour in progress" sentinel was never actually injected, and
 * whatever hidden status message the model last saw stayed uncontradicted.
 *
 * These tests drive store.ts and inject.ts together the same way
 * before_agent_start does, across a plan -> end lifecycle, to pin the
 * correct behavior: `lastIndexContent` must only change based on what was
 * actually injected, never be reset early by a mutation.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTourIndexText, resolveTourContextContent } from "../inject.ts";
import * as store from "../store.ts";
import type { Tour } from "../types.ts";

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-tour-sentinel-test-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function makeTour(): Tour {
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
	};
}

/** Mimics one before_agent_start turn: load state, resolve what (if anything) to inject. */
async function simulateTurn(root: string, lastIndexContent: string | undefined): Promise<string | undefined> {
	const tour = await store.loadActiveTour(root);
	const index = buildTourIndexText(tour);
	return resolveTourContextContent(index, lastIndexContent);
}

test("ending a tour surfaces the no-tour sentinel on the very next turn", async () => {
	await withTmpRoot(async (root) => {
		await store.saveActiveTour(root, makeTour());

		// Turn 1: the in-progress tour is injected.
		let lastIndexContent = await simulateTurn(root, undefined);
		assert.ok(lastIndexContent);
		assert.match(lastIndexContent, /Auth flow/);

		// tour_end (or `/tour end`) archives the tour. The bug was resetting
		// lastIndexContent to undefined right here; it must not be touched -
		// only loading fresh state on the next turn should change it.
		await store.archiveActiveTour(root, "completed");

		// Turn 2: no active tour, but the model was just shown one - the
		// sentinel must fire so it isn't left with stale, uncontradicted state.
		const content = await simulateTurn(root, lastIndexContent);
		assert.equal(content, "Codebase tour: no tour in progress.");
	});
});

test("without the fix (lastIndexContent cleared on mutation), the sentinel is silently skipped", async () => {
	await withTmpRoot(async (root) => {
		await store.saveActiveTour(root, makeTour());
		await simulateTurn(root, undefined);
		await store.archiveActiveTour(root, "completed");

		// Simulates the old buggy handler behavior of clearing the cache itself.
		const buggyLastIndexContent = undefined;
		const content = await simulateTurn(root, buggyLastIndexContent);
		assert.equal(content, undefined, "demonstrates why clearing the cache early swallows the sentinel");
	});
});

test("re-planning over an in-progress tour does not spuriously re-send the same status", async () => {
	await withTmpRoot(async (root) => {
		await store.saveActiveTour(root, makeTour());
		const lastIndexContent = await simulateTurn(root, undefined);

		// A mutation that doesn't change the injected text (e.g. a no-op save)
		// must not cause a duplicate injection on the next turn.
		const content = await simulateTurn(root, lastIndexContent);
		assert.equal(content, undefined);
	});
});
