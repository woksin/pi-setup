import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimateTokens, formatFloor, groupByPrefix, loadFloorConfig, measureFloor, splitSections, statusText } from "./prompt-floor.ts";

const block = (name: string, body: string) => `<${name}>\n${body}\n</${name}>`;
const prompt = ["You are a coding assistant.\n\nSecond preamble paragraph.", block("rules", "r".repeat(100)), block("skills", "s".repeat(500) + "\n<available_skills>\n  <skill>\n</available_skills>"), "<cwd>\n/work\n</cwd>"].join("\n\n");

test("sections are split by top-level tag, nested tags stay inside their section", () => {
	const sections = splitSections(prompt);
	assert.deepEqual(Object.keys(sections), ["preamble", "rules", "skills", "cwd"]);
	assert.equal(sections.preamble, Buffer.byteLength("You are a coding assistant.\n\nSecond preamble paragraph."));
	assert.equal(sections.rules, Buffer.byteLength(block("rules", "r".repeat(100))));
	assert.ok(sections.skills > 500);
});

test("a prompt without tagged sections is all preamble", () => {
	assert.deepEqual(splitSections("plain text"), { preamble: 10 });
});

test("measureFloor sums prompt and tool bytes, sorts tools by size and reports context files", () => {
	const tools = [
		{ name: "small", description: "d", parameters: { type: "object" } },
		{ name: "big", description: "x".repeat(1000), parameters: { type: "object", properties: { a: { type: "string" } } } },
		{ name: "none" },
	];
	const m = measureFloor({ systemPrompt: prompt, systemPromptOptions: { contextFiles: [{ path: "/a/AGENTS.md", content: "héllo" }] }, tools });
	assert.deepEqual(m.tools.map((t) => t.name), ["big", "small", "none"]);
	assert.equal(m.toolsBytes, m.tools.reduce((s, t) => s + t.bytes, 0));
	assert.equal(m.promptBytes, Buffer.byteLength(prompt));
	assert.equal(m.totalBytes, m.promptBytes + m.toolsBytes);
	assert.equal(m.skillsBytes, m.sections.skills);
	assert.deepEqual(m.contextFileBytes, { "/a/AGENTS.md": 6 });
	assert.equal(m.estTokens, estimateTokens(m.totalBytes));
});

test("token estimate is monotone and uses the measured regression", () => {
	assert.equal(estimateTokens(0), 12700);
	assert.equal(estimateTokens(100_000), Math.round(12700 + 33800));
	assert.ok(estimateTokens(2000) > estimateTokens(1000));
});

test("status text marks floors above the warn threshold", () => {
	const m = measureFloor({ systemPrompt: "x".repeat(300_000), tools: [] });
	assert.match(statusText(m, 100_000), /^floor ~\d+k !$/);
	assert.match(statusText(m, 1_000_000), /^floor ~\d+k$/);
	assert.match(formatFloor(m), /Largest tools:/);
});

test("config: missing file gives defaults; file, keepFull env and PI_FLOOR=off apply", () => {
	const dir = mkdtempSync(join(tmpdir(), "floor-cfg-"));
	const defaults = loadFloorConfig({}, join(dir, "none.json"));
	assert.equal(defaults.skills.projectMode, "compact");
	assert.equal(defaults.warnTokens, 100_000);
	const file = join(dir, "prompt-floor.json");
	writeFileSync(file, JSON.stringify({ warnTokens: 90000, skills: { descChars: 40, keepFull: ["a-*"], projectMode: "compact" } }));
	const cfg = loadFloorConfig({ PI_FLOOR_FULL_SKILLS: "b, c" }, file);
	assert.equal(cfg.warnTokens, 90000);
	assert.equal(cfg.skills.descChars, 40);
	assert.deepEqual(cfg.skills.keepFull, ["a-*", "b", "c"]);
	assert.equal(loadFloorConfig({ PI_FLOOR: "off" }, file).skills.projectMode, "full");
	writeFileSync(file, "{ broken");
	assert.equal(loadFloorConfig({}, file).warnTokens, 100_000);
});

test("tools are grouped by name prefix; names without an underscore go under other", () => {
	const tools = [{ name: "browser_a", description: "aaaa" }, { name: "browser_b", description: "bb" }, { name: "web_x", description: "x" }, { name: "read", description: "r" }];
	const groups = groupByPrefix(tools);
	assert.equal(groups.browser.count, 2);
	assert.equal(groups.browser.bytes, 4 + 2 + 2 * 2);
	assert.equal(groups.web.count, 1);
	assert.equal(groups.other.count, 1);
	const m = measureFloor({ systemPrompt: "x", tools });
	assert.deepEqual(m.prefixes, groups);
	assert.match(formatFloor(m, 100_000, { browser: { count: 9, bytes: 20_480 } }), /All registered tools by prefix[^\n]*\n {2}browser_\*: 20\.0 KB \(9\)/);
});
