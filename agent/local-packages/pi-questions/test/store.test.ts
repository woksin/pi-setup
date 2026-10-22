import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { addHistory, canTransition, isActive, isOwn, parseId, validateDraft } from "../src/model.ts";
import { atomicWrite, claimReceipt, createItem, itemDir, listItems, mutateItem, readItem, receiptNames, resolveHome } from "../src/store.ts";
import { addCc, ask, closeItem, commentItem, supersedeItem, updateItem, withdrawItem } from "../src/actions.ts";
import { possibleDuplicates } from "../src/dedup.ts";
import { renderItem, renderList } from "../src/format.ts";
import { seed, tempDir } from "./helpers.ts";

const run = (args: string[]) =>
	new Promise<void>((resolve, reject) => {
		const c = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
		c.on("exit", code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
	});

test("atomic write leaves no temp files and replaces the file", t => {
	const dir = tempDir(t);
	const file = join(dir, "a.json");
	atomicWrite(file, { v: 1 });
	atomicWrite(file, { v: 2 });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: 2 });
	assert.deepEqual(readdirSync(dir), ["a.json"]);
	assert.equal(atomicWrite(file, { v: 3 }, true), false); // immutable: first writer wins
	assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("a partial temp file is never read as an item", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "alpha" });
	writeFileSync(join(itemDir(home, item.id), "r00000002.json.123.abcdef.tmp"), '{"id": "Q-1", "hist');
	const { items, warnings } = listItems(home);
	assert.deepEqual(items.map(i => i.id), [item.id]);
	assert.deepEqual(warnings, []);
});

test("a corrupt item file is skipped with a warning line", t => {
	const home = tempDir(t);
	seed(home, { title: "alpha one" });
	mkdirSync(join(home, "items", "Q-7"));
	writeFileSync(join(itemDir(home, "Q-7"), "r00000001.json"), "{not json");
	const { items, warnings } = listItems(home);
	assert.equal(items.length, 1);
	assert.match(warnings[0], /skipped Q-7: Q-7 is corrupt/);
	// The corrupt number is never reused.
	assert.equal(seed(home, { title: "beta two" }).id, "Q-8");
});

test("a corrupt latest revision is refused for read, write and list, never silently rolled back", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "revision fallback" });
	writeFileSync(join(itemDir(home, item.id), "r00000002.json"), "{truncated");
	assert.throws(() => readItem(home, item.id), /is corrupt.*r00000002\.json/);
	assert.throws(() => commentItem(home, item.id, { kind: "agent", sessionId: "s" }, "x"), /is corrupt/);
	assert.deepEqual(readdirSync(itemDir(home, item.id)).sort(), ["r00000001.json", "r00000002.json"]);
	const { items, warnings } = listItems(home);
	assert.equal(items.length, 0);
	assert.match(warnings[0], /skipped Q-1: .*is corrupt/);
});

test("an unreadable latest revision fails a mutation and writes no revision", t => {
	if (process.getuid?.() === 0) return t.skip("root ignores file permissions");
	const home = tempDir(t);
	const item = seed(home, { title: "unreadable item" });
	const file = join(itemDir(home, item.id), "r00000001.json");
	chmodSync(file, 0o000);
	try {
		assert.throws(() => commentItem(home, item.id, { kind: "agent", sessionId: "s" }, "x"), (e: any) => /Cannot read Q-1 revision 1 \(EACCES\)/.test(e.message));
	} finally {
		chmodSync(file, 0o644);
	}
	assert.deepEqual(readdirSync(itemDir(home, item.id)), ["r00000001.json"]);
});

test("id allocation is bounded by attempts and by a deadline, and other errors propagate", t => {
	const home = tempDir(t);
	let calls = 0;
	const collide = () => { calls++; throw Object.assign(new Error("exists"), { code: "EEXIST" }); };
	const prep = () => ({ build: (id: string) => ({ id }) as any });
	assert.throws(() => createItem(home, prep, { mkdir: collide, maxAttempts: 5 }), /Could not allocate an item id: 5 attempts/);
	assert.equal(calls, 5);
	const started = Date.now();
	assert.throws(() => createItem(home, prep, { mkdir: collide, timeoutMs: 0 }), /Could not allocate an item id/);
	assert.ok(Date.now() - started < 1000);
	const denied = () => { throw Object.assign(new Error("no"), { code: "EACCES" }); };
	assert.throws(() => createItem(home, prep, { mkdir: denied }), (e: any) => e.code === "EACCES");
});

