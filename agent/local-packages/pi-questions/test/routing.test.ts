import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import * as identity from "../src/identity.ts";
import { validateDraft } from "../src/model.ts";
import { readItem, readSessions, receiptName, receiptNames, writeHeartbeat } from "../src/store.ts";
import { session, tempDir } from "./helpers.ts";

function world(t: Parameters<typeof tempDir>[0]) {
	const root = tempDir(t);
	const home = join(root, "home");
	const env = { PI_QUESTIONS_HOME: home, ORCH_HOME: join(root, "orch") };
	const run = (...args: string[]) => {
		const out: string[] = [], err: string[] = [];
		const code = main(args, env, { out: s => out.push(s), err: s => err.push(s) }, root);
		return { code, out: out.join("\n"), err: err.join("\n") };
	};
	const mk = (sessionId: string, lane?: string) => session(t, { root, home, sessionId, lane });
	const map = (id: string, lane = "L47") => {
		const result = run("lane", "set", lane, "--session", id);
		assert.equal(result.code, 0, result.err);
	};
	return { root, home, env, run, mk, map };
}

function heartbeat(home: string, sessionId: string, pid = process.pid) {
	writeHeartbeat(home, { sessionId, pid, repo: null, cwd: "/tmp", at: new Date().toISOString() });
}

test("lane CLI: set, list and clear the atomic per-session map, including existing lane ids", t => {
	const { home, run } = world(t);
	assert.equal(run("lane", "list").code, 0);
	for (const lane of ["L18b", "R-CHR", "PISETUP"]) {
		assert.equal(run("lane", "set", lane, "--session", "s1").code, 0);
		const record = JSON.parse(readFileSync(join(home, "lanes", "s1.json"), "utf8"));
		assert.equal(record.lane, lane);
		assert.equal(record.sessionId, "s1");
		assert.equal(typeof record.setBy, "string");
		assert.ok(Number.isFinite(Date.parse(record.at)));
		assert.match(run("lane", "list").out, new RegExp(`s1.*${lane}|${lane}.*s1`));
	}
	assert.deepEqual(readdirSync(join(home, "lanes")), ["s1.json"]);
	assert.equal(run("lane", "set", "bad lane", "--session", "s1").code, 2);
	assert.equal(run("lane", "set", "L47", "--session", "../escape").code, 2);
	assert.equal(run("lane", "set", "L47").code, 2);
	assert.equal(run("lane", "set", "L47", "--session", "s1", "--pid", "1").code, 2);
	assert.equal(run("lane", "clear", "--pid", "1").code, 2);
	assert.equal(run("lane", "clear", "--session", "s1").code, 0);
	assert.deepEqual(readdirSync(join(home, "lanes")), []);
	assert.doesNotMatch(run("lane", "list").out, /s1/);
});

test("lane CLI pid resolution refuses missing, invalid and ambiguous heartbeat matches", t => {
	const { home, run } = world(t);
	const set = (...selector: string[]) => run("lane", "set", "L47", ...selector);
	assert.match(set("--pid", String(process.pid)).err, /no.*session/i);
	assert.equal(set("--pid", "not-a-pid").code, 2);
	heartbeat(home, "s1");
	assert.equal(set("--pid", String(process.pid)).code, 0);
	heartbeat(home, "s2");
	assert.match(set("--pid", String(process.pid)).err, /multiple|ambiguous|several/i);
	assert.match(set("--tty", "ttys-no-such-terminal").err, /no.*session/i);
});

test("tty resolution uses heartbeat pids and refuses missing or multiple sessions", t => {
	const { home } = world(t);
	heartbeat(home, "s1");
	const tty = (pid: number) => pid === process.pid ? "ttys012" : undefined;
	assert.equal(identity.resolveLaneSession(home, { tty: "/dev/ttys012" }, tty), "s1");
	assert.throws(() => identity.resolveLaneSession(home, { tty: "ttys099" }, tty), /no.*session/i);
	heartbeat(home, "s2");
	assert.throws(() => identity.resolveLaneSession(home, { tty: "ttys012" }, tty), /multiple|ambiguous|several/i);
});

