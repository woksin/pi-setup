import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACTIONS, acknowledge, assessCommand, emptyPolicy, identity, loadPolicy, mutate, mcpReason, policyContext, policyFile, policyPath, savePolicy, validatePolicy, type Policy, type Context } from "./lane-policy.ts";
import laneExtension from "../extensions/lane-policy.ts";
import guardsExtension from "../extensions/guards.ts";
import { setGuards } from "./guards.ts";

// Fresh fixtures stay under .ai-work; never point tests at the operator's policy or repositories.
const scratch = resolve(".ai-work/pi-lane-policy");
let home: string, repo: string, outside: string, oldHome: string | undefined, oldGuards: string | undefined, oldEnv: string | undefined;
let ctx: Context;
let policy: Policy;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(() => {
	mkdirSync(scratch, { recursive: true });
	home = mkdtempSync(join(scratch, "fixture-"));
	oldHome = process.env.HOME; process.env.HOME = home;
	oldGuards = process.env.PI_GUARDS_FILE; process.env.PI_GUARDS_FILE = join(home, "guards.json");
	oldEnv = process.env.PI_GUARDS_OFF; delete process.env.PI_GUARDS_OFF;
	delete (globalThis as any)[Symbol.for("pi.guards")];
	repo = join(home, "repo"); outside = join(home, "outside"); mkdirSync(repo); mkdirSync(outside);
	git(repo, "init", "-b", "lane");
	git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
	git(repo, "remote", "add", "origin", "git@github.com:Cratis/Studio.git");
	ctx = { cwd: repo, session: "writer-session" };
	policy = emptyPolicy(); policy.revision = 1;
	policy.repositories.push({ common: identity(repo)!.common, slug: "Cratis/Studio", coordinator: "coordinator-session", bindings: [{ session: ctx.session, lane: "lane-one", branch: "lane", actions: [...ACTIONS] }], writers: [{ session: ctx.session, branch: "lane", actions: [...ACTIONS] }], grants: [] });
});
afterEach(() => {
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	if (oldGuards === undefined) delete process.env.PI_GUARDS_FILE; else process.env.PI_GUARDS_FILE = oldGuards;
	if (oldEnv === undefined) delete process.env.PI_GUARDS_OFF; else process.env.PI_GUARDS_OFF = oldEnv;
	delete (globalThis as any)[Symbol.for("pi.guards")];
});
function store() { mkdirSync(join(home, ".pi/agent/lane-policy"), { recursive: true }); writeFileSync(policyPath(), JSON.stringify(policy)); }
function grant(action: any = "push", target = "lane") { policy.repositories[0].grants.push({ session: ctx.session, action, target, expires: Date.now() + 60000, revision: policy.revision }); }
function denied(command: string, context = ctx) { assert.ok(assessCommand(command, context), command); }
function allowed(command: string, context = ctx) { assert.equal(assessCommand(command, context), undefined, command); }
function fake(context = ctx, mode = "tui") {
	const commands = new Map<string, any>(), handlers = new Map<string, Function[]>(), listeners = new Map<string, Function[]>();
	const notices: string[] = [], statuses: { key: string; text: string | undefined }[] = [];
	let confirmation = true, confirms = 0;
	const extCtx: any = { ...context, mode, hasUI: mode === "tui", sessionManager: { getSessionId: () => context.session }, ui: { notify: (s: string) => notices.push(s), setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }), confirm: async () => { confirms++; return confirmation; } } };
	const pi: any = {
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: { on: (name: string, fn: Function) => listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
	};
	return { pi, extCtx, notices, statuses, commands, listeners, get confirms() { return confirms; }, decline: () => { confirmation = false; },
		fire: async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) { const value = await fn(event, extCtx); if (value) return value; } },
		command: (text: string) => commands.get("lane-policy").handler(text, extCtx),
	};
}

