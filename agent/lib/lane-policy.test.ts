import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ACTIONS, acknowledge, assessCommand, assessPublication, emptyPolicy, identity, loadPolicy, mutate, mcpReason, policyContext, policyFile, policyPath, policyStore, savePolicy, validatePolicy, type Policy, type Context } from "./lane-policy.ts";
import laneExtension from "../extensions/lane-policy.ts";
import publishExtension from "../extensions/publish.ts";
import guardsExtension from "../extensions/guards.ts";
import { setGuards } from "./guards.ts";

// Fresh fixtures stay under .ai-work; never point tests at the operator's policy or repositories.
const scratch = resolve(".ai-work/pi-lane-policy");
let home: string, repo: string, outside: string, oldHome: string | undefined, oldGuards: string | undefined, oldEnv: string | undefined;
let ctx: Context;
let policy: Policy;
interface GitRepository {
	root: string;
	common: string;
	gitDir: string;
	branch: string;
	remote: { origin?: string; push?: string[] };
}
class FakeGit {
	repositories = new Map<string, GitRepository>();
	failure: Error | undefined;
	onExec: ((command: string, args: readonly string[], options: { timeout?: number }) => void) | undefined;
	unsupported: string[] = [];

	init(cwd: string, branch: string, origin?: string) {
		const root = realpathSync(cwd), common = join(root, ".git");
		mkdirSync(common);
		this.repositories.set(root, { root, common, gitDir: common, branch, remote: { origin } });
	}
	repository(cwd: string): GitRepository {
		if (!existsSync(cwd)) throw this.error(`cannot change to '${cwd}': No such file or directory`);
		let root = realpathSync(cwd);
		while (!this.repositories.has(root) && dirname(root) !== root) root = dirname(root);
		const repository = this.repositories.get(root);
		if (!repository) throw this.error("not a git repository (or any of the parent directories): .git");
		return repository;
	}

	worktree(cwd: string, path: string, branch: string) {
		const parent = this.repository(cwd);
		mkdirSync(path);
		const root = realpathSync(path), gitDir = join(parent.common, "worktrees", basename(root));
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
		this.repositories.set(root, { ...parent, root, gitDir, branch });
	}

	error(message: string, status = 128) {
		return Object.assign(new Error(message), { status, stderr: `fatal: ${message}\n` });
	}

	query(command: string, args: readonly string[]): string {
		assert.equal(command, "git");
		assert.equal(args[0], "-C");
		if (this.failure) throw this.failure;
		return `${this.output(this.repository(args[1]), args.slice(2).join(" "))}\n`;
	}

	output(state: GitRepository, query: string): string {
		if (query.startsWith("show-ref --verify --quiet refs/heads/")) {
			const branch = query.slice("show-ref --verify --quiet refs/heads/".length);
			if (branch === state.branch) return "";
			throw this.error("not a valid branch ref", 1);
		}
		switch (query) {
			case "rev-parse --git-common-dir": return state.common;
			case "rev-parse --git-dir": return state.gitDir;
			case "rev-parse --show-toplevel": return state.root;
			case "symbolic-ref --quiet --short HEAD": return this.branch(state);
			case "remote get-url --push --all origin": return this.pushUrls(state);
			default:
				this.unsupported.push(query);
				throw new Error(`Unsupported fake git query: ${query}`);
		}
	}

	branch(state: GitRepository): string {
		if (!state.branch) throw this.error("ref HEAD is not a symbolic ref", 1);
		return state.branch;
	}

	pushUrls(state: GitRepository): string {
		if (!state.remote.origin) throw this.error("No such remote 'origin'", 2);
		return (state.remote.push ?? [state.remote.origin]).join("\n");
	}

	exec(command: string, args: readonly string[], options: { timeout?: number }) {
		this.onExec?.(command, args, options);
		return this.query(command, args);
	}

	spawn(command: string, args: readonly string[]) {
		try {
			return { status: 0, signal: null, stdout: this.query(command, args), stderr: "" };
		} catch (error: any) {
			return { status: error.status ?? null, signal: null, stdout: "", stderr: error.stderr ?? "", error: error.code ? error : undefined };
		}
	}
}
let fakeGit: FakeGit;
let gitProbe: { mock: { restore(): void } }, diagnosticProbe: { mock: { restore(): void } };
function fixtureIdentity(cwd: string) {
	const id = identity(cwd);
	if (!id) {
		const start = performance.now();
		const probe = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 1500 });
		assert.fail(`identity(${cwd}) is undefined; diagnostic git rev-parse: exit=${probe.status}, signal=${probe.signal}, stderr=${JSON.stringify(probe.stderr)}, durationMs=${(performance.now() - start).toFixed(1)}, error=${probe.error?.message ?? "none"}`);
	}
	return id;
}
beforeEach(t => {
	mkdirSync(scratch, { recursive: true });
	home = mkdtempSync(join(scratch, "fixture-"));
	oldHome = process.env.HOME; process.env.HOME = home;
	oldGuards = process.env.PI_GUARDS_FILE; process.env.PI_GUARDS_FILE = join(home, "guards.json");
	oldEnv = process.env.PI_GUARDS_OFF; delete process.env.PI_GUARDS_OFF;
	delete (globalThis as any)[Symbol.for("pi.guards")];
	repo = join(home, "repo"); outside = join(home, "outside"); mkdirSync(repo); mkdirSync(outside);
	fakeGit = new FakeGit();
	fakeGit.init(repo, "lane", "git@github.com:Cratis/Studio.git");
	gitProbe = t.mock.method(childProcess, "execFileSync", (command, args, options) => fakeGit.exec(command, args, options));
	diagnosticProbe = t.mock.method(childProcess, "spawnSync", (command, args) => fakeGit.spawn(command, args));
	syncBuiltinESMExports();
	ctx = { cwd: repo, session: "writer-session" };
	policy = emptyPolicy(); policy.revision = 1;
	policy.repositories.push({ common: fixtureIdentity(repo).common, slug: "Cratis/Studio", coordinator: "coordinator-session", bindings: [{ session: ctx.session, lane: "lane-one", branch: "lane", actions: [...ACTIONS] }], writers: [{ session: ctx.session, branch: "lane", actions: [...ACTIONS] }], grants: [] });
});
afterEach(() => {
	gitProbe.mock.restore();
	diagnosticProbe.mock.restore();
	syncBuiltinESMExports();
	if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
	if (oldGuards === undefined) delete process.env.PI_GUARDS_FILE; else process.env.PI_GUARDS_FILE = oldGuards;
	if (oldEnv === undefined) delete process.env.PI_GUARDS_OFF; else process.env.PI_GUARDS_OFF = oldEnv;
	delete (globalThis as any)[Symbol.for("pi.guards")];
	// Leftover fixture repositories inside the checkout break specs that copy the working tree.
	rmSync(home, { recursive: true, force: true });
	assert.deepEqual(fakeGit.unsupported, [], "all assessment Git queries must be modelled");
});
function store() { mkdirSync(join(home, ".pi/agent/lane-policy"), { recursive: true }); writeFileSync(policyPath(), JSON.stringify(policy)); }
function grant(action: any = "push", target = "lane") { policy.repositories[0].grants.push({ session: ctx.session, action, target, expires: Date.now() + 60000, revision: policy.revision }); }
function denied(command: string, context = ctx) { assert.ok(assessCommand(command, context), command); }
function allowed(command: string, context = ctx) { assert.equal(assessCommand(command, context), undefined, command); }
function fake(context = ctx, mode = "tui") {
	const commands = new Map<string, any>(), handlers = new Map<string, Function[]>(), listeners = new Map<string, Function[]>();
	const notices: string[] = [], statuses: { key: string; text: string | undefined }[] = [];
	let confirmation = true, confirms = 0;
	const confirmationText: string[] = [];
	const extCtx: any = { ...context, mode, hasUI: mode === "tui", sessionManager: { getSessionId: () => context.session }, ui: { notify: (s: string) => notices.push(s), setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }), confirm: async (_title: string, body: string) => { confirms++; confirmationText.push(body); return confirmation; } } };
	const pi: any = {
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: { on: (name: string, fn: Function) => listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
	};
	return { pi, extCtx, notices, statuses, commands, listeners, confirmationText, get confirms() { return confirms; }, decline: () => { confirmation = false; },
		fire: async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) { const value = await fn(event, extCtx); if (value) return value; } },
		command: (text: string) => commands.get("lane-policy").handler(text, extCtx),
	};
}

