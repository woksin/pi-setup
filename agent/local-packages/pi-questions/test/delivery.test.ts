import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Deliverer, pending } from "../src/delivery.ts";
import { receiptName } from "../src/store.ts";
import { gitRepo, seed, session, sleep, tempDir, waitUntil } from "./helpers.ts";

function world(t: Parameters<typeof tempDir>[0]) {
	const root = tempDir(t);
	const clock = { offset: 0 };
	const now = () => Date.now() + clock.offset;
	const home = join(root, "home");
	const repoA = gitRepo(join(root, "repoA"), "git@github.com:acme/alpha.git");
	const repoB = gitRepo(join(root, "repoB"), "git@github.com:acme/beta.git");
	const mk = (sessionId: string, o: { lane?: string; cwd?: string } = {}) => session(t, { root, home, sessionId, now, ...o });
	return { root, home, clock, repoA, repoB, mk };
}
const FOLLOW_UP = { triggerTurn: true, deliverAs: "followUp" };

test("A asks, B runs /answer: A is sent exactly once, verbatim, as a follow-up that triggers a turn", async t => {
	const { mk, repoA } = world(t);
	const a = mk("sa", { cwd: repoA });
	const b = mk("sb", { cwd: repoA });
	await a.start();
	await b.start();
	await a.call({ action: "ask", kind: "question", title: "Which branch should ship" });
	await b.command("answer", "1 ship   the release branch");
	b.controller.poll();
	a.controller.poll();
	assert.equal(a.sent.length, 1);
	assert.deepEqual(a.sent[0].options, FOLLOW_UP);
	const m = a.sent[0].message;
	assert.equal(m.customType, "user-question");
	assert.equal(m.display, true);
	assert.match(m.content, /^Answer for Q-1 \(your question: Which branch should ship\): ship {3}the release branch - by .+ via command at \d{4}-.*Status: answered\.$/);
	assert.deepEqual(m.details.entries, [{ id: "Q-1", seq: 2 }]);
	for (let i = 0; i < 3; i++) a.controller.poll();
	await a.emit("agent_end");
	assert.equal(a.sent.length, 1);
	assert.equal(b.sent.length, 0);
});

test("a new instance with the same session id sends nothing because of the receipt", async t => {
	const { mk, repoA } = world(t);
	const a = mk("sa", { cwd: repoA });
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Reload safety topic" });
	await a.command("answer", "1 yes");
	a.controller.poll();
	assert.equal(a.sent.length, 1);
	const again = mk("sa", { cwd: repoA });
	await again.start();
	again.controller.poll();
	assert.equal(again.sent.length, 0);
});

test("self-answer: a session answering its own question is woken once", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Self answered question" });
	await a.command("answer", "1 here you go");
	a.controller.poll();
	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0].message.content, /here you go/);
});

test("L0 records the user's quote for a lane's item: the live asking lane is woken exactly once, L0 sends nothing", async t => {
	const { mk, repoA, home } = world(t);
	const lane = mk("sa", { lane: "LANE-A", cwd: repoA });
	const l0 = mk("sl0", { lane: "L0", cwd: repoA });
	await lane.start();
	await l0.start();
	await lane.call({ action: "ask", kind: "question", title: "Lane A needs a ruling", blocking: "its PR" });
	await l0.type("Q-1: wait for the OAuth fix");
	await l0.call({ action: "record_answer", id: "Q-1", quote: "wait for the OAuth fix" });
	l0.controller.poll();
	lane.controller.poll();
	for (let i = 0; i < 3; i++) {
		l0.controller.poll();
		lane.controller.poll();
	}
	assert.equal(lane.sent.length, 1);
	assert.deepEqual(lane.sent[0].options, FOLLOW_UP);
	assert.match(lane.sent[0].message.content, /^Answer for Q-1 \(your question: Lane A needs a ruling\): wait for the OAuth fix - by .+ via quote in chat at /);
	assert.equal(l0.sent.length, 0);
	assert.deepEqual(readdirSync(join(home, "receipts")), ["Q-1.2.asker.json"]);
});