test("missing policy is dormant, including unrelated opaque workflows", () => {
	assert.equal(loadPolicy().policy?.repositories.length, 0);
	assert.deepEqual(loadPolicy().policy?.forbidden, []);
	allowed("git push origin main"); allowed("gh api graphql -f query=mutation"); allowed("python custom.py");
	assert.equal(mcpReason(ctx, "github_create_issue"), undefined);
});
test("push needs binding, exact writer and fresh explicit grant", () => {
	store(); denied("git push origin lane:lane"); grant(); store(); allowed("git push origin lane:lane");
	denied("git push origin lane:lane", { ...ctx, session: "unbound" });
	policy.repositories[0].writers = []; store(); denied("git push origin lane:lane");
	policy.repositories[0].writers = [{ session: ctx.session, branch: "lane", actions: ["push"] }];
	policy.repositories[0].grants[0].expires = Date.now() - 1; store(); denied("git push origin lane:lane");
});
test("dangerous/ambiguous refspecs cannot use an ordinary grant", () => {
	grant(); store();
	for (const command of ["git push", "git push origin", "git push --all origin", "git push --mirror origin", "git push --delete origin lane", "git push origin :lane", "git push origin +lane:lane", "git push origin lane:main", "git push origin lane:other", "git push origin lane:lane other:other", "git push origin lane:refs/tags/lane", "git push -f origin lane:lane"]) denied(command);
	allowed("git push --force-with-lease origin HEAD:lane");
});
test("worktrees and git -C resolve common repository without granting new sessions authority", () => {
	const wt = join(home, "worktree"); git(repo, "worktree", "add", "-b", "other", wt);
	assert.equal(identity(wt)?.common, identity(repo)?.common);
	grant(); store();
	denied(`git -C '${wt}' push origin other:other`, { cwd: outside, session: "other-session" });
	allowed(`git -C '${repo}' push origin lane:lane`, { ...ctx, cwd: outside });
	denied(`cd '${wt}' && git push origin other:other`, { cwd: outside, session: "new-child" });
	denied(`cd -P '${wt}' && git push origin other:other`, { cwd: outside, session: "new-child" });
});
test("branch changes and detached HEAD never create authority", () => {
	grant(); store(); git(repo, "switch", "-c", "another"); denied("git push origin HEAD:another");
	git(repo, "checkout", "--detach"); denied("git push origin HEAD:lane");
});
test("origin must resolve to precisely enrolled GitHub push URL", () => {
	grant(); store();
	git(repo, "remote", "set-url", "--push", "origin", "git@github.com:Other/Studio.git"); denied("git push origin lane:lane");
	git(repo, "remote", "set-url", "--push", "origin", "https://github.com/Cratis/Studio.git"); allowed("git push origin lane:lane");
	git(repo, "remote", "set-url", "--add", "--push", "origin", "git@github.com:Cratis/Studio.git"); denied("git push origin lane:lane");
});
test("GH operations enforce distinct grants and explicit repository identity", () => {
	store(); denied("gh pr create -R Cratis/Studio --head lane --title test");
	grant("pr-create"); store(); allowed("gh pr create -R Cratis/Studio --head lane --title test");
	denied("gh pr create --head lane --title test"); denied("gh pr create -R Other/Repo --head lane");
	denied("gh pr comment 123 -R Cratis/Studio --body test"); grant("pr-comment", "123"); store(); allowed("gh pr comment 123 -R Cratis/Studio --body test");
	denied("gh issue edit 123 -R Cratis/Studio --title test"); grant("issue-write", "123"); store(); allowed("gh issue edit 123 -R Cratis/Studio --title test");
	grant("pr-merge", "123"); store(); denied("gh pr merge 123 -R Cratis/Studio --merge");
});
test("explicitly configured forbidden targets stay denied even with grants", () => {
	policy.forbidden = ["Cratis/Studio/#42", "Cratis/Studio/#43"];
	grant("issue-write", "42"); grant("pr-comment", "43"); store();
	denied("gh issue close 42 -R Cratis/Studio"); denied("gh pr comment 43 -R Cratis/Studio --body hi");
	assert.throws(() => mutate(policy, ["grant", ctx.session, "issue-write", "42", "5", "minutes"], { ...ctx, session: "coordinator-session" }, identity(repo)!), /Forbidden/);
});
test("ordinary execution is allowed; lexical publication stays scoped through wrappers", () => {
	store();
	for (const session of [ctx.session, "unbound-child"]) {
		const child = { ...ctx, session };
		for (const command of ["dotnet build", "dotnet test", "yarn lint", "npm test", "node script.js", "python -c 'build()'", "bash build.sh", "sh -c 'dotnet build'", "pi-phase run --kind build -- dotnet build", "env CI=true npm test", "cd $WORK && dotnet build", "git -c safe.directory='*' status", "rg --pre './filter.sh' pattern file", "gh api repos/Cratis/Studio -X GET"]) allowed(command, child);
		for (const command of ["sh -c 'git push origin lane:lane'", "eval 'git push origin lane:lane'", "node -e 'exec(\"git push origin lane:lane\")'", "python -c 'pr create'", "gh api repos/Cratis/Studio/issues/123 -X PATCH", "gh api graphql -f query=mutation"]) denied(command, child);
	}
	grant(); store(); allowed("bash -c 'git push origin lane:lane'"); allowed("eval 'git push origin lane:lane'");
	for (const command of ["env GIT_CONFIG_COUNT=1 git push origin lane:lane", "GH_HOST=elsewhere gh pr create -R Cratis/Studio", "$(printf git) push origin lane:lane", "git -c alias.ship=push ship", "sh -c 'git push origin lane:main'", "git rebase -x 'git push origin lane:lane' main", "git fetch --upload-pack='git push origin lane:lane' origin", "printf 'git push origin lane:lane' | bash", "printf 'git push origin lane:lane' | /bin/sh"]) denied(command);
});
test("read-only commands and unenrolled repositories retain existing behavior", () => {
	store(); allowed("git status && gh pr view 123 -R Cratis/Studio"); allowed("printf hello");
	allowed("python other.py", { cwd: outside, session: "unenrolled-session" });
	assert.equal(mcpReason({ cwd: outside, session: "unenrolled-session" }, "github_create_issue"), undefined);
	assert.ok(mcpReason({ ...ctx, cwd: outside }, "github_create_issue"));
	git(outside, "init", "-b", "unrelated");
	denied("gh api repos/Cratis/Studio/issues/123 -X PATCH", { cwd: outside, session: "unbound" });
	allowed("gh pr view 123 -R Cratis/Studio", { cwd: outside, session: "unbound" });
});
test("malformed, duplicate and unreadable policy fails closed", () => {
	store(); writeFileSync(policyPath(), "{invalid"); denied("git push origin lane:lane"); assert.ok(mcpReason(ctx, "github_create_issue"));
	assert.throws(() => savePolicy(policy, "{}"), /unreadable/);
	store(); policy.repositories[0].bindings.push({ ...policy.repositories[0].bindings[0] });
	assert.throws(() => validatePolicy(policy), /duplicate/);
});
test("atomic persistence detects concurrent change and occupied lock without stealing it", () => {
	const expected = JSON.stringify(loadPolicy().policy); savePolicy(policy, expected);
	assert.deepEqual(loadPolicy().policy, policy);
	assert.throws(() => savePolicy(emptyPolicy(), expected), /changed/);
	writeFileSync(`${policyPath()}.lock`, "someone else");
	assert.throws(() => savePolicy(policy, JSON.stringify(policy)), /EEXIST/);
	assert.equal(readFileSync(`${policyPath()}.lock`, "utf8"), "someone else");
});
test("canonical policy paths and source files cannot be model-written", async () => {
	store(); const alias = join(home, "alias"); symlinkSync(join(home, ".pi/agent/lane-policy"), alias);
	assert.equal(policyFile(join(alias, "policy.json"), outside), true);
	const f = fake(); laneExtension(f.pi);
	for (const path of [policyPath(), join(alias, "policy.json"), join(home, ".pi/agent/lib/lane-policy.ts"), join(home, ".pi/agent/extensions/guards.ts")]) {
		assert.ok((await f.fire("tool_call", { toolName: "write", input: { path, content: "{}" } }))?.block);
	}
	denied(`printf '{}' > '${policyPath()}'`);
	assert.equal(await f.fire("tool_call", { toolName: "write", input: { path: join(repo, "ordinary.ts"), content: "ok" } }), undefined);
});
test("no model-facing mutation tool; command requires coordinator, TUI and confirmation", async () => {
	store(); const nonCoordinator = fake(); laneExtension(nonCoordinator.pi);
	assert.deepEqual([...nonCoordinator.commands.keys()], ["lane-policy"]);
	await nonCoordinator.command("revoke writer writer-session"); assert.match(nonCoordinator.notices.at(-1)!, /Only/); assert.equal(nonCoordinator.confirms, 0);
	await nonCoordinator.command("revoke writer writer-session --override"); assert.equal(nonCoordinator.confirms, 1); assert.equal(loadPolicy().policy?.repositories[0].writers.length, 0);
	const rpc = fake({ ...ctx, session: "coordinator-session" }, "rpc"); laneExtension(rpc.pi);
	const errors = console.error; console.error = (message: string) => rpc.notices.push(message);
	try { await rpc.command("revoke session writer-session"); } finally { console.error = errors; }
	assert.match(rpc.notices.at(-1)!, /interactive/); assert.equal(rpc.confirms, 0);
	const tui = fake({ ...ctx, session: "coordinator-session" }); laneExtension(tui.pi); tui.decline();
	await tui.command("revoke session writer-session"); assert.equal(loadPolicy().policy?.repositories[0].bindings.length, 1);
});
test("bootstrap is explicit, enrollment confers no writer/grant, conflicts need revocation", async () => {
	const f = fake(); laneExtension(f.pi); assert.equal(existsSync(policyPath()), false);
	await f.command("bootstrap Cratis/Studio"); assert.equal(f.confirms, 1);
	await f.command("enroll writer-session lane-one lane push");
	await f.command("writer writer-session lane push");
	await f.command("writer writer-session lane push"); assert.match(f.notices.at(-1)!, /already assigned/);
	assert.equal(loadPolicy().policy?.repositories[0].grants.length, 0);
	await f.command("grant writer-session push lane 5 minutes"); allowed("git push origin lane:lane");
	await f.command("revoke grants writer-session"); denied("git push origin lane:lane");
});
test("jobs use command assessment; delegation and unrelated MCP remain allowed", async () => {
	store(); const f = fake({ ...ctx, session: "unbound-child" }); laneExtension(f.pi);
	for (const toolName of ["mcp", "mcp_script", "execute", "codescene_code_health_review", "Agent", "SubagentWorkflow", "unknown_future_tool"]) assert.equal(await f.fire("tool_call", { toolName, input: { parentSessionId: ctx.session } }), undefined, toolName);
	for (const toolName of ["job_start", "job_watch"]) {
		assert.equal(await f.fire("tool_call", { toolName, input: { command: "dotnet build", check: "npm test" } }), undefined);
		assert.ok((await f.fire("tool_call", { toolName, input: { command: "git push origin lane:lane", check: "gh pr create -R Cratis/Studio --head lane" } }))?.block);
	}
	assert.ok((await f.fire("tool_call", { toolName: "bash", input: { command: "gh pr create -R Cratis/Studio --head lane" } }))?.block);
	assert.ok((await f.fire("tool_call", { toolName: "mcp", input: { server: "github", tool: "create_issue", repository: "Cratis/Studio" } }))?.block);
	assert.equal(await f.fire("tool_call", { toolName: "mcp", input: { server: "github", tool: "list_issues" } }), undefined);
	assert.equal(await f.fire("tool_call", { toolName: "mcp", input: { server: "codescene", tool: "set_config" } }), undefined);
});
test("/guards off mcp cannot auto-allow an enrolled scope at the broker", async () => {
	store(); const f = fake(); guardsExtension(f.pi); await f.fire("session_start"); setGuards(["mcp"], true);
	let decision: string | undefined;
	for (const fn of f.listeners.get("pi-mcp-adapter:tool-approval-request") ?? []) fn({ prefixedToolName: "github_update_issue", args: { issue: 659 }, claim: (handler: Function) => { decision = handler(); return true; } });
	assert.equal(decision, "deny");
});
test("relevant revocation is re-read on the next call, without a session reload", () => {
	grant(); store(); allowed("git push origin lane:lane");
	mutate(policy, ["revoke", "session", ctx.session], { ...ctx, session: "coordinator-session" }, identity(repo)!); store();
	denied("git push origin lane:lane"); assert.ok(mcpReason(ctx, "github_create_issue"));
});

