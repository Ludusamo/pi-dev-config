import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serializeEntry } from "../frontmatter.ts";
import * as store from "../store.ts";
import type { MemoryFrontmatter } from "../types.ts";
import { testParseFrontmatter } from "./test-parser.ts";

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-store-test-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function makeFrontmatter(overrides: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter {
	const now = new Date().toISOString();
	return {
		id: store.generateId(overrides.title ?? "test entry"),
		title: "Test entry",
		term: "short",
		status: "active",
		tags: [],
		createdAt: now,
		updatedAt: now,
		source: "main",
		...overrides,
	};
}

test("writeEntry then readEntry round-trips frontmatter and body", async () => {
	await withTmpRoot(async (root) => {
		const fm = makeFrontmatter({ tags: ["a", "b"] });
		await store.writeEntry(root, "short", fm, "hello world");
		const entry = await store.readEntry(root, "short", fm.id, testParseFrontmatter);
		assert.ok(entry);
		assert.equal(entry?.body, "hello world");
		assert.deepEqual(entry?.frontmatter.tags, ["a", "b"]);
	});
});

test("readEntry returns undefined for a missing entry", async () => {
	await withTmpRoot(async (root) => {
		const entry = await store.readEntry(root, "long", "does-not-exist", testParseFrontmatter);
		assert.equal(entry, undefined);
	});
});

test("listEntries returns [] for a term directory that doesn't exist yet", async () => {
	await withTmpRoot(async (root) => {
		const entries = await store.listEntries(root, "long", testParseFrontmatter);
		assert.deepEqual(entries, []);
	});
});

test("findEntry locates an entry across short and long terms", async () => {
	await withTmpRoot(async (root) => {
		const fm = makeFrontmatter({ term: "long", status: "active" });
		await store.writeEntry(root, "long", fm, "body");
		const found = await store.findEntry(root, fm.id, testParseFrontmatter);
		assert.equal(found?.term, "long");
		assert.equal(found?.entry.frontmatter.id, fm.id);
	});
});

test("updateEntry patches fields and bumps updatedAt without touching id", async () => {
	await withTmpRoot(async (root) => {
		const fm = makeFrontmatter({ updatedAt: "2020-01-01T00:00:00.000Z" });
		await store.writeEntry(root, "short", fm, "original body");
		const updated = await store.updateEntry(root, fm.id, { title: "New title", body: "new body" }, testParseFrontmatter);
		assert.equal(updated?.frontmatter.id, fm.id);
		assert.equal(updated?.frontmatter.title, "New title");
		assert.equal(updated?.body, "new body");
		assert.notEqual(updated?.frontmatter.updatedAt, "2020-01-01T00:00:00.000Z");
	});
});

test("updateEntry returns undefined for a missing id", async () => {
	await withTmpRoot(async (root) => {
		const updated = await store.updateEntry(root, "nope", { title: "x" }, testParseFrontmatter);
		assert.equal(updated, undefined);
	});
});

test("archiveExpiredShortTerm archives past-TTL entries without deleting the file", async () => {
	await withTmpRoot(async (root) => {
		const expired = makeFrontmatter({
			title: "expired",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		const fresh = makeFrontmatter({
			title: "fresh",
			expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		});
		await store.writeEntry(root, "short", expired, "body");
		await store.writeEntry(root, "short", fresh, "body");

		const archivedCount = await store.archiveExpiredShortTerm(root, testParseFrontmatter);
		assert.equal(archivedCount, 1);

		const expiredEntry = await store.readEntry(root, "short", expired.id, testParseFrontmatter);
		const freshEntry = await store.readEntry(root, "short", fresh.id, testParseFrontmatter);
		assert.equal(expiredEntry?.frontmatter.status, "archived");
		assert.equal(freshEntry?.frontmatter.status, "active");

		// File must still exist on disk - archiving is not deletion.
		const raw = await readFile(expiredEntry!.filePath, "utf-8");
		assert.match(raw, /"archived"/);
	});
});

test("searchEntries filters by query, tags, and term, and excludes archived entries", async () => {
	await withTmpRoot(async (root) => {
		const a = makeFrontmatter({ title: "Auth flow decision", tags: ["auth"], term: "long" });
		const b = makeFrontmatter({ title: "Unrelated note", tags: ["misc"], term: "short" });
		const archived = makeFrontmatter({ title: "Old auth note", tags: ["auth"], status: "archived", term: "long" });
		await store.writeEntry(root, "long", a, "details about auth");
		await store.writeEntry(root, "short", b, "nothing interesting");
		await store.writeEntry(root, "long", archived, "stale");

		const byQuery = await store.searchEntries(root, testParseFrontmatter, { query: "auth" });
		assert.deepEqual(
			byQuery.map((e) => e.frontmatter.id),
			[a.id],
		);

		const byTerm = await store.searchEntries(root, testParseFrontmatter, { term: "short" });
		assert.deepEqual(
			byTerm.map((e) => e.frontmatter.id),
			[b.id],
		);

		const byTag = await store.searchEntries(root, testParseFrontmatter, { tags: ["auth"] });
		assert.deepEqual(
			byTag.map((e) => e.frontmatter.id),
			[a.id],
		);
	});
});

test("buildCompactIndex lists active short-term and non-archived long-term entries", async () => {
	await withTmpRoot(async (root) => {
		assert.equal(await store.buildCompactIndex(root, testParseFrontmatter), "");

		const longActive = makeFrontmatter({ title: "Long active", term: "long", status: "active" });
		const longArchived = makeFrontmatter({ title: "Long archived", term: "long", status: "archived" });
		const shortActive = makeFrontmatter({ title: "Short active", term: "short", status: "active" });
		const shortArchived = makeFrontmatter({ title: "Short archived", term: "short", status: "archived" });
		await store.writeEntry(root, "long", longActive, "");
		await store.writeEntry(root, "long", longArchived, "");
		await store.writeEntry(root, "short", shortActive, "");
		await store.writeEntry(root, "short", shortArchived, "");

		const index = await store.buildCompactIndex(root, testParseFrontmatter);
		assert.match(index, /Long active/);
		assert.match(index, /Short active/);
		assert.doesNotMatch(index, /Long archived/);
		assert.doesNotMatch(index, /Short archived/);
	});
});

test("buildCompactIndex excludes pending long-term entries and expired-but-not-yet-swept short entries", async () => {
	await withTmpRoot(async (root) => {
		const longPending = makeFrontmatter({ title: "Long pending", term: "long", status: "pending" });
		const longNeedsReview = makeFrontmatter({ title: "Long needs review", term: "long", status: "needs-review" });
		const shortExpired = makeFrontmatter({
			title: "Short expired",
			term: "short",
			status: "active",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		await store.writeEntry(root, "long", longPending, "");
		await store.writeEntry(root, "long", longNeedsReview, "");
		await store.writeEntry(root, "short", shortExpired, "");

		const index = await store.buildCompactIndex(root, testParseFrontmatter);
		assert.doesNotMatch(index, /Long pending/);
		assert.match(index, /Long needs review/);
		assert.doesNotMatch(index, /Short expired/);
	});
});

test("buildCompactIndex sanitizes newlines embedded in titles and tags", async () => {
	await withTmpRoot(async (root) => {
		const fm = makeFrontmatter({
			title: "Injected\n- fake-id (active): fake title",
			term: "long",
			status: "active",
			tags: ["a\nb"],
		});
		await store.writeEntry(root, "long", fm, "");
		const index = await store.buildCompactIndex(root, testParseFrontmatter);
		assert.doesNotMatch(index, /\nfake title/);
		assert.doesNotMatch(index, /a\nb/);
	});
});

test("isValidMemoryId rejects path traversal and other disallowed characters", () => {
	assert.equal(store.isValidMemoryId("auth-flow-decision-a1b2c3"), true);
	assert.equal(store.isValidMemoryId("../../etc/passwd"), false);
	assert.equal(store.isValidMemoryId("..%2f..%2fetc"), false);
	assert.equal(store.isValidMemoryId("with/slash"), false);
	assert.equal(store.isValidMemoryId("UPPERCASE"), false);
	assert.equal(store.isValidMemoryId(""), false);
	assert.equal(store.isValidMemoryId(".."), false);
});

test("readEntry, findEntry, and updateEntry reject invalid ids instead of touching the filesystem", async () => {
	await withTmpRoot(async (root) => {
		assert.equal(await store.readEntry(root, "long", "../../etc/passwd", testParseFrontmatter), undefined);
		assert.equal(await store.findEntry(root, "../../etc/passwd", testParseFrontmatter), undefined);
		assert.equal(await store.updateEntry(root, "../../etc/passwd", { title: "x" }, testParseFrontmatter), undefined);
	});
});

test("listEntries skips a corrupt file instead of failing the whole listing", async () => {
	await withTmpRoot(async (root) => {
		const good = makeFrontmatter({ title: "Good entry", term: "short" });
		await store.writeEntry(root, "short", good, "body");
		await mkdir(join(root, "short"), { recursive: true });
		await writeFile(join(root, "short", "corrupt.md"), "not valid frontmatter at all", "utf-8");

		const entries = await store.listEntries(root, "short", testParseFrontmatter);
		assert.deepEqual(
			entries.map((e) => e.frontmatter.id),
			[good.id],
		);
	});
});

test("listEntries skips a file whose frontmatter id doesn't match its filename", async () => {
	await withTmpRoot(async (root) => {
		const good = makeFrontmatter({ title: "Good entry", term: "short" });
		await store.writeEntry(root, "short", good, "body");

		const mismatched = makeFrontmatter({ title: "Mismatched entry", term: "short" });
		await mkdir(join(root, "short"), { recursive: true });
		await writeFile(join(root, "short", "different-filename.md"), serializeEntry(mismatched, "body"), "utf-8");

		const entries = await store.listEntries(root, "short", testParseFrontmatter);
		assert.deepEqual(
			entries.map((e) => e.frontmatter.id),
			[good.id],
		);
	});
});

test("readEntry returns undefined instead of throwing on a corrupt/unparseable file", async () => {
	await withTmpRoot(async (root) => {
		await mkdir(join(root, "short"), { recursive: true });
		await writeFile(join(root, "short", "corrupt.md"), "not valid frontmatter at all", "utf-8");

		const entry = await store.readEntry(root, "short", "corrupt", testParseFrontmatter);
		assert.equal(entry, undefined);
	});
});

test("readEntry returns undefined when the frontmatter id doesn't match the filename", async () => {
	await withTmpRoot(async (root) => {
		const fm = makeFrontmatter({ id: "actual-id", title: "Mismatched", term: "short" });
		await mkdir(join(root, "short"), { recursive: true });
		await writeFile(join(root, "short", "requested-id.md"), serializeEntry(fm, "body"), "utf-8");

		const entry = await store.readEntry(root, "short", "requested-id", testParseFrontmatter);
		assert.equal(entry, undefined);
	});
});

test("promoteEntry gives the promoted long-term entry a new id, and it stays reachable afterward", async () => {
	await withTmpRoot(async (root) => {
		const shortFm = makeFrontmatter({ title: "Promote me", term: "short", status: "active" });
		await store.writeEntry(root, "short", shortFm, "original body");

		const result = await store.promoteEntry(root, shortFm.id, "active", testParseFrontmatter);
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.notEqual(result.entry.frontmatter.id, shortFm.id);

		// The old short-term id now resolves to the archived stub, not the promoted entry.
		const viaOldId = await store.findEntry(root, shortFm.id, testParseFrontmatter);
		assert.equal(viaOldId?.term, "short");
		assert.equal(viaOldId?.entry.frontmatter.status, "archived");
		assert.equal(viaOldId?.entry.frontmatter.promotedTo, result.entry.frontmatter.id);

		// The promoted long-term entry is independently gettable, updatable, and deletable by its new id.
		const newId = result.entry.frontmatter.id;
		const viaNewId = await store.findEntry(root, newId, testParseFrontmatter);
		assert.equal(viaNewId?.term, "long");
		assert.equal(viaNewId?.entry.frontmatter.status, "active");

		const updated = await store.updateEntry(root, newId, { title: "Updated title" }, testParseFrontmatter);
		assert.equal(updated?.frontmatter.title, "Updated title");

		const archived = await store.updateEntry(root, newId, { status: "archived" }, testParseFrontmatter);
		assert.equal(archived?.frontmatter.status, "archived");
	});
});

test("promoteEntry refuses to promote a non-active short-term entry", async () => {
	await withTmpRoot(async (root) => {
		const pendingLikeShort = makeFrontmatter({ title: "Not active", term: "short", status: "needs-review" });
		await store.writeEntry(root, "short", pendingLikeShort, "body");
		const result = await store.promoteEntry(root, pendingLikeShort.id, "active", testParseFrontmatter);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "not-active");

		// Nothing should have been promoted or archived.
		const stillShort = await store.readEntry(root, "short", pendingLikeShort.id, testParseFrontmatter);
		assert.equal(stillShort?.frontmatter.status, "needs-review");
	});
});

test("promoteEntry reports not-found for a missing or long-term id", async () => {
	await withTmpRoot(async (root) => {
		const missing = await store.promoteEntry(root, "does-not-exist", "active", testParseFrontmatter);
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.error, "not-found");

		const longFm = makeFrontmatter({ title: "Already long", term: "long", status: "active" });
		await store.writeEntry(root, "long", longFm, "body");
		const wrongTerm = await store.promoteEntry(root, longFm.id, "active", testParseFrontmatter);
		assert.equal(wrongTerm.ok, false);
	});
});

test("updateEntry does not lose concurrent updates to disjoint fields", async () => {
	await withTmpRoot(async (root) => {
		const fm = makeFrontmatter({ title: "Original", tags: [] });
		await store.writeEntry(root, "short", fm, "body");

		await Promise.all([
			store.updateEntry(root, fm.id, { title: "New title" }, testParseFrontmatter),
			store.updateEntry(root, fm.id, { tags: ["a"] }, testParseFrontmatter),
		]);

		const final = await store.readEntry(root, "short", fm.id, testParseFrontmatter);
		assert.equal(final?.frontmatter.title, "New title");
		assert.deepEqual(final?.frontmatter.tags, ["a"]);
	});
});