test("an empty item directory (a claimed id, or a creator that died) is skipped silently and its id is not reused", t => {
	const home = tempDir(t);
	seed(home, { title: "first thing" });
	mkdirSync(join(home, "items", "Q-2"));
	const { items, warnings } = listItems(home);
	assert.deepEqual([items.length, warnings], [1, []]);
	assert.equal(seed(home, { title: "other matter" }).id, "Q-3");
});

test("two writers interleaved (controlled): the loser re-reads and retries, nothing is lost", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "interleaved writers" });
	let calls = 0;
	const a = mutateItem(home, item.id, i => {
		calls++;
		if (calls === 1) commentItem(home, item.id, { kind: "agent", sessionId: "b" }, "from B, lands first");
		i.history.push({ seq: i.history.length + 1, at: "t", actor: { kind: "agent", sessionId: "a" }, type: "comment", text: "from A" });
	});
	assert.equal(calls, 2);
	assert.equal(a.rev, 3);
	assert.deepEqual(readItem(home, item.id)!.history.map(h => h.text ?? h.type), ["created", "from B, lands first", "from A"]);
});

test("a writer that keeps losing the race stops at its attempt and deadline limits with a clear error", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "contended forever" });
	let calls = 0;
	const sabotage = (i: any) => {
		calls++;
		// A rival takes the very revision this writer is about to write, on every attempt.
		const rev = i.rev + 1;
		writeFileSync(join(itemDir(home, item.id), `r${String(rev).padStart(8, "0")}.json`), JSON.stringify({ ...i, rev }));
	};
	assert.throws(() => mutateItem(home, item.id, sabotage, new Date(), { maxAttempts: 5 }), /Could not update Q-1: other writers kept changing it \(5 attempts\)/);
	assert.equal(calls, 5);
	const started = Date.now();
	assert.throws(() => mutateItem(home, item.id, sabotage, new Date(), { timeoutMs: 0 }), /Could not update Q-1/);
	assert.ok(Date.now() - started < 1000);
});

test("a non-race write error (EACCES) propagates at once instead of looping", t => {
	if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
	const home = tempDir(t);
	const item = seed(home, { title: "unwritable item" });
	chmodSync(itemDir(home, item.id), 0o555);
	const started = Date.now();
	try {
		assert.throws(() => commentItem(home, item.id, { kind: "agent", sessionId: "s" }, "x"), (e: any) => e.code === "EACCES");
	} finally {
		chmodSync(itemDir(home, item.id), 0o755);
	}
	assert.ok(Date.now() - started < 1000);
});

const raceDraft = (title: string, extra: object = {}) => validateDraft({ kind: "question", title, body: "", ...extra });
const raceWho = (sessionId: string) => ({ sessionId, lane: sessionId, cwd: "/tmp", repo: null, pid: process.pid });

test("two simultaneous identical asks both exist and are both marked as possible duplicates at read time", t => {
	const home = tempDir(t);
	let inner: ReturnType<typeof ask> | undefined;
	const outer = ask(home, raceDraft("Same racing question"), raceWho("LANE-1"), Date.now(), {
		afterPrepare: () => { inner = ask(home, raceDraft("same racing question!"), raceWho("LANE-2")); },
	});
	assert.ok("ok" in outer && inner && "ok" in inner);
	const { items } = listItems(home);
	assert.deepEqual(items.map(i => [i.id, i.status]), [["Q-1", "open"], ["Q-2", "open"]]);
	assert.deepEqual(items.map(i => i.cc), [[], []]); // nothing was written by a reconciliation
	assert.equal(items.every(i => i.rev === 1), true);
	assert.deepEqual([...possibleDuplicates(items)], [["Q-2", "Q-1"]]);
	const list = renderList(items, { now: Date.now(), duplicates: possibleDuplicates(items) });
	assert.match(list, /possible duplicate of Q-1/);
	assert.match(renderItem(items[1], Date.now(), "Q-1"), /Possible duplicate of Q-1/);
});

