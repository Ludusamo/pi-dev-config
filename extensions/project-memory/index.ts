/**
 * project-memory - durable, project-scoped memory for the agent.
 *
 * - Storage location is configurable (private/repo/custom/off), private by default.
 * - Private/custom memory is keyed by name: a git repo's remote repo name
 *   (falling back to its folder name with no remote), or a plain directory's
 *   folder name. Worktrees of the same repo always share it (same remote/repo
 *   name); separate clones or forks that happen to share a name share it too
 *   - that's intentional, not a collision to avoid. See resolve.ts.
 * - The mode/custom-path config entry is keyed the same way, so two
 *   same-named projects share their memory-mode setting too, not just their
 *   memory content. Private mode has no trust gate, so any directory whose
 *   name sanitizes to an existing project's key can read and write that
 *   project's private memory with no prompt - be mindful of this in
 *   untrusted checkouts (see the security note in resolve.ts).
 * - The main agent can read and write; pi-runtime subagents (PI_SUBAGENT=1
 *   child `pi` processes) are read-only - they get memory_search/memory_get
 *   but not the write/update/promote/delete tools, and their built-in
 *   write/edit tool calls are blocked from touching the memory store
 *   directly (bash commands that literally mention the resolved memory path
 *   are also blocked, but that check is best-effort only - see
 *   pathguard.ts). Claude-runtime subagents run outside the pi extension
 *   system entirely: they have no memory tools and none of this applies to
 *   them.
 * - A compact index is injected as a hidden per-turn context message; full
 *   entry contents are fetched on demand via memory_get.
 * - Rot prevention is archival, not deletion: short-term TTL expiry and
 *   memory_delete both set status to "archived" rather than removing files.
 */

import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dropProjectConfigKey, readGlobalConfig, setProjectConfig, writeRepoMarker } from "./config.ts";
import { buildMemoryContextMessage, dropStaleMemoryContext, resolveMemoryContextContent } from "./inject.ts";
import { moveProjectKey } from "./migrate.ts";
import { defaultProjectsDir, pathExists, privateMemoryRoot } from "./paths.ts";
import { commandMentionsPath, isWithinRoot, resolveCandidatePath, resolveGuardedRoot } from "./pathguard.ts";
import {
	getGitInfo,
	LEGACY_HASH_PATTERN,
	PROJECT_KEY_PATTERN,
	relinkKeyCandidates,
	resolveMemory,
	type ResolvedMemory,
} from "./resolve.ts";
import * as store from "./store.ts";
import type { MemoryFrontmatter, MemoryMode } from "./types.ts";

const MEMORY_ID_SCHEMA_PATTERN = "^[a-z0-9][a-z0-9-]{0,79}$";

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "project-memory-config.json");
const SHORT_TERM_TTL_DAYS = 14;
const MODES: MemoryMode[] = ["private", "repo", "custom", "off"];

function notAvailable(action: "read" | "write", r: ResolvedMemory) {
	const verb = action === "read" ? "readable" : "writable";
	return {
		content: [
			{
				type: "text" as const,
				text: `Project memory is not ${verb} (mode: ${r.mode}${r.reason ? `, ${r.reason}` : ""}).`,
			},
		],
		details: {},
		isError: true,
	};
}

function invalidId(id: unknown) {
	return {
		content: [{ type: "text" as const, text: `Invalid memory id: ${JSON.stringify(id)}.` }],
		details: {},
		isError: true,
	};
}

