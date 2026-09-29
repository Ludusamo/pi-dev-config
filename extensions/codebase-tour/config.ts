/**
 * Per-project persisted config for codebase-tour - currently just whether
 * the persistent location widget ("pane") is shown. Stored as its own file
 * under the same project root tour state lives in (see paths.ts) rather than
 * project-memory's global-config-with-a-projects-map shape: this is a single
 * project-scoped boolean, so a per-project file is simpler and needs no
 * migration/relink machinery.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Whether the persistent location widget is shown, absent a stored preference - matches the pre-toggle behavior. */
export const DEFAULT_PANE_ENABLED = true;

export interface TourConfig {
	paneEnabled: boolean;
}

export function tourConfigPath(root: string): string {
	return join(root, "config.json");
}

/** Never throws: a missing or corrupt config file (or a non-boolean value) falls back to DEFAULT_PANE_ENABLED, same as "never configured". */
export async function loadPaneEnabled(root: string): Promise<boolean> {
	try {
		const raw = await readFile(tourConfigPath(root), "utf-8");
		const parsed = JSON.parse(raw) as Partial<TourConfig>;
		return typeof parsed.paneEnabled === "boolean" ? parsed.paneEnabled : DEFAULT_PANE_ENABLED;
	} catch {
		return DEFAULT_PANE_ENABLED;
	}
}

export async function savePaneEnabled(root: string, paneEnabled: boolean): Promise<void> {
	const filePath = tourConfigPath(root);
	await mkdir(dirname(filePath), { recursive: true });
	const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	await writeFile(tmpPath, `${JSON.stringify({ paneEnabled } satisfies TourConfig, null, 2)}\n`, "utf-8");
	await rename(tmpPath, filePath);
}

/** What `/tour pane <arg>` should do, given the pane's current value - "report" just tells the user, "set" persists a new value. */
export type PaneCommandDecision = { kind: "report" | "set"; enabled: boolean } | { kind: "invalid" };

/**
 * Pure parsing/decision logic for `/tour pane [on|off|toggle|status]`, split
 * out from the command handler so it's unit-testable without a fake ctx or
 * filesystem. `current` should already be freshly loaded from disk (not a
 * cached value) for "status"/"toggle" to reflect another session's change.
 * A bare argument (empty string, i.e. just `/tour pane`) is treated the same
 * as "status".
 */
export function resolveNextPaneState(arg: string, current: boolean): PaneCommandDecision {
	const normalized = arg.trim().toLowerCase();
	switch (normalized) {
		case "":
		case "status":
			return { kind: "report", enabled: current };
		case "toggle":
			return { kind: "set", enabled: !current };
		case "on":
			return { kind: "set", enabled: true };
		case "off":
			return { kind: "set", enabled: false };
		default:
			return { kind: "invalid" };
	}
}