test("real Git smoke resolves common directory, branch and origin slug", () => {
	gitProbe.mock.restore();
	syncBuiltinESMExports();
	const root = join(home, "real-repo"); mkdirSync(root);
	// Keep real subprocesses in this smoke only, with the product's timeout.
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "lane");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
	git("remote", "add", "origin", "git@github.com:Cratis/Studio.git");
	assert.deepEqual(identity(root), { common: realpathSync(join(root, ".git")), root: realpathSync(root), branch: "lane" });
	// identity() does not return a slug; the push path resolves it from this URL.
	assert.equal(git("remote", "get-url", "--push", "--all", "origin").match(/^git@github\.com:(.+)\.git$/)?.[1], "Cratis/Studio");
});

test("typed publication and CLI reuse exact gh grants without granting unsupported actions", () => {
	store();
	const request = { kind: "issue-comment", repo: "Cratis/Studio", number: 39, body: "Safe" };
	assert.ok(assessPublication(request, ctx));
	denied("pi-publish issue-comment --repo Cratis/Studio --number 39 --body Safe");
	grant("issue-write", "39"); store();
	assert.equal(assessPublication(request, ctx), undefined);
	allowed("/trusted/bin/pi-publish issue-comment --repo Cratis/Studio --number 39 --body Safe");
	allowed("sh -c 'pi-publish issue-comment --repo Cratis/Studio --number 39 --body Safe'");
	assert.ok(assessPublication(request, { ...ctx, session: "other" }));
	assert.ok(assessPublication({ ...request, number: 40 }, ctx));
	for (const request of [
		{ kind: "api", endpoint: "repos/Cratis/Studio/issues", method: "POST" },
		{ kind: "gist-create", files: ["draft.md"] },
		{ kind: "release-create", repo: "Cratis/Studio", tag: "v1", body: "Safe" },
		{ kind: "pr-merge", repo: "Cratis/Studio", number: 39, strategy: "squash" },
	]) assert.ok(assessPublication(request, ctx));
});

for (const durations of [[2000, 2000, 2000], [5000]]) test(`Git identity shares one deadline across calls (${durations})`, t => {
	let elapsed = 0;
	const budgets: number[] = [], reasons: string[] = [];
	t.mock.method(performance, "now", () => elapsed);
	fakeGit.onExec = (_command, _args, options) => {
		budgets.push(options.timeout!);
		elapsed += durations[budgets.length - 1] ?? 0;
		if (elapsed > 5000) throw Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" });
	};
	assert.equal(identity(repo, reason => reasons.push(reason)), undefined);
	assert.deepEqual(budgets, durations.length === 1 ? [5000] : [5000, 3000, 1000]);
	assert.deepEqual(reasons, ["git timed out after 5000 ms"]);
});

test("a detached HEAD lookup cannot succeed after exhausting the shared deadline", t => {
	let elapsed = 0;
	t.mock.method(performance, "now", () => elapsed);
	fakeGit.repository(repo).branch = "";
	fakeGit.onExec = (_command, args) => { elapsed += args.includes("symbolic-ref") ? 1000 : 2000; };
	const reasons: string[] = [];
	assert.equal(identity(repo, reason => reasons.push(reason)), undefined);
	assert.deepEqual(reasons, ["git timed out after 5000 ms"]);
});

test("Git identity retains detached HEAD without branch authority within the shared budget", t => {
	let elapsed = 0;
	const budgets: number[] = [];
	t.mock.method(performance, "now", () => elapsed);
	fakeGit.repository(repo).branch = "";
	fakeGit.onExec = (_command, _args, options) => { budgets.push(options.timeout!); elapsed += 1000; };
	assert.equal(identity(repo)?.branch, "");
	assert.deepEqual(budgets, [5000, 4000, 3000]);
});

for (const failure of [
	{ error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }), reason: "git timed out after 5000 ms" },
	{ error: Object.assign(new Error("git failed"), { status: 128 }), reason: "git exited with status 128" },
]) test(`Git identity failure (${failure.reason}) refuses ACK and publication without stale authority`, async () => {
	grant(); grant("pr-create", "lane"); store();
	const publication = { kind: "pr-create", repo: "Cratis/Studio", head: "lane", base: "main", title: "Title", body: "Body" };
	allowed("git push origin lane:lane");
	allowed("gh pr create -R Cratis/Studio --head lane");
	assert.equal(assessPublication(publication, ctx), undefined);
	const previousIdentity = fixtureIdentity(repo);
	const previousPolicy = readFileSync(policyPath(), "utf8");
	const f = fake(); laneExtension(f.pi);
	fakeGit.onExec = (command, _args, options) => {
		assert.equal(command, "git");
		assert.ok(options.timeout! > 0 && options.timeout! <= 5000);
	};
	fakeGit.failure = failure.error;
	try {
		const reasons: string[] = [];
		assert.equal(identity(repo, reason => reasons.push(reason)), undefined);
		assert.deepEqual(reasons, [failure.reason]);
		await f.command("ack 1");
		assert.equal(f.confirms, 0);
		assert.ok(f.notices.some(message => message.includes("identity could not be determined") && message.includes(failure.reason)));
		assert.equal(readFileSync(policyPath(), "utf8"), previousPolicy);
		denied("git push origin lane:lane");
		denied("gh pr create -R Cratis/Studio --head lane");
		assert.ok(assessPublication(publication, ctx));
		assert.equal((await f.fire("tool_call", { toolName: "bash", input: { command: "git push origin lane:lane" } })).block, true);
	} finally {
		fakeGit.failure = undefined;
		fakeGit.onExec = undefined;
	}
	assert.deepEqual(identity(repo), previousIdentity);
	await f.command("ack 1");
	assert.equal(f.confirms, 1);
});

