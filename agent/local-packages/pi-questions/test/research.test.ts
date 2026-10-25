import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ask, updateItem } from "../src/actions.ts";
import { main as cliMain } from "../src/cli.ts";
import { renderItem, renderRecord } from "../src/format.ts";
import { validateDraft, type Kind } from "../src/model.ts";
import { atomicWrite, itemDir, listItems, readItem } from "../src/store.ts";
import { asker, RESEARCH, RESEARCH_FLAGS, seed, session, tempDir } from "./helpers.ts";

function main(argv: string[], opts: { env: Record<string, string>; cwd: string }) {
	const out: string[] = [], err: string[] = [];
	const code = cliMain(argv, opts.env, { out: s => out.push(s), err: s => err.push(s) }, opts.cwd);
	return { code, out: out.join("\n"), err: err.join("\n") };
}

const invalid = [
	{ name: "missing evidence", evidence: undefined, review: RESEARCH.review, field: "evidence" },
	{ name: "missing review", evidence: RESEARCH.evidence, review: undefined, field: "review" },
	{ name: "missing both", evidence: undefined, review: undefined, field: "evidence and review" },
	{ name: "blank evidence", evidence: " \n\t ", review: RESEARCH.review, field: "evidence" },
	{ name: "blank review", evidence: RESEARCH.evidence, review: " \n\t ", field: "review" },
	{ name: "short evidence", evidence: `  ${"e".repeat(19)}  `, review: RESEARCH.review, field: "evidence" },
	{ name: "short review", evidence: RESEARCH.evidence, review: `  ${"r".repeat(19)}  `, field: "review" },
];

for (const kind of ["question", "decision", "approval"] as Kind[]) {
	for (const sample of invalid) {
		test(`${kind} ask refuses ${sample.name} without storing an item`, async t => {
			const home = tempDir(t);
			const s = session(t, { home, root: home, sessionId: "research" });
			await assert.rejects(s.call({ action: "ask", kind, title: "Needs research", ...sample }), (error: Error) => {
				const text = error.message;
				assert.ok(text.includes(`${sample.field} required`), text);
				assert.match(text, /at least 20 characters each after trim/);
				assert.match(text, /global rule requires research\/source verification and an independent second review on the other provider before asking/);
				assert.match(text, /evidence: "store.ts:42; run 123456"/);
				assert.match(text, /review: "sol-reviewer: agrees,/);
				return true;
			});
			assert.deepEqual(listItems(home).items, []);
		});
	}
}

test("the actions entry point also refuses an unresearched decision", t => {
	const home = tempDir(t);
	assert.throws(() => ask(home, validateDraft({ kind: "decision", title: "Direct ask" }), asker()), /evidence and review required/);
	assert.deepEqual(listItems(home).items, []);
});

test("researched ask persists trimmed fields and get shows text and record sections", async t => {
	const home = tempDir(t);
	const s = session(t, { home, root: home, sessionId: "research" });
	const created = await s.call({ action: "ask", kind: "decision", title: "A researched choice", evidence: `  ${RESEARCH.evidence}\n`, review: `\n${RESEARCH.review}  ` });
	assert.ok(!created.isError, created.content[0].text);
	const item = readItem(home, "Q-1")!;
	assert.equal(item.evidence, RESEARCH.evidence);
	assert.equal(item.review, RESEARCH.review);
	for (const format of ["text", "record"]) {
		const result = await s.call({ action: "get", id: item.id, format });
		assert.ok(result.content[0].text.includes(`Evidence:\n${RESEARCH.evidence}`));
		assert.ok(result.content[0].text.includes(`Review:\n${RESEARCH.review}`));
	}
});

test("exactly 20 characters after trim satisfy both fields", t => {
	const home = tempDir(t);
	const result = ask(home, validateDraft({ kind: "approval", title: "Boundary ask", evidence: ` ${"e".repeat(20)} `, review: ` ${"r".repeat(20)} ` }), asker());
	assert.ok("ok" in result);
	assert.equal(result.ok.item.evidence, "e".repeat(20));
	assert.equal(result.ok.item.review, "r".repeat(20));
});

test("FYI asks are exempt, but accept optional research fields", async t => {
	const home = tempDir(t);
	const s = session(t, { home, root: home, sessionId: "research" });
	const result = await s.call({ action: "ask", kind: "fyi", title: "Notice without research", evidence: undefined, review: undefined });
	assert.ok(!result.isError, result.content[0].text);
	assert.equal(readItem(home, "Q-1")!.evidence, undefined);
	assert.equal(readItem(home, "Q-1")!.review, undefined);
	const withFields = await s.call({ action: "ask", kind: "fyi", title: "Separate deployment notice", evidence: "brief", review: "not needed" });
	assert.ok(!withFields.isError, withFields.content[0].text);
	assert.equal(readItem(home, "Q-2")!.evidence, "brief");
});

test("own open items can set and replace research via update, but others cannot", async t => {
	const home = tempDir(t);
	const s = session(t, { home, root: home, sessionId: "research" });
	const created = await s.call({ action: "ask", kind: "question", title: "Editable research" });
	assert.ok(!created.isError);
	for (const evidence of ["Initial updated evidence", "Replacement source references"]) {
		const updated = await s.call({ action: "update", id: "Q-1", evidence: ` ${evidence} `, review: " replacement reviewer verdict " });
		assert.ok(!updated.isError, updated.content[0].text);
		assert.equal(readItem(home, "Q-1")!.evidence, evidence);
		assert.equal(readItem(home, "Q-1")!.review, "replacement reviewer verdict");
	}
	const other = session(t, { home, root: home, sessionId: "someone-else" });
	await assert.rejects(other.call({ action: "update", id: "Q-1", evidence: "not mine" }), /asked by another session.*not evidence/);
});

test("legacy items load and format unchanged, and may gain research by update", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "Legacy choice" });
	const legacy = { ...item };
	delete legacy.evidence;
	delete legacy.review;
	atomicWrite(join(itemDir(home, item.id), "r00000001.json"), legacy);
	const loaded = readItem(home, item.id)!;
	assert.deepEqual(loaded, JSON.parse(JSON.stringify(legacy)));
	assert.deepEqual(listItems(home).warnings, []);
	for (const render of [renderItem, renderRecord]) {
		const text = render(loaded);
		assert.equal(text, render({ ...loaded, evidence: undefined, review: undefined }));
		assert.doesNotMatch(text, /Evidence:|Review:/);
	}
	const updated = updateItem(home, item.id, { kind: "agent", sessionId: item.asker.sessionId }, RESEARCH);
	assert.equal(updated.evidence, RESEARCH.evidence);
	assert.equal(updated.review, RESEARCH.review);
});

