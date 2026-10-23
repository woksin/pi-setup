import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readItem } from "../src/store.ts";
import defaultExtension from "../src/extension.ts";
import { gitRepo, seed, session, tempDir, writeUser } from "./helpers.ts";

function env(t: Parameters<typeof tempDir>[0]) {
	const root = tempDir(t);
	const home = join(root, "home");
	const repoA = gitRepo(join(root, "repoA"), "git@github.com:acme/alpha.git");
	const repoB = gitRepo(join(root, "repoB"), "git@github.com:acme/beta.git");
	return { root, home, repoA, repoB };
}
const text = (r: any) => r.content[0].text as string;

test("default export is an extension factory; the tool and commands are registered", t => {
	assert.equal(typeof defaultExtension, "function");
	const { root, home } = env(t);
	const s = session(t, { root, home, sessionId: "s1" });
	assert.deepEqual([...s.tools.keys()], ["user_questions"]);
	assert.deepEqual([...s.commands.keys()].sort(), ["answer", "close", "decide", "defer", "lane", "q", "questions"]);
	assert.match(s.tools.get("user_questions").description, /end your turn.*Do not poll/is);
	assert.equal(s.tools.get("user_questions").parameters.type, "object");
});

test("ask: happy path creates an item, returns details, and records the asker", async t => {
	const { root, home, repoA } = env(t);
	const s = session(t, { root, home, sessionId: "s1", lane: "LANE-A", cwd: repoA });
	const r = await s.call({ action: "ask", kind: "decision", title: "Pick a queue", body: "Two choices.", options: [{ key: "a", text: "Redis" }, { key: "b", text: "SQS" }], recommended: "a", blocking: "the worker rewrite", links: ["acme/alpha#5"], project: "infra" });
	assert.match(text(r), /^Created Q-1: Pick a queue\nThe answer will arrive as a follow-up message/);
	const item = r.details.item;
	assert.equal(item.repo, "acme/alpha");
	assert.equal(item.asker.lane, "LANE-A");
	assert.equal(item.asker.sessionId, "s1");
	assert.equal(item.recommended, "a");
	assert.equal(item.status, "open");
	assert.deepEqual(r.details.nearMisses, []);
	assert.deepEqual(readdirSync(join(home, "items")), ["Q-1"]);
});

test("ask: validation errors are thrown as tool failures", async t => {
	const { root, home } = env(t);
	const s = session(t, { root, home, sessionId: "s1" });
	await assert.rejects(s.call({ action: "ask", kind: "question" }), /title is required/);
	await assert.rejects(s.call({ action: "ask", kind: "nope", title: "x" }), /kind must be/);
	await assert.rejects(s.call({ action: "ask", kind: "question", title: "x".repeat(200) }), /too long/);
	await assert.rejects(s.call({ action: "ask", kind: "question", title: "x", body: "y".repeat(4001) }), /body is too long/);
	await assert.rejects(s.call({ action: "frobnicate" }), /unknown action/);
	await assert.rejects(s.call({ action: "get", id: "nope" }), /not an item id/);
	await assert.rejects(s.call({ action: "get", id: "Q-99" }), /does not exist/);
});

test("ask: a duplicate is refused with candidates, next steps and distinctFrom; near misses go to details", async t => {
	const { root, home } = env(t);
	const s = session(t, { root, home, sessionId: "s1" });
	await s.call({ action: "ask", kind: "question", title: "alpha beta gamma delta" });
	await s.call({ action: "ask", kind: "question", title: "alpha beta gamma epsilon zeta eta" }).then(r => {
		assert.equal(r.details.nearMisses.length, 1);
		assert.equal(r.details.nearMisses[0].id, "Q-1");
		assert.ok(r.details.nearMisses[0].score >= 0.35 && r.details.nearMisses[0].score < 0.5);
	});
	await assert.rejects(s.call({ action: "ask", kind: "question", title: "Alpha, beta, gamma delta!" }), (e: Error) => {
		assert.match(e.message, /^Not created: possible duplicate/);
		assert.match(e.message, /Q-1 \[open\] alpha beta gamma delta \(score 1\.00\)/);
		assert.match(e.message, /comment on it.*add yourself to cc/s);
		assert.match(e.message, /distinctFrom: \[Q-1\]/);
		return true;
	});
	const ok = await s.call({ action: "ask", kind: "question", title: "Alpha, beta, gamma delta!", distinctFrom: ["Q-1"] });
	assert.deepEqual(ok.details.item.related, ["Q-1"]);
});