test("attached, spaced and repeated Git -C share attribution; unresolved global targets fail closed", () => {
	grant(); store();
	const unbound = { cwd: outside, session: "unknown-lane" };
	for (const prefix of [`git -C'${repo}'`, `git -C '${repo}'`, `git -C'${home}' -Crepo`, `git --no-pager -C'${repo}'`]) {
		denied(`${prefix} push origin main:main`, unbound);
		denied(`${prefix} push origin lane:lane`, unbound);
		allowed(`${prefix} push origin lane:lane`, { ...ctx, cwd: outside });
	}
	for (const prefix of [`git --git-dir='${repo}/.git'`, `git --work-tree='${repo}'`, "git -C", "git -C'$TARGET'", `git -C'${home}/missing'`, "git -c alias.ship=push"]) denied(`${prefix} push origin main:main`, unbound);
	denied(`GIT_DIR='${repo}/.git' git push origin main:main`, unbound);
	denied("GH_REPO=Cratis/Studio gh api graphql -f query=mutation", unbound);
	allowed("printf 'git -C/ignored gh api repos/Cratis/Studio'", unbound);
});

test("authority revisions invalidate old grants; durable ACK never revives or gates authority", () => {
	grant(); store();
	const id = identity(repo)!;
	const expected = JSON.stringify(policy);
	acknowledge(policy, ctx, id, 1); savePolicy(policy, expected);
	assert.equal(policy.revision, 1); allowed("git push origin lane:lane");
	let previous = JSON.stringify(policy);
	mutate(policy, ["forbid", "Other/Repo/#5"], { ...ctx, session: "coordinator-session" }, id);
	savePolicy(policy, previous);
	assert.equal(policy.revision, 2); assert.equal(policy.repositories[0].grants[0].revision, 1);
	denied("git push origin lane:lane"); assert.match(policyContext(ctx)!, /ACK=stale r1/);
	previous = JSON.stringify(policy); acknowledge(policy, ctx, id, 2); savePolicy(policy, previous);
	denied("git push origin lane:lane");
	previous = JSON.stringify(policy);
	mutate(policy, ["grant", ctx.session, "push", "lane", "5", "minutes"], { ...ctx, session: "coordinator-session" }, id);
	savePolicy(policy, previous);
	assert.equal(loadPolicy().policy?.revision, 3);
	assert.match(policyContext(ctx)!, /ACK=stale r2/); allowed("git push origin lane:lane");
	assert.throws(() => acknowledge(policy, ctx, id, 2), /current/);
	assert.throws(() => acknowledge(policy, { ...ctx, session: "unbound" }, id, 3), /bound/);
});

