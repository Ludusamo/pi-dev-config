import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addPairPreference,
  buildPairPreferencesSnippet,
  loadPairPreferences,
  MAX_PAIR_PREFERENCES,
  MAX_PREFERENCE_LENGTH,
  newPreferenceId,
  parsePairPrefsArgs,
  removePairPreference,
  savePairPreferences,
  type PairPreference,
} from "../preferences.ts";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const tmp = () => mkdtempSync(join(tmpdir(), "pair-prefs-"));
const pref = (id: string, text: string): PairPreference => ({ id, text, createdAt: NOW.toISOString() });

test("load returns [] for missing and corrupt files", () => {
  const dir = tmp();
  assert.deepEqual(loadPairPreferences(join(dir, "nope.json")), []);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.deepEqual(loadPairPreferences(bad), []);
  writeFileSync(bad, JSON.stringify({ preferences: "x" }));
  assert.deepEqual(loadPairPreferences(bad), []);
});

test("load drops invalid entries", () => {
  const f = join(tmp(), "p.json");
  writeFileSync(
    f,
    JSON.stringify({
      preferences: [pref("a", "ok"), { id: "b" }, null, pref("c", "  "), pref("d", "x".repeat(MAX_PREFERENCE_LENGTH + 1))],
    }),
  );
  assert.deepEqual(loadPairPreferences(f), [pref("a", "ok")]);
});

test("save writes atomically with trailing newline and round-trips", () => {
  const dir = tmp();
  const f = join(dir, "sub", "p.json");
  savePairPreferences(f, [pref("a", "one")]);
  const raw = readFileSync(f, "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.deepEqual(JSON.parse(raw), { preferences: [pref("a", "one")] });
  assert.deepEqual(loadPairPreferences(f), [pref("a", "one")]);
  assert.deepEqual(readdirSync(join(dir, "sub")), ["p.json"]);
});

test("add trims, collapses whitespace and records metadata", () => {
  const r = addPairPreference([], "  keep   it\n short ", NOW, "id1");
  assert.deepEqual(r, { prefs: [pref("id1", "keep it short")] });
});

test("add rejects empty, too long and full lists", () => {
  assert.ok("error" in addPairPreference([], "   ", NOW, "x"));
  assert.ok("error" in addPairPreference([], "x".repeat(MAX_PREFERENCE_LENGTH + 1), NOW, "x"));
  const full = Array.from({ length: MAX_PAIR_PREFERENCES }, (_, i) => pref(`i${i}`, `p${i}`));
  assert.ok("error" in addPairPreference(full, "new", NOW, "x"));
});

test("add treats case-insensitive duplicates as a no-op", () => {
  const existing = [pref("a", "Be brief")];
  assert.deepEqual(addPairPreference(existing, "be BRIEF", NOW, "b"), { prefs: existing });
});

test("remove returns the removed entry or undefined", () => {
  const prefs = [pref("a", "one"), pref("b", "two")];
  assert.deepEqual(removePairPreference(prefs, "a"), { prefs: [pref("b", "two")], removed: pref("a", "one") });
  assert.deepEqual(removePairPreference(prefs, "zz"), { prefs, removed: undefined });
});

test("newPreferenceId is non-empty and varies", () => {
  assert.ok(newPreferenceId().length > 0);
  assert.notEqual(newPreferenceId(), newPreferenceId());
});

test("snippet is empty without preferences and lists ids otherwise", () => {
  assert.equal(buildPairPreferencesSnippet([]), "");
  const s = buildPairPreferencesSnippet([pref("a1", "be brief")]);
  assert.match(s, /^Saved pair preferences/);
  assert.match(s, /^- \[a1\] be brief$/m);
});

test("parsePairPrefsArgs handles each subcommand", () => {
  assert.deepEqual(parsePairPrefsArgs(""), { action: "list" });
  assert.deepEqual(parsePairPrefsArgs("list"), { action: "list" });
  assert.deepEqual(parsePairPrefsArgs("add  prefer short answers "), { action: "add", text: "prefer short answers" });
  assert.deepEqual(parsePairPrefsArgs("remove abc"), { action: "remove", id: "abc" });
  assert.deepEqual(parsePairPrefsArgs("clear"), { action: "clear" });
});

test("parsePairPrefsArgs reports invalid input", () => {
  for (const a of ["add", "remove", "remove a b", "clear now", "bogus"]) {
    assert.equal(parsePairPrefsArgs(a).action, "invalid", a);
  }
});
