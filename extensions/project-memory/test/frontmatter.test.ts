import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeEntry, serializeFrontmatter } from "../frontmatter.ts";

/**
 * Minimal parser matching the exact `key: <JSON>` format serializeFrontmatter
 * emits. Used only in tests so we don't need pi's real parseFrontmatter (a
 * thin wrapper around the `yaml` package) as a test dependency.
 */
function testParseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {} as T, body: content };
	const [, yamlBlock, body] = match;
	const frontmatter: Record<string, unknown> = {};
	for (const line of yamlBlock.split("\n")) {
		if (!line.trim()) continue;
		const idx = line.indexOf(": ");
		const key = line.slice(0, idx);
		const value = line.slice(idx + 2);
		frontmatter[key] = JSON.parse(value);
	}
	return { frontmatter: frontmatter as T, body: body.trim() };
}

test("serializeFrontmatter emits JSON-valued lines", () => {
	const text = serializeFrontmatter({ id: "abc", tags: ["a", "b"], count: 3, flag: true, missing: undefined });
	assert.match(text, /^---\n/);
	assert.match(text, /\n---\n$/);
	assert.match(text, /id: "abc"/);
	assert.match(text, /tags: \["a","b"\]/);
	assert.match(text, /count: 3/);
	assert.match(text, /flag: true/);
	assert.doesNotMatch(text, /missing/);
});

test("serializeEntry round-trips through a JSON-per-line parser", () => {
	const frontmatter = {
		id: "my-entry-abc123",
		title: "Some title with \"quotes\" and, commas",
		tags: ["tag-one", "tag two"],
		status: "active",
	};
	const body = "Body line one.\nBody line two.";
	const content = serializeEntry(frontmatter, body);
	const parsed = testParseFrontmatter<typeof frontmatter>(content);
	assert.deepEqual(parsed.frontmatter, frontmatter);
	assert.equal(parsed.body, body);
});

test("serializeEntry with empty body omits the body section", () => {
	const content = serializeEntry({ id: "x" }, "   ");
	assert.equal(content, '---\nid: "x"\n---\n');
});