test("a withdrawn Q-1 is never a duplicate target: the new ask is active and unmarked", t => {
	const home = tempDir(t);
	const first = ask(home, raceDraft("Same racing question"), raceWho("A"));
	assert.ok("ok" in first);
	withdrawItem(home, "Q-1", { kind: "agent", sessionId: "A" }, "changed my mind");
	const second = ask(home, raceDraft("Same racing question"), raceWho("B"));
	assert.ok("ok" in second);
	const { items } = listItems(home);
	assert.deepEqual(items.map(i => i.status), ["withdrawn", "open"]);
	assert.equal(possibleDuplicates(items).size, 0);
});

test("items created far apart, answered, closed or declared distinct are not marked", t => {
	const home = tempDir(t);
	const now = Date.now();
	ask(home, raceDraft("Same racing question"), raceWho("A"), now - 120_000);
	ask(home, raceDraft("Same racing question", { distinctFrom: [] }), raceWho("B"), now, {});
	const items = listItems(home).items;
	assert.equal(items.length, 1); // the second was refused by the create-time check, which is unchanged
	const far = structuredClone(items[0]);
	far.id = "Q-2"; far.createdAt = new Date(now).toISOString();
	assert.equal(possibleDuplicates([items[0], far]).size, 0);
	const near = { ...far, createdAt: new Date(Date.parse(items[0].createdAt) + 1000).toISOString() };
	assert.equal(possibleDuplicates([items[0], near]).size, 1);
	assert.equal(possibleDuplicates([items[0], { ...near, related: ["Q-1"] }]).size, 0);
	assert.equal(possibleDuplicates([{ ...items[0], status: "closed" }, near]).size, 0);
	assert.equal(possibleDuplicates([items[0], { ...near, status: "answered" }]).size, 0);
});

test("supersede moves the superseded item's asker and cc to the replacement, once, and repeating is idempotent", t => {
	const home = tempDir(t);
	ask(home, raceDraft("first topic alpha"), raceWho("A"));
	ask(home, raceDraft("unrelated second beta gamma", { cc: ["X"] }), raceWho("B"));
	const actor = { kind: "agent" as const, sessionId: "B" };
	const done = supersedeItem(home, "Q-2", actor, "Q-1");
	assert.deepEqual([done.status, done.supersededBy], ["superseded", "Q-1"]);
	assert.deepEqual(readItem(home, "Q-1")!.cc, ["B", "X"]);
	const revs = [readItem(home, "Q-1")!.rev, readItem(home, "Q-2")!.rev];
	const again = supersedeItem(home, "Q-2", actor, "Q-1"); // succeeds, writes nothing
	assert.equal(again.status, "superseded");
	assert.deepEqual([readItem(home, "Q-1")!.rev, readItem(home, "Q-2")!.rev], revs);
});

test("superseding into a withdrawn, closed or superseded survivor is refused and nothing is written", t => {
	const home = tempDir(t);
	const actor = { kind: "agent" as const, sessionId: "A" };
	ask(home, raceDraft("first topic alpha"), raceWho("A"));
	ask(home, raceDraft("second beta gamma"), raceWho("B"));
	ask(home, raceDraft("third delta epsilon"), raceWho("C"));
	withdrawItem(home, "Q-1", actor, "gone");
	assert.throws(() => supersedeItem(home, "Q-2", actor, "Q-1"), /withdrawn.*only be superseded by/);
	const snapshot = () => listItems(home).items.map(i => [i.id, i.rev, i.status, i.cc.join()].join("|"));
	const before = snapshot();
	assert.throws(() => supersedeItem(home, "Q-2", actor, "Q-1"), /withdrawn/);
	assert.deepEqual(snapshot(), before);
	closeItem(home, "Q-3", actor, "done");
	assert.throws(() => supersedeItem(home, "Q-2", actor, "Q-3"), /closed/);
	assert.throws(() => supersedeItem(home, "Q-2", actor, "Q-2"), /itself/);
	assert.throws(() => supersedeItem(home, "Q-2", actor, "Q-99"), /does not exist/);
	assert.equal(readItem(home, "Q-2")!.status, "open");
	assert.equal(readItem(home, "Q-2")!.rev, 1);
});