export default function projectMemory(pi: ExtensionAPI) {
	const isSubagent = process.env.PI_SUBAGENT === "1";

	let resolvedPromise: Promise<ResolvedMemory> | undefined;
	let lastIndexContent: string | undefined;
	let sweepStarted = false;

	function ensureResolved(ctx: ExtensionContext): Promise<ResolvedMemory> {
		if (!resolvedPromise) {
			const promise = resolveMemory({
				cwd: ctx.cwd,
				isProjectTrusted: ctx.isProjectTrusted(),
				globalConfigPath: GLOBAL_CONFIG_PATH,
				allowIdentityWrite: !isSubagent,
			});
			// resolveMemory itself shouldn't reject in practice (identity/migration
			// failures fall back to the legacy key instead), but if something
			// unexpected does throw, don't cache the rejection - the next call
			// should get a fresh attempt rather than being stuck failing for the
			// rest of the session.
			promise.catch(() => {
				if (resolvedPromise === promise) resolvedPromise = undefined;
			});
			resolvedPromise = promise;
		}
		return resolvedPromise;
	}

	function invalidateResolved() {
		resolvedPromise = undefined;
		lastIndexContent = undefined;
	}

	pi.on("session_start", async () => {
		invalidateResolved();
		sweepStarted = false;
	});

	// Compaction can drop the previously injected hidden index message from the
	// message list; forget what we last injected so the next turn re-injects
	// even if the index content itself hasn't changed since.
	pi.on("session_compact", async () => {
		lastIndexContent = undefined;
	});

	// Navigating the session tree (branch switch/fork) can land on a leaf
	// whose message list doesn't contain the index message we last injected,
	// for the same reason compaction can drop it - forget it so it re-injects.
	pi.on("session_tree", async () => {
		lastIndexContent = undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const r = await ensureResolved(ctx);
		if (!r.root || !r.readable) return;

		if (!isSubagent && !sweepStarted) {
			sweepStarted = true;
			store.archiveExpiredShortTerm(r.root, parseFrontmatter).catch(() => {});
		}

		const index = await store.buildCompactIndex(r.root, parseFrontmatter).catch(() => "");
		const content = resolveMemoryContextContent(index, lastIndexContent);
		if (content === undefined) return;
		lastIndexContent = content;
		return { message: buildMemoryContextMessage(content) };
	});

	pi.on("context", async (event) => {
		return { messages: dropStaleMemoryContext(event.messages) };
	});

	// Subagents get no write tools at all, but they still inherit the built-in
	// write/edit/bash tools - block those from touching the memory store
	// directly. Paths are normalized the same way pi's own write/edit tools
	// resolve them (~ and @ handling, then canonicalized via realpath) so a
	// differently-formatted-but-equivalent path can't slip past a naive string
	// comparison. The bash check is best-effort only - see pathguard.ts.
	if (isSubagent) {
		pi.on("tool_call", async (event, ctx) => {
			const r = await ensureResolved(ctx);
			if (!r.root) return;
			const resolvedRoot = resolveGuardedRoot(r.root);

			if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				const target = resolveCandidatePath(event.input.path, ctx.cwd);
				if (isWithinRoot(target, resolvedRoot)) {
					return { block: true, reason: "Subagents cannot write to project memory directly.", terminate: false };
				}
				return;
			}

			if (isToolCallEventType("bash", event)) {
				if (commandMentionsPath(event.input.command, resolvedRoot, resolvePath(r.root))) {
					return {
						block: true,
						reason: "Subagents cannot use bash to modify project memory directly.",
						terminate: false,
					};
				}
			}
		});
	}

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search project memory (short-term and long-term entries) by free text and/or tags.",
		promptSnippet: "Search saved project memory entries",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Free-text search across title, tags, and body" })),
			term: Type.Optional(
				Type.Union([Type.Literal("short"), Type.Literal("long"), Type.Literal("all")], {
					description: "Restrict to short-term, long-term, or all (default all)",
				}),
			),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Require all of these tags" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const r = await ensureResolved(ctx);
			if (!r.root || !r.readable) return notAvailable("read", r);
			const results = await store.searchEntries(r.root, parseFrontmatter, {
				query: params.query,
				term: params.term,
				tags: params.tags,
				limit: params.limit,
			});
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No matching memory entries." }], details: { results: [] } };
			}
			const text = results
				.map((e) => `- ${e.frontmatter.id} [${e.frontmatter.term}/${e.frontmatter.status}] ${e.frontmatter.title}`)
				.join("\n");
			return { content: [{ type: "text", text }], details: { results: results.map((e) => e.frontmatter) } };
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Memory Get",
		description: "Fetch the full title, tags, and body of one project memory entry by id.",
		promptSnippet: "Fetch a full project memory entry by id",
		parameters: Type.Object({
			id: Type.String({ description: "Memory entry id", pattern: MEMORY_ID_SCHEMA_PATTERN }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!store.isValidMemoryId(params.id)) return invalidId(params.id);
			const r = await ensureResolved(ctx);
			if (!r.root || !r.readable) return notAvailable("read", r);
			const found = await store.findEntry(r.root, params.id, parseFrontmatter);
			if (!found) {
				return { content: [{ type: "text", text: `No memory found with id ${params.id}.` }], details: {}, isError: true };
			}
			const fm = found.entry.frontmatter;
			const tagsText = fm.tags?.length ? ` tags: ${fm.tags.join(", ")}` : "";
			const header = `${fm.title} [${fm.term}/${fm.status}]${tagsText}`;
			return { content: [{ type: "text", text: `${header}\n\n${found.entry.body}` }], details: fm };
		},
	});

	if (!isSubagent) {
		pi.registerTool({
			name: "memory_write",
			label: "Memory Write",
			description:
				"Save a new project memory entry. Short-term entries are saved immediately and expire after " +
				`${SHORT_TERM_TTL_DAYS} days. Long-term entries require user approval; without an interactive UI ` +
				"they are saved as pending for later review.",
			promptSnippet: "Save a new project memory entry (short-term or long-term)",
			promptGuidelines: [
				"Use memory_write for facts, decisions, or context worth recalling in future sessions - not for ephemeral task state.",
				"Prefer short-term for working notes on the current task; use long-term only for durable, broadly useful facts.",
			],
			parameters: Type.Object({
				term: Type.Union([Type.Literal("short"), Type.Literal("long")]),
				title: Type.String({ description: "Short, descriptive title" }),
				body: Type.String({ description: "Full entry content" }),
				tags: Type.Optional(Type.Array(Type.String())),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const r = await ensureResolved(ctx);
				if (!r.root || !r.writable) return notAvailable("write", r);

				const now = new Date().toISOString();

				if (params.term === "short") {
					const id = await store.generateUniqueId(r.root, params.title, parseFrontmatter);
					const expiresAt = new Date(Date.now() + SHORT_TERM_TTL_DAYS * 86_400_000).toISOString();
					const frontmatter: MemoryFrontmatter = {
						id,
						title: params.title,
						term: "short",
						status: "active",
						tags: params.tags ?? [],
						createdAt: now,
						updatedAt: now,
						source: "main",
						expiresAt,
					};
					await store.writeEntry(r.root, "short", frontmatter, params.body);
					lastIndexContent = undefined;
					return { content: [{ type: "text", text: `Saved short-term memory ${id}.` }], details: { id } };
				}

				// Long-term entries always require approval before being active: if
				// there's an interactive UI, a decline means nothing is saved at all
				// (declining must not silently persist as pending); without a UI
				// there's nobody to ask, so it's saved as pending for later review.
				let status: MemoryFrontmatter["status"];
				if (ctx.hasUI) {
					const approved = await ctx.ui.confirm("Save long-term memory?", `${params.title}\n\n${params.body}`);
					if (!approved) {
						return {
							content: [{ type: "text", text: "Long-term memory not saved (declined)." }],
							details: {},
						};
					}
					status = "active";
				} else {
					status = "pending";
				}

				const id = await store.generateUniqueId(r.root, params.title, parseFrontmatter);
				const frontmatter: MemoryFrontmatter = {
					id,
					title: params.title,
					term: "long",
					status,
					tags: params.tags ?? [],
					createdAt: now,
					updatedAt: now,
					source: "main",
				};
				await store.writeEntry(r.root, "long", frontmatter, params.body);
				lastIndexContent = undefined;
				const text =
					status === "active"
						? `Saved long-term memory ${id}.`
						: `Saved long-term memory ${id} as pending (awaiting review).`;
				return { content: [{ type: "text", text }], details: { id, status } };
			},
		});

		pi.registerTool({
			name: "memory_update",
			label: "Memory Update",
			description:
				"Update the title, body, tags, or status of an existing project memory entry. Changing a " +
				"long-term entry's content or activating it (status: active) requires the same approval as " +
				"memory_write; without an interactive UI those changes are deferred as pending instead of applied.",
			promptSnippet: "Update an existing project memory entry",
			parameters: Type.Object({
				id: Type.String({ description: "Memory entry id", pattern: MEMORY_ID_SCHEMA_PATTERN }),
				title: Type.Optional(Type.String()),
				body: Type.Optional(Type.String()),
				tags: Type.Optional(Type.Array(Type.String())),
				status: Type.Optional(
					Type.Union([
						Type.Literal("active"),
						Type.Literal("pending"),
						Type.Literal("needs-review"),
						Type.Literal("archived"),
					]),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!store.isValidMemoryId(params.id)) return invalidId(params.id);
				const r = await ensureResolved(ctx);
				if (!r.root || !r.writable) return notAvailable("write", r);
				const { id } = params;
				// Built explicitly from the allowed fields only - params comes from
				// model-supplied tool arguments, so it must never be spread directly
				// into a frontmatter patch (that would let extra keys like
				// expiresAt/createdAt/source through untouched).
				const patch: Partial<Omit<MemoryFrontmatter, "id">> & { body?: string } = {};
				if (params.title !== undefined) patch.title = params.title;
				if (params.body !== undefined) patch.body = params.body;
				if (params.tags !== undefined) patch.tags = params.tags;
				if (params.status !== undefined) patch.status = params.status;

				const found = await store.findEntry(r.root, id, parseFrontmatter);
				if (!found) {
					return { content: [{ type: "text", text: `No memory found with id ${id}.` }], details: {}, isError: true };
				}

				// Content changes and activation are trust-bearing for long-term
				// entries, so they go through the same approval gate as memory_write:
				// a declining human means nothing changes; no UI means the change is
				// deferred (saved as pending) rather than silently taking effect.
				const touchesContent = patch.title !== undefined || patch.body !== undefined;
				const activates = patch.status === "active";
				if (found.term === "long" && (touchesContent || activates)) {
					if (ctx.hasUI) {
						const approved = await ctx.ui.confirm(
							"Apply this change to long-term memory?",
							`${patch.title ?? found.entry.frontmatter.title}\n\n${patch.body ?? found.entry.body}`,
						);
						if (!approved) {
							return {
								content: [{ type: "text", text: `Update to ${id} declined; no changes were made.` }],
								details: { id },
							};
						}
					} else {
						patch.status = "pending";
					}
				}

				const updated = await store.updateEntry(r.root, id, patch, parseFrontmatter);
				if (!updated) {
					return { content: [{ type: "text", text: `No memory found with id ${id}.` }], details: {}, isError: true };
				}
				lastIndexContent = undefined;
				const text =
					!ctx.hasUI && (touchesContent || activates) && found.term === "long"
						? `Updated memory ${id} as pending (awaiting review).`
						: `Updated memory ${id}.`;
				return { content: [{ type: "text", text }], details: { id } };
			},
		});

		pi.registerTool({
			name: "memory_promote",
			label: "Memory Promote",
			description:
				"Promote an active short-term memory entry to long-term. Requires user approval; without an interactive UI it is saved as pending.",
			promptSnippet: "Promote a short-term memory entry to long-term",
			parameters: Type.Object({
				id: Type.String({ description: "Short-term memory id to promote", pattern: MEMORY_ID_SCHEMA_PATTERN }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!store.isValidMemoryId(params.id)) return invalidId(params.id);
				const r = await ensureResolved(ctx);
				if (!r.root || !r.writable) return notAvailable("write", r);
				const found = await store.findEntry(r.root, params.id, parseFrontmatter);
				if (!found || found.term !== "short") {
					return {
						content: [{ type: "text", text: `No short-term memory found with id ${params.id}.` }],
						details: {},
						isError: true,
					};
				}
				if (found.entry.frontmatter.status !== "active") {
					return {
						content: [
							{
								type: "text",
								text: `Only active short-term memories can be promoted (current status: ${found.entry.frontmatter.status}).`,
							},
						],
						details: {},
						isError: true,
					};
				}

				// Same approval gate as memory_write: a decline means nothing is
				// promoted at all; no UI means it's promoted as pending.
				let status: Extract<MemoryFrontmatter["status"], "active" | "pending">;
				if (ctx.hasUI) {
					const approved = await ctx.ui.confirm("Promote to long-term memory?", found.entry.frontmatter.title);
					if (!approved) {
						return {
							content: [{ type: "text", text: `Promotion of ${params.id} declined; no changes were made.` }],
							details: {},
						};
					}
					status = "active";
				} else {
					status = "pending";
				}

				const result = await store.promoteEntry(r.root, params.id, status, parseFrontmatter);
				if (!result.ok) {
					const text =
						result.error === "not-active"
							? `Only active short-term memories can be promoted.`
							: `No short-term memory found with id ${params.id}.`;
					return { content: [{ type: "text", text }], details: {}, isError: true };
				}
				lastIndexContent = undefined;
				return {
					content: [
						{ type: "text", text: `Promoted ${params.id} to long-term as ${result.entry.frontmatter.id} (status: ${status}).` },
					],
					details: { id: result.entry.frontmatter.id, status },
				};
			},
		});

		pi.registerTool({
			name: "memory_delete",
			label: "Memory Delete",
			description:
				"Soft-delete a project memory entry by archiving it. The file is retained (status set to archived), never removed.",
			promptSnippet: "Archive (soft-delete) a project memory entry",
			parameters: Type.Object({ id: Type.String({ pattern: MEMORY_ID_SCHEMA_PATTERN }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!store.isValidMemoryId(params.id)) return invalidId(params.id);
				const r = await ensureResolved(ctx);
				if (!r.root || !r.writable) return notAvailable("write", r);
				const updated = await store.updateEntry(r.root, params.id, { status: "archived" }, parseFrontmatter);
				if (!updated) {
					return { content: [{ type: "text", text: `No memory found with id ${params.id}.` }], details: {}, isError: true };
				}
				lastIndexContent = undefined;
				return {
					content: [{ type: "text", text: `Archived memory ${params.id} (soft delete; file retained).` }],
					details: { id: params.id },
				};
			},
		});

		pi.registerCommand("memory-mode", {
			description: "View or set the project memory storage mode (private, repo, custom, off)",
			handler: async (args, ctx) => {
				const arg = args.trim();
				if (!arg) {
					const r = await ensureResolved(ctx);
					ctx.ui.notify(
						`Project memory mode: ${r.mode}${r.root ? ` (${r.root})` : ""}${r.reason ? ` - ${r.reason}` : ""} [key: ${r.projectKey}]` +
							(r.identityReason ? `\n${r.identityReason}` : ""),
						"info",
					);
					return;
				}

				const [modeArg, pathArg] = arg.split(/\s+/, 2);
				if (!MODES.includes(modeArg as MemoryMode)) {
					ctx.ui.notify("Usage: /memory-mode [private|repo|custom|off] [customPath]", "error");
					return;
				}
				const mode = modeArg as MemoryMode;
				if (mode === "custom" && !pathArg) {
					ctx.ui.notify("Custom mode requires a path: /memory-mode custom /abs/path", "error");
					return;
				}

				const r = await ensureResolved(ctx);

				if (mode === "repo") {
					if (!ctx.isProjectTrusted()) {
						ctx.ui.notify("Trust this project before enabling repo memory mode.", "error");
						return;
					}
					const gitInfo = await getGitInfo(ctx.cwd);
					if (!gitInfo) {
						ctx.ui.notify("Repo mode requires a git repository.", "error");
						return;
					}
					const markerPath = join(gitInfo.toplevel, ".pi", "memory.json");
					const confirmed = ctx.hasUI
						? await ctx.ui.confirm(
								"Enable repo memory mode?",
								`This writes ${markerPath}, which should be committed so your team shares this setting.`,
							)
						: true;
					if (!confirmed) return;
					await writeRepoMarker(gitInfo.toplevel);
				}

				await setProjectConfig(GLOBAL_CONFIG_PATH, r.projectKey, {
					mode,
					customPath: pathArg ? resolvePath(pathArg) : undefined,
				});
				invalidateResolved();
				const next = await ensureResolved(ctx);
				ctx.ui.notify(`Project memory mode set to ${next.mode}${next.root ? ` (${next.root})` : ""}.`, "info");
			},
		});

		pi.registerCommand("memory-relink", {
			description:
				"Merge an old project's private memory (by key, by key:<name>, or by its old path) into this " +
				"project's current key. Add --drop-old-config to discard a leftover old-key config entry that " +
				"conflicts with this project's current one (relinking alone can't clear that kind of conflict); " +
				"like the relink itself, without a UI this also requires --force. " +
				"If the old key isn't a leftover legacy id - i.e. it looks like another project's current, " +
				"live key - relinking asks for confirmation first (or, without a UI, requires --force) so a " +
				"mistyped path can't silently drain another project's memory into this one.",
			handler: async (args, ctx) => {
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				const dropOldConfig = tokens.includes("--drop-old-config");
				const force = tokens.includes("--force");
				const arg = tokens.filter((t) => t !== "--drop-old-config" && t !== "--force").join(" ");
				if (!arg) {
					ctx.ui.notify("Usage: /memory-relink <oldKey|key:<name>|oldPath> [--drop-old-config] [--force]", "error");
					return;
				}

				const r = await ensureResolved(ctx);
				const projectsDir = defaultProjectsDir();
				const candidates = await relinkKeyCandidates(arg, ctx.cwd);
				const globalConfig = await readGlobalConfig(GLOBAL_CONFIG_PATH);

				let oldKey: string | undefined;
				for (const candidate of candidates) {
					if (candidate === r.projectKey) continue;
					const hasConfig = Object.hasOwn(globalConfig.projects, candidate);
					const hasDir = await pathExists(privateMemoryRoot(candidate, projectsDir));
					if (hasConfig || hasDir) {
						oldKey = candidate;
						break;
					}
				}

				if (!oldKey) {
					if (candidates.includes(r.projectKey)) {
						ctx.ui.notify("That key already matches this project's current key; nothing to relink.", "info");
						return;
					}
					ctx.ui.notify(
						`No project memory found for ${arg} (checked ${candidates.length} candidate key${candidates.length === 1 ? "" : "s"}: ${candidates.join(", ")}).`,
						"error",
					);
					return;
				}

				// A legacy-shaped key (`g-...` or a bare 16-hex hash) can only ever be
				// this same repo's own past identity - those schemes are never written
				// anymore, so nothing else could still be using one live. Anything else
				// is a normal name key, which could be another project's *current* key
				// (e.g. `/memory-relink ../other-repo` when `other-repo` is a real,
				// still-in-use project someone mistyped their way into) - relinking that
				// would move its private memory away from it. Confirm before doing that
				// when there's a UI to ask; without one, require an explicit --force so
				// it can never happen silently.
				const oldKeyIsLegacyShape = PROJECT_KEY_PATTERN.test(oldKey) || LEGACY_HASH_PATTERN.test(oldKey);
				if (!oldKeyIsLegacyShape) {
					if (ctx.hasUI) {
						const confirmed = await ctx.ui.confirm(
							"Relink another project's memory key?",
							`${oldKey} doesn't look like a leftover legacy id - it may be another project's current memory key. ` +
								`Relinking will move its private memory (and config) into this project's key (${r.projectKey}). ` +
								`Only continue if you're sure ${oldKey} isn't still in active use elsewhere.`,
						);
						if (!confirmed) {
							ctx.ui.notify("Relink cancelled.", "info");
							return;
						}
					} else if (!force) {
						ctx.ui.notify(
							`${oldKey} doesn't look like a leftover legacy id - it may be another project's current memory key. ` +
								`Re-run with --force to relink it anyway (only do this if you're sure it isn't still in active use elsewhere).`,
							"error",
						);
						return;
					}
				}

				const result = await moveProjectKey({ configPath: GLOBAL_CONFIG_PATH, projectsDir, oldKey, newKey: r.projectKey });

				let configDropped = false;
				if (result.config === "conflict" && dropOldConfig) {
					// Discarding a config entry is permanent, so it needs either an
					// explicit confirmation (when there's a UI to ask) or an explicit
					// --force (without one) - it must never auto-confirm itself.
					const confirmed = ctx.hasUI
						? await ctx.ui.confirm(
								"Discard the old config entry?",
								`This project already has its own memory-mode config; the leftover entry under ${oldKey} will be permanently discarded (only the config entry, not any memory files).`,
							)
						: force;
					if (!confirmed && !ctx.hasUI) {
						ctx.ui.notify(
							"--drop-old-config without a UI also requires --force (only do this if you're sure this project's current config is the one to keep).",
							"error",
						);
						return;
					}
					if (confirmed) {
						await dropProjectConfigKey(GLOBAL_CONFIG_PATH, oldKey);
						configDropped = true;
					}
				}
				invalidateResolved();

				const configText = configDropped
					? "old config entry discarded (kept this project's existing one)"
					: result.config === "moved"
						? "config moved"
						: result.config === "conflict"
							? `config left in place under the old key (this project already has its own; rerun with --drop-old-config to discard the old one)`
							: "no config to move";
				const dirText =
					result.dir === "moved"
						? "private memory moved"
						: result.dir === "merged"
							? "private memory merged"
							: result.dir === "conflict"
								? `private memory partially merged (${result.dirConflicts.length} conflicting file${result.dirConflicts.length === 1 ? "" : "s"} left under the old key: ${result.dirConflicts.join(", ")})`
								: "no private memory to move";

				ctx.ui.notify(`Relinked ${oldKey} into this project's key (${r.projectKey}): ${configText}; ${dirText}.`, "info");
			},
		});
	}
}