test("a cc'd lane session (L0) gets exactly one delivery, as does the asker", async t => {
	const { mk, repoA, repoB } = world(t);
	const a = mk("sa", { lane: "LANE-A", cwd: repoA });
	const l0 = mk("sl0", { lane: "L0", cwd: repoB });
	const b = mk("sb");
	await a.start();
	await l0.start();
	await b.start();
	await a.call({ action: "ask", kind: "question", title: "Please rule on this", cc: ["L0", "LANE-A", "sa"] });
	await b.command("answer", "1 approved");
	for (let i = 0; i < 3; i++) {
		a.controller.poll();
		l0.controller.poll();
		b.controller.poll();
	}
	assert.equal(a.sent.length, 1);
	assert.equal(l0.sent.length, 1);
	assert.match(l0.sent[0].message.content, /^Answer for Q-1 \(Please rule on this\): approved/);
	assert.deepEqual(l0.sent[0].options, FOLLOW_UP);
	assert.equal(b.sent.length, 0);
});

test("asker shut down, B answers: C in the same repo gets one nextTurn notice, C2 nothing, D in another repo nothing", async t => {
	const { mk, repoA, repoB, clock } = world(t);
	const a = mk("sa", { cwd: repoA });
	const b = mk("sb", { cwd: repoB });
	await a.start();
	await b.start();
	await a.call({ action: "ask", kind: "question", title: "Orphaned question topic" });
	await a.shutdown();
	await b.command("answer", "1 the answer");
	// Too young: not an orphan yet.
	const early = mk("sc0", { cwd: repoA });
	await early.start();
	assert.equal(early.sent.length, 0);
	clock.offset = 61_000;
	const c = mk("sc", { cwd: repoA });
	const c2 = mk("sc2", { cwd: repoA });
	const d = mk("sd", { cwd: repoB });
	await c.start();
	await c2.start();
	await d.start();
	assert.equal(c.sent.length, 1);
	assert.deepEqual(c.sent[0].options, { deliverAs: "nextTurn" });
	assert.match(c.sent[0].message.content, /Answer for Q-1 \(your question: Orphaned question topic\): the answer/);
	assert.equal(c.notes.length, 1);
	assert.match(c.notes[0].text, /1 answer for questions from an earlier session arrived/);
	assert.equal(c2.sent.length, 0);
	assert.equal(d.sent.length, 0);
	assert.equal(b.sent.length, 0);
	c.controller.poll();
	c2.controller.poll();
	assert.equal(c.sent.length + c2.sent.length, 1);
});

test("lane restart: a new session of the same lane is woken while the old one is dead", async t => {
	const { mk, repoA } = world(t);
	const a = mk("sa", { lane: "LANE-A", cwd: repoA });
	const b = mk("sb", { cwd: repoA });
	await a.start();
	await b.start();
	await a.call({ action: "ask", kind: "question", title: "Lane restart question" });
	await a.shutdown();
	await b.command("answer", "1 carry on");
	const a2 = mk("sa2", { lane: "LANE-A", cwd: repoA });
	await a2.start();
	assert.equal(a2.sent.length, 1);
	assert.deepEqual(a2.sent[0].options, FOLLOW_UP);
	a2.controller.poll();
	assert.equal(a2.sent.length, 1);
});

test("while the asker is live, a second session of its lane does not take the answer", async t => {
	const { mk, repoA } = world(t);
	const a = mk("sa", { lane: "LANE-A", cwd: repoA });
	const a2 = mk("sa2", { lane: "LANE-A", cwd: repoA });
	await a.start();
	await a2.start();
	await a.call({ action: "ask", kind: "question", title: "Only the asker answers" });
	await a.command("answer", "1 ok");
	a2.controller.poll();
	assert.equal(a2.sent.length, 0);
	a.controller.poll();
	assert.equal(a.sent.length, 1);
});

test("an active handoff status file holds delivery; it goes out after the file is removed", async t => {
	const { mk, root } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Held during handoff" });
	mkdirSync(join(root, "budget"), { recursive: true });
	const file = join(root, "budget", "sa.json");
	writeFileSync(file, JSON.stringify({ phase: "handoff-required" }));
	await a.command("answer", "1 later");
	a.controller.poll();
	assert.equal(a.sent.length, 0);
	writeFileSync(file, JSON.stringify({ phase: "idle" }));
	a.controller.poll();
	assert.equal(a.sent.length, 1);
	writeFileSync(file, JSON.stringify({ phase: "compacting" }));
	await a.call({ action: "comment", id: "Q-1", text: "agent note" }); // agent comments are not deliverable
	rmSync(file);
	a.controller.poll();
	assert.equal(a.sent.length, 1);
});

