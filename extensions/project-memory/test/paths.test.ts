import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { isProjectKeyDirContained } from "../paths.ts";

const projectsDir = "/home/user/.pi/agent/memory/projects";

test("isProjectKeyDirContained accepts a well-formed, sanitized key", () => {
	assert.equal(isProjectKeyDirContained("my-project", projectsDir), true);
	assert.equal(isProjectKeyDirContained("g-" + "a".repeat(32), projectsDir), true);
	assert.equal(isProjectKeyDirContained("0123456789abcdef", projectsDir), true);
});

test("isProjectKeyDirContained rejects an empty key (would resolve to projectsDir itself)", () => {
	assert.equal(isProjectKeyDirContained("", projectsDir), false);
});

test("isProjectKeyDirContained rejects keys that escape projectsDir via ..", () => {
	assert.equal(isProjectKeyDirContained("..", projectsDir), false);
	assert.equal(isProjectKeyDirContained("../escaped", projectsDir), false);
	assert.equal(isProjectKeyDirContained("../../etc/passwd", projectsDir), false);
});

test("isProjectKeyDirContained rejects keys nested more than one level deep", () => {
	assert.equal(isProjectKeyDirContained("sub/dir", projectsDir), false);
	assert.equal(isProjectKeyDirContained(join("sub", "dir"), projectsDir), false);
});

test("isProjectKeyDirContained rejects an absolute-path key", () => {
	assert.equal(isProjectKeyDirContained("/etc/passwd", projectsDir), false);
});
