import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACTIONS, acknowledge, assessCommand, emptyPolicy, identity, loadPolicy, mutate, opaqueReason, policyContext, policyFile, policyPath, savePolicy, validatePolicy, type Policy, type Context } from "./lane-policy.ts";
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
	assert.equal(opaqueReason(ctx), undefined);
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
test("gh api, graphql, wrappers and opaque executors fail closed when enrolled", () => {
	grant(); store();
	for (const command of ["gh api repos/Cratis/Studio/issues/123 -X PATCH", "gh api graphql -f query=mutation", "python -c 'publish()'", "node script.js", "bash script.sh", "env GIT_CONFIG_COUNT=1 git push origin lane:lane", "GH_HOST=elsewhere gh pr create -R Cratis/Studio", "eval 'git push origin lane:lane'", "$(printf git) push origin lane:lane", "git -c alias.ship=push ship"]) denied(command);
	denied("bash -c 'git push origin lane:lane'");
	denied("sed -n '1e git push origin main' file");
	denied("rg --pre './publish.sh' pattern file");
	denied("env --chdir=elsewhere git push origin lane:lane");
	denied("sh -c 'git push origin lane:main'");
});
test("read-only commands and unenrolled repositories retain existing behavior", () => {
	store(); allowed("git status && gh pr view 123 -R Cratis/Studio"); allowed("printf hello");
	allowed("python other.py", { cwd: outside, session: "unenrolled-session" });
	assert.equal(opaqueReason({ cwd: outside, session: "unenrolled-session" }), undefined);
	assert.ok(opaqueReason({ ...ctx, cwd: outside }));
	git(outside, "init", "-b", "unrelated");
	denied("gh api repos/Cratis/Studio/issues/123 -X PATCH", { cwd: outside, session: "unbound" });
	allowed("gh pr view 123 -R Cratis/Studio", { cwd: outside, session: "unbound" });
});
test("malformed, duplicate and unreadable policy fails closed", () => {
	store(); writeFileSync(policyPath(), "{invalid"); denied("git push origin lane:lane"); assert.ok(opaqueReason(ctx));
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
test("opaque tool routes and jobs fail before execution without inheriting parent authority", async () => {
	store(); const f = fake(); laneExtension(f.pi);
	for (const toolName of ["mcp", "mcp_script", "execute", "studio_issue_update", "Agent", "SubagentWorkflow", "job_start", "job_watch", "unknown_future_tool"]) {
		assert.ok((await f.fire("tool_call", { toolName, input: { command: "git push origin lane:lane", parentSessionId: ctx.session } }))?.block, toolName);
	}
	const other = fake({ cwd: outside, session: "unbound-child" }); laneExtension(other.pi);
	assert.ok((await other.fire("tool_call", { toolName: "job_start", input: { cwd: repo, command: "git push origin lane:lane" } }))?.block);
	assert.equal(await other.fire("tool_call", { toolName: "job_start", input: { cwd: outside, command: "printf hi" } }), undefined);
	assert.ok((await other.fire("tool_call", { toolName: "mcp", input: { repository: "Cratis/Studio", issue: 659 } }))?.block);
});
test("/guards off mcp cannot auto-allow an enrolled scope at the broker", async () => {
	store(); const f = fake(); guardsExtension(f.pi); await f.fire("session_start"); setGuards(["mcp"], true);
	let decision: string | undefined;
	for (const fn of f.listeners.get("pi-mcp-adapter:tool-approval-request") ?? []) fn({ prefixedToolName: "studio_update", args: { issue: 659 }, claim: (handler: Function) => { decision = handler(); return true; } });
	assert.equal(decision, "deny");
});
test("relevant revocation is re-read on the next call, without a session reload", () => {
	grant(); store(); allowed("git push origin lane:lane");
	mutate(policy, ["revoke", "session", ctx.session], { ...ctx, session: "coordinator-session" }, identity(repo)!); store();
	denied("git push origin lane:lane"); assert.ok(opaqueReason(ctx));
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
	assert.equal(await f.fire("tool_call", { toolName: "lane-policy", input: { command: "ack 1" } }).then(x => x?.block), true);
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
	assert.equal((await writer.fire("tool_call", { toolName: "Agent", input: { parentSessionId: ctx.session } })).block, true);
	assert.equal((await writer.fire("user_bash", { command: "git push origin main:main" })).result.exitCode, 1);
	writeFileSync(policyPath(), "bad schema");
	assert.equal((await writer.fire("tool_call", { toolName: "bash", input: { command: "git push origin lane:lane" } })).block, true);
});

/** Mirrors the installed broker's synchronous first-claim contract, not its implementation. */
function broker(f: ReturnType<typeof fake>) {
	let accepting = true, chosen: Function | undefined;
	const attempts: boolean[] = [];
	const request = { prefixedToolName: "studio_update", args: { repository: "Cratis/Studio" }, claim: (handler: Function) => {
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
	for (const toolName of ["mcp", "mcp_script", "execute", "studio_update"]) assert.equal((await early.fire("tool_call", { toolName, input: { repo: "Cratis/Studio" } })).block, true);
});
