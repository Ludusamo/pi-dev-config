/**
 * mkdir-based mutual exclusion lock for cross-process metadata/store writes.
 *
 * `mkdir` on most filesystems (including network filesystems pi commonly runs
 * on) is atomic, so "does the lock directory already exist" doubles as the
 * acquire check with no separate lockfile package required.
 */

import { mkdir, rmdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockHandle {
	release(): Promise<void>;
}

export interface LockOptions {
	/** How long to wait for the lock before giving up. Default 5000ms. */
	timeoutMs?: number;
	/** A lock directory older than this is assumed abandoned (crashed holder) and reclaimed. Default 30000ms. */
	staleMs?: number;
	/** Delay between acquisition attempts. Default 50ms. */
	pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireLock(lockDir: string, options: LockOptions = {}): Promise<LockHandle> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + timeoutMs;

	await mkdir(dirname(lockDir), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockDir);
			return {
				release: async () => {
					await rmdir(lockDir).catch(() => {});
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

			const stale = await stat(lockDir)
				.then((st) => Date.now() - st.mtimeMs > staleMs)
				.catch(() => false);
			if (stale) {
				await rmdir(lockDir).catch(() => {});
				continue;
			}

			if (Date.now() >= deadline) {
				throw new Error(`Timed out acquiring lock: ${lockDir}`);
			}
			await sleep(pollMs);
		}
	}
}

export async function withLock<T>(lockDir: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
	const handle = await acquireLock(lockDir, options);
	try {
		return await fn();
	} finally {
		await handle.release();
	}
}