test("persistence rejects unchanged/reversed authority revisions and stale concurrent ACK writes", async () => {
	store(); const expected = JSON.stringify(policy);
	const changed = structuredClone(policy); changed.forbidden.push("Other/Repo/#7");
	assert.throws(() => savePolicy(changed, expected), /next policy revision/);
	changed.revision = 0; assert.throws(() => savePolicy(changed, expected), /next policy revision/);
	const f = fake(); laneExtension(f.pi);
	f.extCtx.ui.confirm = async () => {
		const latest = loadPolicy().policy!; const before = JSON.stringify(latest);
		mutate(latest, ["forbid", "Other/Repo/#8"], { ...ctx, session: "coordinator-session" }, identity(repo)!);
		savePolicy(latest, before); return true;
	};
	await f.command("ack 1");
	assert.match(f.notices.at(-1)!, /changed/);
	assert.equal(loadPolicy().policy?.revision, 2);
	assert.deepEqual(loadPolicy().policy?.acknowledgements, []);
});

test("adapter startup, confirmed ACK, restart and compaction expose latest durable revision", async () => {
	grant(); store(); const f = fake(); laneExtension(f.pi);
	await f.fire("session_start", { reason: "startup" });
	assert.match(f.statuses.at(-1)!.text!, /r1/);
	assert.match((await f.fire("before_agent_start", { systemPrompt: "base" })).systemPrompt, /ACK=missing/);
	await f.command("ack 0"); assert.match(f.notices.at(-1)!, /current/); assert.equal(f.confirms, 0);
	await f.command("ack 1"); assert.equal(f.confirms, 1);
	assert.deepEqual(loadPolicy().policy?.acknowledgements, [{ session: ctx.session, common: identity(repo)!.common, revision: 1 }]);
	const restarted = fake(); laneExtension(restarted.pi);
	await restarted.fire("session_start", { reason: "resume" });
	assert.match((await restarted.fire("before_agent_start", { systemPrompt: "base" })).systemPrompt, /ACK=current/);
	policy = loadPolicy().policy!;
	mutate(policy, ["forbid", "Other/Repo/#9"], { ...ctx, session: "coordinator-session" }, identity(repo)!); store();
	await restarted.fire("session_compact", {});
	assert.match(restarted.statuses.at(-1)!.text!, /r2/);
	const summary = (await restarted.fire("before_agent_start", { systemPrompt: "base after compaction" })).systemPrompt;
	assert.match(summary, /^base after compaction/); assert.match(summary, /r2/); assert.match(summary, /ACK=stale r1/);
	const deniedPush = await restarted.fire("tool_call", { toolName: "bash", input: { command: "git push origin lane:lane" } });
	assert.equal(deniedPush.block, true);
	await restarted.command("status"); assert.match(restarted.notices.at(-1)!, /"revision": 2/);
});

