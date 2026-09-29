import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeTourPath, historyDir, historyTourPath } from "../paths.ts";
import * as store from "../store.ts";
import type { Tour } from "../types.ts";

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-tour-store-test-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeAndLoad(root: string, value: unknown): Promise<Tour | undefined> {
	await writeFile(activeTourPath(root), JSON.stringify(value), "utf-8");
	return store.loadActiveTour(root);
}

function makeTour(overrides: Partial<Tour> = {}): Tour {
	const now = new Date().toISOString();
	return {
		id: store.generateTourId(overrides.topic ?? "Auth flow"),
		topic: "Auth flow",
		style: "mixed",
		status: "in-progress",
		createdAt: now,
		updatedAt: now,
		stops: store.buildStops([{ title: "Entry point", summary: "Where requests come in" }]),
		currentStopIndex: -1,
		completedStopIds: [],
		...overrides,
	};
}

test("generateTourId slugifies the topic and appends a random suffix", () => {
	const id = store.generateTourId("Auth Flow!!");
	assert.match(id, /^auth-flow-[0-9a-f]{6}$/);
});

test("generateTourId falls back to a bare suffix for an unsluggable topic", () => {
	const id = store.generateTourId("!!!");
	assert.match(id, /^tour-[0-9a-f]{6}$/);
});

test("buildStops assigns stable, ordered ids and defaults files/notes", () => {
	const stops = store.buildStops([
		{ title: "First Stop", summary: "s1" },
		{ title: "Second Stop", summary: "s2", files: ["a.ts"] },
	]);
	assert.equal(stops[0].id, "stop-1-first-stop");
	assert.equal(stops[1].id, "stop-2-second-stop");
	assert.deepEqual(stops[0].files, []);
	assert.deepEqual(stops[1].files, ["a.ts"]);
	assert.deepEqual(stops[0].notes, []);
});

test("buildStops passes anchors through when given, and leaves them undefined otherwise", () => {
	const anchors = [{ file: "a.ts", startLine: 1, endLine: 5 }];
	const stops = store.buildStops([
		{ title: "First Stop", summary: "s1" },
		{ title: "Second Stop", summary: "s2", anchors },
	]);
	assert.equal(stops[0].anchors, undefined);
	assert.deepEqual(stops[1].anchors, anchors);
});

test("loadActiveTour returns undefined when nothing has been saved", async () => {
	await withTmpRoot(async (root) => {
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("saveActiveTour then loadActiveTour round-trips the tour", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		await store.saveActiveTour(root, tour);
		const loaded = await store.loadActiveTour(root);
		assert.deepEqual(loaded, tour);
	});
});

test("loadActiveTour treats a corrupt active.json as no tour rather than throwing", async () => {
	await withTmpRoot(async (root) => {
		await writeFile(activeTourPath(root), "{ not json", "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour with an invalid id", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		await writeFile(activeTourPath(root), JSON.stringify({ ...tour, id: "../escape" }), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour with an invalid style", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		await writeFile(activeTourPath(root), JSON.stringify({ ...tour, style: "freeform" }), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour with an invalid status", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		await writeFile(activeTourPath(root), JSON.stringify({ ...tour, status: "paused" }), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour whose currentStopIndex is out of range", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour({ currentStopIndex: 5 });
		await writeFile(activeTourPath(root), JSON.stringify(tour), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour whose currentStopIndex is below -1", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour({ currentStopIndex: -2 });
		await writeFile(activeTourPath(root), JSON.stringify(tour), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour with non-string completedStopIds", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		await writeFile(activeTourPath(root), JSON.stringify({ ...tour, completedStopIds: [1, 2] }), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("loadActiveTour rejects a tour whose stops are malformed (bad id, missing files/notes arrays)", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		const badStopId = { ...tour, stops: [{ ...tour.stops[0], id: "Bad Id!" }] };
		assert.equal(await writeAndLoad(root, badStopId), undefined);

		const missingFiles = { ...tour, stops: [{ id: tour.stops[0].id, title: "t", summary: "s", notes: [] }] };
		assert.equal(await writeAndLoad(root, missingFiles), undefined);

		const missingNotes = { ...tour, stops: [{ id: tour.stops[0].id, title: "t", summary: "s", files: [] }] };
		assert.equal(await writeAndLoad(root, missingNotes), undefined);
	});
});

test("loadActiveTour accepts a stop with no anchors field (pre-existing tours predate anchors)", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		assert.equal(tour.stops[0].anchors, undefined);
		await writeFile(activeTourPath(root), JSON.stringify(tour), "utf-8");
		const loaded = await store.loadActiveTour(root);
		assert.deepEqual(loaded, tour);
	});
});

test("loadActiveTour accepts and round-trips valid anchors on a stop", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		const withAnchors = {
			...tour,
			stops: [{ ...tour.stops[0], anchors: [{ file: "a.ts", startLine: 1, endLine: 5, label: "thing" }] }],
		};
		const loaded = await writeAndLoad(root, withAnchors);
		assert.deepEqual(loaded, withAnchors);
	});
});

