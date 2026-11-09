import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const script = join(process.env.HOME ?? homedir(), ".pi/agent/bin/inbox-watch");
const env = (dir: string) => ({ ...process.env, INBOX_DIR: dir, INBOX_SETTLE_SECONDS: "1", INBOX_SETTLE_MAX_SECONDS: "3", INBOX_ALIASES: "" });
const run = (dir: string, ...args: string[]) => new Promise<{ code: number | null; out: string[]; ms: number }>(resolve => {
	const began = Date.now();
	const child = spawn(script, args.length ? args : ["L1"], { env: env(dir) });
	let out = "";
	child.stdout.on("data", d => { out += d; });
	child.on("close", code => resolve({ code, out: out.split("\n").filter(Boolean), ms: Date.now() - began }));
});
const fresh = () => mkdtempSync(join(tmpdir(), "inbox-watch-"));
const put = (dir: string, name: string, ageSeconds = 0) => {
	const file = join(dir, name);
	writeFileSync(file, "x");
	if (ageSeconds) { const t = new Date(Date.now() - ageSeconds * 1000); utimesSync(file, t, t); }
};
const armed = async () => { const dir = fresh(); assert.equal((await run(dir)).code, 1); await new Promise(r => setTimeout(r, 2100)); return dir; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// The marker sits 2 s behind the scan start (existing, documented overlap): once 3 s have passed, one rescan absorbs any repeat and the next must be empty.
const quiet = async (dir: string) => { await sleep(3100); await run(dir); return run(dir); };

test("first arm creates the marker and exits 1", async () => {
	const dir = fresh();
	put(dir, "L0-to-L1-old.md", 100);
	assert.equal((await run(dir)).code, 1);
	assert.ok(readdirSync(dir).includes("L1-inbox.marker"));
});

test("a file older than the settle window is reported without added latency", async () => {
	const dir = await armed();
	put(dir, "L0-to-L1-a.md", 10);
	const r = await run(dir);
	assert.equal(r.code, 0);
	assert.deepEqual(r.out, ["L0-to-L1-a.md"]);
	assert.ok(r.ms < 900, `took ${r.ms}`);
});

test("a burst written during the settle sleep yields one output and the marker is advanced after it", async () => {
	const dir = await armed();
	put(dir, "L0-to-L1-a.md");
	const pending = run(dir);
	await sleep(400);
	put(dir, "L0-to-L1-b.md");
	const r = await pending;
	assert.equal(r.code, 0);
	assert.deepEqual([...r.out].sort(), ["L0-to-L1-a.md", "L0-to-L1-b.md"]);
	assert.equal((await quiet(dir)).code, 1);
});

for (const name of ["URGENT-L0-to-L1-x.md", "L0-to-ALL-STOP-x.md"]) {
	test(`${name} returns at once and flushes other fresh files`, async () => {
		const dir = await armed();
		put(dir, "L0-to-L1-a.md");
		put(dir, name);
		const r = await run(dir);
		assert.equal(r.code, 0);
		assert.ok(r.ms < 900, `took ${r.ms}`);
		assert.deepEqual([...r.out].sort(), ["L0-to-L1-a.md", name].sort());
		assert.equal((await quiet(dir)).code, 1);
	});
}

test("lowercase stop in a topic is not urgent", async () => {
	const dir = await armed();
	put(dir, "L0-to-L1-stop.md");
	const r = await run(dir);
	assert.equal(r.code, 0);
	assert.ok(r.ms >= 900, `took ${r.ms}`);
});

test("BCAST files alone do not wake and are listed once with the next real wake", async () => {
	const dir = await armed();
	put(dir, "BCAST-disk-growth-1200.md", 10);
	const first = await run(dir);
	assert.equal(first.code, 1);
	assert.deepEqual(first.out, []);
	put(dir, "L0-to-L1-x.md", 10);
	const second = await run(dir);
	assert.equal(second.code, 0);
	assert.deepEqual(second.out, ["L0-to-L1-x.md", "BCAST-disk-growth-1200.md"]);
	assert.equal((await quiet(dir)).code, 1);
});

test("a -act BCAST file wakes like ALL", async () => {
	const dir = await armed();
	put(dir, "BCAST-hold-1200-act.md", 10);
	const r = await run(dir);
	assert.equal(r.code, 0);
	assert.deepEqual(r.out, ["BCAST-hold-1200-act.md"]);
});

test("a lane-closed wake file wakes only the reassign target, PISETUP included", async () => {
	const dir = fresh();
	for (const id of ["L1", "L2", "L3", "PISETUP"]) assert.equal((await run(dir, id)).code, 1);
	await sleep(2100);
	put(dir, "lanestatus-to-L2-lane-closed-L2-A-1200.md", 10);
	put(dir, "lanestatus-to-PISETUP-lane-closed-L1-1201.md", 10);
	assert.equal((await run(dir, "L3")).code, 1);
	assert.equal((await run(dir, "L1")).code, 1);
	const r = await run(dir, "L2");
	assert.equal(r.code, 0, "a dashed closed lane (L2-A) reassigning to its prefix (L2) still wakes the target");
	assert.deepEqual(r.out, ["lanestatus-to-L2-lane-closed-L2-A-1200.md"]);
	const p = await run(dir, "PISETUP");
	assert.equal(p.code, 0);
	assert.deepEqual(p.out, ["lanestatus-to-PISETUP-lane-closed-L1-1201.md"]);
});

test("a BCAST file older than the TTL is never reported", async () => {
	const dir = await armed();
	put(dir, "BCAST-old-1200.md", 25 * 3600);
	put(dir, "L0-to-L1-x.md", 10);
	assert.deepEqual((await run(dir)).out, ["L0-to-L1-x.md"]);
});

test("sender-skip and ALL behaviour are unchanged", async () => {
	const dir = await armed();
	put(dir, "L1-to-L0-mine.md", 10);
	assert.equal((await run(dir)).code, 1);
	put(dir, "ALL-hold-1.md", 10);
	assert.deepEqual((await run(dir)).out, ["ALL-hold-1.md"]);
});
