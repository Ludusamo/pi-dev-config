import assert from "node:assert/strict";
import { test } from "node:test";
import { getModePolicy, SESSION_ONLY_FLAG, TOUR_MODE_NAME } from "../../agent-modes/policy.ts";
import { buildTourKickoffMessage, isModeCommandAvailable, MODE_EXIT_HINT, MODE_SWITCH_COMMAND } from "../start.ts";

test("MODE_SWITCH_COMMAND switches to agent-modes' tour mode for this session only", () => {
	assert.equal(MODE_SWITCH_COMMAND, `/mode ${TOUR_MODE_NAME} ${SESSION_ONLY_FLAG}`);
	assert.equal(MODE_SWITCH_COMMAND, "/mode tour --session");
});

test("the mode MODE_SWITCH_COMMAND targets actually blocks edits and git writes", () => {
	// Exercises the real cross-extension coupling: if agent-modes ever renamed
	// "tour" or loosened its policy, this fails instead of the two extensions
	// silently drifting apart behind a shared string constant.
	const policy = getModePolicy(TOUR_MODE_NAME);
	assert.ok(policy, `agent-modes has no mode named "${TOUR_MODE_NAME}"`);
	assert.equal(policy?.editPolicy, "blocked");
	assert.equal(policy?.gitWritePolicy, "blocked");
});

test("getModePolicy returns undefined for an unknown mode", () => {
	assert.equal(getModePolicy("not-a-real-mode"), undefined);
});

test("isModeCommandAvailable is true when the extension-registered mode command is present", () => {
	assert.equal(
		isModeCommandAvailable([{ name: "mode", source: "extension" }, { name: "tour", source: "extension" }]),
		true,
	);
});

test("isModeCommandAvailable is false when agent-modes hasn't registered its command", () => {
	assert.equal(isModeCommandAvailable([{ name: "tour", source: "extension" }]), false);
	assert.equal(isModeCommandAvailable([]), false);
});

test("isModeCommandAvailable is false when 'mode' is a prompt template or skill, not the extension command", () => {
	// A user prompt template or skill could coincidentally be named "mode" -
	// only the real agent-modes command (source "extension") should count.
	assert.equal(isModeCommandAvailable([{ name: "mode", source: "prompt" }]), false);
	assert.equal(isModeCommandAvailable([{ name: "mode", source: "skill" }]), false);
});

test("buildTourKickoffMessage mentions the requested topic when one is given", () => {
	const message = buildTourKickoffMessage("auth flow");
	assert.match(message, /focused on: auth flow/);
	assert.match(message, /tour_plan/);
	assert.match(message, /tour_advance/);
});

test("buildTourKickoffMessage falls back to the overall architecture when no topic is given", () => {
	const message = buildTourKickoffMessage("");
	assert.match(message, /overall architecture/);
	assert.doesNotMatch(message, /focused on:/);
});

test("MODE_EXIT_HINT points the user at the session-only commands for leaving tour mode", () => {
	assert.match(MODE_EXIT_HINT, /\/mode pair --session/);
	assert.match(MODE_EXIT_HINT, /\/mode auto --session/);
});

test("MODE_EXIT_HINT never suggests a mode switch without the session-only flag", () => {
	// A bare `/mode pair`/`/mode auto` would persist as the default mode for
	// every future session - the hint must always carry SESSION_ONLY_FLAG.
	assert.doesNotMatch(MODE_EXIT_HINT, /\/mode pair(?! --session)/);
	assert.doesNotMatch(MODE_EXIT_HINT, /\/mode auto(?! --session)/);
});

test("buildTourKickoffMessage is explicit about starting fresh, not resuming", () => {
	// Regression coverage for the kickoff/mode-snippet wording conflict: the
	// tour mode's system prompt says to resume an in-progress tour "unless the
	// user asks for a new one" - the kickoff message is that signal, so it must
	// say so unambiguously rather than just "start a new tour".
	const message = buildTourKickoffMessage("");
	assert.match(message, /NEW codebase tour/);
	assert.match(message, /replace any tour already in progress/);
});
