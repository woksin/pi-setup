import type { Role } from "./output-cap.ts";

export const isShortTierRole = (role: Role): boolean => role === "subagent";

// Tool arguments and tool schemas are caller data, not provider cache metadata; never rewrite inside them.
const OPAQUE_KEYS = new Set(["input", "input_schema", "inputSchema", "arguments", "parameters"]);

/** Copy only changed branches; bound traversal and ignore non-cache TTL fields. */
export function stripLongTtl(payload: unknown): unknown | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	function walk(value: any, depth: number, cacheField = false): any {
		if (!value || typeof value !== "object" || depth > 8) return value;
		let copy: any;
		for (const key of Object.keys(value)) {
			if (cacheField && key === "ttl" && value[key] === "1h") {
				copy ??= Array.isArray(value) ? [...value] : { ...value };
				delete copy[key];
				continue;
			}
			if (OPAQUE_KEYS.has(key)) continue;
			const child = walk(value[key], depth + 1, key === "cache_control" || key === "cachePoint");
			if (child !== value[key]) {
				copy ??= Array.isArray(value) ? [...value] : { ...value };
				copy[key] = child;
			}
		}
		return copy ?? value;
	}
	let result: Record<string, unknown> | undefined;
	const source = payload as Record<string, unknown>;
	for (const key of ["system", "messages", "tools", "toolConfig"]) {
		const value = walk(source[key], 1);
		if (value !== source[key]) {
			result ??= { ...source };
			result[key] = value;
		}
	}
	return result;
}
