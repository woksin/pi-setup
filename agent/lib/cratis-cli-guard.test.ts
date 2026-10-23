/** cratis-cli-guard: command-position parsing, prose/heredoc skip, read-only list, production match, orchestration deny. Complements guards.test.ts. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setGuards } from "./guards.ts";
import type { ToolLister } from "./cratis-hooks-detect.ts";
import { cratisRepo, inCwd, loaded, notLoaded } from "./cratis-hooks-detect.test.ts";
import cratisExtension, { DEFAULT_PRODUCTION_CONFIG, classifyCratisInvocations, forwardedPorts, loadProductionConfig, productionSources, productionTarget, readOnlyList } from "../extensions/cratis-cli-guard.ts";

const ENV = ["PATH", "PI_GUARDS_FILE", "PI_GUARDS_OFF", "PI_ORCH_ID", "PI_ORCH_MODE_FILE", "PI_ORCH_REPO_ROOT", "PI_ORCH_MESSAGES_DIR", "PI_GUARD_DECISIONS_LOG", "PI_CRATIS_PRODUCTION_FILE", "CHRONICLE_CONNECTION_STRING"];
let saved: Record<string, string | undefined>;
let dir: string;
let ctxFile: string;
const origSources = { ...productionSources };
beforeEach(() => {
	saved = Object.fromEntries(ENV.map(n => [n, process.env[n]]));
	dir = mkdtempSync(join(tmpdir(), "cratis-guard-"));
	process.env.PI_GUARDS_FILE = join(dir, "guards.json");
	for (const n of ["PI_GUARDS_OFF", "PI_ORCH_ID", "CHRONICLE_CONNECTION_STRING"]) delete process.env[n];
	process.env.PI_ORCH_MODE_FILE = join(dir, "mode");
	process.env.PI_ORCH_REPO_ROOT = join(dir, "repos");
	process.env.PI_ORCH_MESSAGES_DIR = join(dir, "messages");
	process.env.PI_GUARD_DECISIONS_LOG = join(dir, "decisions.jsonl");
	process.env.PI_CRATIS_PRODUCTION_FILE = join(dir, "prod.json");
	writeFileSync(process.env.PI_CRATIS_PRODUCTION_FILE, JSON.stringify(DEFAULT_PRODUCTION_CONFIG));
	// A stub `cratis` on PATH answers `context show`.
	ctxFile = join(dir, "context.txt");
	writeFileSync(ctxFile, "Context: default\nServer: chronicle://localhost:35000/Ada\nClient ID: dev\n");
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "cratis"), `#!/bin/sh\ncat "${ctxFile}"\n`);
	chmodSync(join(bin, "cratis"), 0o755);
	process.env.PATH = `${bin}:${saved.PATH}`;
	productionSources.readProcessList = async () => "/sbin/launchd\n";
	productionSources.readCratisConfig = () => JSON.stringify({ contexts: { default: { server: "chronicle://localhost:35000", clientId: "dev" } } });
	delete (globalThis as any)[Symbol.for("pi.guards")];
});
afterEach(() => {
	for (const [n, v] of Object.entries(saved)) if (v === undefined) delete process.env[n]; else process.env[n] = v;
	Object.assign(productionSources, origSources);
	delete (globalThis as any)[Symbol.for("pi.guards")];
});

const risky = (c: string) => classifyCratisInvocations(c).filter(i => !i.readOnly);
const found = (c: string) => classifyCratisInvocations(c);

test("command position: real calls are found after separators, assignments, wrappers, paths, subshells, bash -c, eval", () => {
	for (const c of [
		"cratis chronicle replay obs",
		"cd r; cratis chronicle replay obs",
		"cd r && cratis chronicle replay obs",
		"false || cratis chronicle replay obs",
		"echo hi | cratis chronicle replay obs",
		"echo hi\ncratis chronicle replay obs",
		"(cratis chronicle replay obs)",
		"echo $(cratis chronicle replay obs)",
		"echo `cratis chronicle replay obs`",
		"FOO=1 BAR=2 cratis chronicle replay obs",
		"sudo cratis chronicle replay obs",
		"env -i cratis chronicle replay obs",
		"time cratis chronicle replay obs",
		"timeout 30 cratis chronicle replay obs",
		"rtk proxy cratis chronicle replay obs",
		"/usr/local/bin/cratis chronicle replay obs",
		"bash -c 'cratis chronicle replay obs'",
		"sh -c \"cd x && cratis chronicle replay obs\"",
		"bash -c \"bash -c 'cratis chronicle replay obs'\"",
		"eval cratis chronicle replay obs",
		"eval 'cratis chronicle replay obs'",
	]) assert.equal(risky(c).length, 1, c);
});

test("command position: mentions in arguments, quotes, comments and paths are not calls", () => {
	for (const c of [
		"grep -rn cratis src",
		"grep 'cratis chronicle replay' notes.md",
		"ls ~/repos/cratis/chronicle",
		"echo cratis chronicle replay",
		"cat docs/cratis-chronicle-replay.md",
		"# cratis chronicle replay obs",
		"git log --grep='cratis chronicle replay'",
		"gh issue comment 1 --body 'ran cratis chronicle replay'",
		"npm run cratis -- chronicle replay",
		"cratis-cli chronicle replay obs",
		"mycratis chronicle replay obs",
	]) assert.deepEqual(found(c), [], c);
});

test("REGRESSION 2026-10-22: `cratis` inside heredoc text / commit message / echo string is not a command", () => {
	const rows: [string, string][] = [
		["heredoc to cat (quoted delimiter)", "cat > .ai-work/x/messages/m.md <<'EOF'\nPlease run cratis chronicle observers replay x\nEOF"],
		["heredoc to cat (unquoted, no expansion)", "cat > m.md <<EOF\nrun cratis chronicle observers replay x\nEOF"],
		["heredoc to tee", "tee m.md <<'EOF'\ncratis chronicle observers replay x\nEOF"],
		["heredoc with <<-", "cat > m.md <<-'EOF'\n\tcratis chronicle observers replay x\n\tEOF\n".replace("\tEOF\n", "EOF")],
		["git commit -m", "git commit -m 'fix: do not run cratis chronicle observers replay'"],
		["git commit -m double-quoted multi-line", "git commit -m \"title\n\ncratis chronicle observers replay x\n\""],
		["gh pr create --body", "gh pr create --title 'x' --body 'cratis chronicle observers replay x'"],
		["echo single-quoted", "echo 'cratis chronicle observers replay x'"],
		["echo double-quoted redirected", "echo \"cratis chronicle observers replay x\" > m.md"],
		["printf", "printf '%s\\n' 'cratis chronicle observers replay x'"],
	];
	for (const [name, command] of rows) assert.deepEqual(found(command), [], name);
});

test("prose in a heredoc consumed by git/gh or cat-to-stdout is not a command", () => {
	for (const c of [
		"git commit -m \"$(cat <<'EOF'\nfix\n\ncratis chronicle observers replay x\nEOF\n)\"",
		"git commit -F - <<'EOF'\ncratis chronicle observers replay x\nEOF",
		"gh pr create --body-file - <<'EOF'\ncratis chronicle observers replay x\nEOF",
		"cat <<'EOF'\ncratis chronicle observers replay x\nEOF",
		"cat <<EOF\ncratis chronicle observers replay x\nEOF",
		...["git -C dir commit -F -", "git -c user.name=x commit --file=- -a", "git tag -a v1 -F -", "git notes add -F -", "git apply", "git am",
			"gh pr create --body-file -", "gh pr edit 1 -F -", "gh pr comment 1 --body-file -", "gh pr review 1 --body-file -", "gh issue create --body-file -",
			"gh issue edit 1 --body-file -", "gh issue comment 1 -F -", "gh release create v1 --notes-file -", "gh release edit v1 --notes-file -",
			"gh api repos/o/r/issues --input -"].map(h => `${h} <<'EOF'\ncratis chronicle observers replay x\nEOF`),
		"git tag -a v1 -m \"$(cat <<'EOF'\ncratis chronicle observers replay x\nEOF\n)\"",
	]) assert.deepEqual(found(c), [], c);
});

test("heredocs fed to a shell/interpreter (directly, piped, or via substitution) are still classified", () => {
	for (const c of [
		"bash <<EOF\ncratis chronicle observers replay x\nEOF",
		"cat <<EOF | sh\ncratis chronicle observers replay x\nEOF",
		"python3 - <<EOF\ncratis chronicle observers replay x\nEOF",
		"eval \"$(cat <<EOF\ncratis chronicle observers replay x\nEOF\n)\"",
		"sh -c \"$(cat <<EOF\ncratis chronicle observers replay x\nEOF\n)\"",
		`git bisect run bash <<EOF\n%\nEOF`,
		`git rebase --exec bash -i HEAD~1 <<EOF\n%\nEOF`,
		`git rebase -x sh HEAD~1 <<EOF\n%\nEOF`,
		`git submodule foreach bash <<EOF\n%\nEOF`,
		`gh extension exec shell <<EOF\n%\nEOF`,
		`gh myalias <<EOF\n%\nEOF`,
		`git -c alias.x=sh x <<EOF\n%\nEOF`,
		`git -c core.pager=sh log <<EOF\n%\nEOF`,
		`git commit <<EOF\n%\nEOF`,
		`git status "$(cat <<EOF\n%\nEOF\n)"`,
		"git -c alias.x=foo commit -F - <<EOF\n$(cratis chronicle observers replay x)\nEOF",
	].map(c => c.replace(/%/g, "cratis chronicle observers replay x"))) assert.ok(found(c).length > 0, c);
});

test("heredoc skip is not a bypass: executed or expanded heredoc content is still classified", () => {
	for (const c of [
		"cat <<'EOF' | sh\ncratis chronicle replay x\nEOF",
		"cat > m.sh <<'EOF'\ncratis chronicle replay x\nEOF\nbash m.sh",
		"cat > m.md <<EOF\n$(cratis chronicle replay x)\nEOF",
		"bash <<'EOF'\ncratis chronicle replay x\nEOF",
	]) assert.ok(risky(c).length > 0, c);
});

test("read-only allow list: every built-in path is read-only, with trailing args/flags, any case", () => {
	const builtin = readOnlyList();
	assert.ok(builtin.length >= 20);
	for (const path of builtin) {
		const [inv] = found(`cratis chronicle ${path} --context dev -o json`);
		assert.equal(inv?.readOnly, true, path);
		assert.equal(found(`cratis chronicle ${path.toUpperCase()}`)[0]?.readOnly, true, `${path} upper`);
	}
	assert.deepEqual(found("cratis chronicle jobs list")[0], { text: "cratis chronicle jobs list", path: "chronicle jobs list", readOnly: true });
});

test("read-only list is exact: mutators, siblings, unknown chronicle commands and prefixes are not allowed", () => {
	for (const c of [
		"cratis chronicle observers replay x", "cratis chronicle jobs stop 1", "cratis chronicle jobs", "cratis chronicle failed-partitions retry p",
		"cratis chronicle users add bob", "cratis chronicle applications remove a", "cratis chronicle recommendations apply 1",
		"cratis chronicle brand-new-command", "cratis chronicle", "cratis chronicle observers", "cratis chronicle observers lists",
		"cratis foo chronicle jobs list", // words before the path fail closed
	]) assert.equal(found(c)[0]?.readOnly, false, c);
});

test("other groups, help/version flags and bare cratis are not guarded; prologue start is, interpret is not", () => {
	for (const c of ["cratis context show", "cratis ai init", "cratis run", "cratis init", "cratis --help", "cratis chronicle replay --help", "cratis chronicle -h", "cratis --version", "cratis", "cratis prologue interpret f"])
		assert.deepEqual(risky(c), [], c);
	assert.equal(risky("cratis prologue start")[0]?.path, "prologue start");
	assert.equal(risky("cratis prologue stop").length, 1);
});

test("extraReadOnly extends the list (normalised, 1–2 words), never shrinks it", () => {
	const extra = ["Observers Replay", "  diagnose  "];
	assert.ok(readOnlyList(extra).includes("observers replay"));
	assert.ok(readOnlyList(extra).includes("jobs list"));
	assert.equal(classifyCratisInvocations("cratis chronicle observers replay x", 0, extra)[0].readOnly, true);
	assert.equal(classifyCratisInvocations("cratis chronicle observers reset x", 0, extra)[0].readOnly, false);
	assert.equal(classifyCratisInvocations("cratis chronicle jobs list", 0, extra)[0].readOnly, true);
});

test("production match table: name heuristic, listed context/client/host, port-forward, unreadable context", () => {
	const dev = "Context: default\nServer: chronicle://localhost:35000/Ada\nClient ID: dev\n";
	const p = (t: string, ctx = dev, env: NodeJS.ProcessEnv = {}, ports?: number[]) => productionTarget(t, ctx, env, DEFAULT_PRODUCTION_CONFIG, ports);
	assert.equal(p("cratis chronicle replay x"), undefined);
	assert.equal(p("cratis chronicle replay products"), undefined); // "prod" inside a word
	assert.equal(p("cratis chronicle replay reproduction-db"), undefined);
	for (const t of ["--server chronicle://prod-db:1", "--server chronicle://db.production.example:1", "--context prod", "--context=PROD"])
		assert.match(p(`cratis chronicle replay x ${t}`, dev, {}) ?? "", /production target|not defined|listed/, t);
	assert.match(p("x", dev, { CHRONICLE_CONNECTION_STRING: "chronicle://production:35000" }) ?? "", /CHRONICLE_CONNECTION_STRING names a production target/);
	assert.match(p("x", "Context: production\nServer: s\n") ?? "", /active cratis context is a production context/);
	assert.match(p("x", "Context: ro-verify-9\nServer: chronicle://localhost:1\n") ?? "", /context ro-verify-9 is listed in cratis-production\.json/);
	assert.match(p("x", "Context: l3c-x\n") ?? "", /listed/);
	assert.match(p("x", "Context: a\nClient ID: Cratis-Studio\n") ?? "", /client id Cratis-Studio is listed/);
	assert.match(p("x", "Context: a\nServer: chronicle://x.upcloudlb.com:7443\n") ?? "", /host upcloudlb\.com/);
	assert.match(p("x --server chronicle://localhost:36000", dev, {}, [36000]) ?? "", /port of a running kubectl port-forward/);
	assert.equal(p("x --server chronicle://localhost:36000", dev, {}, [1234]), undefined);
	assert.equal(p("x --server chronicle://localhost:36000", dev, {}, undefined), undefined); // ps failure = unknown, not a deny
	assert.match(p("x", "(could not read the active context)") ?? "", /could not be read/);
});

test("loadProductionConfig: valid file honoured; invalid/missing → defaults", () => {
	const file = process.env.PI_CRATIS_PRODUCTION_FILE!;
	writeFileSync(file, JSON.stringify({ contexts: ["x-*"], clientIds: [], hosts: ["h"], portForwardIsProduction: false, extraReadOnly: ["a b"] }));
	assert.deepEqual(loadProductionConfig(), { contexts: ["x-*"], clientIds: [], hosts: ["h"], portForwardIsProduction: false, extraReadOnly: ["a b"] });
	writeFileSync(file, "{ nope");
	assert.deepEqual(loadProductionConfig(), DEFAULT_PRODUCTION_CONFIG);
	writeFileSync(file, JSON.stringify({ contexts: "x" }));
	assert.deepEqual(loadProductionConfig(), DEFAULT_PRODUCTION_CONFIG);
});

// ---- handler -----------------------------------------------------------------------------------

function app(hasUI: boolean, answer: string | undefined = "Yes, run it", cwd = "/nowhere", tools?: ToolLister) {
	let h: any;
	const selections: string[] = [];
	cratisExtension({ on: (_: string, fn: any) => { h = fn; }, ...(tools ? { getAllTools: tools } : {}) } as any);
	const ctx = { cwd, hasUI, ui: { notify: () => {}, select: async (t: string) => { selections.push(t); return answer; } } };
	return { selections, call: (command: string, toolName = "bash") => h({ toolName, input: { command } }, ctx) as Promise<any> };
}
const decisions = () => existsSync(process.env.PI_GUARD_DECISIONS_LOG!) ? readFileSync(process.env.PI_GUARD_DECISIONS_LOG!, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];

test("handler: non-bash tools, commands without cratis, read-only, and prose never prompt or block", async () => {
	const a = app(true);
	assert.equal(await a.call("cratis chronicle replay x", "read"), undefined);
	assert.equal(await a.call("ls"), undefined);
	assert.equal(await a.call("cratis chronicle jobs list"), undefined);
	assert.equal(await a.call("git commit -m 'cratis chronicle replay x'"), undefined);
	assert.equal(await a.call("cat > m.md <<'EOF'\ncratis chronicle replay x\nEOF"), undefined);
	assert.equal(a.selections.length, 0);
});

test("handler: outside orchestration, risky call blocks headless and asks with UI (decline blocks)", async () => {
	assert.match((await app(false).call("cratis chronicle replay x")).reason, /blocked without a UI/);
	const yes = app(true);
	assert.equal(await yes.call("cratis chronicle replay x"), undefined);
	assert.equal(yes.selections.length, 1);
	assert.equal((await app(true, "No").call("cratis chronicle replay x")).reason, "cratis-cli-guard: the user declined this cratis command.");
});

test("handler: orchestration denies production writes, allows+logs dev writes and read-only, never prompts", async () => {
	process.env.PI_ORCH_ID = "L0";
	const a = app(true);
	assert.equal(await a.call("cratis chronicle replay x"), undefined); // dev context
	const deny = await a.call("cratis chronicle replay x --server chronicle://prod-db:35000");
	assert.equal(deny.block, true);
	assert.match(deny.reason, /denied on production .*ask L0\. Matched rule: the command names a production target/);
	writeFileSync(ctxFile, "Context: ro-verify-1\nServer: chronicle://localhost:35931\nClient ID: x\n");
	assert.match((await a.call("cratis chronicle replay x")).reason, /ro-verify-1 is listed in cratis-production\.json/);
	assert.equal(await a.call("cratis chronicle jobs list"), undefined); // read-only on production is allowed
	assert.equal(await a.call("echo 'cratis chronicle replay x --server prod'"), undefined); // prose
	assert.equal(a.selections.length, 0);
	assert.deepEqual(decisions().map(d => d.decision), ["allow", "deny", "deny", "allow"]);
});

test("handler: orchestration denies when the active context cannot be read", async () => {
	process.env.PI_ORCH_ID = "L0";
	process.env.PATH = "/usr/bin:/bin"; // no `cratis` → execFile fails
	const result = await app(false).call("cratis chronicle replay x");
	assert.equal(result?.block, true);
	assert.match(result.reason, /could not be read/);
});

const SCRIPT = (repo: { root: string }, body: string) => writeFileSync(join(repo.root, ".cratis", "ai", "hooks", "scripts", "cratis-guard-store-mutations.sh"), `#!/usr/bin/env bash\n${body}\n`);
const loadedApp = (repo: { root: string; sub: string }, hasUI: boolean, answer?: string) => app(hasUI, answer, repo.sub, loaded(repo));

test("layering: stands down only when the real Cratis script blocks (exit 2); a silent exit 0 (missing jq) keeps the local block", async () => {
	const repo = cratisRepo();
	try {
		await inCwd(repo.root, async () => {
			SCRIPT(repo, "cat >/dev/null; exit 2");
			const on = loadedApp(repo, false);
			assert.equal(await on.call("cratis chronicle replay x"), undefined); // Cratis blocks it: no second block
			assert.match((await on.call("cratis prologue start db")).reason, /blocked without a UI/); // not covered by Cratis
			const ui = loadedApp(repo, true, "No");
			assert.equal(await ui.call("cratis chronicle replay x"), undefined);
			assert.equal(ui.selections.length, 0);

			SCRIPT(repo, "cat >/dev/null; exit 0"); // `hook_have jq || exit 0`: nobody would block it
			assert.match((await loadedApp(repo, false).call("cratis chronicle observers replay x")).reason, /blocked without a UI/);
			const asks = loadedApp(repo, true, "No");
			assert.equal((await asks.call("cratis chronicle replay x")).reason, "cratis-cli-guard: the user declined this cratis command.");
			assert.equal(asks.selections.length, 1);
			SCRIPT(repo, "exit 1"); // broken script: not a block verdict either
			assert.match((await loadedApp(repo, false).call("cratis chronicle replay x")).reason, /blocked without a UI/);
		});
	} finally { repo.cleanup(); }
});

test("layering: Cratis extension not registered (untrusted project) or registered from elsewhere → local blocks and no repository script runs", async () => {
	const repo = cratisRepo();
	const elsewhere = cratisRepo();
	const marker = join(repo.root, "ran");
	try {
		SCRIPT(repo, `touch "${marker}"; exit 2`);
		await inCwd(repo.root, async () => {
			for (const tools of [notLoaded, undefined, loaded(repo, join(elsewhere.root, ".cratis", "ai", "harnesses", "pi", "extensions", "cratis-hooks", "index.ts"))]) {
				assert.match((await app(false, undefined, repo.sub, tools).call("cratis chronicle replay x")).reason, /blocked without a UI/);
			}
			process.env.CRATIS_HOOKS_ALLOW_STORE_MUTATIONS = "1"; // the switch is not honoured either
			try { assert.match((await app(false, undefined, repo.sub, notLoaded).call("cratis chronicle replay x")).reason, /blocked without a UI/); }
			finally { delete process.env.CRATIS_HOOKS_ALLOW_STORE_MUTATIONS; }
		});
		assert.equal(existsSync(marker), false); // untrusted repository code was never executed
	} finally { repo.cleanup(); elsewhere.cleanup(); }
});

test("layering: Cratis scripts are selected from process.cwd(), not the tool cwd", async () => {
	const holder = cratisRepo(); // process.cwd(): holds the scripts the Cratis extension runs
	const toolRepo = cratisRepo(); // the tool's cwd: has its own scripts
	try {
		SCRIPT(holder, "cat >/dev/null; exit 2");
		SCRIPT(toolRepo, "exit 0");
		await inCwd(holder.root, async () => assert.equal(await app(false, undefined, toolRepo.sub, loaded(holder)).call("cratis chronicle replay x"), undefined));
		await inCwd(toolRepo.root, async () => assert.match((await app(false, undefined, holder.sub, loaded(toolRepo)).call("cratis chronicle replay x")).reason, /blocked without a UI/));
	} finally { holder.cleanup(); toolRepo.cleanup(); }
});

test("layering: the Cratis read-only list is read at runtime; unparsable or missing JSON falls back to the local list", async () => {
	const fresh = cratisRepo({ list: JSON.stringify({ group: "chronicle", readOnly: [{ command: "future inspect" }], mutating: [] }) });
	const broken = cratisRepo({ list: "{ nope" });
	try {
		assert.deepEqual(classifyCratisInvocations("cratis chronicle future inspect", 0, []).map(i => i.readOnly), [false]);
		await inCwd(fresh.root, async () => {
			const a = loadedApp(fresh, true, "No");
			assert.equal(await a.call("cratis chronicle future inspect"), undefined); // read-only per Cratis' list: never prompted
			assert.equal(a.selections.length, 0);
			assert.equal((await app(true, "No", fresh.sub, notLoaded).call("cratis chronicle future inspect")).block, true); // untrusted: list not believed
		});
		await inCwd(broken.root, async () => {
			SCRIPT(broken, "exit 0");
			const b = loadedApp(broken, true, "No");
			assert.equal(await b.call("cratis chronicle jobs list"), undefined); // built-in list still classifies reads
			assert.equal((await b.call("cratis chronicle future inspect")).block, true); // local list only: unknown → confirm → declined
		});
	} finally { fresh.cleanup(); broken.cleanup(); }
});

test("layering: with the Cratis switch set, a covered chronicle command runs unprompted unless the target is production", async () => {
	const repo = cratisRepo();
	process.env.CRATIS_HOOKS_ALLOW_STORE_MUTATIONS = "1";
	try {
		await inCwd(repo.root, async () => {
			const a = loadedApp(repo, true, "No");
			assert.equal(await a.call("cratis chronicle replay x"), undefined);
			assert.equal(a.selections.length, 0);
			assert.match((await a.call("cratis chronicle replay x --server chronicle://prod-db:35000")).reason, /denied on production/);
		});
	} finally { delete process.env.CRATIS_HOOKS_ALLOW_STORE_MUTATIONS; repo.cleanup(); }
});

// Cases moved from guards.test.ts: they need the fake pi/ctx harness and a mocked `cratis context show`.
const CRATIS_CONFIG = JSON.stringify({ activeContext: "default", contexts: {
	default: { server: "chronicle://localhost:35000", clientId: "dev" },
	"my-dev": { server: "chronicle://localhost:36000", clientId: "dev" },
	"fwd-dev": { server: "chronicle://localhost:37000", clientId: "dev" },
	studio: { server: "chronicle://localhost:1", clientId: "Cratis-Studio" },
	cloud: { server: "chronicle://x.upcloudlb.com:7443", clientId: "dev" },
} });
const HANG = "\u0000hang";
let context = "Test context: chronicle://user:<password>@localhost\n";

function fake(hasUI = true) {
	const handlers = new Map<string, Function[]>();
	const notices: { text: string; type: string }[] = [];
	const selections: { title: string; options: string[]; opts?: any }[] = [];
	let choice: string | undefined = "Yes, run it";
	const ctx: any = {
		hasUI,
		ui: {
			notify: (text: string, type: string) => notices.push({ text, type }),
			select: async (title: string, options: string[], opts?: any) => {
				selections.push({ title, options, opts });
				return choice === HANG ? new Promise<string | undefined>(() => {}) : choice;
			},
			setStatus: () => {},
		},
	};
	const pi: any = {
		registerCommand: () => {},
		on: (name: string, handler: Function) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => handlers.set(name, handlers.get(name)!.filter(value => value !== handler));
		},
		getActiveTools: () => ["bash", "job_start"],
		events: { on: () => () => {}, emit: () => {} },
	};
	return {
		pi, ctx, notices, selections,
		choose: (value: string | undefined) => { choice = value; },
		fire: async (name: string, event: unknown = {}) => {
			for (const handler of handlers.get(name) ?? []) {
				const result = await handler(event, ctx);
				if (result?.block) return result;
			}
			return undefined;
		},
	};
}
function bash(command: string, timeout?: number) {
	return { toolName: "bash", input: { command, ...(timeout !== undefined ? { timeout } : {}) } };
}

describe("guards.test.ts harness cases", () => {
	beforeEach(() => {
		context = "Test context: chronicle://user:<password>@localhost\n";
		productionSources.readCratisConfig = () => CRATIS_CONFIG;
		mock.method(console, "warn", () => {});
		mock.method(childProcess, "execFile", (_command: string, _args: string[], _options: unknown, callback: Function) => {
			if (context === "") callback(new Error("no context"), "");
			else callback(null, context);
		});
		syncBuiltinESMExports();
	});
	afterEach(() => {
		mock.restoreAll();
		syncBuiltinESMExports();
	});

	test("cratis on prompts with the existing title/options, allows yes and blocks no", async () => {
		const app = fake();
		cratisExtension(app.pi);
		assert.equal(await app.fire("tool_call", bash("cratis chronicle replay observer")), undefined);
		assert.deepEqual(app.selections[0].options, ["No", "Yes, run it"]);
		assert.equal(app.selections[0].title,
			"⚠️ cratis command that may change state:\n\n  cratis chronicle replay observer\n\nActive context:\nTest context: chronicle://user:***@localhost\n\n" +
			"Check the target (--server / CHRONICLE_CONNECTION_STRING override the context). Run it?");
		app.choose("No");
		assert.deepEqual(await app.fire("tool_call", bash("cratis prologue start")), {
			block: true, reason: "cratis-cli-guard: the user declined this cratis command.",
		});
		app.choose(undefined);
		assert.equal((await app.fire("tool_call", bash("cratis chronicle replay observer")))?.block, true);
		assert.equal(app.notices.length, 0);
	});

	test("cratis on still blocks without UI", async () => {
		const app = fake(false);
		cratisExtension(app.pi);
		const result = await app.fire("tool_call", bash("cratis chronicle replay observer"));
		assert.equal(result?.block, true);
		assert.match(result.reason, /state-changing or unrecognised cratis command\(s\) blocked without a UI/);
		assert.equal(app.selections.length, 0);
	});

	test("cratis off allows risky calls without prompting, including headless, and does not notify for reads", async () => {
		setGuards("cratis", true);
		for (const hasUI of [true, false]) {
			const app = fake(hasUI);
			cratisExtension(app.pi);
			for (const command of ["cratis chronicle replay observer", "cratis prologue start"]) {
				assert.equal(await app.fire("tool_call", bash(command)), undefined);
			}
			assert.equal(app.selections.length, 0);
			assert.equal(app.notices.length, hasUI ? 2 : 0);
			if (hasUI) assert.equal(app.notices[0].text, "cratis-cli-guard off: allowed 'cratis chronicle replay observer'");
			await app.fire("tool_call", bash("cratis chronicle jobs list"));
			await app.fire("tool_call", bash("printf 'cratis chronicle replay'"));
			assert.equal(app.notices.length, hasUI ? 2 : 0);
		}
	});

	test("cratis classifier ignores heredoc bodies and quoted prose but still finds real command lines", () => {
		// Regression for the L0 stall: prose in a message file was classified as a cratis call.
		for (const command of [
			"cat > .ai-work/x/messages/m.md <<'EOF'\n...run cratis chronicle observers replay...\nEOF",
			"mkdir -p .ai-work/x/messages && cat > .ai-work/x/messages/m.md <<'EOF'\ncratis chronicle observers replay x\nEOF\necho done >> STATE.md",
			"cat > a.md <<'EOF'\ncratis chronicle observers replay x\nEOF\nmv a.md b.md && cat b.md",
			"echo 'cratis chronicle observers replay' > .ai-work/m.md && printf '%s' \"cratis chronicle replay\"",
			"git commit -m 'cratis chronicle observers replay'",
		]) assert.deepEqual(classifyCratisInvocations(command), [], command);
		for (const command of [
			"cratis chronicle observers replay x",
			"cd repo && cratis chronicle observers replay x",
			"cat > a.md <<'EOF'\nx\nEOF\ncratis chronicle observers replay x",
			"cat > m.sh <<'EOF'\ncratis chronicle observers replay x\nEOF\nbash m.sh",
			"cat > m.sh <<'EOF'\ncratis chronicle observers replay x\nEOF\nchmod +x m.sh; ./m.sh",
			"PATH=/tmp:$PATH; cat > m.md <<'EOF'\ncratis chronicle observers replay x\nEOF",
			"tee m.md <<'EOF' | bash\ncratis chronicle observers replay x\nEOF",
			"cat <<'EOF' | sh\ncratis chronicle observers replay x\nEOF",
			"cat > m.md <<EOF\n$(cratis chronicle observers replay x)\nEOF\necho hi",
			"bash -c 'cratis chronicle observers replay x'",
		]) assert.equal(classifyCratisInvocations(command).filter(i => !i.readOnly).length > 0, true, command);
	});

	test("cratis heredoc message with prose never prompts, in any session", async () => {
		const app = fake();
		cratisExtension(app.pi);
		assert.equal(await app.fire("tool_call", bash("cat > .ai-work/x/messages/m.md <<'EOF'\n...run cratis chronicle observers replay...\nEOF")), undefined);
		assert.equal(app.selections.length, 0);
	});

	test("cratis prompt outside orchestration has a 60 s limit and a timeout denies with an actionable reason", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const app = fake();
		cratisExtension(app.pi);
		app.choose(HANG);
		const pending = app.fire("tool_call", bash("cratis chronicle replay observer"));
		for (let i = 0; i < 5 && !app.selections.length; i++) await new Promise(resolve => setImmediate(resolve));
		assert.equal(app.selections[0].opts.timeout, 60000);
		mock.timers.tick(60000);
		const result = await pending;
		assert.equal(result?.block, true);
		assert.match(result.reason, /no answer to the confirmation within 60 s[\s\S]*Report the exact command/);
		assert.deepEqual(decisions().map(d => [d.guard, d.decision]), [["cratis", "timeout:deny"]]);
		assert.equal(existsSync(process.env.PI_ORCH_MESSAGES_DIR!), false);
	});

	test("cratis in orchestration never prompts: allows and logs, denies production targets immediately", async () => {
		process.env.PI_ORCH_ID = "L0";
		for (const hasUI of [true, false]) {
			const app = fake(hasUI);
			cratisExtension(app.pi);
			app.choose(HANG);
			assert.equal(await app.fire("tool_call", bash("cratis chronicle observers replay x")), undefined);
			assert.equal(await app.fire("tool_call", bash("cratis prologue start")), undefined);
			for (const command of ["cratis chronicle observers replay x --server chronicle://prod-db:35000", "CHRONICLE_CONNECTION_STRING=chronicle://production:35000 cratis chronicle jobs stop 1"]) {
				const result = await app.fire("tool_call", bash(command));
				assert.equal(result?.block, true, command);
				assert.match(result.reason, /denied on production \(read-only list: diagnose, auth status,[^)]*\); ask L0\. Matched rule: the command names a production target\./);
			}
			context = "Context: production\nServer: chronicle://cluster:35000\n";
			assert.match((await app.fire("tool_call", bash("cratis chronicle observers replay x")))?.reason, /active cratis context is a production context/);
			context = "";
			assert.match((await app.fire("tool_call", bash("cratis chronicle observers replay x")))?.reason, /could not be read/);
			context = "Test context: chronicle://user:<password>@localhost\n";
			assert.equal(await app.fire("tool_call", bash("cratis chronicle jobs list")), undefined);
			assert.equal(app.selections.length, 0);
		}
		assert.deepEqual(decisions().map(d => d.decision), ["allow", "allow", "deny", "deny", "deny", "deny", "allow", "allow", "allow", "deny", "deny", "deny", "deny", "allow"]);
		assert.equal(productionTarget("cratis chronicle replay --server chronicle://localhost:35000", "dev"), undefined);
		assert.match(productionTarget("x", "dev", { CHRONICLE_CONNECTION_STRING: "chronicle://prod:1" })!, /CHRONICLE_CONNECTION_STRING/);
		assert.equal(productionTarget("cratis chronicle replay products", "dev"), undefined);
	});

	async function orchestrated(command: string, ctxText: string, ps = "/sbin/launchd\n", hasUI = true) {
		process.env.PI_ORCH_ID = "L0";
		context = ctxText;
		productionSources.readProcessList = async () => { if (ps === "FAIL") throw new Error("ps failed"); return ps; };
		const app = fake(hasUI);
		cratisExtension(app.pi);
		app.choose(HANG);
		const result = await app.fire("tool_call", bash(command));
		assert.equal(app.selections.length, 0, "never prompts in orchestration");
		return result;
	}
	const PROD_CTX = "Context: ro-verify-1\nServer: chronicle://localhost:35931/x\nClient ID: someone\n";
	const DEV_CTX = "Context: default\nServer: chronicle://localhost:35000/Ada\nClient ID: dev\n";

	test("production list: read-only commands stay allowed (and logged), state-changing ones are denied", async () => {
		for (const command of ["cratis chronicle observers list --context ro-verify-1", "cratis chronicle events tail --context ro-verify-1", "cratis chronicle events get x", "cratis chronicle jobs list"]) {
			assert.equal(await orchestrated(command, PROD_CTX, "kubectl port-forward svc/chronicle 35931:35000\n"), undefined, command);
		}
		assert.deepEqual(decisions().map(d => d.decision), ["allow", "allow", "allow", "allow"]);
		assert.match(decisions()[0].detail, /^read-only: cratis chronicle observers list/);
		for (const command of ["cratis chronicle observers replay x --context ro-verify-1", "cratis chronicle observers replay x"]) {
			const result = await orchestrated(command, command.includes("--context") ? DEV_CTX : PROD_CTX);
			assert.equal(result?.block, true, command);
			assert.match(result.reason, /context ro-verify-1 is listed in cratis-production\.json/);
		}
	});

	test("production list: listed context, client id, host and port-forward port deny; ps failure and dev context do not", async () => {
		const replay = "cratis chronicle observers replay x";
		assert.match((await orchestrated(`${replay} --context=L3C-9`, DEV_CTX))?.reason, /context L3C-9 is listed/);
		assert.match((await orchestrated(replay, "Context: diag-77\nServer: chronicle://localhost:1\n"))?.reason, /context diag-77 is listed/);
		assert.match((await orchestrated(replay, "Context: x\nServer: chronicle://localhost:1\nClient ID: Cratis-Studio\n"))?.reason, /client id Cratis-Studio is listed/);
		assert.match((await orchestrated(`${replay} --server chronicle://a.upcloudlb.com:7443`, DEV_CTX))?.reason, /host upcloudlb\.com/);
		assert.match((await orchestrated(replay, "Context: x\nServer: chronicle://localhost:35931/e\n", "kubectl --kubeconfig k port-forward -n infrastructure svc/chronicle 35931:35000\n"))?.reason, /localhost:35931 .*port-forward/);
		assert.match((await orchestrated(`${replay} --server chronicle://localhost:4444`, DEV_CTX, "/usr/bin/kubectl port-forward svc/c 4444\n"))?.reason, /localhost:4444/);
		// ps failure alone, unlisted localhost contexts, and a port-forward on another port are allowed.
		assert.equal(await orchestrated(replay, "Context: x\nServer: chronicle://localhost:35931/e\n", "FAIL"), undefined);
		assert.equal(await orchestrated(replay, DEV_CTX), undefined);
		assert.equal(await orchestrated(replay, DEV_CTX, "kubectl port-forward svc/chronicle 35931:35000\n"), undefined);
		assert.match((await orchestrated(replay, DEV_CTX, "kubectl port-forward svc/chronicle 35000:35000\n"))?.reason, /localhost:35000/);
	});

	test("production list: read at every check, missing or invalid file falls back to defaults with one log line", async () => {
		const replay = "cratis chronicle observers replay x";
		writeFileSync(process.env.PI_CRATIS_PRODUCTION_FILE!, JSON.stringify({ ...DEFAULT_PRODUCTION_CONFIG, contexts: ["default"] }));
		assert.match((await orchestrated(replay, DEV_CTX))?.reason, /context default is listed/);
		unlinkSync(process.env.PI_CRATIS_PRODUCTION_FILE!);
		assert.match((await orchestrated(`${replay} --context ro-check-1`, DEV_CTX))?.reason, /listed in cratis-production\.json/);
		assert.deepEqual(decisions().map(d => d.decision), ["deny", "config", "deny"]);
		writeFileSync(process.env.PI_CRATIS_PRODUCTION_FILE!, "{not json");
		assert.match((await orchestrated(`${replay} --context diag-1`, DEV_CTX))?.reason, /listed in/);
	});

	test("production list: --context not in the list is looked up in ~/.cratis/config.json", async () => {
		const replay = "cratis chronicle observers replay x";
		assert.equal(await orchestrated(`${replay} --context my-dev`, PROD_CTX), undefined, "active prod context does not leak into a named dev context");
		assert.equal(await orchestrated(`${replay} --context=MY-DEV`, DEV_CTX, "kubectl port-forward svc/c 35000:35000\n"), undefined);
		assert.match((await orchestrated(`${replay} --context fwd-dev`, DEV_CTX, "kubectl port-forward svc/c 37000:35000\n"))?.reason, /localhost:37000 .*port-forward/);
		assert.match((await orchestrated(`${replay} --context studio`, DEV_CTX))?.reason, /client id Cratis-Studio is listed/);
		assert.match((await orchestrated(`${replay} --context cloud`, DEV_CTX))?.reason, /host upcloudlb\.com/);
		assert.match((await orchestrated(`${replay} --context nope`, DEV_CTX))?.reason, /context nope is not defined in ~\/\.cratis\/config\.json/);
		productionSources.readCratisConfig = () => { throw new Error("no file"); };
		assert.match((await orchestrated(`${replay} --context my-dev`, DEV_CTX))?.reason, /context my-dev is not defined/);
		assert.equal(await orchestrated("cratis chronicle observers list --context nope", DEV_CTX), undefined, "read-only is never looked up");
	});

	test("production list: extraReadOnly extends the read-only list; the denial names command, list and rule", async () => {
		const file = process.env.PI_CRATIS_PRODUCTION_FILE!;
		const command = "cratis chronicle events read --context ro-verify-1";
		const denied = await orchestrated(command, DEV_CTX);
		assert.equal(denied?.block, true);
		assert.ok(denied.reason.includes(command));
		assert.ok(denied.reason.includes(`denied on production (read-only list: ${readOnlyList().join(", ")}); ask L0`));
		assert.match(denied.reason, /Matched rule: context ro-verify-1 is listed in cratis-production\.json/);
		assert.equal(readOnlyList().join(", ").startsWith("diagnose, auth status, applications list"), true);
		writeFileSync(file, JSON.stringify({ ...DEFAULT_PRODUCTION_CONFIG, extraReadOnly: ["Events Read", "observers  STATE"] }));
		assert.equal(await orchestrated(command, DEV_CTX), undefined);
		assert.equal(await orchestrated("cratis chronicle observers state x --context ro-verify-1", DEV_CTX), undefined);
		const other = await orchestrated("cratis chronicle observers replay x --context ro-verify-1", DEV_CTX);
		assert.ok(other.reason.includes(`(read-only list: ${readOnlyList().join(", ")}, events read, observers state); ask L0`));
		assert.deepEqual(classifyCratisInvocations("cratis chronicle events read", 0, ["events read"]).map(i => i.readOnly), [true]);
		assert.deepEqual(classifyCratisInvocations("cratis chronicle events read").map(i => i.readOnly), [false]);
	});

	test("production list: outside orchestration the prompt shows the production reason", async () => {
		const app = fake();
		cratisExtension(app.pi);
		context = PROD_CTX;
		await app.fire("tool_call", bash("cratis chronicle observers replay x"));
		assert.match(app.selections[0].title, /PRODUCTION: context ro-verify-1 is listed in cratis-production\.json/);
		assert.deepEqual(app.selections[0].options, ["No", "Yes, run it"]);
	});

	test("forwardedPorts parses kubectl port-forward forms and reports ps failure as unknown", async () => {
		productionSources.readProcessList = async () => "kubectl port-forward -n infrastructure svc/chronicle 35931:35000\nkubectl port-forward pod/x 8080\nkubectl port-forward svc/y :9000\nvim kubectl-port-forward.md\n";
		assert.deepEqual(await forwardedPorts(), [35931, 8080]);
		productionSources.readProcessList = async () => { throw new Error("x"); };
		assert.equal(await forwardedPorts(), undefined);
	});
});
