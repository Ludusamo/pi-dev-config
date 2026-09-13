import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildMemoryContextMessage,
	dropStaleMemoryContext,
	EMPTY_MEMORY_CONTEXT_MESSAGE,
	MEMORY_CONTEXT_CUSTOM_TYPE,
	resolveMemoryContextContent,
} from "../inject.ts";

test("buildMemoryContextMessage produces a hidden custom message", () => {
	const message = buildMemoryContextMessage("index text");
	assert.equal(message.customType, MEMORY_CONTEXT_CUSTOM_TYPE);
	assert.equal(message.content, "index text");
	assert.equal(message.display, false);
});

test("dropStaleMemoryContext keeps only the latest memory-context message", () => {
	const messages = [
		{ role: "user", content: "hi" },
		{ role: "custom", customType: MEMORY_CONTEXT_CUSTOM_TYPE, content: "old index" },
		{ role: "assistant", content: "ok" },
		{ role: "custom", customType: MEMORY_CONTEXT_CUSTOM_TYPE, content: "new index" },
		{ role: "custom", customType: "something-else", content: "unrelated" },
	];

	const result = dropStaleMemoryContext(messages);

	assert.equal(result.length, 4);
	assert.deepEqual(
		result.map((m) => (m as { content: string }).content),
		["hi", "ok", "new index", "unrelated"],
	);
});

test("dropStaleMemoryContext is a no-op when there is no memory-context message", () => {
	const messages = [{ role: "user", content: "hi" }];
	assert.deepEqual(dropStaleMemoryContext(messages), messages);
});

test("dropStaleMemoryContext is a no-op with a single memory-context message", () => {
	const messages = [{ role: "custom", customType: MEMORY_CONTEXT_CUSTOM_TYPE, content: "only" }];
	assert.deepEqual(dropStaleMemoryContext(messages), messages);
});

test("resolveMemoryContextContent stays quiet while the index has always been empty", () => {
	assert.equal(resolveMemoryContextContent("", undefined), undefined);
});

test("resolveMemoryContextContent injects a new index when it changes", () => {
	assert.equal(resolveMemoryContextContent("index v1", undefined), "index v1");
	assert.equal(resolveMemoryContextContent("index v2", "index v1"), "index v2");
});

test("resolveMemoryContextContent is a no-op when the index is unchanged", () => {
	assert.equal(resolveMemoryContextContent("index v1", "index v1"), undefined);
});

test("resolveMemoryContextContent sends the empty-state sentinel once entries disappear", () => {
	assert.equal(resolveMemoryContextContent("", "index v1"), EMPTY_MEMORY_CONTEXT_MESSAGE);
});

test("resolveMemoryContextContent does not repeat the empty-state sentinel every turn", () => {
	assert.equal(resolveMemoryContextContent("", EMPTY_MEMORY_CONTEXT_MESSAGE), undefined);
});

test("resolveMemoryContextContent recovers once entries reappear after being empty", () => {
	assert.equal(resolveMemoryContextContent("index v3", EMPTY_MEMORY_CONTEXT_MESSAGE), "index v3");
});
