import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readItem } from "../src/store.ts";
import { fileURLToPath } from "node:url";
import { answerItem } from "../src/actions.ts";
import { main } from "../src/cli.ts";
import { gitRepo, tempDir } from "./helpers.ts";

function cli(env: Record<string, string>, cwd: string) {
	return (...args: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = main(args, env, { out: s => out.push(s), err: s => err.push(s) }, cwd);
		return { code, out: out.join("\n"), err: err.join("\n") };
	};
}

test("ask creates an item with the asker from PI_SESSION_ID and PI_ORCH_ID, and runs the duplicate check", t => {
	const root = tempDir(t);
	const home = join(root, "home");
	const repo = gitRepo(join(root, "r"), "git@github.com:acme/alpha.git");
	const run = cli({ PI_QUESTIONS_HOME: home, PI_SESSION_ID: "sess-7", PI_ORCH_ID: "LANE-Z" }, repo);
	const first = run("ask", "--kind", "decision", "--title", "Pick a cache", "--body", "details", "--option", "a=Redis", "--option", "b=Memcached=fast", "--recommended", "a", "--urgency", "high", "--blocking", "perf work", "--cc", "L0");
	assert.equal(first.code, 0, first.err);
	assert.match(first.out, /^Created Q-1: Pick a cache\nWait for the answer with: pi-questions wait Q-1/);
	const item = readItem(home, "Q-1")!;
	assert.deepEqual([item.asker.sessionId, item.asker.lane, item.asker.repo, item.repo, item.cc, item.urgency], ["sess-7", "LANE-Z", "acme/alpha", "acme/alpha", ["L0"], "high"]);
	assert.deepEqual(item.options, [{ key: "a", text: "Redis" }, { key: "b", text: "Memcached=fast" }]);
	const dup = run("ask", "--kind", "decision", "--title", "pick a cache!");
	assert.equal(dup.code, 2);
	assert.match(dup.err, /Not created: possible duplicate/);
	assert.match(dup.err, /Q-1 \[open\] Pick a cache \(score 1\.00\)/);
	assert.match(dup.err, /--distinct-from Q-1/);
	const forced = run("ask", "--kind", "decision", "--title", "pick a cache!", "--distinct-from", "Q-1");
	assert.equal(forced.code, 0);
	assert.deepEqual(readItem(home, "Q-2")!.related, ["Q-1"]);
});

test("wait exits 1 while open, then 0 once answered", t => {
	const root = tempDir(t);
	const home = join(root, "home");
	const run = cli({ PI_QUESTIONS_HOME: home, PI_SESSION_ID: "s" }, root);
	assert.equal(run("ask", "--kind", "question", "--title", "Wait for me").code, 0);
	const open = run("wait", "Q-1");
	assert.equal(open.code, 1);
	assert.equal(open.out, "Q-1 is open\nnot answered yet (exit 1)");
	assert.equal(run("ask", "--kind", "question", "--title", "Something entirely unrelated about deploys").code, 0);
	assert.equal(run("wait", "Q-1", "Q-2").code, 1);
	answerItem(home, "Q-1", { kind: "user", sessionId: "u" }, { text: "done now", by: "u", via: "command" });
	const done = run("wait", "q1");
	assert.equal(done.code, 0);
	assert.equal(done.out, "Q-1 is answered: done now");
	const many = run("wait", "Q-2", "Q-1");
	assert.equal(many.code, 0);
	assert.equal(many.out, "Q-2 is open\nQ-1 is answered: done now");
	assert.equal(run("wait", "Q-9").code, 2);
});

test("list output: default scope, --all with the asker lane, and warnings", t => {
	const root = tempDir(t);
	const home = join(root, "home");
	const repoA = gitRepo(join(root, "a"), "git@github.com:acme/alpha.git");
	const repoB = gitRepo(join(root, "b"), "git@github.com:acme/beta.git");
	cli({ PI_QUESTIONS_HOME: home, PI_SESSION_ID: "sa", PI_ORCH_ID: "LANE-A" }, repoA)("ask", "--kind", "question", "--title", "Alpha question here");
	cli({ PI_QUESTIONS_HOME: home, PI_SESSION_ID: "sb", PI_ORCH_ID: "LANE-B" }, repoB)("ask", "--kind", "question", "--title", "Beta matter to decide", "--project", "p1");
	const run = cli({ PI_QUESTIONS_HOME: home, PI_SESSION_ID: "sx" }, repoA);
	const here = run("list");
	assert.match(here.out, /Alpha question here/);
	assert.doesNotMatch(here.out, /Beta matter/);
	const all = run("list", "--all");
	assert.match(all.out, /Beta matter/);
	assert.match(all.out, /asker LANE-B/);
	assert.doesNotMatch(run("list", "--all", "--project", "nope").out.replace("No matching items.", ""), /Alpha/);
	assert.match(run("get", "Q-2", "--record").out, /^Decision record Q-2: Beta matter to decide/);
	assert.ok(all.out.split("\n").every(l => l.length <= 100 && !l.startsWith(">")));
});

test("usage and errors: exit 2 with a message, never a stack trace", t => {
	const root = tempDir(t);
	const run = cli({ PI_QUESTIONS_HOME: join(root, "home") }, root);
	assert.equal(run("ask", "--kind", "question").code, 2);
	assert.match(run("ask", "--kind", "question").err, /^error: title is required/);
	assert.equal(run("ask", "--kind", "question", "--title", "x", "--option", "bad").code, 2);
	assert.equal(run("get").code, 2);
	assert.equal(run("frobnicate").code, 2);
	assert.match(run("frobnicate").err, /^usage: pi-questions/);
	assert.equal(run("list", "--bogus").code, 2);
});

test("the real executable honours PI_QUESTIONS_HOME and exits with wait's status", t => {
	const root = tempDir(t);
	const home = join(root, "elsewhere");
	const env = { ...process.env, PI_QUESTIONS_HOME: home, PI_SESSION_ID: "proc-1", HOME: join(root, "fakehome"), PI_CODING_AGENT_DIR: join(root, "agent") };
	const run = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args], { env, cwd: root, encoding: "utf8" });
	const ask = run("ask", "--kind", "fyi", "--title", "Process level notice");
	assert.equal(ask.status, 0, ask.stderr);
	assert.ok(existsSync(join(home, "items", "Q-1")));
	assert.ok(!existsSync(join(root, "agent", "user-questions")));
	assert.equal(run("wait", "Q-1").status, 1);
	assert.match(run("list").stdout, /Process level notice/);
});