test("loadActiveTour rejects a stop whose anchors are malformed", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		const missingFile = { ...tour, stops: [{ ...tour.stops[0], anchors: [{ startLine: 1 }] }] };
		assert.equal(await writeAndLoad(root, missingFile), undefined);

		const badStartLine = { ...tour, stops: [{ ...tour.stops[0], anchors: [{ file: "a.ts", startLine: 0 }] }] };
		assert.equal(await writeAndLoad(root, badStartLine), undefined);

		const nonArrayAnchors = { ...tour, stops: [{ ...tour.stops[0], anchors: "a.ts" }] };
		assert.equal(await writeAndLoad(root, nonArrayAnchors), undefined);
	});
});

test("loadActiveTour accepts a tour with no focus field (pre-existing tours predate focus)", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		assert.equal(tour.focus, undefined);
		await writeFile(activeTourPath(root), JSON.stringify(tour), "utf-8");
		const loaded = await store.loadActiveTour(root);
		assert.deepEqual(loaded, tour);
	});
});

test("loadActiveTour accepts and round-trips a valid focus", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour({ focus: { file: "a.ts", startLine: 3 } });
		const loaded = await writeAndLoad(root, tour);
		assert.deepEqual(loaded, tour);
	});
});

test("loadActiveTour rejects a tour with a malformed focus", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		assert.equal(await writeAndLoad(root, { ...tour, focus: { startLine: 1 } }), undefined);
		assert.equal(await writeAndLoad(root, { ...tour, focus: { file: "a.ts", endLine: -1 } }), undefined);
	});
});

test("loadActiveTour rejects a tour with an empty stops array", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour({ stops: [], currentStopIndex: -1 });
		await writeFile(activeTourPath(root), JSON.stringify(tour), "utf-8");
		assert.equal(await store.loadActiveTour(root), undefined);
	});
});

test("archiveActiveTour is a no-op when there is no active tour", async () => {
	await withTmpRoot(async (root) => {
		assert.equal(await store.archiveActiveTour(root, "abandoned"), undefined);
	});
});

test("archiveActiveTour moves the active tour into history and clears the active slot", async () => {
	await withTmpRoot(async (root) => {
		const tour = makeTour();
		await store.saveActiveTour(root, tour);

		const archived = await store.archiveActiveTour(root, "completed");
		assert.ok(archived);
		assert.equal(archived.status, "completed");
		assert.equal(archived.id, tour.id);

		assert.equal(await store.loadActiveTour(root), undefined);
		const history = await store.listHistory(root);
		assert.equal(history.length, 1);
		assert.equal(history[0].id, tour.id);
		assert.equal(history[0].status, "completed");
	});
});

test("listHistory is empty when there is no history directory yet", async () => {
	await withTmpRoot(async (root) => {
		assert.deepEqual(await store.listHistory(root), []);
	});
});

// Written directly to the history dir (rather than via saveActiveTour +
// archiveActiveTour, which stamps updatedAt with the real current time) so
// ordering depends only on the updatedAt values below, not on wall-clock
// timing between two calls.
test("listHistory sorts by most recently updated first", async () => {
	await withTmpRoot(async (root) => {
		const older = makeTour({ topic: "First", updatedAt: "2024-01-01T00:00:00.000Z" });
		const newer = makeTour({ topic: "Second", updatedAt: "2024-06-01T00:00:00.000Z" });
		await mkdir(historyDir(root), { recursive: true });
		await writeFile(historyTourPath(root, older.id), JSON.stringify(older), "utf-8");
		await writeFile(historyTourPath(root, newer.id), JSON.stringify(newer), "utf-8");

		const history = await store.listHistory(root);
		assert.equal(history.length, 2);
		assert.equal(history[0].topic, "Second");
		assert.equal(history[1].topic, "First");
	});
});

test("listHistory breaks a tied updatedAt deterministically by id", async () => {
	await withTmpRoot(async (root) => {
		const tied = "2024-01-01T00:00:00.000Z";
		const a = makeTour({ topic: "Alpha", updatedAt: tied });
		const b = makeTour({ topic: "Beta", updatedAt: tied });
		await mkdir(historyDir(root), { recursive: true });
		await writeFile(historyTourPath(root, a.id), JSON.stringify(a), "utf-8");
		await writeFile(historyTourPath(root, b.id), JSON.stringify(b), "utf-8");

		const expectedIds = [a.id, b.id].sort((x, y) => x.localeCompare(y));
		const history = await store.listHistory(root);
		assert.deepEqual(history.map((s) => s.id), expectedIds);

		// Order must be stable across repeated calls, not incidentally matching readdir order once.
		const historyAgain = await store.listHistory(root);
		assert.deepEqual(historyAgain.map((s) => s.id), expectedIds);
	});
});

test("toSummary reports stop and completion counts", () => {
	const tour = makeTour({
		stops: store.buildStops([
			{ title: "One", summary: "s" },
			{ title: "Two", summary: "s" },
		]),
		completedStopIds: ["stop-1-one"],
	});
	const summary = store.toSummary(tour);
	assert.equal(summary.stopCount, 2);
	assert.equal(summary.completedStopCount, 1);
});
