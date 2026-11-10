import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import promptFloor from "../extensions/prompt-floor.ts";

test("before_agent_start compacts project skills, sets the status, logs sizes only and /floor prints the table", async () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "floor-ext-")));
	const corpus = join(base, "repo", "corpus");
	for (let i = 0; i < 20; i++) {
		mkdirSync(join(corpus, `s${i}`), { recursive: true });
		writeFileSync(join(corpus, `s${i}`, "SKILL.md"), `---\nname: s${i}\ndescription: Use for thing ${i}. More words here.\n---\n# s${i}\n`);
	}
	mkdirSync(join(base, "repo", ".pi"), { recursive: true });
	symlinkSync("../corpus", join(base, "repo", ".pi", "skills"));
	const cwd = join(base, "repo");
	const { skills } = loadSkills({ cwd, agentDir: join(base, "agent"), skillPaths: [], includeDefaults: true });
	assert.equal(skills.length, 20);

	const log = join(base, "floor.jsonl");
	process.env.PI_FLOOR_LOG = log;
	process.env.PI_FLOOR_FILE = join(base, "none.json");
	delete process.env.PI_FLOOR;
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const pi: any = {
		on: (name: string, fn: Function) => { handlers[name] = fn; },
		registerCommand: (name: string, options: any) => { commands[name] = options; },
		getActiveTools: () => ["read"],
		getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }, { name: "off", description: "x".repeat(5000) }],
	};
	promptFloor(pi);
	const options: any = { cwd, skills, sections: { other: "kept" } };
	const render = () => `You are pi.\n\n<skills>\n${formatSkillsForPrompt(options.skills)}\n</skills>\n\n<repo_skills>\n${options.sections.repo_skills ?? ""}\n</repo_skills>`;
	const event = { get systemPrompt() { return render(); }, systemPromptOptions: options };
	const status: Record<string, string | undefined> = {};
	const notes: string[] = [];
	const ctx = { cwd, hasUI: true, ui: { setStatus: (k: string, v?: string) => { status[k] = v; }, notify: (t: string) => notes.push(t) } };

	const before = event.systemPrompt.length;
	await handlers.before_agent_start(event, ctx);
	assert.ok(event.systemPrompt.length < before);
	assert.equal(options.sections.other, "kept");
	assert.ok(options.sections.repo_skills.includes("s19 | Use for thing 19. | "));
	assert.match(status["prompt-floor"]!, /^floor ~\d+k/);
	await handlers.before_agent_start(event, ctx); // unchanged measurement is not logged twice
	const lines = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	const record = JSON.parse(lines[0]);
	assert.equal(record.skillsCompacted, 20);
	assert.equal(record.toolCount, 1);
	assert.deepEqual(record.activePrefixes, { other: { count: 1, bytes: record.activePrefixes.other.bytes } });
	assert.equal(record.allPrefixes.other.count, 2, "all-tools totals include inactive tools");
	assert.ok(!lines[0].includes("More words"), "no prompt text in the log");

	await commands.floor.handler("", ctx);
	assert.match(notes[0], /Largest tools:\n {2}read:/);
	assert.doesNotMatch(notes[0], /off:/);
	assert.match(notes[0], /All registered tools by prefix/);
});