test("identity precedence: env, map, orch heartbeat, name; clearing restores fallbacks", t => {
	const { home, env, run, map } = world(t);
	mkdirSync(join(env.ORCH_HOME, "heartbeats"), { recursive: true });
	writeFileSync(join(env.ORCH_HOME, "heartbeats", "a.json"), JSON.stringify({ id: "ORCH", sessionId: "s1" }));
	map("s1", "L18b");
	assert.equal(identity.laneOf(env, "s1", "NAME"), "L18b");
	assert.equal(identity.laneOf({ ...env, PI_ORCH_ID: "ENV" }, "s1", "NAME"), "ENV");
	assert.equal(run("lane", "clear", "--session", "s1").code, 0);
	assert.equal(identity.laneOf(env, "s1", "NAME"), "ORCH");
	assert.equal(identity.laneOf(env, "s2", "L18b"), "L18b");
	assert.equal(identity.laneOf({ ...env, PI_QUESTIONS_HOME: `${home}-other` }, "s2", "not a lane"), undefined);
});

test("/lane sets, shows and clears current session identity and heartbeat", async t => {
	const { mk, home } = world(t);
	const s = mk("s1");
	await s.start();
	await s.command("lane", "L18b");
	await s.command("lane", "");
	assert.match(s.notes.at(-1)!.text, /L18b/);
	assert.equal(readSessions(home)[0].lane, "L18b");
	await s.command("lane", "bad lane");
	assert.equal(s.notes.at(-1)!.level, "error");
	await s.command("lane", "clear");
	assert.equal(readSessions(home)[0].lane, undefined);
	await s.command("lane", "");
	assert.doesNotMatch(s.notes.at(-1)!.text, /L18b/);
});

test("external map changes recompute within one delivery poll, including heartbeat and clear", async t => {
	const { mk, home, map, run } = world(t);
	const s = mk("s1");
	await s.start();
	map("s1");
	s.controller.poll();
	assert.equal(readSessions(home)[0].lane, "L47");
	await s.call({ action: "ask", kind: "question", title: "Mapped running identity" });
	assert.equal(readItem(home, "Q-1")!.asker.lane, "L47");
	run("lane", "clear", "--session", "s1");
	s.controller.poll();
	assert.equal(readSessions(home)[0].lane, undefined);
});

test("ask for: validates like cc, deduplicates, limits to five, and CLI persists it", t => {
	const base = { kind: "question", title: "On behalf draft" };
	assert.deepEqual(validateDraft({ ...base, for: [" L47 ", "L47", "session-123"] }).for, ["L47", "session-123"]);
	for (const invalid of ["L47", [""], [12], ["a", "b", "c", "d", "e", "f"]]) {
		assert.throws(() => validateDraft({ ...base, for: invalid }), /for/);
	}
	assert.equal(validateDraft(base).for, undefined);
	const { run, home } = world(t);
	const result = run("ask", "--kind", "question", "--title", "On behalf CLI", "--for", "L47", "--for", "session-123");
	assert.equal(result.code, 0, result.err);
	assert.deepEqual(readItem(home, "Q-1")!.for, ["L47", "session-123"]);
});

