import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDelegationGuidance,
  buildIntentHint,
  DEFAULT_MODE,
  detectSubagentIntents,
  INTENT_HINT_CUSTOM_TYPE,
  getModePolicy,
  MODES,
  parseModeArgs,
  SESSION_ONLY_FLAG,
  subagentMode,
  TOUR_MODE_NAME,
} from "../policy.ts";

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

test("subagentMode never blocks edits, whatever the dispatcher's mode", () => {
  for (const parent of [...Object.keys(MODES), undefined, "bogus"]) {
    assert.equal(subagentMode(parent).editPolicy, "unrestricted", `parent ${parent}`);
  }
});

test("subagentMode allows git writes only under auto and coordinator dispatchers", () => {
  assert.equal(subagentMode("auto").gitWritePolicy, "unrestricted");
  assert.equal(subagentMode("coordinator").gitWritePolicy, "unrestricted");
  for (const parent of ["pair", "guarded", "tour", undefined, "bogus"]) {
    assert.equal(subagentMode(parent).gitWritePolicy, "blocked", `parent ${parent}`);
  }
});

test("subagentMode never needs confirmation, since a subagent has no UI to approve it", () => {
  for (const parent of Object.keys(MODES)) {
    const m = subagentMode(parent);
    assert.notEqual(m.editPolicy, "confirm");
    assert.notEqual(m.gitWritePolicy, "confirm");
  }
});

const ALL_AGENTS = ["scout", "planner", "worker", "reviewer", "devils-advocate"];

test("buildDelegationGuidance is empty outside pair/guarded/auto", () => {
  for (const mode of ["coordinator", "tour", "subagent", "nope"]) {
    assert.equal(buildDelegationGuidance(mode, ALL_AGENTS), "");
  }
});

test("buildDelegationGuidance mentions only available agents", () => {
  const g = buildDelegationGuidance("auto", ["scout"]);
  assert.match(g, /`scout`/);
  assert.doesNotMatch(g, /`reviewer`/);
  assert.equal(buildDelegationGuidance("auto", ["worker"]), "");
});

test("buildDelegationGuidance adds the no-override line only in pair mode", () => {
  assert.match(buildDelegationGuidance("pair", ALL_AGENTS), /do not override this mode/);
  assert.doesNotMatch(buildDelegationGuidance("guarded", ALL_AGENTS), /do not override this mode/);
  assert.equal(buildDelegationGuidance("pair", []), "");
});

test("pair prompt is design-first, confirmation-gated and blocks workarounds", () => {
  const p = MODES.pair;
  assert.equal(p.editPolicy, "blocked");
  assert.equal(p.gitWritePolicy, "blocked");
  assert.match(p.systemPromptSnippet, /explicitly\s+confirmed the design/);
  assert.match(p.systemPromptSnippet, /15 lines or fewer/);
  assert.match(p.systemPromptSnippet, /Detail \| Proposal \| Why it matters/);
  assert.match(p.systemPromptSnippet, /\/mode guarded --session/);
  assert.match(p.systemPromptSnippet, /sed -i/);
  assert.match(p.systemPromptSnippet, /heredocs/);
  assert.match(p.systemPromptSnippet, /pair_preference/);
  assert.doesNotMatch(p.description, /without explicit user permission/);
});

test("pair worker guidance appears only in pair mode and needs the worker agent", () => {
  assert.match(buildDelegationGuidance("pair", ["worker"]), /offer to dispatch the `worker` subagent/);
  assert.match(buildDelegationGuidance("pair", ["worker"]), /only dispatch after the user says yes/);
  assert.equal(buildDelegationGuidance("guarded", ["worker"]), "");
  assert.doesNotMatch(buildDelegationGuidance("guarded", ALL_AGENTS), /worker/);
  assert.doesNotMatch(buildDelegationGuidance("pair", ["scout"]), /worker/);
});

test("detectSubagentIntents finds explicit devil's advocate requests", () => {
  assert.deepEqual(detectSubagentIntents("Play devil's advocate on this plan"), ["devils-advocate"]);
  assert.deepEqual(detectSubagentIntents("please poke holes in this design"), ["devils-advocate"]);
  assert.deepEqual(detectSubagentIntents("argue against this approach"), ["devils-advocate"]);
});