test("an invalid source transition writes nothing, and superseding to a different target is refused", t => {
	const home = tempDir(t);
	const actor = { kind: "agent" as const, sessionId: "A" };
	ask(home, raceDraft("first topic alpha"), raceWho("A"));
	ask(home, raceDraft("second beta gamma"), raceWho("B"));
	ask(home, raceDraft("third delta epsilon"), raceWho("C"));
	withdrawItem(home, "Q-2", actor, "gone");
	assert.throws(() => supersedeItem(home, "Q-2", actor, "Q-1"), /cannot become superseded/);
	assert.deepEqual(readItem(home, "Q-1")!.cc, []);
	ask(home, raceDraft("fourth zeta eta theta"), raceWho("D"));
	supersedeItem(home, "Q-3", actor, "Q-1");
	assert.throws(() => supersedeItem(home, "Q-3", actor, "Q-4"), /already superseded by Q-1/);
	assert.equal(readItem(home, "Q-3")!.supersededBy, "Q-1");
});

test("after S is superseded, addCc(S, LATE) is forwarded to T, which ends with the asker, the cc and LATE", t => {
	const home = tempDir(t);
	const actor = { kind: "agent" as const, sessionId: "B" };
	ask(home, raceDraft("first topic alpha"), raceWho("A"));
	ask(home, raceDraft("second beta gamma", { cc: ["X"] }), raceWho("B"));
	// Step b) only: S is superseded, the transfer to T has not happened yet.
	mutateItem(home, "Q-2", i => { i.status = "superseded"; i.supersededBy = "Q-1"; });
	const forwarded = addCc(home, "Q-2", actor, "LATE");
	assert.equal(forwarded.id, "Q-1");
	assert.deepEqual(readItem(home, "Q-2")!.cc, ["X"]); // S was not modified
	supersedeItem(home, "Q-2", actor, "Q-1"); // recovery completes the transfer
	assert.deepEqual([...readItem(home, "Q-1")!.cc].sort(), ["B", "LATE", "X"]);
	assert.equal(addCc(home, "Q-2", actor, "LATE").id, "Q-1"); // idempotent
	assert.equal(readItem(home, "Q-1")!.cc.length, 3);
});

test("recovery: a crash between b) and c) is completed by rerunning supersede", t => {
	const home = tempDir(t);
	const actor = { kind: "agent" as const, sessionId: "B" };
	ask(home, raceDraft("first topic alpha"), raceWho("A"));
	ask(home, raceDraft("second beta gamma", { cc: ["X"] }), raceWho("B"));
	mutateItem(home, "Q-2", i => { i.status = "superseded"; i.supersededBy = "Q-1"; }); // b) only
	assert.deepEqual(readItem(home, "Q-1")!.cc, []);
	supersedeItem(home, "Q-2", actor, "Q-1");
	assert.deepEqual(readItem(home, "Q-1")!.cc, ["B", "X"]);
});

test("addCc forwarding follows a chain, bounded", t => {
	const home = tempDir(t);
	const actor = { kind: "agent" as const, sessionId: "Z" };
	for (let n = 1; n <= 8; n++) seed(home, { title: `distinct topic number ${n} word${n}${n}` });
	for (let n = 1; n < 8; n++) mutateItem(home, `Q-${n}`, i => { i.status = "superseded"; i.supersededBy = `Q-${n + 1}`; });
	assert.throws(() => addCc(home, "Q-1", actor, "L"), /more than 5/);
	assert.equal(addCc(home, "Q-3", actor, "L").id, "Q-8");
});

test("concurrent creation: 8 processes x 10 items give Q-1..Q-80, unique and valid", async t => {
	const home = tempDir(t);
	await Promise.all([...Array(8).keys()].map(n => run(["test/worker.ts", "create", home, "10", String(n)])));
	const { items, warnings } = listItems(home);
	assert.deepEqual(warnings, []);
	assert.equal(items.length, 80);
	assert.deepEqual(items.map(i => i.id).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))), [...Array(80).keys()].map(n => `Q-${n + 1}`));
	assert.equal(new Set(items.map(i => i.title)).size, 80);
	for (const i of items) assert.deepEqual(readdirSync(itemDir(home, i.id)), ["r00000001.json"]); // no temp files left
});

test("concurrent mutation: 4 processes x 25 comments give 100 comments and rev 101", async t => {
	const home = tempDir(t);
	const item = seed(home, { title: "shared item" });
	await Promise.all([...Array(4).keys()].map(() => run(["test/worker.ts", "comment", home, "25", item.id])));
	const after = readItem(home, item.id)!;
	assert.equal(after.history.filter(h => h.type === "comment").length, 100);
	assert.equal(after.rev, 101);
	assert.deepEqual(after.history.map(h => h.seq), [...Array(101).keys()].map(n => n + 1));
});