test("during compaction delivery is held, then sent after session_compact", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Compaction hold" });
	await a.emit("session_before_compact");
	await a.command("answer", "1 sure");
	a.controller.poll();
	await a.emit("agent_end");
	assert.equal(a.sent.length, 0);
	await a.emit("session_compact");
	assert.equal(a.sent.length, 1);
});

test("a failed compaction releases the hold too", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Compaction failure hold" });
	await a.emit("session_before_compact");
	await a.command("answer", "1 sure");
	a.controller.poll();
	assert.equal(a.sent.length, 0);
	await a.emit("session_compact_failed");
	assert.equal(a.sent.length, 1);
});

test("when send throws synchronously, the receipt is removed and the deliverer is disposed", async t => {
	const { mk, home } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Stale context topic" });
	a.state.throwOnSend = true;
	await a.command("answer", "1 here");
	a.controller.poll();
	assert.equal(a.sent.length, 1);
	assert.deepEqual(existsSync(join(home, "receipts")) ? readdirSync(join(home, "receipts")) : [], []);
	a.state.throwOnSend = false;
	a.controller.poll();
	a.controller.poll();
	assert.equal(a.sent.length, 1); // disposed: nothing more
	// A fresh instance can still deliver it, since the receipt was released.
	const a2 = mk("sa");
	await a2.start();
	assert.equal(a2.sent.length, 1);
});

test("a stale context (isIdle throws) disposes before any receipt is claimed", async t => {
	const { mk, home } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Stale probe topic" });
	await a.command("answer", "1 here");
	a.state.stale = true;
	a.controller.poll();
	assert.equal(a.sent.length, 0);
	assert.deepEqual(existsSync(join(home, "receipts")) ? readdirSync(join(home, "receipts")) : [], []);
});

test("several entries go out in one batched message", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "First batched query" });
	await a.call({ action: "ask", kind: "decision", title: "Second unrelated decision", options: [{ key: "x", text: "Ex" }] });
	await a.emit("session_before_compact");
	await a.command("answer", "1 one");
	await a.command("decide", "2 x because");
	await a.command("q", "1 comment extra note");
	await a.emit("session_compact");
	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0].message.content, /^3 updates on questions for the user:\n\nAnswer for Q-1 .*: one - by/);
	assert.match(a.sent[0].message.content, /Decision for Q-2 \(your question: Second unrelated decision\): option x \(Ex\)\. because - by/);
	assert.match(a.sent[0].message.content, /Comment on Q-1 \(your question: First batched query\) from .+: extra note/);
	assert.equal(a.sent[0].message.details.entries.length, 3);
});

test("session wiring: watcher on items, poll and heartbeat intervals, shutdown cleans up", async t => {
	const { mk, home } = world(t);
	const a = mk("sa");
	await a.start();
	assert.deepEqual(a.intervals.map(i => i.ms).sort(), [20_000, 30_000]);
	assert.equal(a.watchers.length, 1);
	assert.equal(a.watchers[0].dir, join(home, "items"));
	assert.ok(existsSync(join(home, "sessions", "sa.json")));
	await a.call({ action: "ask", kind: "question", title: "Watcher driven topic" });
	await a.command("answer", "1 via watcher");
	a.watchers[0].cb(); // fs.watch event, debounced
	await waitUntil(() => a.sent.length === 1, 2000, "watcher delivery");
	await a.command("q", "1 comment hello");
	a.intervals.find(i => i.ms === 20_000)!.fn(); // the poll timer
	await waitUntil(() => a.sent.length === 2, 2000, "poll delivery");
	await a.shutdown();
	assert.ok(a.watchers[0].closed);
	assert.ok(a.intervals.every(i => i.cleared));
	assert.equal(existsSync(join(home, "sessions", "sa.json")), false);
	await sleep(20);
	a.controller.poll();
	assert.equal(a.sent.length, 2);
});