test("detectSubagentIntents finds explicit worker dispatch", () => {
  assert.deepEqual(detectSubagentIntents("Dispatch this to a worker"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("use a worker subagent for the refactor"), ["worker"]);
});

test("detectSubagentIntents returns fixed order and de-dupes", () => {
  assert.deepEqual(
    detectSubagentIntents("Use a worker subagent. Then poke holes in it. Also play devil's advocate."),
    ["devils-advocate", "worker"],
  );
});

test("detectSubagentIntents skips negated clauses but keeps others", () => {
  assert.deepEqual(detectSubagentIntents("Don't use a worker"), []);
  assert.deepEqual(detectSubagentIntents("No need for a devil's advocate. Use a worker subagent."), ["worker"]);
});

test("detectSubagentIntents avoids worker false positives", () => {
  assert.deepEqual(detectSubagentIntents("Why does the worker thread crash?"), []);
  assert.deepEqual(detectSubagentIntents("restart the background worker process"), []);
  assert.deepEqual(detectSubagentIntents("use a worker thread for parsing"), []);
});

test("detectSubagentIntents ignores prompts that merely mention worker agents", () => {
  for (const p of [
    "What does the worker agent do in this codebase?",
    "Explain how the worker subagent is defined",
    "fix the bug where we spawn a worker for each request",
    "use the worker's output",
  ]) {
    assert.deepEqual(detectSubagentIntents(p), [], p);
  }
});

test("detectSubagentIntents only suppresses when the trigger itself is negated", () => {
  assert.deepEqual(detectSubagentIntents("Use a worker agent, and don't touch tests"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("Dispatch this to a worker without running the tests"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("Play devil's advocate, not too harshly"), ["devils-advocate"]);
  assert.deepEqual(detectSubagentIntents("don't argue against me, just use a worker agent"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("No devil's advocate needed"), []);
  assert.deepEqual(detectSubagentIntents("Please don't use a worker"), []);
});

test("detectSubagentIntents requires a request for devil's advocate, not a mention", () => {
  for (const p of [
    "What does the devils-advocate agent do?",
    "Explain how the devils-advocate subagent is defined",
    "fix the devils-advocate prompt",
    "what is devil's advocate",
    "why did the model argue against my plan",
    "the reviewer will poke holes in it anyway",
  ]) {
    assert.deepEqual(detectSubagentIntents(p), [], p);
  }
  for (const p of [
    "I want a devils advocate",
    "play devil's advocate on this",
    "please poke holes in this design",
    "can you argue against this plan",
    "play devil\u2019s advocate on this",
  ]) {
    assert.deepEqual(detectSubagentIntents(p), ["devils-advocate"], p);
  }
});

test("detectSubagentIntents handles negated devil's advocate with straight and curly apostrophes", () => {
  assert.deepEqual(detectSubagentIntents("I don't want you to play devil's advocate"), []);
  assert.deepEqual(detectSubagentIntents("I don\u2019t want you to play devil\u2019s advocate"), []);
  assert.deepEqual(detectSubagentIntents("Don\u2019t play devil\u2019s advocate"), []);
  assert.deepEqual(detectSubagentIntents("Please don\u2019t use a worker"), []);
});

test("detectSubagentIntents ignores ordinary coding requests about a worker", () => {
  for (const p of [
    "use a worker to offload the image resizing",
    "have the worker retry on failure",
    "spawn a worker for the encoder",
    "let's use a worker here instead of the main thread",
  ]) {
    assert.deepEqual(detectSubagentIntents(p), [], p);
  }
  assert.deepEqual(detectSubagentIntents("use the `worker` for this"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("spawn a worker agent"), ["worker"]);
});

test("detectSubagentIntents does not treat code-style send as worker delegation", () => {
  assert.deepEqual(detectSubagentIntents("send messages to the worker"), []);
  assert.deepEqual(detectSubagentIntents("send the payload to the worker so it can process it"), []);
  assert.deepEqual(detectSubagentIntents("use the worker-thread API"), []);
  assert.deepEqual(detectSubagentIntents("send this to a worker"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("dispatch the task to the worker subagent"), ["worker"]);
  assert.deepEqual(detectSubagentIntents("delegate this change to the worker agent"), ["worker"]);
});

test("buildIntentHint drops unavailable agents and empty results", () => {
  assert.equal(buildIntentHint(["worker"], "auto", ["scout"]), "");
  const hint = buildIntentHint(["devils-advocate", "worker"], "auto", ["devils-advocate"]);
  assert.match(hint, /devils-advocate/);
  assert.doesNotMatch(hint, /`worker`/);
});

test("buildIntentHint drops worker in tour mode", () => {
  assert.equal(buildIntentHint(["worker"], "tour", ALL_AGENTS), "");
});

test("buildIntentHint mentions planner only when available", () => {
  assert.match(buildIntentHint(["worker"], "pair", ALL_AGENTS), /`planner`/);
  assert.doesNotMatch(buildIntentHint(["worker"], "pair", ["worker"]), /planner/);
});

test("INTENT_HINT_CUSTOM_TYPE is stable", () => {
  assert.equal(INTENT_HINT_CUSTOM_TYPE, "agent-intent-hint");
});
