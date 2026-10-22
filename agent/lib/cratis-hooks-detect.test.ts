import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cratisHookActive, cratisReadOnlyCommands, cratisSecretsStandsDown, cratisSwitchOn, repoRoot } from "./cratis-hooks-detect.ts";

/** A temp repo with the named Cratis hook scripts and (optionally) the Cratis Pi extension. */
export function cratisRepo(options: { scripts?: string[]; extension?: boolean; list?: string } = {}): { root: string; sub: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "cratis-detect-"));
	const scripts = join(root, ".cratis", "ai", "hooks", "scripts");
	mkdirSync(scripts, { recursive: true });
	for (const name of options.scripts ?? ["cratis-guard-secrets.sh", "cratis-guard-store-mutations.sh"]) writeFileSync(join(scripts, name), "#!/usr/bin/env bash\n");
	if (options.extension ?? true) mkdirSync(join(root, ".cratis", "ai", "harnesses", "pi", "extensions", "cratis-hooks"), { recursive: true });
	if (options.list !== undefined) writeFileSync(join(scripts, "cratis-store-mutations.json"), options.list);
	const sub = join(root, "src", "deep");
	mkdirSync(sub, { recursive: true });
	return { root, sub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("active only when the script AND the Cratis Pi extension exist, per concern, from a subdirectory", () => {
	const both = cratisRepo();
	const onlySecrets = cratisRepo({ scripts: ["cratis-guard-secrets.sh"] });
	const noExtension = cratisRepo({ extension: false });
	try {
		assert.equal(repoRoot(both.sub), both.root);
		assert.equal(cratisHookActive(both.sub, "secrets"), true);
		assert.equal(cratisHookActive(both.sub, "store-mutations"), true);
		assert.equal(cratisHookActive(onlySecrets.sub, "secrets"), true);
		assert.equal(cratisHookActive(onlySecrets.sub, "store-mutations"), false);
		assert.equal(cratisHookActive(noExtension.sub, "secrets"), false);
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
		assert.deepEqual(cratisReadOnlyCommands(repos[0].sub, {}), ["jobs list", "brand new"]);
		for (const r of repos.slice(1)) assert.equal(cratisReadOnlyCommands(r.sub, {}), undefined);
		const override = join(repos[0].root, "other.json");
		writeFileSync(override, JSON.stringify({ group: "chronicle", readOnly: [{ command: "x y" }], mutating: [] }));
		assert.deepEqual(cratisReadOnlyCommands(repos[0].sub, { CRATIS_HOOKS_STORE_MUTATIONS: override }), ["x y"]);
		const absent = cratisRepo({ scripts: [], list: good });
		repos.push(absent);
		assert.equal(cratisReadOnlyCommands(absent.sub, {}), undefined);
	} finally { for (const r of repos) r.cleanup(); }
});

test("cratisSecretsStandsDown: real script exit 2 stands down, exit 0 / timeout / absent do not, the switch always does", () => {
	const repo = cratisRepo();
	const script = join(repo.root, ".cratis", "ai", "hooks", "scripts", "cratis-guard-secrets.sh");
	try {
		writeFileSync(script, '#!/usr/bin/env bash\ngrep -q printenv && { echo blocked >&2; exit 2; }\nexit 0\n');
		assert.equal(cratisSecretsStandsDown(repo.sub, "printenv", {}), true);
		assert.equal(cratisSecretsStandsDown(repo.sub, "helm get values x", {}), false);
		assert.equal(cratisSecretsStandsDown(repo.sub, "helm get values x", { CRATIS_HOOKS_ALLOW_SECRET_READS: "1" }), true);
		assert.equal(cratisSecretsStandsDown(repo.sub, "printenv", {}, () => ({ status: 2, error: new Error("timeout") })), false);
		assert.equal(cratisSecretsStandsDown(mkdtempSync(join(tmpdir(), "no-cratis-")), "printenv", {}), false);
	} finally { repo.cleanup(); }
});