test("adapter ACK is not a model tool and requires bound actor, TUI and affirmative confirmation", async () => {
	store(); const f = fake(); laneExtension(f.pi); f.decline();
	await f.command("ack 1"); assert.deepEqual(loadPolicy().policy?.acknowledgements, []);
	assert.deepEqual([...f.commands.keys()], ["lane-policy"], "ACK is only registered as an operator command, not a tool");
	const unknown = fake({ ...ctx, session: "unknown" }); laneExtension(unknown.pi);
	await unknown.command("ack 1"); assert.match(unknown.notices.at(-1)!, /bound/); assert.equal(unknown.confirms, 0);
	const rpc = fake(ctx, "rpc"); laneExtension(rpc.pi);
	const report = console.error; console.error = (text: string) => rpc.notices.push(text);
	try { await rpc.command("ack 1"); } finally { console.error = report; }
	assert.match(rpc.notices.at(-1)!, /interactive/);
	assert.deepEqual(loadPolicy().policy?.acknowledgements, []);
});

test("adapter decisions cover direct commands, nested batch, explicit other repo and job targeting", async () => {
	grant(); store(); const writer = fake(); laneExtension(writer.pi);
	assert.equal(await writer.fire("tool_call", { toolName: "bash", input: { command: "git push origin lane:lane" } }), undefined);
	const child = fake({ cwd: outside, session: "new-child" }); laneExtension(child.pi);
	const push = { recipient_name: "functions.bash", parameters: { command: `git -C'${repo}' push origin lane:lane`, parentSessionId: ctx.session } };
	assert.equal((await child.fire("tool_call", { toolName: "multi_tool_use.parallel", input: { tool_uses: [push] } })).block, true);
	assert.equal(await writer.fire("tool_call", { toolName: "multi_tool_use.parallel", input: { tool_uses: [{ ...push, parameters: { command: "git push origin lane:lane" } }] } }), undefined);
	for (const toolName of ["job_start", "job_watch"]) {
		assert.equal((await child.fire("tool_call", { toolName, input: { command: push.parameters.command, check: push.parameters.command } })).block, true);
		assert.equal((await child.fire("tool_call", { toolName, input: { cwd: "../repo", command: "git push origin lane:lane" } })).block, true);
	}
	assert.equal((await writer.fire("tool_call", { toolName: "bash", input: { command: "gh pr create -R Other/Repo --head lane" } })).block, true);
	assert.equal(await writer.fire("tool_call", { toolName: "Agent", input: { parentSessionId: ctx.session } }), undefined);
	assert.equal((await writer.fire("user_bash", { command: "git push origin main:main" })).result.exitCode, 1);
	writeFileSync(policyPath(), "bad schema");
	assert.equal((await writer.fire("tool_call", { toolName: "bash", input: { command: "git push origin lane:lane" } })).block, true);
});