test("ids are never reused, and createItem can refuse", t => {
	const home = tempDir(t);
	assert.equal(seed(home, { title: "first thing" }).id, "Q-1");
	mkdirSync(join(home, "items", "Q-2")); // taken by someone else
	assert.equal(seed(home, { title: "other matter" }).id, "Q-3");
	assert.deepEqual(createItem(home, () => ({ refuse: "no" })), { refused: "no" });
});

test("mutateItem validates before writing and keeps the file intact on a throw", t => {
	const home = tempDir(t);
	const item = seed(home, { title: "keep me" });
	assert.throws(() => mutateItem(home, item.id, i => { i.title = ""; }), /title must be/);
	assert.throws(() => mutateItem(home, item.id, () => { throw new Error("boom"); }), /boom/);
	assert.equal(readItem(home, item.id)!.rev, 1);
	assert.throws(() => mutateItem(home, "Q-99", () => {}), /does not exist/);
});

test("receipts: the first claim wins and is visible by name", t => {
	const home = tempDir(t);
	assert.equal(claimReceipt(home, "Q-1", 2, "asker", "s1"), true);
	assert.equal(claimReceipt(home, "Q-1", 2, "asker", "s2"), false);
	assert.deepEqual([...receiptNames(home)], ["Q-1.2.asker.json"]);
});

test("PI_QUESTIONS_HOME is respected, and no path is hard-coded", () => {
	assert.equal(resolveHome({ PI_QUESTIONS_HOME: "/x/y" }), "/x/y");
	assert.equal(resolveHome({ PI_CODING_AGENT_DIR: "/a" }), "/a/user-questions");
});

test("model: ids, transitions, ownership and due deferrals", t => {
	assert.equal(parseId("42"), "Q-42");
	assert.equal(parseId("q42"), "Q-42");
	assert.equal(parseId("Q-42"), "Q-42");
	assert.equal(parseId("x"), null);
	assert.ok(canTransition("open", "answered"));
	assert.ok(!canTransition("closed", "answered"));
	assert.throws(() => validateDraft({ kind: "question", title: "x".repeat(121) }), /title is too long/);
	assert.throws(() => validateDraft({ kind: "nope", title: "x" }), /kind must be/);
	assert.throws(() => validateDraft({ kind: "question", title: "x", options: [{ key: "a", text: "A" }], recommended: "b" }), /recommended/);
	const home = tempDir(t);
	const item = seed(home, { title: "mine" }, { sessionId: "s1", lane: "LA" });
	assert.ok(isOwn(item, { sessionId: "s1" }));
	assert.ok(isOwn(item, { sessionId: "s2", lane: "LA" }));
	assert.ok(!isOwn(item, { sessionId: "s2", lane: "LB" }));
	const d = { ...item, status: "deferred" as const, deferredUntil: new Date(2000).toISOString() };
	assert.ok(isActive(d, 3000));
	assert.ok(!isActive(d, 1000));
	assert.ok(!isActive({ ...d, deferredUntil: undefined }, 3000));
	addHistory(d, { kind: "agent", sessionId: "s" }, "comment", "t", "x");
	assert.equal(d.history.at(-1)!.seq, 2);
});

test("owner path: update {cc} on a superseded item is forwarded to the survivor; other updates stay refused", t => {
	const home = tempDir(t);
	const actor = { kind: "agent" as const, sessionId: "B" };
	ask(home, raceDraft("first topic alpha"), raceWho("A"));
	ask(home, raceDraft("second beta gamma"), raceWho("B"));
	supersedeItem(home, "Q-2", actor, "Q-1");
	const s = readItem(home, "Q-2")!;
	const res = updateItem(home, "Q-2", actor, { cc: ["LATE"] });
	assert.equal(res.id, "Q-1");
	assert.deepEqual([...readItem(home, "Q-1")!.cc].sort(), ["B", "LATE"]);
	assert.equal(readItem(home, "Q-2")!.rev, s.rev);
	assert.throws(() => updateItem(home, "Q-2", actor, { title: "new title" }), /only open or deferred/);
	assert.throws(() => updateItem(home, "Q-2", actor, { cc: ["Y"], urgency: "high" }), /only open or deferred/);
	assert.equal(readItem(home, "Q-2")!.rev, s.rev);
});
