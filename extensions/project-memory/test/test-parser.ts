import type { FrontmatterParser } from "../types.ts";

/**
 * Minimal parser matching the exact `key: <JSON>` format frontmatter.ts
 * emits, shared across store/config/resolve tests. Not a general YAML
 * parser - only needs to understand our own serializer's output.
 */
export const testParseFrontmatter: FrontmatterParser = <T extends Record<string, unknown>>(content: string) => {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {} as T, body: content };
	const [, yamlBlock, body] = match;
	const frontmatter: Record<string, unknown> = {};
	for (const line of yamlBlock.split("\n")) {
		if (!line.trim()) continue;
		const idx = line.indexOf(": ");
		const key = line.slice(0, idx);
		const value = line.slice(idx + 2);
		frontmatter[key] = JSON.parse(value);
	}
	return { frontmatter: frontmatter as T, body: body.trim() };
};
