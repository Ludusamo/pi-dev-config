import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildTourContextMessage,
	buildTourIndexText,
	dropStaleTourContext,
	resolveTourContextContent,
	TOUR_CONTEXT_CUSTOM_TYPE,
} from "../inject.ts";
import type { Tour } from "../types.ts";

function makeTour(overrides: Partial<Tour> = {}): Tour {
	return {
		id: "tour-1",
		topic: "Auth flow",
		style: "mixed",
		status: "in-progress",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		stops: [
			{ id: "stop-1", title: "Entry point", summary: "Where requests come in", files: ["src/index.ts"], notes: [] },
			{ id: "stop-2", title: "Session store", summary: "Where sessions live", files: [], notes: [] },
		],
		currentStopIndex: 0,
		completedStopIds: [],
		...overrides,
	};
}

test("buildTourContextMessage produces a hidden custom message", () => {
	const message = buildTourContextMessage("status text");
	assert.equal(message.customType, TOUR_CONTEXT_CUSTOM_TYPE);
	assert.equal(message.content, "status text");
	assert.equal(message.display, false);
});

test("buildTourIndexText is empty when there is no tour", () => {
	assert.equal(buildTourIndexText(undefined), "");
});

test("buildTourIndexText is empty for a tour that is not in-progress", () => {
	assert.equal(buildTourIndexText(makeTour({ status: "completed" })), "");
});

test("buildTourIndexText marks the current stop and lists files", () => {
	const text = buildTourIndexText(makeTour());
	assert.match(text, /Auth flow/);
	assert.match(text, /-> 1\. Entry point \[current\] \(src\/index\.ts\)/);
	assert.match(text, /2\. Session store \[pending\]/);
});

test("buildTourIndexText marks completed stops as done", () => {
	const text = buildTourIndexText(makeTour({ currentStopIndex: 1, completedStopIds: ["stop-1"] }));
	assert.match(text, /1\. Entry point \[done\]/);
	assert.match(text, /-> 2\. Session store \[current\]/);
});

test("buildTourIndexText includes the current focus when set", () => {
	const text = buildTourIndexText(makeTour({ focus: { file: "src/index.ts", startLine: 12, endLine: 30, label: "entry point" } }));
	assert.match(text, /Current focus: src\/index\.ts:12-30 - entry point/);
});

test("buildTourIndexText lists the current stop's anchors, including beyond the first", () => {
	const tour = makeTour({
		stops: [
			{
				id: "stop-1",
				title: "Entry point",
				summary: "Where requests come in",
				files: ["src/index.ts"],
				anchors: [
					{ file: "src/index.ts", startLine: 1, endLine: 10 },
					{ file: "src/router.ts", startLine: 5, label: "dispatch" },
				],
				notes: [],
			},
			{ id: "stop-2", title: "Session store", summary: "Where sessions live", files: [], notes: [] },
		],
	});
	const text = buildTourIndexText(tour);
	assert.match(text, /anchor: src\/index\.ts:1-10/);
	assert.match(text, /anchor: src\/router\.ts:5 - dispatch/);
});

test("buildTourIndexText does not list anchors for a stop that isn't current", () => {
	const tour = makeTour({
		currentStopIndex: 1,
		stops: [
			{
				id: "stop-1",
				title: "Entry point",
				summary: "Where requests come in",
				files: [],
				anchors: [{ file: "src/index.ts", startLine: 1 }],
				notes: [],
			},
			{ id: "stop-2", title: "Session store", summary: "Where sessions live", files: [], notes: [] },
		],
	});
	const text = buildTourIndexText(tour);
	assert.doesNotMatch(text, /anchor:/);
});

test("buildTourIndexText omits the focus line when there is no focus", () => {
	const text = buildTourIndexText(makeTour());
	assert.doesNotMatch(text, /Current focus:/);
});

test("buildTourIndexText sanitizes embedded newlines in the focus label", () => {
	const text = buildTourIndexText(makeTour({ focus: { file: "a.ts", label: "line1\nline2" } }));
	assert.equal(
		text.split("\n").some((line) => line.trim() === "line2"),
		false,
	);
	assert.match(text, /Current focus: a\.ts - line1 line2/);
});

test("buildTourIndexText sanitizes embedded newlines so they can't forge a fake index line", () => {
	const tour = makeTour({ topic: "line1\nline2", stops: [{ id: "s", title: "t\nitle", summary: "s", files: ["a\nb"], notes: [] }] });
	const text = buildTourIndexText(tour);
	// The embedded newline is collapsed to a space, so "line2" never appears as its own line.
	assert.equal(
		text.split("\n").some((line) => line.trim() === "line2"),
		false,
	);
	assert.match(text, /line1 line2/);
});

test("resolveTourContextContent stays quiet while there has never been a tour", () => {
	assert.equal(resolveTourContextContent("", undefined), undefined);
});

test("resolveTourContextContent injects new content when it changes", () => {
	assert.equal(resolveTourContextContent("status v1", undefined), "status v1");
	assert.equal(resolveTourContextContent("status v2", "status v1"), "status v2");
});

test("resolveTourContextContent is a no-op when content is unchanged", () => {
	assert.equal(resolveTourContextContent("status v1", "status v1"), undefined);
});

test("resolveTourContextContent sends the no-tour sentinel once a tour ends", () => {
	assert.equal(resolveTourContextContent("", "status v1"), "Codebase tour: no tour in progress.");
});

test("resolveTourContextContent does not repeat the no-tour sentinel every turn", () => {
	assert.equal(resolveTourContextContent("", "Codebase tour: no tour in progress."), undefined);
});

test("dropStaleTourContext keeps only the latest tour-context message", () => {
	const messages = [
		{ role: "user", content: "hi" },
		{ role: "custom", customType: TOUR_CONTEXT_CUSTOM_TYPE, content: "old" },
		{ role: "assistant", content: "ok" },
		{ role: "custom", customType: TOUR_CONTEXT_CUSTOM_TYPE, content: "new" },
		{ role: "custom", customType: "something-else", content: "unrelated" },
	];
	const result = dropStaleTourContext(messages);
	assert.equal(result.length, 4);
	assert.deepEqual(
		result.map((m) => (m as { content: string }).content),
		["hi", "ok", "new", "unrelated"],
	);
});

test("dropStaleTourContext is a no-op when there is no tour-context message", () => {
	const messages = [{ role: "user", content: "hi" }];
	assert.deepEqual(dropStaleTourContext(messages), messages);
});
