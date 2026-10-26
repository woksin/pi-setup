/** New publication coverage only; legacy issue lifecycle specs remain unchanged. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { claim, detectIssueCommands, detectPublicationIssues, readEvents, recordDetected, update } from "./issue-work.ts";
import type { Deps, Runner, SessionInfo } from "./issue-work.ts";
import issueWorkExtension from "../extensions/issue-work.ts";

interface Fixture {
	deps: Deps; calls: { cmd: string; args: string[] }[];
	body: string; state: string; assignees: { login: string }[];
}
const now = "2026-10-08T12:00:00.000Z";
const session = (): SessionInfo => ({ sessionId: "me", cwd: "/repo", branch: "feat/x", pid: 111, model: "m" });
function issueView(f: Fixture): string {
	return JSON.stringify({ title: "Title", url: "https://github.com/o/r/issues/5", state: f.state,
		body: f.body, labels: [], assignees: f.assignees, comments: [], updatedAt: now });
}
function apiResponse(endpoint: string): string {
	if (endpoint === "user") return "fixture-user\n";
	if (endpoint.endsWith("/comments")) return "[]";
	return JSON.stringify({ user: { login: "opener" }, author_association: "OWNER", labels: [] });
}
function githubResponse(f: Fixture, args: string[]): string {
	if (args[0] === "api") return apiResponse(args[1]);
	if (args[1] === "view") return issueView(f);
	if (args[1] === "edit") { f.assignees = [{ login: "fixture-user" }]; return ""; }
	throw new Error("unexpected-fixture-call");
}
function fixture(t: TestContext): Fixture {
	const root = mkdtempSync(join(tmpdir(), "issue-publication-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const f: Fixture = { body: "Body", state: "OPEN", assignees: [], calls: [], deps: {
		dataDir: root, statusScript: "/fake/issue-status.py", now: () => new Date(now),
		isPidAlive: () => false, procStartTime: async () => undefined,
		lock: async () => async () => {}, findPlan: async () => undefined,
		run: async (cmd, args) => {
			f.calls.push({ cmd, args });
			if (cmd === "python3") return { stdout: "Updated status block.", stderr: "" };
			if (cmd === "gh") return { stdout: githubResponse(f, args), stderr: "" };
			throw new Error("unexpected-fixture-call");
		},
	} };
	return f;
}

test("claim/update refuse raw new outbound note, plan, branch and PR before assignment or any runner call", async t => {
	const f = fixture(t);
	for (const source of ["note", "plan", "branch", "pr"]) {
		const value = source === "pr" ? "https://github.com/o/r/pull/1?path=/Users/alice/private-value" : "https://example.invalid/?path=/Users/alice/private-value";
		const s = source === "branch" ? { ...session(), branch: value } : session();
		const fields = source === "branch" ? {} : { [source]: value };
		const actions = source === "pr" ? ["update"] : ["claim", "update"];
		for (const action of actions) {
			const promise = action === "claim" ? claim(f.deps, s, { repo: "o/r", issue: 5, ...fields }) : update(f.deps, s, { repo: "o/r", issue: 5, state: "paused", ...fields });
			await assert.rejects(promise, error => {
				assert.match((error as Error).message, /issue_work publication: scan-refused/);
				assert.ok(!(error as Error).message.includes("private-value")); return true;
			});
		}
	}
	assert.deepEqual(f.calls, []);
});

test("only new issue fields are scanned, not fetched legacy public text", async t => {
	const f = fixture(t); f.body = "Legacy public body /Users/alice/private-value";
	assert.match(await claim(f.deps, session(), { repo: "o/r", issue: 5, note: "Safe new note", plan: "Safe plan" }), /Claimed/);
	assert.ok(f.calls.some(call => call.cmd === "python3"));
});

test("typed and CLI issue closes reuse touch and actual closed-state confirmation", async t => {
	const f = fixture(t), request = { kind: "issue-close", repo: "o/r", number: 3, body: "Done" };
	assert.deepEqual(detectPublicationIssues(request), [{ repo: "o/r", issue: 3, verb: "close", state: "done" }]);
	assert.deepEqual(detectIssueCommands("/trusted/pi-publish issue-close --repo o/r --number 3 --body Done"), detectPublicationIssues(request));
	assert.deepEqual(detectIssueCommands("false || pi-publish issue-close --repo o/r --number 3"), []);
	assert.deepEqual(detectIssueCommands("pi-publish --help issue-close --repo o/r --number 3"), []);
	assert.deepEqual(detectPublicationIssues({ ...request, unknown: true }), []);
	await (await recordDetected(f.deps, session(), request, undefined)).confirm;
	assert.ok(!(await readEvents(f.deps)).some(event => event.state === "done"));
	f.state = "CLOSED";
	await (await recordDetected(f.deps, session(), "pi-publish issue-close --repo o/r --number 3", undefined)).confirm;
	assert.ok((await readEvents(f.deps)).some(event => event.state === "done"));
});

test("extension records only published structured results or successful CLI issue touches", async t => {
	const f = fixture(t), handlers = new Map<string, any>(), background: Promise<void>[] = [];
	const pi: any = { registerTool: () => {}, registerCommand: () => {}, on: (name: string, handler: any) => handlers.set(name, handler), sendMessage: () => {} };
	const git: Runner = async (_command, args) => ({ stdout: args.includes("branch") ? "feat/x\n" : "git@github.com:o/r.git\n", stderr: "" });
	issueWorkExtension(pi, { deps: f.deps, git, onBackground: work => background.push(work) });
	const ctx: any = { hasUI: true, cwd: "/repo", sessionManager: { getSessionId: () => "main", getSessionFile: () => undefined }, ui: { setStatus: () => {}, notify: () => {} } };
	const event = { toolName: "publish", input: { kind: "issue-close", repo: "o/r", number: 3 }, details: { code: "published" }, isError: false };
	await handlers.get("tool_result")({ ...event, isError: true }, ctx);
	await handlers.get("tool_result")({ ...event, details: { code: "gh-failed" } }, ctx);
	await handlers.get("tool_result")({ ...event, details: {} }, ctx);
	await handlers.get("tool_result")(event, { ...ctx, hasUI: false });
	assert.deepEqual(await readEvents(f.deps), []);
	await handlers.get("tool_result")(event, ctx); await Promise.all(background);
	assert.ok(!(await readEvents(f.deps)).some(entry => entry.state === "done"));
	f.state = "CLOSED";
	await handlers.get("tool_result")({ toolName: "bash", input: { command: "pi-publish issue-close --repo o/r --number 4" }, isError: false }, ctx);
	await Promise.all(background);
	const events = await readEvents(f.deps);
	assert.equal(events.filter(entry => entry.issue === 3).length, 1);
	assert.ok(events.some(entry => entry.issue === 4 && entry.state === "done"));
});
