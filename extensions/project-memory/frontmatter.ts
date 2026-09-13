/**
 * Frontmatter serialization for memory entry files.
 *
 * Parsing is intentionally NOT implemented here - callers inject pi's
 * exported `parseFrontmatter` (see types.ts FrontmatterParser). This module
 * only writes frontmatter, and it does so by emitting one `key: <JSON>` line
 * per field. Any value produced by `JSON.stringify` is also valid YAML flow
 * scalar/sequence/mapping syntax, so the output round-trips through a real
 * YAML parser without pulling a yaml dependency into this extension.
 */

const FRONTMATTER_DELIMITER = "---";

export function serializeFrontmatter(data: Record<string, unknown>): string {
	const lines = Object.entries(data)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
	return `${FRONTMATTER_DELIMITER}\n${lines.join("\n")}\n${FRONTMATTER_DELIMITER}\n`;
}

export function serializeEntry(frontmatter: Record<string, unknown>, body: string): string {
	const trimmedBody = body.trim();
	return trimmedBody ? `${serializeFrontmatter(frontmatter)}\n${trimmedBody}\n` : serializeFrontmatter(frontmatter);
}
