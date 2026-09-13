import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, withLock } from "../lock.ts";

async function makeTmpDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-memory-lock-test-"));
}

test("acquireLock succeeds when no lock exists, and blocks a second acquirer until released", async () => {
	const dir = await makeTmpDir();
	try {
		const lockDir = join(dir, ".lock");
		const handle = await acquireLock(lockDir);

		let secondAcquired = false;
		const secondAttempt = acquireLock(lockDir, { timeoutMs: 2000, pollMs: 10 }).then((h) => {
			secondAcquired = true;
			return h;
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(secondAcquired, false, "second acquirer should still be waiting");

		await handle.release();
		const secondHandle = await secondAttempt;
		assert.equal(secondAcquired, true);
		await secondHandle.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("acquireLock times out when the lock is held and not stale", async () => {
	const dir = await makeTmpDir();
	try {
		const lockDir = join(dir, ".lock");
		const handle = await acquireLock(lockDir);
		await assert.rejects(() => acquireLock(lockDir, { timeoutMs: 100, pollMs: 10, staleMs: 60_000 }), /Timed out/);
		await handle.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("acquireLock reclaims a stale lock directory", async () => {
	const dir = await makeTmpDir();
	try {
		const lockDir = join(dir, ".lock");
		await acquireLock(lockDir); // leaves lockDir on disk, simulating a crashed holder that never released
		const old = new Date(Date.now() - 60_000);
		await utimes(lockDir, old, old);

		const handle = await acquireLock(lockDir, { timeoutMs: 1000, pollMs: 10, staleMs: 1000 });
		await handle.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("withLock releases the lock even when the callback throws", async () => {
	const dir = await makeTmpDir();
	try {
		const lockDir = join(dir, ".lock");
		await assert.rejects(
			withLock(lockDir, async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		// Lock should be free again - this would time out if release() were skipped.
		const handle = await acquireLock(lockDir, { timeoutMs: 500, pollMs: 10 });
		await handle.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
