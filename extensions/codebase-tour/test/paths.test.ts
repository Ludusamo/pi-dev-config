import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { activeTourPath, historyDir, historyTourPath, tourProjectRoot } from "../paths.ts";

const toursDir = "/home/user/.pi/agent/tours";

test("tourProjectRoot joins the tours dir and project key", () => {
	assert.equal(tourProjectRoot("my-project", toursDir), join(toursDir, "my-project"));
});

test("activeTourPath points at active.json under the root", () => {
	assert.equal(activeTourPath("/root"), join("/root", "active.json"));
});

test("historyDir and historyTourPath nest under history/", () => {
	assert.equal(historyDir("/root"), join("/root", "history"));
	assert.equal(historyTourPath("/root", "tour-1"), join("/root", "history", "tour-1.json"));
});
