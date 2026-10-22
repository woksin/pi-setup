/** mcp-project-trust (early extension): allow/deny table for project MCP configs. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module reads PI_CODING_AGENT_DIR / PI_MCP_CONFIG_MODE at import time and applies the mode on load: isolate both.
const agent = realpathSync(mkdtempSync(join(tmpdir(), "mcp-trust-agent-")));
const savedEnv = { dir: process.env.PI_CODING_AGENT_DIR, mode: process.env.PI_MCP_CONFIG_MODE };
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_MCP_CONFIG_MODE;
const mod = await import("../early-extensions/mcp-project-trust.ts");
const { isFolderTrusted } = mod;
const extension = mod.default;
process.on("exit", () => {
	for (const [k, v] of [["PI_CODING_AGENT_DIR", savedEnv.dir], ["PI_MCP_CONFIG_MODE", savedEnv.mode]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const folder = (name: string) => { const p = join(realpathSync(mkdtempSync(join(tmpdir(), "mcp-trust-"))), name); mkdirSync(p, { recursive: true }); return p; };
const trust = (decisions: Record<string, boolean> | undefined) => decisions === undefined ? writeFileSync(join(agent, "trust.json"), "{ not json") : writeFileSync(join(agent, "trust.json"), JSON.stringify(decisions));
const settings = (s: object) => writeFileSync(join(agent, "settings.json"), JSON.stringify(s));
const reset = () => { trust({}); settings({}); };

test("CLI flags win: --approve/-a trust, --no-approve/-na distrust, and distrust beats approve", () => {
	reset();
	const cwd = folder("p");
	trust({ [cwd]: false });
	assert.equal(isFolderTrusted(cwd, ["node", "pi", "--approve"]), true);
	assert.equal(isFolderTrusted(cwd, ["node", "pi", "-a"]), true);
	trust({ [cwd]: true });
	assert.equal(isFolderTrusted(cwd, ["node", "pi", "--no-approve"]), false);
	assert.equal(isFolderTrusted(cwd, ["node", "pi", "-na"]), false);
	assert.equal(isFolderTrusted(cwd, ["node", "pi", "-a", "--no-approve"]), false);
});

test("saved decisions: exact folder true/false; closest ancestor wins; deeper false beats parent true", () => {
	reset();
	const parent = folder("parent");
	const child = join(parent, "a", "b");
	mkdirSync(child, { recursive: true });
	trust({ [parent]: true });
	assert.equal(isFolderTrusted(child, []), true);
	assert.equal(isFolderTrusted(parent, []), true);
	trust({ [parent]: true, [join(parent, "a")]: false });
	assert.equal(isFolderTrusted(child, []), false);
	assert.equal(isFolderTrusted(parent, []), true);
	trust({ [parent]: false, [child]: true });
	assert.equal(isFolderTrusted(child, []), true);
	assert.equal(isFolderTrusted(join(parent, "a"), []), false);
	trust({ [child]: "yes" as unknown as boolean }); // only literal true counts
	assert.equal(isFolderTrusted(child, []), false);
});

test("a saved false is final: defaultProjectTrust never overrides it", () => {
	reset();
	const cwd = folder("p");
	trust({ [cwd]: false });
	settings({ defaultProjectTrust: "trust" });
	assert.equal(isFolderTrusted(cwd, []), false);
});

test("no decision: only allow-values of defaultProjectTrust trust; ask/unknown/missing do not", () => {
	const cwd = folder("p");
	for (const [value, expected] of [["trust", true], ["always", true], ["allow", true], [true, true], ["ask", false], ["never", false], ["deny", false], [false, false], [undefined, false], ["TRUST", false], [1, false]] as const) {
		trust({});
		settings(value === undefined ? {} : { defaultProjectTrust: value });
		assert.equal(isFolderTrusted(cwd, []), expected, String(value));
	}
});

test("missing or corrupt trust.json / settings.json fail closed (untrusted)", () => {
	const cwd = folder("p");
	trust(undefined); // corrupt
	settings({});
	assert.equal(isFolderTrusted(cwd, []), false);
	trust(undefined);
	settings({ defaultProjectTrust: "trust" }); // corrupt trust file → no decisions → falls to default
	assert.equal(isFolderTrusted(cwd, []), true);
	reset();
	writeFileSync(join(agent, "settings.json"), "{ nope");
	assert.equal(isFolderTrusted(cwd, []), false);
	assert.equal(isFolderTrusted(join(tmpdir(), "does-not-exist-" + process.pid), []), false); // nonexistent cwd still evaluated
});

test("handler: untrusted folder sets exclusive mode and notifies when a project .mcp.json exists; trusted clears it", async () => {
	reset();
	let h: any;
	extension({ on: (_: string, fn: any) => { h = fn; } } as any);
	const notices: string[] = [];
	const ctxFor = (cwd: string, hasUI = true) => ({ cwd, hasUI, ui: { notify: (t: string) => notices.push(t) } });

	const bare = folder("bare");
	await h({}, ctxFor(bare));
	assert.equal(process.env.PI_MCP_CONFIG_MODE, "exclusive");
	assert.equal(notices.length, 0); // no project config → nothing to ignore

	const withMcp = folder("with-mcp");
	writeFileSync(join(withMcp, ".mcp.json"), "{}");
	await h({}, ctxFor(withMcp));
	assert.equal(process.env.PI_MCP_CONFIG_MODE, "exclusive");
	assert.match(notices[0], /\.mcp\.json is ignored because the folder is not trusted\. Use \/trust/);

	const piMcp = folder("pi-mcp");
	mkdirSync(join(piMcp, ".pi"));
	writeFileSync(join(piMcp, ".pi", "mcp.json"), "{}");
	await h({}, ctxFor(piMcp));
	assert.equal(notices.length, 2);
	await h({}, ctxFor(piMcp, false)); // headless: no notice, still exclusive
	assert.equal(notices.length, 2);
	assert.equal(process.env.PI_MCP_CONFIG_MODE, "exclusive");

	trust({ [withMcp]: true });
	await h({}, ctxFor(withMcp));
	assert.equal(process.env.PI_MCP_CONFIG_MODE, undefined); // trusted: adapter reads project config
	assert.equal(notices.length, 2);
});

test("handler: an explicit PI_MCP_CONFIG_MODE in the environment is always respected", async () => {
	reset();
	process.env.PI_MCP_CONFIG_MODE = "merge";
	const fresh = await import("../early-extensions/mcp-project-trust.ts?user-set"); // new instance sees the variable at load
	let h: any;
	fresh.default({ on: (_: string, fn: any) => { h = fn; } } as any);
	await h({}, { cwd: folder("untrusted"), hasUI: false, ui: { notify() {} } });
	assert.equal(process.env.PI_MCP_CONFIG_MODE, "merge");
	delete process.env.PI_MCP_CONFIG_MODE;
});