/** Mirrors the installed broker's synchronous first-claim contract, not its implementation. */
function broker(f: ReturnType<typeof fake>) {
	let accepting = true, chosen: Function | undefined;
	const attempts: boolean[] = [];
	const request = { prefixedToolName: "github_update_issue", args: { repository: "Cratis/Studio" }, claim: (handler: Function) => {
		assert.equal(accepting, true); const accepted = !chosen; attempts.push(accepted); if (accepted) chosen = handler; return accepted;
	} };
	for (const fn of f.listeners.get("pi-mcp-adapter:tool-approval-request") ?? []) fn(request);
	accepting = false;
	return { decision: chosen?.(), attempts };
}

test("operator lane-policy switch controls adapter and broker without bypassing the independent MCP guard", async () => {
	store(); const f = fake(); guardsExtension(f.pi); laneExtension(f.pi); await f.fire("session_start");
	const command = { toolName: "bash", input: { command: "git push origin main:main" } };
	assert.equal((await f.fire("tool_call", command)).block, true);
	await f.commands.get("guards").handler("off mcp", f.extCtx);
	assert.equal(broker(f).decision, "deny");
	await f.commands.get("guards").handler("off lane-policy", f.extCtx);
	assert.equal(await f.fire("tool_call", command), undefined);
	assert.equal(await f.fire("tool_call", { toolName: "Agent", input: {} }), undefined);
	assert.equal(await f.fire("tool_call", { toolName: "write", input: { path: policyPath(), content: "{}" } }), undefined);
	assert.equal(await f.fire("user_bash", { command: command.input.command }), undefined);
	assert.equal(broker(f).decision, "allow_once");
	assert.match((await f.fire("before_agent_start", { systemPrompt: "base" })).systemPrompt, /OFF by operator/);
	await f.commands.get("guards").handler("on mcp", f.extCtx);
	assert.equal(broker(f).decision, undefined);
	await f.commands.get("guards").handler("on lane-policy", f.extCtx);
	assert.equal((await f.fire("tool_call", command)).block, true);
	assert.equal(broker(f).decision, "deny");
});