test("CLI research flags persist and display fields; missing fields refuse without storage", t => {
	const root = tempDir(t);
	const home = join(root, "questions");
	const opts = { env: { PI_QUESTIONS_HOME: home, PI_SESSION_ID: "cli-research" }, cwd: root };
	for (const flags of [[], ["--evidence", RESEARCH.evidence], ["--review", RESEARCH.review], ["--evidence", "short", "--review", RESEARCH.review]]) {
		const result = main(["ask", "--kind", "decision", "--title", "CLI choice", ...flags], opts);
		assert.equal(result.code, 2);
		assert.match(result.err, /global rule requires research\/source verification/);
		assert.deepEqual(listItems(home).items, []);
	}
	const result = main(["ask", "--kind", "decision", "--title", "CLI choice", ...RESEARCH_FLAGS], opts);
	assert.equal(result.code, 0, result.err);
	assert.equal(readItem(home, "Q-1")!.evidence, RESEARCH.evidence);
	assert.equal(readItem(home, "Q-1")!.review, RESEARCH.review);
	assert.match(main(["get", "Q-1"], opts).out, /Evidence:\nstore.ts:42/);
	assert.match(main(["get", "Q-1", "--record"], opts).out, /Review:\nsol-reviewer/);
});

test("research fields must be strings in drafts and updates", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "Typed fields" });
	for (const field of ["evidence", "review"]) {
		assert.throws(() => validateDraft({ kind: "fyi", title: "Typed draft", [field]: 123 }), new RegExp(`${field} must be a string`));
		assert.throws(() => updateItem(home, item.id, { kind: "agent", sessionId: item.asker.sessionId }, { [field]: 123 }), new RegExp(`${field} must be a string`));
	}
});
