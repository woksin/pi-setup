/** Orchestration detection, decision log, ALL notices and bounded prompts never throw or hang. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSelect, guardSelect, isOrchestrated, orchLog, postAllNotice } from "./orchestration.ts";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-orch-test-"));
	env = {
		PI_ORCH_MODE_FILE: join(dir, "orchestration-mode"),
		PI_ORCH_REPO_ROOT: join(dir, "repos"),
		PI_ORCH_MESSAGES_DIR: join(dir, "repos", ".ai-work", "einari-issues", "messages"),
		PI_GUARD_DECISIONS_LOG: join(dir, "logs", "guard-decisions.jsonl"),
	};
});
afterEach(() => rmSync(dir, { recursive: true }));

test("isOrchestrated: PI_ORCH_ID, operator switch file, or cwd under the repos root with a message board", () => {
	assert.equal(isOrchestrated(env, join(dir, "repos", "Studio")), false);
	assert.equal(isOrchestrated({ ...env, PI_ORCH_ID: "L0" }, "/elsewhere"), true);
	assert.equal(isOrchestrated({ ...env, PI_ORCH_ID: "  " }, "/elsewhere"), false);
	writeFileSync(env.PI_ORCH_MODE_FILE!, "# on\n");
	assert.equal(isOrchestrated(env, undefined), true);
	rmSync(env.PI_ORCH_MODE_FILE!);
	mkdirSync(env.PI_ORCH_MESSAGES_DIR!, { recursive: true });
	assert.equal(isOrchestrated(env, join(dir, "repos", "Studio", "Source")), true);
	assert.equal(isOrchestrated(env, join(dir, "repos")), true);
	assert.equal(isOrchestrated(env, join(dir, "repos-other")), false);
	assert.equal(isOrchestrated(env, undefined), false);
});

test("orchLog appends JSON lines and never throws", () => {
	orchLog("cratis", "allow", "cratis chronicle observers replay", env);
	orchLog("wait", "allow", "x", env);
	const lines = readFileSync(env.PI_GUARD_DECISIONS_LOG!, "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.deepEqual(lines.map(l => [l.guard, l.decision]), [["cratis", "allow"], ["wait", "allow"]]);
	writeFileSync(join(dir, "file"), "");
	assert.doesNotThrow(() => orchLog("x", "y", "z", { ...env, PI_GUARD_DECISIONS_LOG: join(dir, "file", "sub", "log") }));
});

test("postAllNotice writes ALL-guard-<guard>-<HHMM>.md only when the board exists, never overwriting", () => {
	const at = new Date(2026, 9, 20, 3, 18);
	assert.equal(postAllNotice("cratis", "x", env, at), undefined);
	mkdirSync(env.PI_ORCH_MESSAGES_DIR!, { recursive: true });
	const first = postAllNotice("cratis", "hello", env, at)!;
	const second = postAllNotice("cratis", "again", env, at)!;
	assert.equal(first, join(env.PI_ORCH_MESSAGES_DIR!, "ALL-guard-cratis-0318.md"));
	assert.equal(second, join(env.PI_ORCH_MESSAGES_DIR!, "ALL-guard-cratis-0318-2.md"));
	assert.match(readFileSync(first, "utf8"), /hello/);
	assert.deepEqual(readdirSync(env.PI_ORCH_MESSAGES_DIR!).filter(f => f.endsWith(".tmp")), []);
});

test("boundedSelect passes a ≤60 s timeout and resolves even when the UI never answers", async () => {
	let seen: any;
	const hung = { select: (_t: string, _o: string[], opts?: any) => { seen = opts; return new Promise<string | undefined>(() => {}); } };
	const result = await boundedSelect(hung, "t", ["a"], 20);
	assert.deepEqual(result, { choice: undefined, timedOut: true });
	assert.equal(seen.timeout, 20);
	assert.equal(seen.signal.aborted, true);
	assert.deepEqual(await boundedSelect({ select: async () => "a" }, "t", ["a"], 1000), { choice: "a", timedOut: false });
	assert.deepEqual(await boundedSelect({ select: async () => undefined }, "t", ["a"], 5000), { choice: undefined, timedOut: false });
});

test("guardSelect timeout resolves to the default, logs it, and posts an ALL notice in orchestration only", async () => {
	const hung = { select: () => new Promise<string | undefined>(() => {}) };
	mkdirSync(env.PI_ORCH_MESSAGES_DIR!, { recursive: true });
	const outside = await guardSelect(hung, "cratis", "Run it?", ["No", "Yes"], "deny", { env, cwd: "/elsewhere", ms: 20 });
	assert.deepEqual(outside, { choice: undefined, timedOut: true });
	assert.deepEqual(readdirSync(env.PI_ORCH_MESSAGES_DIR!), []);
	const inside = await guardSelect(hung, "cratis", "Run it?", ["No", "Yes"], "deny", { env: { ...env, PI_ORCH_ID: "L0" }, ms: 20 });
	assert.equal(inside.timedOut, true);
	const notices = readdirSync(env.PI_ORCH_MESSAGES_DIR!);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /^ALL-guard-cratis-\d{4}\.md$/);
	assert.match(readFileSync(join(env.PI_ORCH_MESSAGES_DIR!, notices[0]), "utf8"), /resolved to: deny[\s\S]*Run it\?/);
	assert.equal(readFileSync(env.PI_GUARD_DECISIONS_LOG!, "utf8").trim().split("\n").length, 2);
});
