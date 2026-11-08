import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type FloorConfig } from "./prompt-floor.ts";
import { compactSkills, readablePath, skillHint } from "./skill-floor.ts";

const cfg = (skills: Partial<FloorConfig["skills"]> = {}): FloorConfig => ({ ...DEFAULT_CONFIG, skills: { ...DEFAULT_CONFIG.skills, ...skills } });

function writeSkill(root: string, name: string, description: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}

/** Real loadSkills result: 107 project skills behind a `.pi/skills` symlink (as in Cratis worktrees) and 5 global skills. */
function fixture() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "skill-floor-")));
	const corpus = join(base, "repo", ".cratis", "ai", "skills");
	for (let i = 0; i < 107; i++) writeSkill(corpus, `proj-skill-${String(i).padStart(3, "0")}`, `Use when working on feature ${i}. ${"Long explanation of the skill that goes on and on. ".repeat(6)}`);
	mkdirSync(join(base, "repo", ".pi"), { recursive: true });
	symlinkSync("../.cratis/ai/skills", join(base, "repo", ".pi", "skills"));
	const agentDir = join(base, "agent");
	for (let i = 0; i < 5; i++) writeSkill(join(agentDir, "skills"), `global-skill-${i}`, `Global skill ${i}. ${"More detail. ".repeat(10)}`);
	const cwd = join(base, "repo");
	const { skills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
	return { cwd, skills };
}

test("fixture is built from the real loader: 107 project + 5 global skills", () => {
	const { skills } = fixture();
	assert.equal(skills.filter((s) => s.sourceInfo.scope === "project").length, 107);
	assert.equal(skills.filter((s) => s.sourceInfo.scope !== "project").length, 5);
});

test("compaction shrinks the listing, keeps every project skill with a readable path, leaves global skills alone", () => {
	const { cwd, skills } = fixture();
	const before = formatSkillsForPrompt(skills).length;
	const result = compactSkills(skills, cfg(), cwd);
	const after = formatSkillsForPrompt(result.skills).length + (result.section?.length ?? 0);
	assert.ok(after < before / 2, `${after} vs ${before}`);
	assert.equal(result.compacted, 107);
	const lines = result.section!.split("\n").slice(1);
	assert.equal(lines.length, 107);
	for (const skill of skills.filter((s) => s.sourceInfo.scope === "project")) {
		const line = lines.find((l) => l.startsWith(`${skill.name} | `));
		assert.ok(line, `missing ${skill.name}`);
		const path = line.split(" | ").pop()!;
		assert.ok(existsSync(resolve(cwd, path)), `unreadable ${path}`);
		assert.equal(realpathSync(resolve(cwd, path)), realpathSync(skill.filePath));
		assert.ok(line.split(" | ")[1].length > 0, "hint kept");
	}
	// Global skills are still fully listed by Pi and project ones are hidden from its listing.
	const pi = formatSkillsForPrompt(result.skills);
	for (let i = 0; i < 5; i++) assert.match(pi, new RegExp(`<name>global-skill-${i}</name>`));
	assert.doesNotMatch(pi, /proj-skill-/);
	assert.match(pi, /More detail\. More detail\./);
});

test("input skill objects are not mutated and the result is deterministic", () => {
	const { cwd, skills } = fixture();
	const snapshot = JSON.stringify(skills);
	const a = compactSkills(skills, cfg(), cwd);
	const b = compactSkills([...skills].reverse(), cfg(), cwd);
	assert.equal(JSON.stringify(skills), snapshot);
	assert.equal(a.section, b.section);
	assert.ok(a.skills.every((s, i) => s !== skills[i] || s.sourceInfo.scope !== "project"));
});

test("keepFull globs keep matching project skills in the normal listing", () => {
	const { cwd, skills } = fixture();
	const result = compactSkills(skills, cfg({ keepFull: ["proj-skill-00*"] }), cwd);
	assert.equal(result.compacted, 97);
	const pi = formatSkillsForPrompt(result.skills);
	assert.match(pi, /<name>proj-skill-005<\/name>/);
	assert.doesNotMatch(result.section!, /^proj-skill-005 /m);
	assert.match(result.section!, /^proj-skill-010 /m);
});

test("the size cap shrinks hints but never drops a skill or its path", () => {
	const { cwd, skills } = fixture();
	const result = compactSkills(skills, cfg({ maxBytes: 1 }), cwd);
	const lines = result.section!.split("\n").slice(1);
	assert.equal(lines.length, 107);
	assert.ok(lines.every((l) => /^proj-skill-\d{3} \| \| \S+SKILL\.md$/.test(l)), lines[0]);
});

test("off switch, no project skills and author-hidden skills produce no section", () => {
	const { cwd, skills } = fixture();
	const off = compactSkills(skills, cfg({ projectMode: "full" }), cwd);
	assert.equal(off.section, undefined);
	assert.equal(off.skills, skills);
	const globalOnly = skills.filter((s) => s.sourceInfo.scope !== "project");
	assert.equal(compactSkills(globalOnly, cfg(), cwd).section, undefined);
	assert.equal(compactSkills([], cfg(), cwd).section, undefined);
	const hidden = skills.map((s) => ({ ...s, disableModelInvocation: true }));
	assert.equal(compactSkills(hidden, cfg(), cwd).section, undefined);
});

test("paths: relative when they resolve to the same file, absolute otherwise", () => {
	assert.equal(readablePath("/w/repo/.pi/skills/a/SKILL.md", "/w/repo"), ".pi/skills/a/SKILL.md");
	assert.equal(readablePath("/w/repo/.pi/skills/a/SKILL.md", "/w/repo/sub"), "../.pi/skills/a/SKILL.md");
	assert.equal(readablePath("relative/x", "/w"), "relative/x");
	assert.equal(readablePath("/w/x/SKILL.md", ""), "/w/x/SKILL.md");
});

test("hint is the first sentence, flattened, cut at the limit", () => {
	assert.equal(skillHint("Use before <x>.\nSecond sentence.", 80), "Use before x .");
	assert.equal(skillHint("abcdefghij", 5), "abcd…");
	assert.equal(skillHint("anything", 0), "");
});
