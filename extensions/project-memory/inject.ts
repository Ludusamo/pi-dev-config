/**
 * Builds the hidden context message that carries the compact memory index,
 * and keeps stale copies of it out of the messages actually sent to the LLM.
 *
 * Kept free of pi imports (uses structural typing) so it's independently
 * unit-testable.
 */

export const MEMORY_CONTEXT_CUSTOM_TYPE = "project-memory-context";

// Sent once, in place of the real index, when the index transitions from
// non-empty to empty (e.g. the only entries got archived/expired) - without
// this, the last hidden message left in context would still show the old,
// now-stale index content.
export const EMPTY_MEMORY_CONTEXT_MESSAGE = "Project memory: no active entries.";

export interface InjectableMessage {
	customType: string;
	content: string;
	display: boolean;
}

export function buildMemoryContextMessage(indexText: string): InjectableMessage {
	return {
		customType: MEMORY_CONTEXT_CUSTOM_TYPE,
		content: indexText,
		display: false,
	};
}

/**
 * Decides what hidden index content (if any) should be injected this turn,
 * given the freshly built index and the content last injected.
 *
 * Returns undefined when nothing needs to change: either the index is still
 * empty and always has been (nothing was ever shown), or it's unchanged from
 * last turn. Otherwise returns the content to inject (the real index, or the
 * empty-state sentinel if the index just became empty after being non-empty).
 */
export function resolveMemoryContextContent(index: string, lastContent: string | undefined): string | undefined {
	const content = index || (lastContent ? EMPTY_MEMORY_CONTEXT_MESSAGE : "");
	if (!content || content === lastContent) return undefined;
	return content;
}

interface CustomLikeMessage {
	role?: string;
	customType?: string;
}

function isMemoryContextMessage(message: unknown): message is CustomLikeMessage {
	const m = message as CustomLikeMessage | null | undefined;
	return !!m && m.role === "custom" && m.customType === MEMORY_CONTEXT_CUSTOM_TYPE;
}

/**
 * Keeps only the most recent project-memory-context custom message in a
 * message list, dropping earlier duplicates so repeated per-turn injection
 * doesn't bloat every subsequent LLM call with stale index snapshots.
 */
export function dropStaleMemoryContext<T>(messages: T[]): T[] {
	let lastIndex = -1;
	messages.forEach((message, index) => {
		if (isMemoryContextMessage(message)) lastIndex = index;
	});
	if (lastIndex === -1) return messages;
	return messages.filter((message, index) => index === lastIndex || !isMemoryContextMessage(message));
}