test("list: default scope, all with asker lanes, project, status, mine", async t => {
	const { root, home, repoA, repoB } = env(t);
	const a = session(t, { root, home, sessionId: "sa", lane: "LANE-A", cwd: repoA });
	const b = session(t, { root, home, sessionId: "sb", lane: "LANE-B", cwd: repoB });
	await a.call({ action: "ask", kind: "question", title: "Alpha only topic", project: "einari-issues" });
	await b.call({ action: "ask", kind: "decision", title: "Beta only subject", blocking: "release" });
	await b.call({ action: "ask", kind: "fyi", title: "Global notice item", global: true });
	const here = text(await a.call({ action: "list" }));
	assert.match(here, /Q-1 \[question\] Alpha only topic/);
	assert.match(here, /Q-3 \[fyi\] Global notice item/);
	assert.doesNotMatch(here, /Beta only subject/);
	const all = await a.call({ action: "list", all: true });
	assert.match(text(all), /Beta only subject/);
	assert.match(text(all), /asker LANE-B/);
	assert.match(text(all), /asker LANE-A/);
	assert.match(text(all), /^Blocking \(1\)\nQ-2/m);
	assert.equal(all.details.items.length, 3);
	const proj = await a.call({ action: "list", all: true, project: "einari-issues" });
	assert.deepEqual(proj.details.items.map((i: any) => i.id), ["Q-1"]);
	assert.deepEqual((await a.call({ action: "list", all: true, mine: true })).details.items.map((i: any) => i.id), ["Q-1"]);
	assert.deepEqual((await a.call({ action: "list", repo: "acme/beta" })).details.items.map((i: any) => i.id), ["Q-2"]);
	assert.match(text(await a.call({ action: "list", status: "answered" })), /No matching items/);
});

test("/questions all uses the all-repos view with asker lanes", async t => {
	const { root, home, repoA, repoB } = env(t);
	const a = session(t, { root, home, sessionId: "sa", lane: "LANE-A", cwd: repoA });
	const l0 = session(t, { root, home, sessionId: "sl0", lane: "L0", cwd: root });
	await a.call({ action: "ask", kind: "question", title: "Something for alice" });
	seed(home, { title: "Beta side matter" }, { sessionId: "sb", lane: "LANE-B", repo: "acme/beta" });
	void repoB;
	await l0.command("questions", "all");
	assert.match(l0.notes[0].text, /Something for alice/);
	assert.match(l0.notes[0].text, /Beta side matter/);
	assert.match(l0.notes[0].text, /asker LANE-B/);
	await l0.command("questions", "");
	assert.doesNotMatch(l0.notes[1].text, /Something for alice/);
	await l0.command("questions", "search beta side");
	assert.match(l0.notes[2].text, /Q-2/);
});

