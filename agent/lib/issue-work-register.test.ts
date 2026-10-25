/** Offline register queries, delivery-aware claims and extension dispatch. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendEvent, claim, list, owner, readEvents, update, writeLease,
	type Deps, type RegistryEvent, type Runner, type SessionInfo,
} from "./issue-work.ts";
import { parseIssueRefs } from "./issue-work-register.ts";
import issueWorkExtension from "../extensions/issue-work.ts";

let dir: string;
let calls: { cmd: string; args: string[] }[];
let issueBody: string;
const now = "2026-10-08T12:00:00.000Z";
const alivePids = new Set<number>();
const psFails = new Set<number>();
const ev = (over: Partial<RegistryEvent>): RegistryEvent => ({ ts: "2026-10-08T10:00:00.000Z", repo: "o/r", issue: 1, sessionId: "s1", source: "tool", ...over });

function apiReply(path: string): string {
	if (path === "user") return "woksin\n";
	if (path.endsWith("/comments")) return "[[]]";
	return JSON.stringify({ user: { login: "opener" }, author_association: "OWNER", labels: [] });
}

const fakeRun: Runner = async (cmd, args) => {
	calls.push({ cmd, args });
	if (cmd === "python3") return { stdout: "Updated status block.", stderr: "" };
	if (args[0] === "api") return { stdout: apiReply(args[1]), stderr: "" };
	if (args[1] === "edit") return { stdout: "", stderr: "" };
	return { stdout: JSON.stringify({ title: "Title", url: `https://github.com/${args[4]}/issues/${args[2]}`, state: "OPEN", body: issueBody, labels: [], assignees: [], comments: [], updatedAt: now }), stderr: "" };
};

const deps = (): Deps => ({ dataDir: dir, run: fakeRun, statusScript: "/fake/issue-status.py", now: () => new Date(now), isPidAlive: (p) => alivePids.has(p),
	procStartTime: async (p) => psFails.has(p) ? undefined : `start-${p}`, lock: async () => async () => {} });
const session = (id = "me", pid = 111, branch = "feat/x"): SessionInfo => ({ sessionId: id, cwd: "/repo", branch, pid, model: "m" });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-work-register-test-"));
	calls = []; issueBody = "Body";
	alivePids.clear(); psFails.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const daysAgo = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
const queryOwner = (issue = 5, days?: number, ownSessionId?: string) => owner(deps(), { refs: [{ repo: "o/r", issue }], days, ownSessionId });

for (const row of [
	{ name: "no entry", verdict: "FREE", reason: /no register entry/ },
	{ name: "review", state: "in-review", age: 3, verdict: "OWNED", reason: /other.*In review/ },
	{ name: "done", state: "done", age: 2, verdict: "OWNED", reason: /other.*Done/ },
	{ name: "delivered note", state: "in-progress", age: 3, note: "Code delivered to L15", verdict: "OWNED", reason: /delivered or in review/ },
	{ name: "ended progress", state: "in-progress", age: 3, verdict: "OWNED", reason: /ended session other/ },
	{ name: "ended blocked", state: "blocked", age: 3, verdict: "OWNED", reason: /ended session other/ },
	{ name: "recent pause", state: "paused", age: 2 / 24, verdict: "OWNED", reason: /under 24 h/ },
	{ name: "old pause", state: "paused", age: 2, verdict: "FREE", reason: /no live holder/ },
	{ name: "old review", state: "in-review", age: 20, verdict: "FREE", reason: /no live holder/ },
	{ name: "old progress", state: "in-progress", age: 20, verdict: "FREE", reason: /no live holder/ },
] as const) {
	test(`owner verdict: ${row.name}`, async () => {
		if ("state" in row) await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state: row.state, ts: daysAgo(row.age), branch: "b2", cwd: "/repo", note: "note" in row ? row.note : "latest note" }));
		const result = await queryOwner();
		assert.equal(result.results[0].verdict, row.verdict);
		assert.match(result.results[0].reason, row.reason);
		if ("state" in row) {
			assert.match(result.text, /latest: .*branch: b2 \| note:/);
			if (row.age < 14) assert.match(result.text, /sessions \(14d\): other ended\//);
			else assert.doesNotMatch(result.text, /sessions/);
		}
		assert.equal(calls.length, 0);
		assert.equal(existsSync(join(dir, "seen")), false);
	});
}

for (const unknown of [false, true]) {
	test(`owner reports ${unknown ? "unverifiable" : "live"} holders and own session`, async () => {
		alivePids.add(222);
		await writeLease(deps(), session("abcdefgh-session", 222));
		await appendEvent(deps(), ev({ issue: 5, sessionId: "abcdefgh-session", state: "in-progress" }));
		if (unknown) psFails.add(222);
		const result = await queryOwner(5, undefined, "abcdefgh-session");
		assert.equal(result.results[0].verdict, "OWNED");
		assert.match(result.text, unknown ? /liveness cannot be verified/ : /held by live session abcdefgh/);
		assert.match(result.text, /abcdefgh \(this session\)/);
		assert.equal(calls.length, 0);
	});
}

test("owner marks a claim queried by its delegating session", async (t) => {
	const s = session("abcdefgh-delegating", 222);
	alivePids.add(s.pid);
	await writeLease(deps(), s);
	await claim(deps(), s, { repo: "o/r", issue: 5 });
	calls = [];
	const result = await queryOwner(5, undefined, s.sessionId);
	assert.match(result.text, /held by live session abcdefgh.*\(this session\)/);
	assert.match(result.text, /abcdefgh \(this session\) live\/in-progress/);
	assert.equal(calls.length, 0);
	t.diagnostic(result.text);
});

test("owner uses latest session state and note, and clamps the window", async () => {
	await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state: "in-review", note: "delivered", ts: daysAgo(3) }));
	await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state: "paused", note: "not delivered", ts: daysAgo(2) }));
	assert.equal((await queryOwner()).results[0].verdict, "FREE");
	await appendEvent(deps(), ev({ issue: 6, sessionId: "other", state: "in-review", ts: daysAgo(2) }));
	assert.equal((await queryOwner(6, 0)).results[0].verdict, "FREE");
	assert.equal((await queryOwner(6, 100)).results[0].verdict, "OWNED");
	assert.match((await queryOwner(6, 100)).text, /sessions \(90d\)/);
});

test("owner parses, deduplicates and orders issue refs without side effects", async () => {
	const refs = parseIssueRefs([5, "5", "#5", "o/r#5", "O/R#5", "https://github.com/o/r/issues/5", "o/r#6", 7], "o/r");
	assert.deepEqual(refs, [{ repo: "o/r", issue: 5 }, { repo: "o/r", issue: 6 }, { repo: "o/r", issue: 7 }]);
	const result = await owner(deps(), { refs });
	assert.deepEqual(result.results.map((r) => r.issue), [5, 6, 7]);
	assert.match(result.text, /o\/r#5: FREE.*\no\/r#6: FREE.*\no\/r#7: FREE/);
	for (const ref of ["x", "o/r#0", "https://github.com/o/r/pull/5", 0, 1.5]) assert.throws(() => parseIssueRefs([ref], "o/r"), /issue refs must be/);
	assert.throws(() => parseIssueRefs([5]), /repo/);
	assert.throws(() => parseIssueRefs(Array(51).fill(5), "o/r"), /at most 50 issues/);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(join(dir, "seen")), false);
	assert.equal(existsSync(join(dir, "cache.json")), false);
});

test("list filters repo, state and free while preserving the default output", async () => {
	for (const [issue, repo, state, age] of [[1, "o/r", "paused", 2], [2, "else/repo", "paused", 2], [3, "o/r", "in-review", 3], [4, "o/r", "done", 2]] as const)
		await appendEvent(deps(), ev({ issue, repo, state, ts: daysAgo(age) }));
	assert.equal(await list(deps(), { fetch: false }), await list(deps(), { fetch: false, free: false }));
	assert.doesNotMatch(await list(deps(), { fetch: false, repo: "O/R" }), /else\/repo/);
	assert.doesNotMatch(await list(deps(), { fetch: false, state: "paused" }), /In review|Done/);
	assert.match(await list(deps(), { fetch: false, state: "done" }), /o\/r#4 \[Done\]/);
	const free = await list(deps(), { fetch: false, free: true });
	assert.match(free, /o\/r#1 \[Paused\]/);
	assert.match(free, /  free: latest Paused/);
	assert.doesNotMatch(free, /o\/r#3|o\/r#4/);
	// An explicit done filter bypasses both implicit done and free exclusions.
	assert.match(await list(deps(), { fetch: false, state: "done", free: true }), /o\/r#4 \[Done\]/);
});

for (const state of ["in-review", "done", "in-progress"] as const) {
	test(`claim refuses recent ${state} delivery before GitHub, even with force`, async () => {
		await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state, ts: daysAgo(3), note: state === "in-progress" ? "delivered to R-CHR" : "ready", branch: "b2" }));
		for (const force of [false, true]) await assert.rejects(claim(deps(), session(), { repo: "o/r", issue: 5, force }), /(?:In review|Done|delivered).*other.*takeover: true/s);
		assert.equal(calls.length, 0);
		const text = await claim(deps(), session(), { repo: "o/r", issue: 5, takeover: true });
		assert.match(text, /Took over from other/);
		assert.equal((await readEvents(deps())).at(-1)!.sessionId, "me");
	});
}

test("takeover bypasses a status block only when a delivery entry exists", async () => {
	issueBody = "Body\n<!-- agent-status:start -->\n## Status\n**State:** In review\n**Branch:** b2\n<!-- agent-status:end -->";
	await assert.rejects(claim(deps(), session(), { repo: "o/r", issue: 5, takeover: true }), /force: true/);
	await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state: "in-review", ts: daysAgo(3) }));
	assert.match(await claim(deps(), session(), { repo: "o/r", issue: 5, takeover: true }), /Took over from other/);
});

for (const kind of ["own", "old", "superseded", "not delivered"] as const) {
	test(`claim permits ${kind} review or note`, async () => {
		await appendEvent(deps(), ev({ issue: 5, sessionId: kind === "own" ? "me" : "other", state: kind === "not delivered" ? "in-progress" : "in-review", ts: daysAgo(kind === "old" ? 15 : 3), note: kind === "not delivered" ? "not delivered" : undefined }));
		if (kind === "superseded") await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state: "paused", ts: daysAgo(2) }));
		assert.match(await claim(deps(), session(), { repo: "o/r", issue: 5 }), /Claimed o\/r#5/);
	});
}

test("done update still works with another session's recent review entry", async () => {
	await appendEvent(deps(), ev({ issue: 5, sessionId: "other", state: "in-review", ts: daysAgo(3) }));
	assert.match(await update(deps(), session(), { repo: "o/r", issue: 5, state: "done" }), /Updated o\/r#5 to Done/);
	assert.match(await list(deps(), { fetch: false, state: "done", free: true }), /o\/r#5 \[Done\]/);
});

test("extension exposes read-only owner to subagents and register-first guidance", async () => {
	let tool: any;
	const handlers = new Map<string, any>();
	const pi: any = { registerTool: (t: any) => { tool = t; }, registerCommand: () => {}, on: (e: string, h: any) => handlers.set(e, h) };
	const git: Runner = async (_c, args) => ({ stdout: args.includes("branch") ? "b\n" : "git@github.com:o/r.git\n", stderr: "" });
	issueWorkExtension(pi, { deps: deps(), git });
	const ctx: any = { hasUI: false, cwd: "/repo", sessionManager: { getSessionId: () => "sub", getSessionFile: () => undefined } };
	assert.ok(tool.parameters.properties.action.enum.includes("owner"));
	for (const key of ["issues", "free", "days", "takeover"]) assert.ok(tool.parameters.properties[key]);
	assert.match(tool.description, /authoritative local register/i);
	const result = await tool.execute("id", { action: "owner", issues: ["5", "o/r#6"] }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /o\/r#5: FREE.*\no\/r#6: FREE/);
	assert.deepEqual(result.details.results, [5, 6].map((issue) => ({ repo: "o/r", issue, verdict: "FREE", reason: "no register entry" })));
	assert.match((await tool.execute("id", { action: "owner", issue: 7 }, undefined, undefined, ctx)).content[0].text, /o\/r#7/);
	await assert.rejects(tool.execute("id", { action: "owner" }, undefined, undefined, ctx), /owner needs issue or issues/);
	assert.deepEqual(await readEvents(deps()), []);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(join(dir, "seen")), false);
	const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
	handlers.get("before_agent_start")(prompt, { ...ctx, hasUI: true });
	assert.match(prompt.systemPromptOptions.sections.issue_work_guidance, /issue_work owner/);
});
