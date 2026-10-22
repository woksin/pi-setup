import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cratisHookActive, cratisReadOnlyCommands, cratisSwitchOn, cratisVerdict } from "./cratis-hooks-detect.ts";

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
	// A managed Cratis setup links .pi/extensions -> ../.cratis/ai/harnesses/pi/extensions; the loaded extension is index.ts.
	if (options.extension ?? true) {
		mkdirSync(join(root, ".pi", "extensions", "cratis-hooks"), { recursive: true });
		writeFileSync(join(root, ".pi", "extensions", "cratis-hooks", "index.ts"), "export default function () {}\n");
	}
	if (options.list !== undefined) writeFileSync(join(scripts, "cratis-store-mutations.json"), options.list);
	const sub = join(root, "src", "deep");
	mkdirSync(sub, { recursive: true });
	return { root, sub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("active only when the script AND the Cratis Pi extension exist under the base, per concern", () => {
	const both = cratisRepo();
	const onlySecrets = cratisRepo({ scripts: ["cratis-guard-secrets.sh"] });
	const noExtension = cratisRepo({ extension: false });
	try {
		assert.equal(cratisHookActive(both.root, "secrets"), true);
		assert.equal(cratisHookActive(both.root, "store-mutations"), true);
		assert.equal(cratisHookActive(both.sub, "secrets"), false); // a subdirectory is not process.cwd()'s .cratis
		assert.equal(cratisHookActive(onlySecrets.root, "secrets"), true);
		assert.equal(cratisHookActive(onlySecrets.root, "store-mutations"), false);
		assert.equal(cratisHookActive(noExtension.root, "secrets"), false);
		assert.equal(cratisHookActive(mkdtempSync(join(tmpdir(), "no-cratis-")), "secrets"), false);
	} finally { both.cleanup(); onlySecrets.cleanup(); noExtension.cleanup(); }
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
		assert.deepEqual(cratisReadOnlyCommands({}, repos[0].root), ["jobs list", "brand new"]);
		for (const r of repos.slice(1)) assert.equal(cratisReadOnlyCommands({}, r.root), undefined);
		const override = join(repos[0].root, "other.json");
		writeFileSync(override, JSON.stringify({ group: "chronicle", readOnly: [{ command: "x y" }], mutating: [] }));
		assert.deepEqual(cratisReadOnlyCommands({ CRATIS_HOOKS_STORE_MUTATIONS: override }, repos[0].root), ["x y"]);
		const absent = cratisRepo({ scripts: [], list: good });
		repos.push(absent);
		assert.equal(cratisReadOnlyCommands({}, absent.root), undefined);
	} finally { for (const r of repos) r.cleanup(); }
});

test("cratisVerdict runs the real script: exit 2 blocks; exit 0 (e.g. missing jq), timeout, no extension do not; the switch is honoured", () => {
	const repo = cratisRepo();
	const other = cratisRepo(); // a different root than the one holding the scripts
	const script = join(repo.root, ".cratis", "ai", "hooks", "scripts", "cratis-guard-store-mutations.sh");
	try {
		writeFileSync(script, '#!/usr/bin/env bash\ncat >/dev/null\n[ "$(pwd -P)" = "$(cd "$EXPECT_CWD" && pwd -P)" ] || exit 0\nexit 2\n');
		process.env.EXPECT_CWD = other.sub;
		// Run from repo.root (process.cwd()'s scripts) with the tool cwd = other.sub, exactly as the Cratis extension does.
		assert.equal(cratisVerdict("store-mutations", other.sub, "cratis chronicle observers replay x", process.env, undefined, repo.root), "blocked");
		writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n"); // `hook_have jq || exit 0`
		assert.equal(cratisVerdict("store-mutations", repo.sub, "cratis chronicle observers replay x", {}, undefined, repo.root), "none");
		writeFileSync(script, "#!/usr/bin/env bash\nexit 2\n");
		assert.equal(cratisVerdict("store-mutations", repo.sub, "x", {}, undefined, repo.root), "blocked");
		assert.equal(cratisVerdict("store-mutations", repo.sub, "x", { CRATIS_HOOKS_ALLOW_STORE_MUTATIONS: "1" }, () => { throw new Error("not run"); }, repo.root), "switch");
		assert.equal(cratisVerdict("store-mutations", repo.sub, "x", {}, () => ({ status: 2, error: new Error("timeout") }), repo.root), "none");
		assert.equal(cratisVerdict("store-mutations", repo.sub, "x", {}, () => { throw new Error("spawn"); }, repo.root), "none");
		// The scripts live under another root than process.cwd(): the Cratis extension would not use them, nor do we.
		assert.equal(cratisVerdict("store-mutations", repo.sub, "x", {}, undefined, other.root), "none");
		// Cratis extension not loaded for this process: fail closed even though the script blocks.
		const bare = cratisRepo({ extension: false });
		writeFileSync(join(bare.root, ".cratis", "ai", "hooks", "scripts", "cratis-guard-store-mutations.sh"), "#!/usr/bin/env bash\nexit 2\n");
		assert.equal(cratisVerdict("store-mutations", bare.sub, "x", {}, undefined, bare.root), "none");
		bare.cleanup();
	} finally { delete process.env.EXPECT_CWD; repo.cleanup(); other.cleanup(); }
});
