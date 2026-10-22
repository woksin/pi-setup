import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { answerItem } from "../src/actions.ts";
import { ageOf, deliveryMessage, plain, renderCandidates, renderItem, renderList, renderRecord, statusText, wrap } from "../src/format.ts";
import { seed, session, tempDir } from "./helpers.ts";

const LONG = "word ".repeat(60);
const HUGE = "x".repeat(250);
const MID = "word ".repeat(22).trim();

function nasty(t: Parameters<typeof tempDir>[0]) {
	const home = tempDir(t);
	const items = [
		seed(home, { title: `> quoted ${MID}`, body: `> a quote line\n${LONG}\n${HUGE}`, blocking: `> ${LONG.slice(0, 200)}`, urgency: "high", project: HUGE.slice(0, 40) }, { lane: "LANE-A-LONG" }),
		seed(home, { kind: "decision", title: `Other ${HUGE.slice(0, 100)}`, options: [{ key: "a", text: `> ${LONG.slice(0, 200)}` }], recommended: "a", links: [HUGE] }, { repo: `acme/${HUGE.slice(0, 60)}` }),
		seed(home, { title: "Short one", urgency: "low", tags: ["t"] }, { repo: null as any }),
	];
	const answered = answerItem(home, items[1].id, { kind: "user", sessionId: "u", name: "u" }, { text: `> ${LONG}`, by: "u", via: "quote", source: "s", option: "a" });
	return { home, items: [items[0], answered, items[2]] };
}

test("list output: plain text, no line starting with '>', no line wider than 100 columns", t => {
	const { items } = nasty(t);
	for (const showAsker of [false, true]) {
		const out = renderList(items, { now: Date.now(), showAsker, warnings: [`skipped ${HUGE}`], heading: `Heading ${LONG}` });
		for (const line of out.split("\n")) {
			assert.ok(!line.startsWith(">"), `blockquote line: ${line}`);
			assert.ok(line.length <= 100, `line is ${line.length} wide: ${line}`);
		}
		assert.match(out, /^Heading/);
		assert.match(out, /Blocking \(1\)\nQ-1 /m);
	}
});

test("show, record, candidates and delivery output: no line starts with '>', shown lines wrap at 100", t => {
	const { items } = nasty(t);
	for (const item of items) {
		for (const out of [renderItem(item, Date.now()), renderRecord(item)]) {
			for (const line of out.split("\n")) assert.ok(!line.startsWith(">"), `blockquote line: ${line}`);
		}
		for (const line of renderItem(item, Date.now()).split("\n")) assert.ok(line.length <= 100, `line is ${line.length} wide`);
	}
	const cands = renderCandidates(items.map(item => ({ item, score: 0.9 })), items.map(item => ({ item, score: 0.4 })));
	for (const line of cands.split("\n")) assert.ok(!line.startsWith(">") && line.length <= 100);
	for (const line of deliveryMessage(["> quoted\n> more", "> x"]).split("\n")) assert.ok(!line.startsWith(">"));
	assert.equal(plain([">a", "b"]), " >a\nb");
});

test("tool and command output in a live session carries the same guarantees", async t => {
	const root = tempDir(t);
	const home = join(root, "home");
	const s = session(t, { root, home, sessionId: "s1", lane: "LANE-A" });
	await s.call({ action: "ask", kind: "question", title: `> ${MID}`, body: `> ${LONG}`, blocking: LONG });
	await s.call({ action: "ask", kind: "question", title: `Another ${HUGE.slice(0, 100)}`, global: true });
	const outputs = [
		(await s.call({ action: "list", all: true })).content[0].text,
		(await s.call({ action: "search", query: "word" })).content[0].text,
		(await s.call({ action: "get", id: "Q-1" })).content[0].text,
	];
	await s.command("questions", "all");
	await s.command("q", "1");
	outputs.push(...s.notes.map(n => n.text));
	for (const out of outputs) for (const line of out.split("\n")) assert.ok(!line.startsWith(">") && line.length <= 100, `bad line: ${line.slice(0, 60)}`);
});

test("wrap: breaks at spaces, splits long words, keeps the hanging indent", () => {
	const lines = wrap(`${"ab ".repeat(20)}${"c".repeat(30)}`, 20, "  ");
	assert.ok(lines.every(l => l.length <= 20));
	assert.ok(lines.slice(1).every(l => l.startsWith("  ")));
	assert.deepEqual(wrap(""), [""]);
});

test("ages and status text", () => {
	const now = Date.now();
	assert.equal(ageOf(new Date(now - 5 * 60_000).toISOString(), now), "5m");
	assert.equal(ageOf(new Date(now - 3 * 3_600_000).toISOString(), now), "3h");
	assert.equal(ageOf(new Date(now - 5 * 86_400_000).toISOString(), now), "5d");
	assert.equal(statusText({ open: 0, blocking: 0, answered: 0 }), undefined);
	assert.equal(statusText({ open: 5, blocking: 2, answered: 1 }), "Q 5 open, 2 blocking, 1 answered for you");
	assert.equal(statusText({ open: 1, blocking: 0, answered: 0 }), "Q 1 open");
	assert.equal(statusText({ open: 1, blocking: 0, answered: 1, held: true }), "Q 1 open, 1 answered for you (delivery held)");
});
