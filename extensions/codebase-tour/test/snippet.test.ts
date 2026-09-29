import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
	clampSnippetRange,
	DEFAULT_PREVIEW_LINES,
	MAX_SNIPPET_LINES,
	readSnippet,
	sanitizeSnippetLine,
	truncateLineWidth,
} from "../snippet.ts";

async function withTmpCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tour-snippet-test-"));
	try {
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("clampSnippetRange previews the top of the file when neither line is given", () => {
	const { start, end, truncated, requestedEnd } = clampSnippetRange(undefined, undefined, 100);
	assert.equal(start, 1);
	assert.equal(end, DEFAULT_PREVIEW_LINES);
	// The file has 100 lines but only DEFAULT_PREVIEW_LINES are shown - that's
	// truncation, even though no explicit range was ever requested.
	assert.equal(truncated, true);
	assert.equal(requestedEnd, 100);
});

test("clampSnippetRange reports no truncation for a whole-file preview that already covers every line", () => {
	const { start, end, truncated } = clampSnippetRange(undefined, undefined, DEFAULT_PREVIEW_LINES);
	assert.equal(start, 1);
	assert.equal(end, DEFAULT_PREVIEW_LINES);
	assert.equal(truncated, false);
});

test("clampSnippetRange uses a short default window when only startLine is given", () => {
	const { start, end } = clampSnippetRange(10, undefined, 100);
	assert.equal(start, 10);
	assert.equal(end, 10 + DEFAULT_PREVIEW_LINES - 1);
});

test("clampSnippetRange respects an explicit tight range", () => {
	const { start, end, truncated } = clampSnippetRange(5, 8, 100);
	assert.equal(start, 5);
	assert.equal(end, 8);
	assert.equal(truncated, false);
});

test("clampSnippetRange clamps a range past the end of the file", () => {
	const { start, end } = clampSnippetRange(95, 200, 100);
	assert.equal(start, 95);
	assert.equal(end, 100);
});

test("clampSnippetRange caps an oversized requested range at maxLines and reports truncation", () => {
	const { start, end, truncated, requestedEnd } = clampSnippetRange(1, 1000, 1000, {
		defaultWindow: DEFAULT_PREVIEW_LINES,
		maxLines: MAX_SNIPPET_LINES,
	});
	assert.equal(start, 1);
	assert.equal(end, MAX_SNIPPET_LINES);
	assert.equal(truncated, true);
	// requestedEnd reports the requested endLine that got cut, not just the file's total.
	assert.equal(requestedEnd, 1000);
});

test("clampSnippetRange ignores an endLine before startLine and falls back to the default window", () => {
	const { start, end } = clampSnippetRange(20, 5, 100);
	assert.equal(start, 20);
	assert.equal(end, 20 + DEFAULT_PREVIEW_LINES - 1);
});

test("clampSnippetRange treats a startLine past the end of the file as the last line", () => {
	const { start, end } = clampSnippetRange(500, undefined, 100);
	assert.equal(start, 100);
	assert.equal(end, 100);
});

test("truncateLineWidth leaves short lines untouched", () => {
	assert.equal(truncateLineWidth("short line", 200), "short line");
});

test("truncateLineWidth truncates long lines with a marker", () => {
	const line = "x".repeat(250);
	const result = truncateLineWidth(line, 200);
	assert.equal(result.length, 200);
	assert.ok(result.endsWith("..."));
});

test("truncateLineWidth strips a trailing carriage return from CRLF line endings", () => {
	assert.equal(truncateLineWidth("code here\r", 200), "code here");
});

test("readSnippet reads a tight, explicit line range", async () => {
	await withTmpCwd(async (cwd) => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		await writeFile(join(cwd, "file.ts"), lines.join("\n"), "utf-8");
		const result = await readSnippet({ file: "file.ts", startLine: 3, endLine: 5 }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.startLine, 3);
			assert.equal(result.endLine, 5);
			assert.deepEqual(result.lines, ["line 3", "line 4", "line 5"]);
			assert.equal(result.totalLines, 20);
			assert.equal(result.truncated, false);
		}
	});
});

test("readSnippet previews the top of the file when no line range is given", async () => {
	await withTmpCwd(async (cwd) => {
		const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
		await writeFile(join(cwd, "file.ts"), lines.join("\n"), "utf-8");
		const result = await readSnippet({ file: "file.ts" }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.startLine, 1);
			assert.equal(result.endLine, 5);
			assert.deepEqual(result.lines, lines);
		}
	});
});

test("readSnippet reports a missing file as an error, not a throw", async () => {
	await withTmpCwd(async (cwd) => {
		const result = await readSnippet({ file: "does-not-exist.ts" }, cwd);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /could not read file/);
	});
});