test("for a live mapped lane: wake lane once, give coordinator a notice, show list and held status", async t => {
	const { mk, map, home } = world(t);
	const coordinator = mk("l0");
	const worker = mk("worker");
	await coordinator.start();
	await worker.start();
	map("worker");
	worker.controller.poll();
	await coordinator.call({ action: "ask", kind: "question", title: "Choose lane transport", for: ["L47"] });
	await coordinator.command("questions", "all");
	assert.match(coordinator.notes.at(-1)!.text, /for L47/);
	await worker.emit("session_before_compact");
	await coordinator.command("answer", "1 use the durable queue");
	worker.controller.poll();
	assert.equal(worker.statuses.at(-1), "Q 0 open, 1 answered for L47 (delivery held)");
	assert.equal(worker.sent.length, 0);
	coordinator.controller.poll();
	assert.deepEqual(coordinator.sent.map(s => s.options), [{ deliverAs: "nextTurn" }]);
	assert.equal(coordinator.notes.at(-1)!.text, "1 answer arrived. See the next turn.");
	await worker.emit("session_compact");
	assert.deepEqual(worker.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
	assert.ok(receiptNames(home).has(receiptName("Q-1", 2, "for:L47")));
	worker.controller.poll();
	coordinator.controller.poll();
	assert.equal(worker.sent.length, 1);
	assert.equal(coordinator.sent.length, 1);
});

test("for an absent lane: leave its receipt unclaimed, and wake its next session immediately", async t => {
	const { mk, map, home } = world(t);
	const coordinator = mk("l0");
	await coordinator.start();
	await coordinator.call({ action: "ask", kind: "decision", title: "Lane restart destination", for: ["L47"] });
	await coordinator.command("answer", "1 proceed");
	coordinator.controller.poll();
	assert.ok(!receiptNames(home).has(receiptName("Q-1", 2, "for:L47")));
	map("new-worker");
	const worker = mk("new-worker");
	await worker.start();
	assert.deepEqual(worker.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
});

test("for a lane with two sessions: one receipt wins, including when the asker is in that lane", async t => {
	const { mk, map } = world(t);
	map("asker");
	map("peer");
	const a = mk("asker"), b = mk("peer");
	await a.start();
	await b.start();
	await a.call({ action: "ask", kind: "question", title: "Ask inside recipient lane", for: ["L47"] });
	await a.command("answer", "1 yes");
	b.controller.poll();
	assert.equal(b.sent.length, 0, "a peer must not claim the live asker's for-lane receipt");
	a.controller.poll();
	assert.deepEqual(a.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
	assert.equal(b.sent.length, 0);
});

test("for session ids and several lanes: independent wakes, one per recipient", async t => {
	const { mk, map } = world(t);
	map("w1");
	map("w2");
	map("w3", "L48");
	const a = mk("l0"), b = mk("w1"), c = mk("w2"), d = mk("direct"), e = mk("w3");
	for (const s of [a, b, c, d, e]) await s.start();
	await a.call({ action: "ask", kind: "question", title: "Several recipient targets", for: ["L47", "L48", "direct"] });
	await a.command("answer", "1 done");
	b.controller.poll();
	c.controller.poll();
	d.controller.poll();
	e.controller.poll();
	assert.equal(b.sent.length + c.sent.length, 1);
	assert.deepEqual(d.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
	assert.deepEqual(e.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
});

test("legacy items: map enables restart and takeover, but a live asker retains the wake", async t => {
	const { mk, map, home } = world(t);
	map("old");
	map("replacement");
	const old = mk("old");
	await old.start();
	await old.call({ action: "ask", kind: "question", title: "Legacy lane takeover" });
	assert.equal(readItem(home, "Q-1")!.for, undefined);
	const replacement = mk("replacement");
	await replacement.start();
	await old.command("answer", "1 continue");
	replacement.controller.poll();
	assert.equal(replacement.sent.length, 0);
	await old.shutdown();
	replacement.controller.poll();
	assert.deepEqual(replacement.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
});


test("mapping an already-running session delivers a waiting for-answer on its next poll", async t => {
	const { mk, map, home } = world(t);
	const coordinator = mk("l0"), worker = mk("unmapped");
	await coordinator.start();
	await worker.start();
	await coordinator.call({ action: "ask", kind: "question", title: "Late map recipient", for: ["L47"] });
	await coordinator.command("answer", "1 wake the mapped lane");
	worker.controller.poll();
	assert.equal(worker.sent.length, 0);
	assert.ok(!receiptNames(home).has(receiptName("Q-1", 2, "for:L47")));
	map("unmapped");
	worker.controller.poll();
	assert.deepEqual(worker.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
	assert.equal(readSessions(home).find(s => s.sessionId === "unmapped")!.lane, "L47");
});

test("/lane cannot override PI_ORCH_ID or mutate identity from a subagent", async t => {
	const { root, home, mk } = world(t);
	const s = mk("s1", "ENV");
	await s.start();
	await s.command("lane", "L47");
	assert.match(s.notes.at(-1)!.text, /PI_ORCH_ID=ENV takes precedence/);
	assert.ok(!existsSync(join(home, "lanes", "s1.json")));
	assert.equal(readSessions(home)[0].lane, "ENV");
	const sub = session(t, { root, home, sessionId: "sub", hasUI: false });
	await sub.start();
	await sub.command("lane", "L47");
	assert.match(sub.notes.at(-1)!.text, /only available in the main session/);
	assert.ok(!existsSync(join(home, "lanes", "sub.json")));
});


test("session-name fallback is strict while explicit map and environment ids may have lowercase letters", t => {
	const { env, map, run } = world(t);
	for (const name of ["Review", "L18bc", "Lane47", "not a lane"]) {
		assert.equal(identity.laneOf(env, "named", name), undefined, name);
	}
	for (const name of ["L18b", "L47", "R-CHR", "PISETUP"]) {
		assert.equal(identity.laneOf(env, "named", name), name);
	}
	map("named", "Review");
	assert.equal(identity.laneOf(env, "named", "anything"), "Review");
	run("lane", "clear", "--session", "named");
	assert.equal(identity.laneOf({ ...env, PI_ORCH_ID: "Review" }, "named", "anything"), "Review");
});

test("for the asker's lane: a peer can take over immediately after the asker exits", async t => {
	const { mk, map } = world(t);
	map("asker");
	map("peer");
	const a = mk("asker"), b = mk("peer");
	await a.start();
	await b.start();
	await a.call({ action: "ask", kind: "question", title: "On behalf lane takeover", for: ["L47"] });
	await a.command("answer", "1 continue after restart");
	await a.shutdown();
	b.controller.poll();
	assert.deepEqual(b.sent.map(s => s.options), [{ triggerTurn: true, deliverAs: "followUp" }]);
});

test("lane set CLI warns about other live lane sessions but still applies the mapping", async t => {
	const { mk, run, home } = world(t);
	const other = mk("occupied", "L47");
	await other.start();
	const result = run("lane", "set", "L47", "--session", "target");
	assert.equal(result.code, 0, result.err);
	assert.equal(result.err, "warning: L47 is also the lane of live session occupied; answers for L47 go to whichever session polls first");
	assert.equal(JSON.parse(readFileSync(join(home, "lanes", "target.json"), "utf8")).lane, "L47");
});

test("/lane warns about another live lane session and still applies the mapping", async t => {
	const { mk, home } = world(t);
	const other = mk("occupied", "L47"), target = mk("target");
	await other.start();
	await target.start();
	await target.command("lane", "L47");
	assert.ok(target.notes.some(n => n.level === "warning" && n.text === "warning: L47 is also the lane of live session occupied; answers for L47 go to whichever session polls first"));
	assert.equal(JSON.parse(readFileSync(join(home, "lanes", "target.json"), "utf8")).lane, "L47");
	assert.equal(readSessions(home).find(s => s.sessionId === "target")!.lane, "L47");
});

test("lane warnings exclude self, stale and dead heartbeats", async t => {
	const { mk, run, home } = world(t);
	const self = mk("self", "L47");
	await self.start();
	for (const [sessionId, pid] of [["dead", -1], ["stale", process.pid]] as const) {
		writeHeartbeat(home, { sessionId, pid, lane: "L47", repo: null, cwd: "/tmp", at: new Date().toISOString() });
	}
	const stale = new Date(Date.now() - identity.LIVE_MS - 1000);
	utimesSync(join(home, "sessions", "stale.json"), stale, stale);
	const result = run("lane", "set", "L47", "--session", "self");
	assert.equal(result.code, 0, result.err);
	assert.equal(result.err, "");
});

test("/lane with PI_ORCH_ID leaves an existing mapping byte-for-byte unchanged", async t => {
	const { mk, map, home } = world(t);
	map("s1", "EXISTING");
	const file = join(home, "lanes", "s1.json");
	const before = readFileSync(file, "utf8");
	const s = mk("s1", "ENV");
	await s.start();
	await s.command("lane", "L47");
	assert.match(s.notes.at(-1)!.text, /PI_ORCH_ID=ENV takes precedence/);
	assert.equal(readFileSync(file, "utf8"), before);
});