test("broker denial claims synchronously before later bypass; an earlier claimant still needs outer tool denial", async () => {
	store(); const f = fake(); guardsExtension(f.pi); laneExtension(f.pi); await f.fire("session_start"); setGuards("mcp", true);
	f.pi.events.on("pi-mcp-adapter:tool-approval-request", (r: any) => r.claim(() => "allow_once"));
	assert.deepEqual(broker(f), { decision: "deny", attempts: [true, false] });
	const early = fake();
	early.pi.events.on("pi-mcp-adapter:tool-approval-request", (r: any) => r.claim(() => "allow_once"));
	guardsExtension(early.pi); laneExtension(early.pi); await early.fire("session_start");
	assert.deepEqual(broker(early), { decision: "allow_once", attempts: [true, false] });
	for (const toolName of ["mcp", "mcp_script", "execute", "github_update_issue"]) assert.equal((await early.fire("tool_call", { toolName, input: { server: "github", tool: "update_issue", repo: "Cratis/Studio" } })).block, true);
});

test("GitHub reads are allowed; every listed unsupported publication family is gated", () => {
	store();
	for (const command of ["gh pr view 123", "gh issue list", "gh release list", "gh workflow view build", "gh run watch 123", "gh api repos/Cratis/Studio -X GET", "git merge topic", "git rebase main", "git fetch origin", "git worktree list"]) allowed(command);
	for (const command of ["gh pr edit 123 -R Cratis/Studio", "gh pr close 123 -R Cratis/Studio", "gh pr review 123 -R Cratis/Studio", "gh issue delete 123 -R Cratis/Studio", "gh api repos/Cratis/Studio/issues -f title=test", "gh api repos/Cratis/Studio/issues -XPOST", "gh api graphql -f 'query=mutation { change }'", "gh release create v1", "gh workflow run build", "gh workflow disable build", "gh workflow enable build", "gh run rerun 123", "gh run cancel 123"]) denied(command);
	const merge = assessCommand("gh pr merge 123 -R Cratis/Studio", ctx)!;
	assert.match(merge, /r1/); assert.match(merge, /train writer\/operator/); assert.match(merge, /writer=lane-one/); assert.match(merge, /send branch\+SHA to lane-one/);
	const push = assessCommand("git push origin lane:lane", { ...ctx, session: "child" })!;
	assert.match(push, /r1/); assert.match(push, /writer=lane-one/); assert.match(push, /send branch\+SHA to lane-one/);
});

test("policy/source tampering is protected before enrollment but reading policy is allowed", async () => {
	const f = fake(); laneExtension(f.pi);
	assert.equal(loadPolicy().policy?.repositories.length, 0);
	assert.ok((await f.fire("tool_call", { toolName: "write", input: { path: policyPath(), content: "{}" } }))?.block);
	assert.match(assessCommand(`printf '{}' > '${policyPath()}'`, ctx)!, /r0/);
	allowed(`cat '${policyPath()}'`);
	assert.equal(await f.fire("tool_call", { toolName: "apply_patch", input: { patch: "*** Update File: ordinary.ts\n+ok" } }), undefined);
	assert.ok((await f.fire("tool_call", { toolName: "apply_patch", input: { patch: `*** Update File: ${policyPath()}\n+{}` } }))?.block);
});

test("malformed policy blocks publication and GitHub-write MCP but not everyday work", async () => {
	store(); writeFileSync(policyPath(), "bad");
	allowed("node build.js && dotnet test");
	denied("sh -c 'git push origin lane:lane'");
	assert.equal(mcpReason(ctx, "codescene_set_config", "codescene"), undefined);
	assert.ok(mcpReason(ctx, "github_create_issue", "github"));
	const f = fake(); laneExtension(f.pi);
	assert.equal(await f.fire("tool_call", { toolName: "Agent", input: { task: "ordinary work" } }), undefined);
});

test("broker allows non-GitHub MCP while retaining synchronous GitHub write denial", async () => {
	store(); const f = fake(); guardsExtension(f.pi); await f.fire("session_start"); setGuards("mcp", true);
	const handler = f.listeners.get("pi-mcp-adapter:tool-approval-request")![0];
	for (const [serverName, prefixedToolName, expected] of [["codescene", "codescene_set_config", "allow_once"], ["figma-desktop", "figma_add_code_connect_map", "allow_once"], ["github", "github_list_issues", "allow_once"], ["github", "github_create_issue", "deny"]]) {
		let decision: string | undefined;
		handler({ serverName, prefixedToolName, claim: (fn: Function) => { decision = fn(); return true; } });
		assert.equal(decision, expected);
	}
});

