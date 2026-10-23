import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolLister } from "./cratis-hooks-detect.ts";
import { cratisExtensionLoaded, cratisHookActive, cratisReadOnlyCommands, cratisSwitchOn, cratisVerdict, spawnRunner } from "./cratis-hooks-detect.ts";

/** What `pi.getAllTools()` lists when Pi loaded the Cratis extension of `repo` (via the .pi/extensions symlink), or from `path`. */
export const loaded = (repo: { root: string }, path = join(repo.root, ".pi", "extensions", "cratis-hooks", "index.ts")): ToolLister =>
	() => [{ name: "read", sourceInfo: { path: "<builtin:read>" } }, { name: "cratis_quality_gate", sourceInfo: { path } }];
/** Untrusted project: Pi skipped the project extensions, so no Cratis tool is registered. */
export const notLoaded: ToolLister = () => [{ name: "read", sourceInfo: { path: "<builtin:read>" } }];

/** Run `fn` with process.cwd() = `dir` (the Cratis extension selects its scripts from process.cwd()). */
export async function inCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
	const before = process.cwd();
	process.chdir(dir);
	try { return await fn(); } finally { process.chdir(before); }
}

/** A temp repo with the named Cratis hook scripts and (optionally) the Cratis Pi extension. */
export function cratisRepo(options: { scripts?: string[]; extension?: boolean; list?: string } = {}): { root: string; sub: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "cratis-detect-"));
	const scripts = join(root, ".cratis", "ai", "hooks", "scripts");
	mkdirSync(scripts, { recursive: true });
	for (const name of options.scripts ?? ["cratis-guard-secrets.sh", "cratis-guard-store-mutations.sh"]) writeFileSync(join(scripts, name), "#!/usr/bin/env bash\n");
	// A managed Cratis setup links .pi/extensions -> ../.cratis/ai/harnesses/pi/extensions; Pi loads its index.ts.
	if (options.extension ?? true) {
		const harness = join(root, ".cratis", "ai", "harnesses", "pi", "extensions");
		mkdirSync(join(harness, "cratis-hooks"), { recursive: true });
		writeFileSync(join(harness, "cratis-hooks", "index.ts"), "export default function () {}\n");
		writeFileSync(join(harness, "cratis-hooks", "quality-gate.ts"), "export const x = 1;\n");
		mkdirSync(join(root, ".pi"), { recursive: true });
		symlinkSync("../.cratis/ai/harnesses/pi/extensions", join(root, ".pi", "extensions"));
	}
	if (options.list !== undefined) writeFileSync(join(scripts, "cratis-store-mutations.json"), options.list);
	const sub = join(root, "src", "deep");
	mkdirSync(sub, { recursive: true });
	return { root, sub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("active only when script, extension and a matching registered tool all exist, per concern", () => {
	const both = cratisRepo();
	const onlySecrets = cratisRepo({ scripts: ["cratis-guard-secrets.sh"] });
	const noExtension = cratisRepo({ extension: false });
	try {
		const on = (r: { root: string }, concern: "secrets" | "store-mutations", tools = loaded(r)) => cratisHookActive(concern, { base: r.root, tools });
		assert.equal(on(both, "secrets"), true);
		assert.equal(on(both, "store-mutations"), true);
		assert.equal(cratisHookActive("secrets", { base: both.sub, tools: loaded(both) }), false); // a subdirectory is not process.cwd()'s .cratis
		assert.equal(on(onlySecrets, "secrets"), true);
		assert.equal(on(onlySecrets, "store-mutations"), false);
		assert.equal(cratisHookActive("secrets", { base: noExtension.root, tools: loaded(noExtension) }), false);
		assert.equal(cratisHookActive("secrets", { base: mkdtempSync(join(tmpdir(), "no-cratis-")) }), false);
	} finally { both.cleanup(); onlySecrets.cleanup(); noExtension.cleanup(); }
});

test("registration is proof: no tool (untrusted project), no lister, a throwing lister or a tool from elsewhere are not active", () => {
	const repo = cratisRepo();
	const elsewhere = cratisRepo();
	try {
		assert.equal(cratisExtensionLoaded(repo.root, loaded(repo)), true);
		assert.equal(cratisExtensionLoaded(repo.root, loaded(repo, join(repo.root, ".cratis", "ai", "harnesses", "pi", "extensions", "cratis-hooks", "quality-gate.ts"))), true);
		assert.equal(cratisExtensionLoaded(repo.root, notLoaded), false);
		assert.equal(cratisExtensionLoaded(repo.root, undefined), false);
		assert.equal(cratisExtensionLoaded(repo.root, () => { throw new Error("no pi"); }), false);
		assert.equal(cratisExtensionLoaded(repo.root, loaded(repo, join(elsewhere.root, ".cratis", "ai", "harnesses", "pi", "extensions", "cratis-hooks", "index.ts"))), false);
		assert.equal(cratisExtensionLoaded(repo.root, loaded(repo, "/nonexistent/package/corpus/cratis-hooks/index.ts")), false);
		assert.equal(cratisExtensionLoaded(repo.root, () => [{ name: "other_tool", sourceInfo: { path: join(repo.root, ".pi", "extensions", "cratis-hooks", "index.ts") } }]), false);
	} finally { repo.cleanup(); elsewhere.cleanup(); }
});

test("the Cratis switches are read from the environment, only when exactly 1", () => {
	assert.equal(cratisSwitchOn("secrets", { CRATIS_HOOKS_ALLOW_SECRET_READS: "1" }), true);
	assert.equal(cratisSwitchOn("secrets", { CRATIS_HOOKS_ALLOW_STORE_MUTATIONS: "1" }), false);
	assert.equal(cratisSwitchOn("store-mutations", { CRATIS_HOOKS_ALLOW_STORE_MUTATIONS: "1" }), true);
	assert.equal(cratisSwitchOn("store-mutations", { CRATIS_HOOKS_ALLOW_STORE_MUTATIONS: "true" }), false);
});

test("read-only list: read from the Cratis JSON; missing, unparsable or malformed → undefined", () => {
	const good = JSON.stringify({ group: "chronicle", readOnly: [{ command: "Jobs  List" }, { command: "brand new" }], mutating: [] });
	const repos = [cratisRepo({ list: good }), cratisRepo(), cratisRepo({ list: "{ not json" }), cratisRepo({ list: JSON.stringify({ group: "chronicle", readOnly: [{ command: 1 }], mutating: [] }) }), cratisRepo({ list: JSON.stringify({ group: "other", readOnly: [], mutating: [] }) })];
	try {
		assert.deepEqual(cratisReadOnlyCommands({ env: {}, base: repos[0].root, tools: loaded(repos[0]) }), ["jobs list", "brand new"]);
		for (const r of repos.slice(1)) assert.equal(cratisReadOnlyCommands({ env: {}, base: r.root, tools: loaded(r) }), undefined);
		assert.equal(cratisReadOnlyCommands({ env: {}, base: repos[0].root, tools: notLoaded }), undefined); // untrusted project: its JSON is not believed
		const override = join(repos[0].root, "other.json");
		writeFileSync(override, JSON.stringify({ group: "chronicle", readOnly: [{ command: "x y" }], mutating: [] }));
		assert.deepEqual(cratisReadOnlyCommands({ env: { CRATIS_HOOKS_STORE_MUTATIONS: override }, base: repos[0].root, tools: loaded(repos[0]) }), ["x y"]);
		const absent = cratisRepo({ scripts: [], list: good });
		repos.push(absent);
		assert.equal(cratisReadOnlyCommands({ env: {}, base: absent.root, tools: loaded(absent) }), undefined);
	} finally { for (const r of repos) r.cleanup(); }
});

test("cratisVerdict runs the real script only after positive registration: exit 2 blocks; exit 0, timeout, other root do not", () => {
	const repo = cratisRepo();
	const other = cratisRepo(); // a different root than the one holding the scripts
	const script = join(repo.root, ".cratis", "ai", "hooks", "scripts", "cratis-guard-store-mutations.sh");
	// Record the real runner's result so a failing assertion names its cause (#19).
	let last: unknown;
	const recording: typeof spawnRunner = (...args) => {
		const result = spawnRunner(...args);
		last = { status: result.status, error: (result.error as NodeJS.ErrnoException | undefined)?.code ?? result.error?.message };
		return result;
	};
	const v = (cwd: string, options: object) => { last = undefined; return cratisVerdict("store-mutations", cwd, "cratis chronicle observers replay x", { env: {}, base: repo.root, tools: loaded(repo), run: recording, ...options }); };
	const why = () => `runner result: ${JSON.stringify(last)}`;
	try {
		writeFileSync(script, '#!/usr/bin/env bash\ncat >/dev/null\n[ "$(pwd -P)" = "$(cd "$EXPECT_CWD" && pwd -P)" ] || exit 0\nexit 2\n');
		process.env.EXPECT_CWD = other.sub;
		// Run from repo.root (process.cwd()'s scripts) with the tool cwd = other.sub, exactly as the Cratis extension does.
		assert.equal(v(other.sub, {}), "blocked", why());
		writeFileSync(script, "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n"); // `hook_have jq || exit 0`
		assert.equal(v(repo.sub, {}), "none", why());
		// Real Cratis scripts read the payload first; the stub does too.
		writeFileSync(script, "#!/usr/bin/env bash\ncat >/dev/null\nexit 2\n");
		assert.equal(v(repo.sub, {}), "blocked", why());
		assert.equal(v(repo.sub, { env: { CRATIS_HOOKS_ALLOW_STORE_MUTATIONS: "1" }, run: () => { throw new Error("not run"); } }), "switch");
		assert.equal(v(repo.sub, { run: () => ({ status: 2, error: new Error("timeout") }) }), "none");
		assert.equal(v(repo.sub, { run: () => { throw new Error("spawn"); } }), "none");
		// The scripts live under another root than process.cwd(): the Cratis extension would not use them, nor do we.
		assert.equal(v(repo.sub, { base: other.root, tools: loaded(other) }), "none");
		// Not registered (untrusted project) or registered from elsewhere: nothing is spawned, the switch is not honoured.
		let spawns = 0;
		const counting = () => { spawns++; return { status: 2 }; };
		for (const tools of [notLoaded, undefined, loaded(repo, join(other.root, ".cratis", "ai", "harnesses", "pi", "extensions", "cratis-hooks", "index.ts"))]) {
			assert.equal(v(repo.sub, { tools, run: counting }), "none");
			assert.equal(v(repo.sub, { tools, run: counting, env: { CRATIS_HOOKS_ALLOW_STORE_MUTATIONS: "1" } }), "none");
			assert.equal(cratisVerdict("secrets", repo.sub, "printenv", { env: { CRATIS_HOOKS_ALLOW_SECRET_READS: "1" }, base: repo.root, tools, run: counting }), "none");
			assert.equal(cratisVerdict("secrets", repo.sub, "printenv", { env: {}, base: repo.root, tools, run: counting }), "none");
		}
		assert.equal(spawns, 0);
	} finally { delete process.env.EXPECT_CWD; repo.cleanup(); other.cleanup(); }
});
