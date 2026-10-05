/**
 * Global saved pair-mode collaboration preferences, kept dependency-light (node builtins only)
 * so policy-adjacent tests can import it outside the pi runtime.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PAIR_PREFERENCES_FILE = join(homedir(), ".pi", "agent", "agent-modes-pair-preferences.json");
export const MAX_PAIR_PREFERENCES = 20;
export const MAX_PREFERENCE_LENGTH = 200;

export interface PairPreference {
  id: string;
  text: string;
  createdAt: string;
}

function isPreference(value: unknown): value is PairPreference {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.text === "string" &&
    v.text.trim().length > 0 &&
    v.text.length <= MAX_PREFERENCE_LENGTH &&
    typeof v.createdAt === "string"
  );
}

/** Never throws: missing/corrupt files give [], invalid entries are dropped. */
export function loadPairPreferences(filePath: string = PAIR_PREFERENCES_FILE): PairPreference[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { preferences?: unknown };
    if (!parsed || !Array.isArray(parsed.preferences)) return [];
    const seen = new Set<string>();
    const out: PairPreference[] = [];
    for (const p of parsed.preferences) {
      if (!isPreference(p)) continue;
      const text = p.text.replace(/\s+/g, " ").trim();
      if (!text || text.length > MAX_PREFERENCE_LENGTH || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, text, createdAt: p.createdAt });
      if (out.length >= MAX_PAIR_PREFERENCES) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Atomic write via tmp file + rename. */
export function savePairPreferences(filePath: string, prefs: readonly PairPreference[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ preferences: prefs }, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

export function newPreferenceId(): string {
  return randomBytes(3).toString("hex");
}

export type AddPreferenceResult = { prefs: PairPreference[] } | { error: string };

export function addPairPreference(
  prefs: readonly PairPreference[],
  text: string,
  now: Date,
  id: string,
): AddPreferenceResult {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { error: "Preference text is empty." };
  if (clean.length > MAX_PREFERENCE_LENGTH) {
    return { error: `Preference is too long (${clean.length} > ${MAX_PREFERENCE_LENGTH} characters).` };
  }
  if (prefs.some((p) => p.text.toLowerCase() === clean.toLowerCase())) return { prefs: [...prefs] };
  if (prefs.length >= MAX_PAIR_PREFERENCES) {
    return { error: `Too many saved preferences (max ${MAX_PAIR_PREFERENCES}). Remove one first.` };
  }
  return { prefs: [...prefs, { id, text: clean, createdAt: now.toISOString() }] };
}

export function removePairPreference(
  prefs: readonly PairPreference[],
  id: string,
): { prefs: PairPreference[]; removed: PairPreference | undefined } {
  const removed = prefs.find((p) => p.id === id);
  return { prefs: prefs.filter((p) => p.id !== id), removed };
}

export function buildPairPreferencesSnippet(prefs: readonly PairPreference[]): string {
  if (prefs.length === 0) return "";
  return (
    "Saved pair preferences (the user's standing collaboration style; follow them unless the user's current instructions say otherwise):\n" +
    prefs.map((p) => `- [${p.id}] ${p.text}`).join("\n")
  );
}

export type PairPrefsCommand =
  | { action: "list" }
  | { action: "add"; text: string }
  | { action: "remove"; id: string }
  | { action: "clear" }
  | { action: "invalid"; error: string };

const PAIR_PREFS_USAGE = "Usage: /pair-prefs [list | add <text> | remove <id> | clear]";

export function parsePairPrefsArgs(args: string): PairPrefsCommand {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const sub = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();
  switch (sub) {
    case "list":
      return rest ? { action: "invalid", error: PAIR_PREFS_USAGE } : { action: "list" };
    case "clear":
      return rest ? { action: "invalid", error: PAIR_PREFS_USAGE } : { action: "clear" };
    case "add":
      return rest ? { action: "add", text: rest } : { action: "invalid", error: `Missing preference text. ${PAIR_PREFS_USAGE}` };
    case "remove":
      if (!rest || /\s/.test(rest)) return { action: "invalid", error: `Provide exactly one id. ${PAIR_PREFS_USAGE}` };
      return { action: "remove", id: rest };
    default:
      return { action: "invalid", error: `Unknown subcommand: ${sub}. ${PAIR_PREFS_USAGE}` };
  }
}