const round3Routes = [
	["gh pr alias", "gh pr new"],
	["gh issue alias", "gh issue new"],
	["gh pr branch mutation", "gh pr update-branch"],
	["gh repo mutation", "gh repo sync"],
	["gh alias setup", 'gh alias set pc "pr create"'],
	["REST file body", "gh api repos/Cratis/Studio/issues --input body.json"],
	["GraphQL file query", "gh api graphql -F query=@m.graphql"],
	["Git subtree publication", "git subtree push --prefix=src origin main"],
	["Git LFS publication", "git lfs push origin lane"],
	["Git send-pack", "git send-pack origin lane"],
	["Git alias setup", "git config alias.sync push"],
	["Git push URL setup", "git config remote.origin.pushurl https://github.com/Other/Repo.git"],
	["Git push URL rewrite", "git config url.https://github.com/Other/.pushInsteadOf https://github.com/Cratis/"],
] as const;
for (const [route, command] of round3Routes) test(`round3 structural publication gate: ${route}`, () => {
	grant(); store();
	const child = { ...ctx, session: "unbound-child" };
	assert.match(assessCommand(command, child)!, /Lane policy r1:/, command);
	denied(command, ctx); // A direct-push grant must not authorize alias/config/opaque publication routes.
});

test("GH read allowlist and ordinary Git remain available to unbound enrolled sessions", () => {
	store(); const child = { ...ctx, session: "unbound-child" };
	for (const command of ["gh pr view 123", "gh pr list", "gh pr checks 123", "gh issue view 123", "gh issue list", "gh run watch 123", "gh run list", "gh release view v1", "gh workflow list", "gh repo view", "gh repo list Cratis", "gh search prs ordinary", "gh auth status", "gh api repos/Cratis/Studio -X GET", "gh api --method=GET repos/Cratis/Studio", "gh -R Cratis/Studio pr view 123", "gh --repo=Cratis/Studio pr checks 123", "git stash push", "git commit -m ordinary", "git merge topic", "git fetch origin", "git rebase main", "git branch", "git worktree list", "git config --get alias.sync", "git config user.name", "dotnet build", "npm test", "node build.js"]) allowed(command, child);
});

test("GH unknown families and all GraphQL/body-carrying API calls default to publication", () => {
	store();
	for (const command of ["gh secret list", "gh variable list", "gh extension list", "gh alias list", "gh future view", "gh repo delete Other/Repo", "gh api repos/Cratis/Studio", "gh api repos/Cratis/Studio -X HEAD", "gh api repos/Cratis/Studio --input=body.json -X GET", "gh api repos/Cratis/Studio -X GET -f a=b", "gh api repos/Cratis/Studio -X GET -F a=@file", "gh api repos/Cratis/Studio -X GET --field a=b", "gh api repos/Cratis/Studio -X GET --raw-field=a=b", "gh api graphql -X GET", "gh api graphql -f 'query={viewer{login}}'", "gh -R Cratis/Studio api graphql -X GET", "sh -c 'gh pr new'", "node -e 'gh pr new'"]) denied(command, { ...ctx, session: "unbound-child" });
});

test("Git publication tokens/config writes are structural, with only exact stash push exempt", () => {
	grant(); store();
	for (const command of ["git http-push https://github.com/Cratis/Studio.git lane", "git stash push -m ordinary", "git commit -m push", "git arbitrary push", "git config alias.sync status", "git config alias.sync get", "git config alias.sync=status", "git config --global alias.pc 'pr create'", "git config --unset alias.sync", "git config set remote.origin.pushurl https://github.com/Other/Repo.git", "git -C . config alias.sync status", "git -calias.sync=status sync", "sh -c 'git lfs push origin lane'"]) denied(command);
	allowed("git stash push", { ...ctx, session: "unbound-child" });
});

test("guards.json model write/edit/shell protection applies before enrollment and through symlinks", async () => {
	const guard = join(home, ".pi/agent/guards.json");
	mkdirSync(join(home, ".pi/agent"), { recursive: true }); writeFileSync(guard, "{}");
	const alias = join(home, "guard-alias.json"); symlinkSync(guard, alias);
	const f = fake(); laneExtension(f.pi);
	for (const path of [guard, alias]) {
		assert.equal(policyFile(path, repo), true);
		for (const toolName of ["write", "edit"]) assert.ok((await f.fire("tool_call", { toolName, input: { path, content: "{}" } }))?.block);
		denied(`printf '{}' > '${path}'`);
		denied(`cp ordinary.json '${path}'`);
		denied(`ln -sf ordinary.json '${path}'`);
		denied(`dd if=ordinary.json of='${path}'`);
		denied(`curl --output '${path}' https://example.invalid/body`);
		allowed(`cat '${path}'`);
	}
	assert.equal(readFileSync(guard, "utf8"), "{}");
	store();
	assert.ok((await f.fire("tool_call", { toolName: "write", input: { path: guard, content: "{}" } }))?.block);
	denied(`rm '${guard}'`);
});
