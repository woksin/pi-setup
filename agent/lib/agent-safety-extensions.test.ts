/** Every subagent type with an explicit `extensions:` allowlist must load the safety guards (kill-guard: #219). */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REQUIRED_SUBAGENT_GUARDS = ["kill-guard"];
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/** The explicit `extensions: [a, b]` list from the frontmatter, or undefined when the agent has none. */
function explicitExtensions(markdown: string): string[] | undefined {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
	const line = /^extensions:\s*\[(.*)\]\s*$/m.exec(frontmatter);
	return line ? line[1].split(",").map((name) => name.trim()).filter(Boolean) : undefined;
}

const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md")).sort();

test("at least one agent definition is found", () => {
	assert.ok(agentFiles.length > 0, `no agent *.md files in ${AGENTS_DIR}`);
});

for (const file of agentFiles) {
	test(`${file} loads the required safety guards`, () => {
		const extensions = explicitExtensions(readFileSync(join(AGENTS_DIR, file), "utf8"));
		if (!extensions) return; // no explicit allowlist: nothing to check
		for (const guard of REQUIRED_SUBAGENT_GUARDS) {
			assert.ok(extensions.includes(guard), `${file}: extensions must include ${guard} (got: ${extensions.join(", ")})`);
		}
	});
}
