import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODE, getModePolicy, MODES, parseModeArgs, SESSION_ONLY_FLAG, TOUR_MODE_NAME } from "../policy.ts";

test("MODES has a policy for every built-in mode name", () => {
  for (const name of ["pair", "guarded", "auto", "coordinator", "tour"]) {
    assert.ok(MODES[name], `missing mode: ${name}`);
  }
});

test("DEFAULT_MODE is a real mode", () => {
  assert.ok(MODES[DEFAULT_MODE]);
});

test("getModePolicy reports tour mode as fully blocked (edits and git writes)", () => {
  assert.deepEqual(getModePolicy(TOUR_MODE_NAME), { editPolicy: "blocked", gitWritePolicy: "blocked" });
});

test("getModePolicy reports guarded mode as confirmation-gated", () => {
  assert.deepEqual(getModePolicy("guarded"), { editPolicy: "confirm", gitWritePolicy: "confirm" });
});

test("getModePolicy reports auto mode as fully unrestricted", () => {
  assert.deepEqual(getModePolicy("auto"), { editPolicy: "unrestricted", gitWritePolicy: "unrestricted" });
});

test("getModePolicy returns undefined for an unknown mode name", () => {
  assert.equal(getModePolicy("nope"), undefined);
});

test("parseModeArgs reads a plain mode name and persists by default", () => {
  assert.deepEqual(parseModeArgs("tour"), { name: "tour", persist: true });
});

test("parseModeArgs lowercases the mode name", () => {
  assert.deepEqual(parseModeArgs("TOUR"), { name: "tour", persist: true });
});

test(`parseModeArgs treats ${SESSION_ONLY_FLAG} as session-only (no persist)`, () => {
  assert.deepEqual(parseModeArgs(`tour ${SESSION_ONLY_FLAG}`), { name: "tour", persist: false });
});

test("parseModeArgs accepts the flag before the mode name too", () => {
  assert.deepEqual(parseModeArgs(`${SESSION_ONLY_FLAG} tour`), { name: "tour", persist: false });
});

test("parseModeArgs tolerates extra whitespace", () => {
  assert.deepEqual(parseModeArgs(`  tour   ${SESSION_ONLY_FLAG}  `), { name: "tour", persist: false });
});

test("parseModeArgs returns an empty name for blank args", () => {
  assert.deepEqual(parseModeArgs(""), { name: "", persist: true });
  assert.deepEqual(parseModeArgs("   "), { name: "", persist: true });
});

test("parseModeArgs rejects an unknown flag instead of silently ignoring it", () => {
  const result = parseModeArgs("tour --sesion");
  assert.match(result.error ?? "", /Unknown flag/);
  assert.match(result.error ?? "", /--sesion/);
});

test("parseModeArgs rejects an unknown flag even alongside the real flag", () => {
  const result = parseModeArgs(`tour ${SESSION_ONLY_FLAG} --bogus`);
  assert.match(result.error ?? "", /--bogus/);
});

test("parseModeArgs does not error on the real flag", () => {
  assert.equal(parseModeArgs(`tour ${SESSION_ONLY_FLAG}`).error, undefined);
});
