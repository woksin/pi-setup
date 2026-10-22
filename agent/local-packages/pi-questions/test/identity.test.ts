import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { laneOf, liveness, LIVE_MS, parseRemote, repoOf, userName } from "../src/identity.ts";
import { gitRepo, tempDir, writeUser } from "./helpers.ts";

test("origin URL parsing: ssh, scp-style and https", () => {
	assert.equal(parseRemote("git@github.com:Cratis/Chronicle.git"), "Cratis/Chronicle");
	assert.equal(parseRemote("https://github.com/Cratis/Chronicle"), "Cratis/Chronicle");
	assert.equal(parseRemote("https://github.com/Cratis/Chronicle.git/"), "Cratis/Chronicle");
	assert.equal(parseRemote("ssh://git@github.com:22/woksin/pi-questions.git"), "woksin/pi-questions");
	assert.equal(parseRemote("nonsense"), null);
});

test("repoOf reads origin; worktrees share the repo; no origin falls back to the directory; non-git is null", t => {
	const dir = tempDir(t);
	const main = gitRepo(join(dir, "main"), "git@github.com:acme/widgets.git");
	execFileSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"]);
	const wt = join(dir, "wt");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feature", wt]);
	assert.equal(repoOf(main), "acme/widgets");
	assert.equal(repoOf(wt), "acme/widgets");
	const bare = gitRepo(join(dir, "noorigin"));
	assert.equal(repoOf(bare), "noorigin");
	const plain = join(dir, "plain");
	mkdirSync(plain);
	assert.equal(repoOf(plain), null);
});

test("lane order: env, then orch heartbeat, then session name, then none", t => {
	const dir = tempDir(t);
	const orch = join(dir, "orch");
	mkdirSync(join(orch, "heartbeats"), { recursive: true });
	writeFileSync(join(orch, "heartbeats", "p1.json"), JSON.stringify({ id: "S-p1", sessionId: "other" }));
	writeFileSync(join(orch, "heartbeats", "p2.json"), JSON.stringify({ id: "S-p2", sessionId: "me" }));
	assert.equal(laneOf({ PI_ORCH_ID: "ENV-LANE" }, "me", "NAME", orch), "ENV-LANE");
	// A S-* heartbeat id is not a lane; the session name is next.
	assert.equal(laneOf({}, "me", "NAMED-LANE", orch), "NAMED-LANE");
	writeFileSync(join(orch, "heartbeats", "p3.json"), JSON.stringify({ id: "CHRON-A", sessionId: "me" }));
	assert.equal(laneOf({}, "me", "NAMED-LANE", orch), "CHRON-A");
	assert.equal(laneOf({}, "nobody", "not a lane name", orch), undefined);
	assert.equal(laneOf({}, "nobody", undefined, join(dir, "missing")), undefined);
});

test("liveness: dead pid and a stale heartbeat are not live", () => {
	const now = 1_000_000_000;
	assert.equal(liveness({ pid: process.pid }, now - 1000, now), true);
	assert.equal(liveness({ pid: process.pid }, now - LIVE_MS - 1, now), false);
	assert.equal(liveness({ pid: 2 ** 22 + 999 }, now - 1000, now), false);
	assert.equal(liveness({ pid: 5 }, now, now, () => true), true);
});

test("userName: githubUser from user.json, else the OS user", t => {
	const root = tempDir(t);
	const env = { PI_CODING_AGENT_DIR: join(root, "agent") };
	const os = userName(env);
	assert.ok(os.length > 0);
	writeUser(root, "someone-else");
	assert.equal(userName(env), "someone-else");
});