test("get text and record, and search covers decided and closed items", async t => {
	const { root, home } = env(t);
	const s = session(t, { root, home, sessionId: "s1" });
	await s.call({ action: "ask", kind: "decision", title: "Choose license", options: [{ key: "a", text: "MIT" }] });
	await s.command("decide", "1 a simplest");
	await s.call({ action: "close", id: "Q-1", note: "done" });
	const txt = text(await s.call({ action: "get", id: "q1" }));
	assert.match(txt, /^Q-1 \[decision\] Choose license/);
	assert.match(txt, /Answer \[option a: MIT\]: simplest \(by .+ via command/);
	const rec = text(await s.call({ action: "get", id: "1", format: "record" }));
	assert.match(rec, /^Decision record Q-1: Choose license\n/);
	assert.match(rec, /Outcome: a \(MIT\)\nStatement: simplest\nDecided by /);
	const found = await s.call({ action: "search", query: "license" });
	assert.deepEqual(found.details.items.map((i: any) => [i.id, i.status, i.answer]), [["Q-1", "closed", "simplest"]]);
	assert.deepEqual((await s.call({ action: "search", query: "license", kind: "question" })).details.items, []);
	assert.deepEqual((await s.call({ action: "search", query: "license", status: "closed" })).details.items.length, 1);
});

test("update: own open items fully; others may only add links or themselves to cc", async t => {
	const { root, home } = env(t);
	const a = session(t, { root, home, sessionId: "sa", lane: "LANE-A" });
	const a2 = session(t, { root, home, sessionId: "sa2", lane: "LANE-A" });
	const c = session(t, { root, home, sessionId: "sc", lane: "LANE-C" });
	await a.call({ action: "ask", kind: "question", title: "Original title", urgency: "low" });
	const r = await a2.call({ action: "update", id: "Q-1", title: "New title", urgency: "high", blocking: "x", tags: ["t1"] }); // same lane: own
	assert.equal(r.details.item.title, "New title");
	assert.equal(r.details.item.urgency, "high");
	assert.equal(r.details.item.history.at(-1).type, "edited");
	await assert.rejects(a.call({ action: "update", id: "Q-1", urgency: "extreme" }), /urgency must be/);
	await assert.rejects(a.call({ action: "update", id: "Q-1" }), /nothing to update/);
	await assert.rejects(c.call({ action: "update", id: "Q-1", title: "hijack" }), /may only add links or add yourself to cc \(not title\)/);
	const linked = await c.call({ action: "update", id: "Q-1", links: ["acme/alpha#9"] });
	assert.deepEqual(linked.details.item.links, ["acme/alpha#9"]);
	assert.equal(linked.details.item.history.at(-1).type, "linked");
	const cc = await c.call({ action: "update", id: "Q-1", cc: ["LANE-C"] });
	assert.deepEqual(cc.details.item.cc, ["LANE-C"]);
	await assert.rejects(c.call({ action: "update", id: "Q-1", cc: ["L0"] }), /only add yourself/);
	await a.command("answer", "1 yes");
	await assert.rejects(a.call({ action: "update", id: "Q-1", title: "late" }), /only open or deferred items can be edited/);
});

test("comment on any item; withdraw, supersede and close are for the asker only", async t => {
	const { root, home } = env(t);
	const a = session(t, { root, home, sessionId: "sa", lane: "LANE-A" });
	const c = session(t, { root, home, sessionId: "sc", lane: "LANE-C" });
	await a.call({ action: "ask", kind: "question", title: "First topic here" });
	await a.call({ action: "ask", kind: "question", title: "Entirely other subject" });
	await a.call({ action: "ask", kind: "fyi", title: "Heads up about nothing" });
	const cm = await c.call({ action: "comment", id: "Q-1", text: "me too" });
	assert.equal(cm.details.item.history.at(-1).actor.sessionId, "sc");
	await assert.rejects(c.call({ action: "comment", id: "Q-1" }), /text is required/);
	for (const action of ["withdraw", "supersede", "close"]) await assert.rejects(c.call({ action, id: "Q-1", reason: "r", by: "Q-2" }), /only its asker/);
	await assert.rejects(a.call({ action: "withdraw", id: "Q-1" }), /reason is required/);
	await assert.rejects(a.call({ action: "close", id: "Q-1" }), /close applies to answered or decided items, or fyi/);
	await assert.rejects(a.call({ action: "supersede", id: "Q-1", by: "Q-99" }), /does not exist/);
	await assert.rejects(a.call({ action: "supersede", id: "Q-1", by: "Q-1" }), /itself/);
	const sup = await a.call({ action: "supersede", id: "Q-1", by: "Q-2" });
	assert.equal(sup.details.item.status, "superseded");
	assert.equal(sup.details.item.supersededBy, "Q-2");
	assert.equal((await a.call({ action: "withdraw", id: "Q-2", reason: "gone" })).details.item.status, "withdrawn");
	assert.equal((await a.call({ action: "close", id: "Q-3" })).details.item.status, "closed"); // fyi
	await assert.rejects(a.call({ action: "withdraw", id: "Q-3", reason: "x" }), /closed; it cannot become withdrawn/);
});

test("Q4: the asker may close its own answered or decided items", async t => {
	const { root, home } = env(t);
	const a = session(t, { root, home, sessionId: "sa", lane: "LANE-A" });
	await a.call({ action: "ask", kind: "question", title: "Needs an answer" });
	await a.command("answer", "1 go ahead");
	const closed = await a.call({ action: "close", id: "Q-1", note: "used it" });
	assert.equal(closed.details.item.status, "closed");
	assert.equal(closed.details.item.history.at(-1).actor.kind, "agent");
});

test("hasUI false: mutations are refused, list, get and search still work", async t => {
	const { root, home } = env(t);
	const main = session(t, { root, home, sessionId: "sa" });
	await main.call({ action: "ask", kind: "question", title: "Visible topic" });
	const sub = session(t, { root, home, sessionId: "sub", hasUI: false });
	for (const params of [
		{ action: "ask", kind: "question", title: "nope" }, { action: "update", id: "Q-1", title: "x" }, { action: "comment", id: "Q-1", text: "x" },
		{ action: "withdraw", id: "Q-1", reason: "x" }, { action: "supersede", id: "Q-1", by: "Q-2" }, { action: "close", id: "Q-1" },
		{ action: "record_answer", id: "Q-1", quote: "yes" },
	]) await assert.rejects(sub.call(params), /only available in the main session\. Report .* to your parent session/);
	assert.match(text(await sub.call({ action: "list", all: true })), /Visible topic/);
	assert.match(text(await sub.call({ action: "get", id: "Q-1" })), /Visible topic/);
	assert.match(text(await sub.call({ action: "search", query: "visible" })), /Visible topic/);
});

test("record_answer: only a quote from this session's interactive input is accepted", async t => {
	const { root, home } = env(t);
	writeUser(root, "alice");
	const s = session(t, { root, home, sessionId: "s1", lane: "L0" });
	await s.call({ action: "ask", kind: "decision", title: "Which path", options: [{ key: "a", text: "left" }, { key: "b", text: "right" }] });
	await assert.rejects(s.call({ action: "record_answer", id: "Q-1", quote: "go left" }), /not in the user's input in this session/);
	await s.type("Q-1: go   left please", "extension"); // relayed, never counts
	await assert.rejects(s.call({ action: "record_answer", id: "Q-1", quote: "go left" }), /not in the user's input/);
	await s.type("Q-1: go   left please", "interactive");
	await assert.rejects(s.call({ action: "record_answer", id: "Q-1", quote: "Go left" }), /not in the user's input/); // case-sensitive
	await assert.rejects(s.call({ action: "record_answer", id: "Q-1", quote: "go left", option: "z" }), /no option "z"/);
	const r = await s.call({ action: "record_answer", id: "Q-1", quote: "go left", option: "a" });
	const item = r.details.item;
	assert.equal(item.status, "decided");
	assert.deepEqual({ text: item.answer.text, by: item.answer.by, via: item.answer.via, option: item.answer.option }, { text: "go left", by: "alice", via: "quote", option: "a" });
	assert.equal(item.answer.source, "Q-1: go   left please");
	assert.equal(item.history.at(-1).actor.kind, "user");
	await assert.rejects(s.call({ action: "record_answer", id: "Q-1", quote: "go left" }), /reopen it first/);
});

test("answer.by falls back to the OS user when user.json is absent", async t => {
	const { root, home } = env(t);
	const s = session(t, { root, home, sessionId: "s1" });
	await s.call({ action: "ask", kind: "question", title: "Anything at all" });
	await s.command("answer", "1 sure");
	const item = readItem(home, "Q-1")!;
	assert.ok(item.answer.by.length > 0 && item.answer.by !== "alice-fixture");
	assert.equal(item.answer.via, "command");
});

test("commands: /answer /decide /defer /close /q write the user as actor; errors are notified", async t => {
	const { root, home } = env(t);
	writeUser(root, "alice");
	const s = session(t, { root, home, sessionId: "s1" });
	await s.call({ action: "ask", kind: "decision", title: "Command target one", options: [{ key: "a", text: "A" }, { key: "b", text: "B" }] });
	await s.call({ action: "ask", kind: "question", title: "Second unrelated topic" });
	await s.call({ action: "ask", kind: "question", title: "Third distinct matter" });
	await s.command("decide", "1 2 because");
	let item = readItem(home, "Q-1")!;
	assert.deepEqual([item.status, item.answer.option, item.answer.text, item.answer.via, item.answer.by], ["decided", "b", "because", "command", "alice"]);
	assert.equal(item.history.at(-1).actor.kind, "user");
	assert.equal(item.history.at(-1).actor.name, "alice");
	await s.command("q", "1 reopen");
	await s.command("q", "1 comment thinking about it");
	await s.command("q", "2 answer verbatim words");
	await s.command("defer", "3 2099-01-01 later");
	item = readItem(home, "Q-3")!;
	assert.equal(item.status, "deferred");
	assert.match(item.deferredUntil, /^2099-/);
	await s.command("close", "2 done");
	await s.command("answer", "99 text");
	await s.command("answer", "oops");
	await s.command("decide", "1 zz");
	assert.deepEqual(s.notes.filter(n => n.level === "error").map(n => n.text.slice(0, 22)), ["Q-99 does not exist", "usage: /answer <id> <t", "Q-1 has no option \"zz\""]);
	await s.command("q", "1");
	assert.match(s.notes.at(-1)!.text, /^Q-1 \[decision\] Command target one/);
});

test("/defer with a date hides the item from the open count until that date", async t => {
	const { root, home } = env(t);
	let now = Date.parse("2030-01-01T10:00:00Z");
	const s = session(t, { root, home, sessionId: "s1", now: () => now });
	await s.start();
	await s.call({ action: "ask", kind: "question", title: "Hide me for a while" });
	await s.call({ action: "ask", kind: "question", title: "Keep me visible" });
	await s.command("defer", "1 2030-02-01");
	assert.match(text(await s.call({ action: "list" })), /Q-2/);
	assert.doesNotMatch(text(await s.call({ action: "list" })), /Q-1/);
	s.controller.poll();
	assert.equal(s.statuses.at(-1), "Q 1 open");
	now = Date.parse("2030-02-02T00:00:00Z");
	assert.match(text(await s.call({ action: "list" })), /Q-1 \[question\] Hide me/);
	s.controller.poll();
	assert.equal(s.statuses.at(-1), "Q 2 open");
});

test("status line: counts, blocking, answered for you, hidden at zero", async t => {
	const { root, home } = env(t);
	const s = session(t, { root, home, sessionId: "s1" });
	await s.start();
	assert.equal(s.statuses.at(-1), undefined); // zero: hidden
	await s.call({ action: "ask", kind: "question", title: "First thing to ask", blocking: "launch" });
	await s.call({ action: "ask", kind: "question", title: "Second unrelated query" });
	s.controller.poll();
	assert.equal(s.statuses.at(-1), "Q 2 open, 1 blocking");
	s.state.throwOnSend = false;
	// Held delivery (handoff) leaves an unseen answer: "answered for you".
	const { writeFileSync, mkdirSync } = await import("node:fs");
	mkdirSync(join(root, "budget"), { recursive: true });
	writeFileSync(join(root, "budget", "s1.json"), JSON.stringify({ phase: "handoff-required" }));
	await s.command("answer", "2 yes");
	s.controller.poll();
	assert.equal(s.statuses.at(-1), "Q 1 open, 1 blocking, 1 answered for you (delivery held)");
	await s.command("answer", "1 yes");
	s.controller.poll();
	assert.equal(s.statuses.at(-1), "Q 0 open, 2 answered for you (delivery held)");
});

test("status line is never set in a subagent (hasUI false)", async t => {
	const { root, home } = env(t);
	seed(home, { title: "Some open thing" });
	const sub = session(t, { root, home, sessionId: "sub", hasUI: false });
	await sub.start();
	sub.controller.poll();
	await sub.emit("agent_end");
	await sub.emit("session_compact");
	assert.deepEqual(sub.statuses, []);
	assert.equal(sub.intervals.length, 0);
	assert.equal(sub.watchers.length, 0);
	assert.deepEqual(readdirSync(home).filter(d => d === "sessions"), []);
});

test("no hard-coded /Users paths in src or test", () => {
	const needle = ["", "Users", ""].join("/");
	for (const dir of ["src", "test"]) {
		for (const f of readdirSync(dir)) {
			if (f === "extension.test.ts") continue;
			assert.ok(!readFileSync(join(dir, f), "utf8").includes(needle), `${dir}/${f} contains ${needle}`);
		}
	}
	assert.ok(!readFileSync("test/extension.test.ts", "utf8").split("\n").some(l => l.includes(`"${["", "Users"].join("/")}`)));
});
