/** cratis-cli-guard: command-position parsing, prose/heredoc skip, read-only list, production match, orchestration deny. Complements guards.test.ts. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cratisRepo } from "./cratis-hooks-detect.test.ts";
import cratisExtension, { DEFAULT_PRODUCTION_CONFIG, classifyCratisInvocations, loadProductionConfig, productionSources, productionTarget, readOnlyList } from "../extensions/cratis-cli-guard.ts";

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

// FINDING (reported, not fixed): the heredoc skip only covers `cat`/`tee` writing a file. A heredoc consumed by git/gh
// (the usual commit-message / PR-body form) or `cat` to stdout takes the legacy full scan, so prose naming a cratis
// command is still classified as a call. Fails safe (prompt / headless block) but is the 2026-10-22 false-positive class.
test("KNOWN GAP: prose in a heredoc consumed by git/gh or cat-to-stdout is not a command", { todo: "false positive: only cat/tee file-writing heredocs are skipped" }, () => {
	for (const c of [
		"git commit -m \"$(cat <<'EOF'\nfix\n\ncratis chronicle observers replay x\nEOF\n)\"",
		"git commit -F - <<'EOF'\ncratis chronicle observers replay x\nEOF",
		"gh pr create --body-file - <<'EOF'\ncratis chronicle observers replay x\nEOF",
		"cat <<'EOF'\ncratis chronicle observers replay x\nEOF",
	]) assert.deepEqual(found(c), [], c);
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

function app(hasUI: boolean, answer: string | undefined = "Yes, run it", cwd = "/nowhere") {
	let h: any;
	const selections: string[] = [];
	cratisExtension({ on: (_: string, fn: any) => { h = fn; } } as any);
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

test("layering: with the Cratis store-mutations hook the chronicle guard stands down; without it, it blocks as before", async () => {
	const withHook = cratisRepo();
	const without = cratisRepo({ scripts: ["cratis-guard-secrets.sh"] });
	try {
		const on = app(false, undefined, withHook.sub);
		assert.equal(await on.call("cratis chronicle replay x"), undefined); // Cratis blocks it; no second block
		assert.match((await on.call("cratis prologue start db")).reason, /blocked without a UI/); // not covered by Cratis
		assert.match((await app(false, undefined, without.sub).call("cratis chronicle replay x")).reason, /blocked without a UI/);
		const ui = app(true, "No", withHook.sub);
		assert.equal(await ui.call("cratis chronicle replay x"), undefined);
		assert.equal(ui.selections.length, 0);
	} finally { withHook.cleanup(); without.cleanup(); }
});

test("layering: the Cratis read-only list is read at runtime; unparsable or missing JSON falls back to the local list", async () => {
	const list = JSON.stringify({ group: "chronicle", readOnly: [{ command: "future inspect" }], mutating: [] });
	const fresh = cratisRepo({ list });
	const broken = cratisRepo({ list: "{ nope" });
	try {
		assert.deepEqual(classifyCratisInvocations("cratis chronicle future inspect", 0, []).map(i => i.readOnly), [false]);
		// A command only the Cratis list calls read-only is allowed without a prompt (and is never prompted for).
		const a = app(true, "No", fresh.sub);
		assert.equal(await a.call("cratis chronicle future inspect"), undefined);
		assert.equal(a.selections.length, 0);
		// Unparsable list: Cratis refuses every chronicle command itself, so the local guard stays out of the way,
		// and the built-in read-only list still classifies reads (no prompt either way).
		const b = app(true, "No", broken.sub);
		assert.equal(await b.call("cratis chronicle jobs list"), undefined);
		assert.equal(await b.call("cratis chronicle replay x"), undefined);
		assert.equal(b.selections.length, 0);
	} finally { fresh.cleanup(); broken.cleanup(); }
});

test("layering: with the Cratis switch set, a covered chronicle command runs unprompted unless the target is production", async () => {
	const repo = cratisRepo();
	process.env.CRATIS_HOOKS_ALLOW_STORE_MUTATIONS = "1";
	try {
		const a = app(true, "No", repo.sub);
		assert.equal(await a.call("cratis chronicle replay x"), undefined);
		assert.equal(a.selections.length, 0);
		assert.match((await a.call("cratis chronicle replay x --server chronicle://prod-db:35000")).reason, /denied on production/);
	} finally { delete process.env.CRATIS_HOOKS_ALLOW_STORE_MUTATIONS; repo.cleanup(); }
});