for (const failure of [
	{ error: Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" }), reason: "git timed out after 5000 ms" },
	{ error: Object.assign(new Error("git failed"), { status: 128 }), reason: "git exited with status 128" },
]) test(`publication assessment notices include the identity failure cause (${failure.reason})`, () => {
	store(); fakeGit.failure = failure.error;
	for (const command of ["git push origin lane:lane", `git -C '${repo}' push origin lane:lane`, "gh pr create -R Cratis/Studio --head lane"]) {
		assert.ok(assessCommand(command, ctx)?.includes(failure.reason), command);
	}
	assert.ok(assessPublication({ kind: "pr-create", repo: "Cratis/Studio", head: "lane", title: "Title", body: "Body" }, ctx)?.includes(failure.reason));
});

test("fixture identity failures include the diagnostic Git exit, stderr and duration", () => {
	assert.throws(() => fixtureIdentity(join(home, "missing")), (error: Error) => {
		assert.ok(error instanceof assert.AssertionError);
		assert.match(error.message, /diagnostic git rev-parse: exit=128/);
		assert.match(error.message, /stderr="fatal:/);
		assert.match(error.message, /durationMs=\d+\.\d/);
		return true;
	});
});

test("hosted publication is host-qualified: never matches an enrolled github.com slug or reuses its grants", () => {
	grant("issue-write", "39"); grant("pr-create", "lane"); store();
	const request = { kind: "issue-comment", repo: "Cratis/Studio", number: 39, body: "Safe" };
	assert.equal(assessPublication(request, ctx), undefined);
	assert.equal(assessPublication({ ...request, host: "github.com" }, ctx), undefined);
	assert.match(assessPublication({ ...request, host: "ghe.example.com" }, ctx)!, /Mismatched repository/);
	assert.match(assessPublication({ kind: "pr-create", repo: "Cratis/Studio", head: "lane", title: "Title", body: "Safe", host: "ghe.example.com" }, ctx)!, /Mismatched repository/);
	denied("pi-publish issue-comment --repo Cratis/Studio --host ghe.example.com --number 39 --body Safe");
	allowed("pi-publish issue-comment --repo Cratis/Studio --number 39 --body Safe");
	const unenrolled = { cwd: outside, session: "unenrolled-session" };
	const api = { kind: "api", endpoint: "repos/Cratis/Studio/issues", method: "POST" };
	assert.ok(assessPublication(api, unenrolled));
	assert.equal(assessPublication({ ...api, host: "ghe.example.com" }, unenrolled), undefined);
	assert.equal(assessPublication({ ...request, host: "ghe.example.com" }, unenrolled), undefined);
	assert.ok(assessPublication({ ...api, host: "ghe.example.com" }, ctx));
	assert.equal(assessPublication({ ...request, host: "GHE.example.com" }, ctx), "Lane policy: invalid publication request.");
});

test("typed PR create shares head binding and grants; forbidden targets and revisions still apply", () => {
	grant("pr-create", "lane"); grant("pr-comment", "39"); store();
	assert.equal(assessPublication({ kind: "pr-create", repo: "Cratis/Studio", head: "lane", base: "main", title: "Title", body: "Safe" }, ctx), undefined);
	assert.ok(assessPublication({ kind: "pr-create", repo: "Cratis/Studio", head: "other", title: "Title", body: "Safe" }, ctx));
	policy.forbidden.push("Cratis/Studio/#39"); store();
	assert.ok(assessPublication({ kind: "pr-comment", repo: "Cratis/Studio", number: 39, body: "Safe" }, ctx));
	policy.forbidden = []; policy.revision++; store();
	assert.ok(assessPublication({ kind: "pr-comment", repo: "Cratis/Studio", number: 39, body: "Safe" }, ctx));
});

test("unreadable/malformed policy denies every typed or CLI write, only validated check/help are read-only", () => {
	mkdirSync(policyPath(), { recursive: true });
	for (const request of [{ kind: "api", endpoint: "repos/o/r", method: "POST" }, { kind: "gist-create", files: ["a"] }, { kind: "issue-close", repo: "Cratis/Studio", number: 39 }]) assert.match(assessPublication(request, ctx)!, /publication denied/);
	assert.equal(assessPublication({ kind: "check", files: ["draft.md"] }, ctx), undefined);
	for (const command of ["pi-publish --help", "pi-publish check --file draft.md"]) allowed(command);
	for (const command of ["pi-publish api --endpoint repos/o/r --method POST", "pi-publish gist-create --file a", "pi-publish --help; pi-publish gist-create --file a", "pi-publish check --file a --method POST", "pi-publish --help gist-create --file a", "pi-publish unknown"]) denied(command);
	assert.match(assessPublication({ kind: "check", files: [], body: "private-value" }, ctx)!, /^Lane policy: invalid publication request\.$/);
});

test("lane extension dispatches publish before opaque/MCP, including nested children", async () => {
	store(); const host = fake(); laneExtension(host.pi);
	const input = { kind: "issue-comment", repo: "Cratis/Studio", number: 39, body: "private-value" };
	const direct = await host.fire("tool_call", { toolName: "publish", input });
	assert.equal(direct.block, true); assert.ok(!direct.reason.includes("private-value"));
	const nested = await host.fire("tool_call", { toolName: "multi_tool_use.parallel", input: { tool_uses: [{ recipient_name: "functions.publish", parameters: input }] } });
	assert.equal(nested.block, true);
	assert.equal(await host.fire("tool_call", { toolName: "publish", input: { kind: "check", files: ["a"] } }), undefined);
});

test("missing policy stays available for bootstrap but publication fails closed; unrelated workflows remain allowed", () => {
	assert.equal(loadPolicy().policy?.repositories.length, 0);
	assert.deepEqual(loadPolicy().policy?.forbidden, []);
	denied("git push origin main"); denied("gh api graphql -f query=mutation"); allowed("python custom.py");
	allowed(`cat '${join(home, ".pi/agent/bin/pi-publish")}'`); allowed("gh pr view 1 -R Cratis/Studio");
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
	const wt = join(home, "worktree"); fakeGit.worktree(repo, wt, "other");
	assert.equal(identity(wt)?.common, identity(repo)?.common);
	grant(); store();
	denied(`git -C '${wt}' push origin other:other`, { cwd: outside, session: "other-session" });
	allowed(`git -C '${repo}' push origin lane:lane`, { ...ctx, cwd: outside });
	denied(`cd '${wt}' && git push origin other:other`, { cwd: outside, session: "new-child" });
	denied(`cd -P '${wt}' && git push origin other:other`, { cwd: outside, session: "new-child" });
});
test("branch changes and detached HEAD never create authority", () => {
	grant(); store(); fakeGit.repository(repo).branch = "another"; denied("git push origin HEAD:another");
	fakeGit.repository(repo).branch = ""; denied("git push origin HEAD:lane");
});
test("origin must resolve to precisely enrolled GitHub push URL", () => {
	grant(); store();
	fakeGit.repository(repo).remote.push = ["git@github.com:Other/Studio.git"]; denied("git push origin lane:lane");
	fakeGit.repository(repo).remote.push = ["https://github.com/Cratis/Studio.git"]; allowed("git push origin lane:lane");
	fakeGit.repository(repo).remote.push!.push("git@github.com:Cratis/Studio.git"); denied("git push origin lane:lane");
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
	assert.throws(() => mutate(policy, ["grant", ctx.session, "issue-write", "42", "5", "minutes"], { ...ctx, session: "coordinator-session" }, fixtureIdentity(repo)), /Forbidden/);
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
	fakeGit.init(outside, "unrelated");
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
	mutate(policy, ["revoke", "session", ctx.session], { ...ctx, session: "coordinator-session" }, fixtureIdentity(repo)); store();
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
	const id = fixtureIdentity(repo);
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
		mutate(latest, ["forbid", "Other/Repo/#8"], { ...ctx, session: "coordinator-session" }, fixtureIdentity(repo));
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
	assert.deepEqual(loadPolicy().policy?.acknowledgements, [{ session: ctx.session, common: fixtureIdentity(repo).common, revision: 1 }]);
	const restarted = fake(); laneExtension(restarted.pi);
	await restarted.fire("session_start", { reason: "resume" });
	assert.match((await restarted.fire("before_agent_start", { systemPrompt: "base" })).systemPrompt, /ACK=current/);
	policy = loadPolicy().policy!;
	mutate(policy, ["forbid", "Other/Repo/#9"], { ...ctx, session: "coordinator-session" }, fixtureIdentity(repo)); store();
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

test("reading policy/guard config and writing .ai-work messages that mention it are never policy-write", async () => {
	const guard = join(home, ".pi/agent/guards.json");
	mkdirSync(join(home, ".pi/agent"), { recursive: true }); writeFileSync(guard, "{}");
	for (const state of ["unenrolled", "enrolled"]) {
		if (state === "enrolled") store();
		for (const path of [guard, policyPath(), "~/.pi/agent/guards.json"]) {
			allowed(`cat '${path}' 2>/dev/null | jq .`);
			allowed(`jq .off '${path}' 2>&1`);
			allowed(`grep -n lane '${path}' >&2`);
			allowed(`cat '${path}' > .ai-work/notes/copy.json`);
			allowed(`echo "do not edit ${path}" > .ai-work/einari-issues/messages/L0-to-L3.md`);
			allowed(`mkdir -p .ai-work/x/messages && cat > .ai-work/x/messages/m.md <<'EOF'\nThe policy file ${path} and ~/.pi/agent/lane-policy/policy.json stay untouched.\nEOF\necho done >> .ai-work/x/STATE.md`);
			allowed(`tee -a .ai-work/x/messages/m.md <<'EOF'\nsee ${path}\nEOF`);
			denied(`printf '{}' > '${path}'`);
			denied(`cat > '${path}' <<'EOF'\n{}\nEOF`);
			denied(`echo '{}' | tee '${path}'`);
			denied(`mv '${path}' .ai-work/moved.json`);
			denied(`cat '${path}' > .ai-work/../x.json`);
			denied(`cat <<'EOF' | bash\nprintf '{}' > ${path}\nEOF`);
			denied(`python3 - <<'EOF'\nopen('${path}', 'w')\nEOF`);
		}
	}
	const f = fake(); laneExtension(f.pi);
	assert.equal(await f.fire("tool_call", { toolName: "bash", input: { command: `cat > .ai-work/m/messages/x.md <<'EOF'\n${guard}\nEOF` } }), undefined);
	assert.ok((await f.fire("tool_call", { toolName: "bash", input: { command: `cat > '${guard}' <<'EOF'\n{}\nEOF` } }))?.block);
	assert.equal(readFileSync(guard, "utf8"), "{}");
});

const livePaths = () => { const agent = join(home, ".pi/agent"); return { agent, guards: join(agent, "lib/guards.ts"), laneLib: join(agent, "lib/lane-policy.ts"), laneExt: join(agent, "extensions/lane-policy.ts"), json: join(agent, "guards.json"), store: policyPath() }; };

const publicationSources = ["extensions/wait-guard.ts", "lib/orchestration.ts", "guards.json", "lib/guards.ts", "extensions/guards.ts", "lib/lane-policy.ts", "extensions/lane-policy.ts", "lib/candidate-guard.ts", "extensions/train-guard.ts", "lib/publisher.ts", "lib/publish-request.ts", "lib/publish-scan.ts", "lib/publish-guard.ts", "lib/secret-mask.ts", "extensions/publish.ts", "extensions/publish-guard.ts", "bin/pi-publish"];

test("installed publication enforcement exact paths and symlinks require operator maintenance", async () => {
	const p = livePaths(), f = fake({ ...ctx, name: "PISETUP" }); laneExtension(f.pi);
	for (const source of publicationSources) {
		const path = join(p.agent, source);
		mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, "fixture");
		const alias = join(home, source.replaceAll("/", "-")); symlinkSync(path, alias);
		for (const target of [path, alias, `${path}.bak`]) {
			assert.equal(policyFile(target, repo), true, target); assert.equal(policyStore(target, repo), true, target);
			assert.ok((await f.fire("tool_call", { toolName: "write", input: { path: target, content: "x" } }))?.block);
			assert.ok((await f.fire("tool_call", { toolName: "edit", input: { path: target } }))?.block);
		}
		denied(`printf x > '${alias}'`, { ...ctx, name: "PISETUP" });
		allowed(`cat '${path}'`, { ...ctx, name: "PISETUP" });
		assert.equal(readFileSync(path, "utf8"), "fixture");
	}
});

test("publication enforcement ancestor, glob and directory symlink writes are protected", async () => {
	const p = livePaths(), setup = { ...ctx, name: "PISETUP" }, f = fake(setup); laneExtension(f.pi);
	mkdirSync(join(p.agent, "lib"), { recursive: true });
	const alias = join(home, "lib-alias"); symlinkSync(join(p.agent, "lib"), alias);
	for (const target of [p.agent, join(p.agent, "lib"), join(p.agent, "extensions"), join(p.agent, "bin"), alias]) {
		assert.equal(policyFile(target, repo), true); assert.equal(policyStore(target, repo), true);
		assert.ok((await f.fire("tool_call", { toolName: "write", input: { path: target, content: "x" } }))?.block);
		denied(`rm -rf '${target}'`, setup);
	}
	for (const target of [`${p.agent}/lib/publish*`, `${p.agent}/extensions/publish?.ts`, `${p.agent}/lib/[ps]*.ts`, `${p.agent}/bin/pi-*`, `${alias}/publish*`, `${p.agent}/lib/{publisher,guards}.ts`]) {
		denied(`rm ${target}`, setup); denied(`cp ordinary.ts ${target}`, setup);
	}
	assert.equal(policyStore(join(p.agent, "lib/ordinary.ts"), repo), false);
});

test("read-only commands on authority files are never policy writes", () => {
	// Isolate authority-path attribution from the absent-store publication refusal.
	policy = emptyPolicy(); store();
	const p = livePaths();
	for (const c of [
		`grep -n x ${p.agent}/lane-policy*.json`,
		`cat ${p.json}; wc -l ${p.laneExt} ${p.laneLib}`,
		`sed -n 1,40p ${p.laneExt}`,
		`cat > /tmp/x <<'EOF'\nsee ${p.guards}\nEOF\ngh issue create --repo o/r --title t --body-file /tmp/x`,
		`diff ${p.guards} agent/lib/guards.ts`, `cmp ${p.guards} /tmp/x`, `head -3 ${p.guards}; tail -3 ${p.guards}; rg x ${p.guards}`,
		`ls -la ${p.agent}/lane-policy; stat ${p.json}; find ${p.agent}/lib -name '*.ts'`,
		`git -C ${p.agent} diff lib/guards.ts`, `git show HEAD:agent/lib/guards.ts`, `git log -3 -- ${p.guards}`, `git status --short ${p.guards}`,
	]) { allowed(c); allowed(c, { ...ctx, name: "PISETUP" }); }
	// repo copy of an authority file is not the live authority file
	allowed("git add agent/lib/guards.ts && git commit -m x && git diff agent/lib/guards.ts");
});

test("writes to authority files stay blocked for non-setup lanes", () => {
	const p = livePaths(), other = { ...ctx, name: "lane-one" };
	for (const c of [
		`sed -i s/a/b/ ${p.guards}`, `sed -n 'w ${p.guards}' x`, `sed --in-place s/a/b/ ${p.guards}`, `printf x > ${p.json}`, `echo x >> ${p.json}`, `echo x | tee ${p.guards}`,
		`cp /tmp/x ${p.guards}`, `mv /tmp/x ${p.laneLib}`, `rm ${p.guards}`, `ln -sf /tmp/x ${p.guards}`,
		`python3 -c "open('${p.guards}','w').write('x')"`, `perl -pi -e s/a/b/ ${p.guards}`,
		`git -C ${p.agent} diff --output=${p.guards} HEAD`, `find ${p.guards} -fprint ${p.guards}`,
	]) { denied(c); denied(c, other); }
});

test("round 1: strict sed/git read-only allowlists", () => {
	const p = livePaths(), other = { ...ctx, name: "lane-one" };
	for (const c of [
		`sed -n 'w/${p.json}' /tmp/x`, `sed -n 'w${p.guards}' /tmp/x`, `sed -n -e 'w ${p.json}' /tmp/x`, `sed --expression='w ${p.json}' /tmp/x`, `sed -f /tmp/script ${p.guards}`,
		`sed -i.bak s/a/b/ ${p.guards}`, `sed -Ei s/a/b/ ${p.guards}`, `sed --in-place=.b s/a/b/ ${p.guards}`, `sed 's/a/b/w ${p.json}' x`, `sed -n '1e touch x' ${p.guards}`, `sed -n 'r ${p.guards}' x`, `sed -n '/a/p;w ${p.json}' x`,
		`GIT_EXTERNAL_DIFF=/tmp/helper git diff --no-index --ext-diff ${p.guards} /tmp/x`, `env GIT_EXTERNAL_DIFF=/tmp/h git diff ${p.guards}`, `git -c core.pager=/tmp/h diff ${p.guards}`,
		`git diff --ext-diff ${p.guards}`, `git diff --textconv ${p.guards}`, `git diff --output=${p.json} ${p.guards}`, `git --paginate diff ${p.guards}`, `git difftool ${p.guards}`, `git grep -O/tmp/h x ${p.guards}`, `git add ${p.guards}`, `git commit -am x ${p.guards}`,
	]) { denied(c); denied(c, other); }
	for (const c of [`sed -n '/error/p' ${p.json}`, `sed -n '1,40p;$=' ${p.guards}`, `sed -En '/a\\/b/,/c/p' ${p.guards}`, `sed -s -n -e '5q' -e '$p' ${p.guards}`, `sed --quiet 3p ${p.guards}`, `git -C ${p.agent} diff lib/guards.ts`]) { allowed(c); allowed(c, { ...ctx, name: "PISETUP" }); }
});

test("setup writer may write ordinary setup files but never the operator store or enforcement sources", async () => {
	const p = livePaths(), setup = { ...ctx, name: "PISETUP" }, dir = join(p.agent, "lane-policy");
	mkdirSync(dir, { recursive: true });
	for (const c of [`printf x > ${dir}/README.md`, `cp /tmp/x ${dir}/setup-writers.json`, `cp /tmp/x ${p.agent}/lib/ordinary.ts`]) allowed(c, setup);
	for (const c of [
		`sed -i s/a/b/ ${p.guards}`, `printf x > ${p.json}`, `cp /tmp/x ${p.laneLib}`, `perl -pi -e s/a/b/ ${p.laneExt}`, `rm ${p.guards}`, `cd ${p.agent}/lib && sed -i s/a/b/ guards.ts`,
		`printf x > ${p.store}`, `sed -i s/a/b/ ${p.store}`, `rm -rf ${dir}`, `rm -rf ${dir}/`, `rm ${dir}/policy.json`, `rm '${dir}/pol'icy.json`, `rm ${dir}/pol\\icy.json`, `rm ${dir}/pol*`, `rm ${dir}/*.json`, `rm ${dir}/p?licy.json`, `rm ${dir}/{policy,x}.json`,
		`rm -rf ${p.agent}/lane-poli*`, `rm -rf ${p.agent}/*`, `rm -rf ${p.agent}`, `rm $HOME/.pi/agent/lane-policy/policy.json`, `rm "$X"`, `mv ${p.store} /tmp/x`, `mv /tmp/x ${p.store}`, `cp /tmp/x ${p.store}`, `ln -sf /tmp/x ${p.store}`,
		`cd ${p.agent} && rm -rf lane-policy`, `cd ${p.agent}/lane-policy && rm policy.json`, `cd ${p.agent}/lane-policy && rm *`, `cd $SOMEWHERE && rm policy.json`, `find ${p.agent} -delete`, `find ${dir} -exec rm {} +`, `dd if=/tmp/x of=${p.store}`, `echo x | tee ${p.store}`, `printf x >> ${p.store}`,
		`python3 -c "import shutil; shutil.rmtree('/Users/x/.pi/agent/lane-policy')"`, `python3 -c "import os; os.remove(os.path.expanduser('~/.pi/agent/lane-' + 'policy/policy.json'))"`, `node -e "require('fs').rmSync('/Users/x/.pi/agent/lane-policy/policy.json')"`, `bash -c 'rm ${p.store}'`, `eval "rm ~/.pi/agent/lane-policy/policy.json"`, `perl -e 'unlink "/Users/x/.pi/agent/lane-policy/policy.json"'`,
		`apply_patch ${JSON.stringify({ patch: `*** Delete File: ${p.store}` })}`,
	]) denied(c, setup);
	assert.equal(policyStore(p.store, repo), true); assert.equal(policyStore(p.guards, repo), true);
	for (const c of [
		`sed -n -e 'w ${p.store}' /tmp/x`, `sed -n 'w${p.store}' /tmp/x`, `sed --expression='w ${p.store}' /tmp/x`, `sed -n '1p\\;w${p.store}' /tmp/x`, `sed 's/x/y/w ${p.store}' /tmp/x`,
		`sed -n 'w ~/.pi/agent/lane-policy/policy.json' /tmp/x`, `sed -n 'w $HOME/.pi/agent/lane-policy/policy.json' /tmp/x`,
	]) denied(c, setup);
	for (const c of [`cat ${p.store}`, `grep -n x ${p.store}`, `sed -n p ${p.store}`, `sed -n '/rev/p' ${p.store}`, `cat ${p.store}; wc -l ${p.store}`]) allowed(c, setup);
	for (const name of [undefined, "", "pisetup", "PISETUP "]) denied(`sed -i s/a/b/ ${p.guards}`, { ...ctx, name });
	const named = (name: string | undefined) => { const f = fake(); f.extCtx.sessionManager.getSessionName = () => name; laneExtension(f.pi); return f; };
	assert.equal((await named("PISETUP").fire("tool_call", { toolName: "write", input: { path: p.guards, content: "x" } })).block, true);
	assert.equal(await named("PISETUP").fire("tool_call", { toolName: "write", input: { path: join(dir, "README.md"), content: "x" } }), undefined);
	assert.equal((await named("PISETUP").fire("tool_call", { toolName: "write", input: { path: p.store, content: "x" } })).block, true);
	assert.ok((await named("lane-one").fire("tool_call", { toolName: "write", input: { path: p.guards, content: "x" } }))?.block);
	assert.ok((await named(undefined).fire("tool_call", { toolName: "edit", input: { path: p.guards } }))?.block);
	writeFileSync(join(dir, "setup-writers.json"), JSON.stringify(["SETUP2"]));
	denied(`sed -i s/a/b/ ${p.guards}`, setup); denied(`sed -i s/a/b/ ${p.guards}`, { ...ctx, name: "SETUP2" });
	allowed(`sed -i s/a/b/ ${dir}/README.md`, { ...ctx, name: "SETUP2" });
	writeFileSync(join(dir, "setup-writers.json"), "bad");
	denied(`sed -i s/a/b/ ${p.guards}`, setup);
	store(); grant("push", "other");
	denied("git push origin lane:lane", setup);
});

test("ordinary paths are not critical: only exact critical files, siblings and agent-dir ancestors are", async () => {
	const p = livePaths(), setup = { ...ctx, name: "PISETUP" }, f = fake(setup); laneExtension(f.pi);
	mkdirSync(join(p.agent, "lib"), { recursive: true }); mkdirSync(join(p.agent, "skills"), { recursive: true });
	for (const ordinary of [home, join(home, ".pi"), "/", join(home, "ordinary.txt"), join(p.agent, "skills"), join(p.agent, "lib/ordinary.ts"), join(p.agent, "lib/guards.test.ts"), join(p.agent, "AGENTS.md")]) {
		assert.equal(policyStore(ordinary, repo), false, ordinary);
		assert.equal(policyFile(ordinary, repo), false, ordinary);
	}
	assert.equal(await f.fire("tool_call", { toolName: "write", input: { path: join(home, "ordinary.txt"), content: "x" } }), undefined);
	allowed(`ls '${home}'`, setup);
	for (const critical of [p.agent, join(p.agent, "lib"), p.guards, `${p.guards}.lock`]) assert.equal(policyStore(critical, repo), true, critical);
});

test("dependencies of the publish guard are protected critical enforcement, derived from its imports", async () => {
	const root = new URL("../", import.meta.url).pathname, seen = new Set<string>(), queue = ["lib/publish-guard.ts"];
	while (queue.length) {
		const rel = queue.pop()!;
		if (seen.has(rel)) continue;
		seen.add(rel);
		for (const match of readFileSync(join(root, rel), "utf8").matchAll(/from\s+["'](\.[^"']+)["']/g)) queue.push(resolve(root, rel, "..", match[1]).slice(root.length));
	}
	assert.ok(seen.has("extensions/wait-guard.ts"), "tokenizer dependency must be discovered");
	const p = livePaths(), setup = { ...ctx, name: "PISETUP" }, f = fake(setup); laneExtension(f.pi);
	for (const rel of seen) {
		const path = join(p.agent, rel);
		assert.equal(policyFile(path, repo), true, rel); assert.equal(policyStore(path, repo), true, rel);
		assert.ok((await f.fire("tool_call", { toolName: "edit", input: { path } }))?.block, rel);
		denied(`rm '${path}'`, setup); denied(`cp ordinary.ts '${path}'`, setup);
		denied(`printf x > "$HOME/.pi/agent/${rel}"`, setup);
	}
});

test("typed API writes are admitted by target repository for sessions unbound to it", () => {
	grant("issue-write", "39"); store();
	const stranger = { cwd: outside, session: "stranger-session" };
	for (const endpoint of ["repos/Cratis/Studio/issues", "repos/cratis/studio/issues/39/comments", "repos/%43ratis/Studio/issues", "repos/Cratis/%53tudio/issues", "/repos/CRATIS/STUDIO/issues"]) {
		assert.match(assessPublication({ kind: "api", endpoint, method: "POST" }, stranger)!, /Lane policy/);
		assert.match(assessPublication({ kind: "api", endpoint, method: "DELETE", fields: [{ name: "a", value: "b" }] }, stranger)!, /Lane policy/);
	}
	// Non-enrolled targets remain outside this policy for an unbound session.
	for (const endpoint of ["repos/other/project/issues", "repos/Cratis/StudioTools/issues", "repos/Cratis/Studio-tools/issues", "repos/Cratis/Studio-docs/issues", "repos/other/project/issues?target=Cratis/Studio", "repos/other/project/issues?target=repos/Cratis/Studio/issues"]) {
		assert.equal(assessPublication({ kind: "api", endpoint, method: "POST" }, stranger), undefined, endpoint);
	}
	for (const repo of ["Cratis/Studio", "cratis/studio", "CRATIS/STUDIO"]) {
		assert.match(assessPublication({ kind: "issue-comment", repo, number: 39, body: "draft" }, stranger)!, /Lane policy/);
	}
	for (const repo of ["Cratis/StudioTools", "Cratis/Studio-tools", "Cratis/Studio-docs"]) {
		assert.equal(assessPublication({ kind: "issue-comment", repo, number: 39, body: "Cratis/Studio" }, stranger), undefined, repo);
	}
	assert.match(assessPublication({ kind: "api", endpoint: "repos/%ZZ/Studio/issues", method: "POST" }, stranger)!, /invalid publication request/);
	assert.equal(assessPublication({ kind: "gist-create", files: ["draft.md"], description: "about Cratis/Studio" }, stranger), undefined);
});

// #196: stateless, human-approved candidate exceptions (binding addendum 2).
const exceptionArgs = ["exception", "writer-session", "urgent-fix", "lane", "1", "Fix", "production", "regression"];
const exceptionPush = "git push --no-follow-tags origin lane:lane";
const exceptionRequest = { kind: "pr-create", repo: "Cratis/Studio", head: "lane", title: "Fix", body: "Safe" };
function changedException(args: string[], actor = { ...ctx, session: "coordinator-session" }): Policy {
	const next = structuredClone(policy);
	mutate(next, args, actor, fixtureIdentity(repo));
	return next;
}
function mint(args = exceptionArgs) {
	store();
	const next = changedException(args);
	savePolicy(next, JSON.stringify(policy)); policy = next;
	return next.repositories[0].grants;
}
function revokeExceptions(what = "grants") {
	const next = changedException(["revoke", what, ctx.session]);
	savePolicy(next, JSON.stringify(policy)); policy = next;
}
function publisher() {
	let registered: any, sends = 0;
	publishExtension({ registerTool: (def: any) => { registered = def; } } as any, {
		candidate: async () => ({}), root: () => repo,
		send: async () => { sends++; return { code: "published", text: "published", isError: false }; },
	});
	return { execute: (context: unknown) => registered.execute("id", exceptionRequest, undefined, undefined, context), sends: () => sends };
}

test("exception mint appends both UUID grants in one revision without widening an existing binding", () => {
	const binding = structuredClone(policy.repositories[0].bindings[0]), before = policy.revision;
	const grants = mint();
	assert.equal(policy.revision, before + 1); assert.deepEqual(policy.repositories[0].bindings[0], binding);
	assert.deepEqual(grants.map(g => g.action), ["push", "pr-create"]);
	for (const g of grants) {
		assert.match(g.id!, /^[0-9a-f-]{36}$/); assert.equal(g.kind, "urgent-fix");
		assert.equal(g.reason, "Fix production regression"); assert.equal(g.by, "coordinator-session");
		assert.equal(g.revision, policy.revision); assert.equal(g.expires - g.issuedAt!, 60000);
	}
	assert.notEqual(grants[0].id, grants[1].id);
});
test("major exception creates only push and PR-create binding/writer with a default 30 minute window", () => {
	policy.repositories[0].bindings = []; policy.repositories[0].writers = [];
	const grants = mint(["exception", ctx.session, "major", "lane", "Major coordinated change"]);
	assert.equal(grants[0].expires - grants[0].issuedAt!, 30 * 60000);
	assert.deepEqual(policy.repositories[0].bindings, [{ session: ctx.session, lane: "exception", branch: "lane", actions: ["push", "pr-create"] }]);
	assert.deepEqual(policy.repositories[0].writers, [{ session: ctx.session, branch: "lane", actions: ["push", "pr-create"] }]);
});
test("exception accepts at most 60 minutes and normalizes the refs/heads mint namespace", () => {
	const grants = mint(["exception", ctx.session, "major", "refs/heads/lane", "60", "Coordinated migration"]);
	assert.equal(grants[0].target, "lane"); assert.equal(grants[0].expires - grants[0].issuedAt!, 3600000);
});
for (const [name, args] of [
	["unknown kind", ["exception", "writer-session", "minor", "lane", "1", "reason"]],
	["missing reason", exceptionArgs.slice(0, 5)],
	["zero minutes", [...exceptionArgs.slice(0, 4), "0", "reason"]],
	["negative minutes", [...exceptionArgs.slice(0, 4), "-1", "reason"]],
	["fractional minutes", [...exceptionArgs.slice(0, 4), "1.5", "reason"]],
	["overflow minutes", [...exceptionArgs.slice(0, 4), "9007199254740992", "reason"]],
	["window beyond one hour", [...exceptionArgs.slice(0, 4), "61", "reason"]],
	["blank session", ["exception", " ", "major", "lane", "1", "reason"]],
	["blank branch", ["exception", "writer-session", "major", " ", "1", "reason"]],
	["blank reason", [...exceptionArgs.slice(0, 5), "  "]],
	["reason longer than 200 characters", [...exceptionArgs.slice(0, 5), "x".repeat(201)]],
	["control character in reason", [...exceptionArgs.slice(0, 5), "fix\u007fnow"]],
	["override forbidden", [...exceptionArgs, "--override"]],
	["override embedded in reason", [...exceptionArgs, "--override", "please"]],
] as [string, string[]][]) test(`exception mint rejects ${name}`, () => assert.throws(() => changedException(args)));
for (const branch of ["main", "master", "develop", "development", "release/1", "integration/work", "refs/heads/main", "refs/tags/lane", "refs/remotes/origin/lane", "refs/heads/refs/tags/lane", "HEAD", "lane:other", "+lane", "lane*", "lane..other", "lane/.hidden", "lane.lock", "lane/"]) {
	test(`exception mint rejects protected or ambiguous branch ${branch}`, () => {
		assert.throws(() => changedException(["exception", ctx.session, "urgent-fix", branch, "1", "Fix"]));
	});
}
test("exception mint denies a configured forbidden branch", () => {
	policy.forbidden = ["Cratis/Studio/#lane"];
	assert.throws(() => changedException(exceptionArgs));
});
test("exception mint is coordinator-only, not the lane writer or an override", () => {
	assert.throws(() => changedException(exceptionArgs, ctx));
	assert.throws(() => changedException([...exceptionArgs, "--override"], { ...ctx, session: "stranger" }));
});
test("exception mint refuses another writer, another binding branch, or widening existing actions", () => {
	policy.repositories[0].writers[0].session = "other"; assert.throws(() => changedException(exceptionArgs));
	policy.repositories[0].writers[0].session = ctx.session;
	policy.repositories[0].bindings[0].branch = "other"; assert.throws(() => changedException(exceptionArgs));
	policy.repositories[0].bindings[0].branch = "lane"; policy.repositories[0].bindings[0].actions = ["pr-comment"];
	assert.throws(() => changedException(exceptionArgs));
});
for (const [name, change] of [
	["empty reason", { reason: "" }], ["overlong reason", { reason: "x".repeat(201) }], ["control reason", { reason: "x\u007f" }],
	["empty issuer", { by: " " }], ["unknown kind", { kind: "minor" }], ["missing id", { id: undefined }],
	["invalid issue time", { issuedAt: NaN }], ["reversed times", { issuedAt: Number.MAX_SAFE_INTEGER }],
	["excessive window", { issuedAt: 1 }], ["merge action", { action: "pr-merge" }], ["issue action", { action: "issue-write" }],
	["tag target", { target: "refs/tags/lane" }],
] as [string, Record<string, unknown>][]) test(`exception schema rejects ${name}`, () => {
	mint(); const candidate = structuredClone(policy); Object.assign(candidate.repositories[0].grants[0], change);
	assert.throws(() => validatePolicy(candidate));
});
test("exception schema rejects duplicate ids; ordinary legacy grants remain valid", () => {
	grant(); assert.doesNotThrow(() => validatePolicy(policy)); policy.repositories[0].grants = [];
	mint(); policy.repositories[0].grants[1].id = policy.repositories[0].grants[0].id;
	assert.throws(() => validatePolicy(policy));
});

test("exception assessments are stateless and idempotent for unlimited matching pushes and PR-create attempts", () => {
	mint(); const before = readFileSync(policyPath(), "utf8");
	for (let n = 0; n < 8; n++) { allowed(exceptionPush); assert.equal(assessPublication(exceptionRequest, ctx), undefined); }
	assert.equal(readFileSync(policyPath(), "utf8"), before);
	assert.deepEqual(readdirSync(dirname(policyPath())), ["policy.json"]);
});
test("repeated literal shell-wrapper assessments of pushes and PR-create stay allowed within the window", () => {
	mint();
	for (let n = 0; n < 4; n++) {
		allowed(`sh -c '${exceptionPush}'`);
		allowed("sh -c 'gh pr create -R Cratis/Studio --head lane --title Fix --body Safe'");
		allowed(`eval '${exceptionPush}'`);
	}
});
test("typed hook and execution both admit repeated matching publications without cached authorization", async () => {
	mint(); const f = fake(); laneExtension(f.pi); const tool = publisher();
	for (let n = 0; n < 3; n++) {
		assert.equal(await f.fire("tool_call", { toolName: "publish", input: exceptionRequest }), undefined);
		assert.equal((await tool.execute(f.extCtx)).isError, false);
	}
	assert.equal(tool.sends(), 3);
});
for (const change of ["revoked grants", "revoked session", "expired", "unreadable policy", "deleted policy"]) test(`${change} between typed hook and execution denies before publication`, async t => {
	const grants = mint(); const f = fake(); laneExtension(f.pi); const tool = publisher();
	assert.equal(await f.fire("tool_call", { toolName: "publish", input: exceptionRequest }), undefined);
	if (change === "revoked grants") revokeExceptions();
	else if (change === "revoked session") revokeExceptions("session");
	else if (change === "expired") t.mock.method(Date, "now", () => grants[0].expires);
	else if (change === "unreadable policy") writeFileSync(policyPath(), "{");
	else rmSync(policyPath());
	assert.equal((await tool.execute(f.extCtx)).isError, true); assert.equal(tool.sends(), 0);
});
test("a valid empty policy is dormant without enrollment, unlike an absent policy store", () => {
	policy = emptyPolicy(); store(); allowed("git push origin main"); allowed("gh api graphql -f query=mutation");
});
test("revocation during Git attribution is reread before granting an exception", () => {
	mint(); let revoked = false;
	fakeGit.onExec = (_command, args) => {
		if (revoked || !args.includes("get-url")) return;
		revoked = true; revokeExceptions();
	};
	denied(exceptionPush); assert.equal(revoked, true);
});
test("unqualified exception push cannot resolve a tag when its local branch is absent", () => {
	gitProbe.mock.restore(); diagnosticProbe.mock.restore(); syncBuiltinESMExports();
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-b", "other");
	git("-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "commit", "--allow-empty", "-m", "fixture");
	git("tag", "lane"); git("remote", "add", "origin", "git@github.com:Cratis/Studio.git");
	mint(); denied(exceptionPush);
	git("branch", "lane"); allowed("git push --no-follow-tags origin refs/heads/lane:refs/heads/lane");
});
test("a later assessment sees revocation, not a cached permit", () => {
	mint(); allowed(exceptionPush); revokeExceptions(); denied(exceptionPush); assert.ok(assessPublication(exceptionRequest, ctx));
});
test("stale revision and changed writer or binding invalidate exception authority", () => {
	mint(); policy.revision++; store(); denied(exceptionPush);
	policy.repositories[0].grants.forEach(g => { g.revision = policy.revision; });
	policy.repositories[0].writers[0].session = "other"; store(); denied(exceptionPush);
	policy.repositories[0].writers[0].session = ctx.session; policy.repositories[0].bindings[0].actions = ["pr-comment"]; store(); denied(exceptionPush);
});
test("clock rollback before issuedAt denies; now equal to expiry and later deny", t => {
	const grants = mint(); let now = grants[0].issuedAt! - 1; t.mock.method(Date, "now", () => now);
	denied(exceptionPush); assert.ok(assessPublication(exceptionRequest, ctx));
	now = grants[0].expires; denied(exceptionPush); assert.ok(assessPublication(exceptionRequest, ctx));
	now++; denied(exceptionPush);
});
test("exception denies wrong repo, branch, session and action", () => {
	mint(); denied(exceptionPush, { ...ctx, session: "other" });
	for (const head of ["other", "refs/tags/lane"]) assert.ok(assessPublication({ ...exceptionRequest, head }, ctx));
	assert.ok(assessPublication({ ...exceptionRequest, repo: "Other/Repo" }, ctx));
	fakeGit.repository(repo).remote.push = ["git@github.com:Other/Repo.git"]; denied(exceptionPush);
	denied("git push --no-follow-tags origin other:other"); denied("git push --no-follow-tags origin lane:other");
	denied("gh pr merge 39 -R Cratis/Studio"); denied("gh pr comment 39 -R Cratis/Studio --body safe");
});
for (const [name, command] of [
	["force", "git push --no-follow-tags --force origin lane:lane"],
	["force-with-lease", "git push --no-follow-tags --force-with-lease origin lane:lane"],
	["plus refspec", "git push --no-follow-tags origin +lane:lane"],
	["branch deletion", "git push --no-follow-tags origin :lane"],
	["delete option", "git push --no-follow-tags --delete origin lane"],
	["all branches", "git push --no-follow-tags --all origin"],
	["mirror", "git push --no-follow-tags --mirror origin"],
	["tags", "git push --no-follow-tags --tags origin lane:lane"],
	["protected namespace", "git push --no-follow-tags origin lane:refs/heads/main"],
	["tag namespace", "git push --no-follow-tags origin refs/tags/lane:refs/tags/lane"],
	["implicit tags", "git push --follow-tags origin lane:lane"],
] as [string, string][]) test(`exception push rejects ${name}`, () => { mint(); denied(command); });
test("branch push normalizes only refs/heads and HEAD sources, not tag namespaces", () => {
	mint(); allowed("git push --no-follow-tags origin refs/heads/lane:refs/heads/lane");
	allowed("git push --no-follow-tags origin HEAD:refs/heads/lane");
	assert.ok(assessPublication({ ...exceptionRequest, head: "refs/heads/lane" }, ctx));
});
test("configured push.followTags cannot publish tags: explicit --no-follow-tags is mandatory", () => {
	mint(); writeFileSync(join(repo, ".git", "config"), "[push]\n\tfollowTags = true\n");
	denied("git push origin lane:lane"); allowed(exceptionPush);
});
test("ordinary grants preserve force-with-lease and never require exception metadata", () => {
	grant(); store(); allowed("git push --force-with-lease origin lane:lane");
});
test("policy remains protected from model direct writes and shell mutation", async () => {
	mint(); assert.ok(policyFile(policyPath())); denied(`printf '{}' > '${policyPath()}'`); denied(`rm '${policyPath()}'`);
	const f = fake(); laneExtension(f.pi);
	assert.ok(await f.fire("tool_call", { toolName: "write", input: { path: policyPath(), content: "{}" } }));
	assert.ok(await f.fire("tool_call", { toolName: "edit", input: { path: policyPath(), oldText: "a", newText: "b" } }));
});
test("push and PR-create refusals name the human exception route but malformed commands do not", () => {
	store();
	for (const denial of [assessCommand("git push origin lane:lane", ctx)!, assessPublication(exceptionRequest, ctx)!]) {
		assert.match(denial, /writer-session urgent-fix lane/); assert.match(denial, /writer-session major lane/);
		assert.match(denial, /coordinator TUI/); assert.match(denial, /revoke grants/); assert.match(denial, /60/);
		assert.match(denial, /unlimited matching pushes and PR-create attempts until expiry or revocation/);
	}
	assert.doesNotMatch(assessCommand("git push", ctx)!, /\/lane-policy exception/);
});
for (const mode of ["rpc", "json", "print", "tui-refused", "lane TUI", "coordinator override"]) test(`human-only mint rejects ${mode}`, async () => {
	store(); const actor = mode === "lane TUI" ? ctx : { ...ctx, session: "coordinator-session" };
	const f = fake(actor, ["rpc", "json", "print"].includes(mode) ? mode : "tui");
	if (mode === "tui-refused") f.decline(); laneExtension(f.pi);
	await f.command(exceptionArgs.join(" ") + (mode === "coordinator override" ? " --override" : ""));
	assert.equal(loadPolicy().policy!.repositories[0].grants.length, 0);
});
test("confirmed coordinator TUI discloses unlimited attempts/window/reason and logs grant and admission metadata", async () => {
	store(); const f = fake({ ...ctx, session: "coordinator-session" }); laneExtension(f.pi);
	await f.command(exceptionArgs.join(" "));
	assert.equal(f.confirms, 1); assert.equal(loadPolicy().policy!.repositories[0].grants.length, 2);
	const confirmation = f.confirmationText[0]; assert.match(confirmation, /Fix production regression/); assert.match(confirmation, /lane/);
	assert.match(confirmation, /unlimited matching pushes and PR-create attempts until expiry or revocation/);
	assert.match(confirmation, /1 minute/); allowed(exceptionPush);
	const log = readFileSync(join(home, ".pi/agent/logs/guard-decisions.jsonl"), "utf8");
	assert.match(log, /exception-grant/); assert.match(log, /exception-admission/); assert.match(log, /urgent-fix/);
	assert.match(log, /Fix production regression/); assert.match(log, /coordinator-session/); assert.match(log, /writer-session/);
	assert.ok(!log.includes(exceptionRequest.body));
});