test("readSnippet refuses a path that escapes the project directory", async () => {
	await withTmpCwd(async (cwd) => {
		// mkdtemp creates both dirs as siblings under the same os.tmpdir() parent,
		// so a plain ".." from cwd reaches outside without needing an absolute path.
		const outside = await mkdtemp(join(tmpdir(), "pi-tour-snippet-outside-"));
		try {
			await writeFile(join(outside, "secret.ts"), "top secret", "utf-8");
			const relative = join("..", basename(outside), "secret.ts");
			const result = await readSnippet({ file: relative }, cwd);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /outside the project directory/);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("readSnippet refuses a path that escapes the project directory via a symlink", async () => {
	await withTmpCwd(async (cwd) => {
		const outside = await mkdtemp(join(tmpdir(), "pi-tour-snippet-outside-"));
		try {
			await writeFile(join(outside, "secret.ts"), "top secret", "utf-8");
			await symlink(outside, join(cwd, "link"));
			const result = await readSnippet({ file: "link/secret.ts" }, cwd);
			assert.equal(result.ok, false);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test("readSnippet preserves the label on both success and error results", async () => {
	await withTmpCwd(async (cwd) => {
		await writeFile(join(cwd, "file.ts"), "one\ntwo", "utf-8");
		const ok = await readSnippet({ file: "file.ts", label: "the thing" }, cwd);
		assert.equal(ok.label, "the thing");
		const err = await readSnippet({ file: "missing.ts", label: "the thing" }, cwd);
		assert.equal(err.label, "the thing");
	});
});

test("readSnippet reports truncation and the accurate totalLines for a default preview shorter than the file", async () => {
	await withTmpCwd(async (cwd) => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		await writeFile(join(cwd, "file.ts"), lines.join("\n"), "utf-8");
		const result = await readSnippet({ file: "file.ts" }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.startLine, 1);
			assert.equal(result.endLine, DEFAULT_PREVIEW_LINES);
			assert.equal(result.totalLines, 100);
			assert.equal(result.truncated, true);
		}
	});
});

test("readSnippet reports the requested end line that got cut when an explicit range exceeds MAX_SNIPPET_LINES", async () => {
	await withTmpCwd(async (cwd) => {
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
		await writeFile(join(cwd, "file.ts"), lines.join("\n"), "utf-8");
		const result = await readSnippet({ file: "file.ts", startLine: 1, endLine: 300 }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.startLine, 1);
			assert.equal(result.endLine, MAX_SNIPPET_LINES);
			assert.equal(result.requestedEnd, 300);
			assert.equal(result.truncated, true);
		}
	});
});

test("readSnippet does not count a single trailing newline as an extra phantom line", async () => {
	await withTmpCwd(async (cwd) => {
		await writeFile(join(cwd, "file.ts"), "line 1\nline 2\nline 3\n", "utf-8");
		const result = await readSnippet({ file: "file.ts" }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.totalLines, 3);
			assert.deepEqual(result.lines, ["line 1", "line 2", "line 3"]);
			assert.equal(result.truncated, false);
		}
	});
});

test("readSnippet still counts genuine trailing blank lines, just not the final EOF newline", async () => {
	await withTmpCwd(async (cwd) => {
		await writeFile(join(cwd, "file.ts"), "line 1\n\n\n", "utf-8");
		const result = await readSnippet({ file: "file.ts" }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.totalLines, 3);
			assert.deepEqual(result.lines, ["line 1", "", ""]);
		}
	});
});

test("readSnippet strips ANSI escape codes and control characters from returned lines", async () => {
	await withTmpCwd(async (cwd) => {
		const content = "safe\x1b[31mred text\x1b[0m and \x07bell\x01ctrl";
		await writeFile(join(cwd, "file.ts"), content, "utf-8");
		const result = await readSnippet({ file: "file.ts" }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.lines, ["safered text and bellctrl"]);
		}
	});
});

test("readSnippet preserves tabs while stripping other control characters", () => {
	assert.equal(sanitizeSnippetLine("a\tb"), "a\tb");
});

test("readSnippet reports an oversized file as an error instead of reading it", async () => {
	await withTmpCwd(async (cwd) => {
		await writeFile(join(cwd, "big.ts"), "x".repeat(1000), "utf-8");
		const result = await readSnippet({ file: "big.ts" }, cwd, { maxFileBytes: 100 });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /too large to preview/);
	});
});

test("readSnippet reads a file within the size cap normally", async () => {
	await withTmpCwd(async (cwd) => {
		await writeFile(join(cwd, "small.ts"), "hello", "utf-8");
		const result = await readSnippet({ file: "small.ts" }, cwd, { maxFileBytes: 100 });
		assert.equal(result.ok, true);
	});
});

test("readSnippet reads a nested file with only startLine given", async () => {
	await withTmpCwd(async (cwd) => {
		await mkdir(dirname(join(cwd, "sub", "file.ts")), { recursive: true });
		await writeFile(join(cwd, "sub", "file.ts"), "a\nb\nc", "utf-8");
		const result = await readSnippet({ file: "sub/file.ts", startLine: 2 }, cwd);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.lines, ["b", "c"]);
	});
});
