import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnchorList, formatAnchorLocation, formatLocationWidgetLines, formatSnippetText } from "../panel.ts";
import type { SnippetResult } from "../snippet.ts";

test("formatAnchorLocation renders a bare file when there's no line range", () => {
	assert.equal(formatAnchorLocation({ file: "src/index.ts" }), "src/index.ts");
});

test("formatAnchorLocation renders a single line", () => {
	assert.equal(formatAnchorLocation({ file: "src/index.ts", startLine: 12 }), "src/index.ts:12");
});

test("formatAnchorLocation renders a range", () => {
	assert.equal(formatAnchorLocation({ file: "src/index.ts", startLine: 12, endLine: 30 }), "src/index.ts:12-30");
});

test("formatAnchorLocation collapses a same-line range to a single line number", () => {
	assert.equal(formatAnchorLocation({ file: "src/index.ts", startLine: 12, endLine: 12 }), "src/index.ts:12");
});

test("formatSnippetText renders a numbered, headered block on success", () => {
	const snippet: SnippetResult = {
		ok: true,
		file: "src/index.ts",
		label: "entry point",
		startLine: 10,
		endLine: 12,
		lines: ["const a = 1;", "const b = 2;", "const c = 3;"],
		truncated: false,
		requestedEnd: 12,
		totalLines: 100,
	};
	const text = formatSnippetText(snippet);
	assert.match(text, /^src\/index\.ts:10-12 - entry point/);
	assert.match(text, /10\| const a = 1;/);
	assert.match(text, /12\| const c = 3;/);
	assert.doesNotMatch(text, /truncated/);
});

test("formatSnippetText notes truncation when the range was cut short, including the requested end line", () => {
	const snippet: SnippetResult = {
		ok: true,
		file: "src/index.ts",
		startLine: 1,
		endLine: 60,
		lines: Array(60).fill("x"),
		truncated: true,
		requestedEnd: 300,
		totalLines: 500,
	};
	const text = formatSnippetText(snippet);
	assert.match(text, /truncated at line 60/);
	assert.match(text, /requested through line 300/);
	assert.match(text, /500 lines total/);
});

test("formatSnippetText renders the error message on failure", () => {
	const snippet: SnippetResult = { ok: false, file: "missing.ts", error: "could not read file" };
	assert.equal(formatSnippetText(snippet), "missing.ts: could not read file");
});

test("formatAnchorList is empty when there are no anchors", () => {
	assert.equal(formatAnchorList(undefined), "");
	assert.equal(formatAnchorList([]), "");
});

test("formatAnchorList lists every anchor, not just the first", () => {
	const anchors = [
		{ file: "src/a.ts", startLine: 1, endLine: 10 },
		{ file: "src/b.ts", startLine: 20, label: "helper" },
	];
	assert.equal(formatAnchorList(anchors), "src/a.ts:1-10, src/b.ts:20 (helper)");
});

test("formatLocationWidgetLines is empty when there is no focus", () => {
	assert.deepEqual(formatLocationWidgetLines(undefined, "Auth flow"), []);
});

test("formatLocationWidgetLines includes the tour topic when given", () => {
	const lines = formatLocationWidgetLines({ file: "src/index.ts", startLine: 12, endLine: 30, label: "entry point" }, "Auth flow");
	assert.deepEqual(lines, ["Tour: Auth flow @ src/index.ts:12-30 - entry point"]);
});

test("formatLocationWidgetLines falls back to a generic prefix without a tour topic", () => {
	const lines = formatLocationWidgetLines({ file: "src/index.ts" }, undefined);
	assert.deepEqual(lines, ["Tour location: src/index.ts"]);
});

test("formatLocationWidgetLines sanitizes embedded newlines in the label so they can't forge extra widget lines", () => {
	const lines = formatLocationWidgetLines({ file: "src/index.ts", label: "line1\nline2" }, "Auth flow");
	assert.equal(lines.length, 1);
	assert.match(lines[0], /line1 line2/);
});