test("pending(): pure rules, including the 60 s orphan age and the same-repo requirement", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "Pure rules topic" }, { sessionId: "dead", repo: "o/r" });
	const at = new Date(1_000_000).toISOString();
	item.status = "answered";
	item.history.push({ seq: 2, at, actor: { kind: "user", sessionId: "u", name: "u" }, type: "answered", text: "yes" });
	const opts = { orphanOk: true, receiptName };
	const me = { sessionId: "x", repo: "o/r" };
	assert.equal(pending([item], me, [], new Set(), 1_000_000 + 59_000, opts).length, 0);
	const out = pending([item], me, [], new Set(), 1_000_000 + 61_000, opts);
	assert.deepEqual(out.map(e => e.mode), ["notice"]);
	assert.equal(pending([item], { ...me, repo: "o/other" }, [], new Set(), 2_000_000, opts).length, 0);
	assert.equal(pending([item], me, [], new Set(), 2_000_000, { ...opts, orphanOk: false }).length, 0);
	assert.equal(pending([item], me, [{ sessionId: "dead" }], new Set(), 2_000_000, opts).length, 0);
	assert.equal(pending([item], me, [], new Set([receiptName("Q-1", 2, "asker")]), 2_000_000, opts).length, 0);
});

test("Deliverer: handoff and compaction hold, then it sends", t => {
	const claimed: string[] = [];
	let handoff = true;
	const sends: string[] = [];
	const d = new Deliverer(
		{ isIdle: () => true, runActive: () => false, handoffActive: () => handoff, send: m => void sends.push(m.content) },
		e => (claimed.push(e.recipient), true),
		() => {},
	);
	const item = seed(tempDir(t), { title: "Unit deliverer topic" });
	const entry = { item, h: { seq: 2, at: "t", actor: { kind: "user" as const, sessionId: "u" }, type: "comment" as const, text: "hi" }, recipient: "asker", role: "asker" as const, mode: "wake" as const };
	assert.equal(d.deliver([entry]), 0);
	handoff = false;
	d.hold("compaction");
	assert.equal(d.deliver([entry]), 0);
	d.release("compaction");
	assert.equal(d.deliver([entry]), 1);
	assert.deepEqual(claimed, ["asker"]);
});

test("prolonged compaction: time passing never releases the hold; the end event does", async t => {
	const { mk, clock } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Very long compaction" });
	await a.emit("session_before_compact");
	await a.command("answer", "1 sure");
	for (const hours of [1, 6, 48]) {
		clock.offset = hours * 3_600_000;
		a.controller.poll();
		await a.emit("agent_end");
	}
	assert.equal(a.sent.length, 0);
	assert.equal(a.statuses.at(-1), "Q 0 open, 1 answered for you (delivery held)");
	await a.emit("session_compact");
	assert.equal(a.sent.length, 1);
	assert.equal(a.statuses.at(-1), undefined);
});

test("branch summarisation and tree navigation hold delivery until session_tree", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Tree navigation hold" });
	await a.emit("session_before_tree");
	await a.command("answer", "1 sure");
	a.controller.poll();
	await a.emit("agent_end");
	assert.equal(a.sent.length, 0);
	await a.emit("session_tree");
	assert.equal(a.sent.length, 1);
});

test("a cancelled tree navigation (no session_tree) is released by the next agent_start, not by time", async t => {
	const { mk, clock } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Cancelled navigation" });
	await a.emit("session_before_tree");
	await a.command("answer", "1 sure");
	clock.offset = 3_600_000;
	a.controller.poll();
	assert.equal(a.sent.length, 0);
	await a.emit("agent_start");
	a.controller.poll();
	assert.equal(a.sent.length, 1);
});

test("not idle and no agent run (unknown busy work) defers; an active run is follow-up safe", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.call({ action: "ask", kind: "question", title: "Busy but no run" });
	await a.command("answer", "1 sure");
	a.state.idle = false;
	a.controller.poll();
	await a.emit("agent_end"); // before any agent_start in this instance: not a known run
	assert.equal(a.sent.length, 0);
	await a.emit("agent_start");
	a.controller.poll();
	assert.equal(a.sent.length, 1);
	assert.deepEqual(a.sent[0].options, FOLLOW_UP);
});

test("after agent_settled the run is over: busy again means defer until idle", async t => {
	const { mk } = world(t);
	const a = mk("sa");
	await a.start();
	await a.emit("agent_start");
	await a.call({ action: "ask", kind: "question", title: "Settled then busy" });
	await a.emit("agent_settled");
	a.state.idle = false;
	await a.command("answer", "1 sure");
	a.controller.poll();
	assert.equal(a.sent.length, 0);
	a.state.idle = true;
	a.controller.poll();
	assert.equal(a.sent.length, 1);
});
