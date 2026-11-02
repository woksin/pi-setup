/** exact-model-guard: authoritative agent lookup and fail-closed abort before any provider request. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNameFromSession, createGuard, GUARD_ENTRY, resetProcessRoot, verdict, type AgentDefinition, type AgentLoader } from "../extensions/exact-model-guard.ts";

const OPUS = { provider: "anthropic", id: "claude-opus-5-5" };
const SOL = { provider: "openai-codex", id: "gpt-6.1-sol" };
const agents = (entries: AgentDefinition[]) => new Map(entries.map((a) => [a.name, a]));
const REGISTRY = agents([
	{ name: "reviewer", model: "anthropic/claude-opus-5-5", extensions: ["cratis-cli-guard", "exact-model-guard"] },
	{ name: "grunt", model: "anthropic/claude-sonnet-5-5", extensions: ["provider-fallback"] },
	{ name: "unpinned", extensions: ["exact-model-guard"] },
	{ name: "inherits", model: "anthropic/claude-opus-5-5", extensions: true },
]);

test("agentNameFromSession strips the #id suffix", () => {
	assert.equal(agentNameFromSession("reviewer#1a2b3c4d"), "reviewer");
	assert.equal(agentNameFromSession("sol-reviewer"), "sol-reviewer");
	assert.equal(agentNameFromSession(undefined), undefined);
	assert.equal(agentNameFromSession(""), undefined);
});

test("verdict: pinned model ok; anything unverifiable stops; only the process root skips", () => {
	assert.deepEqual(verdict("reviewer", REGISTRY, OPUS), { kind: "ok" });
	const stop = verdict("reviewer", REGISTRY, SOL);
	assert.equal(stop.kind, "stop");
	assert.match((stop as { text: string }).text, /must run on anthropic\/claude-opus-5-5 but was about to call openai-codex\/gpt-6.1-sol/);
	assert.match((verdict("reviewer", REGISTRY, undefined) as { text: string }).text, /an unknown model/);
	assert.match((verdict("unpinned", REGISTRY, OPUS) as { text: string }).text, /pins no model/);
	assert.match((verdict("reviewer", new Error("boom"), OPUS) as { text: string }).text, /cannot load agent definitions .*boom/);
	// The guard runs only in children whose selected definition lists it: a cwd definition that does not is a mismatch.
	assert.match((verdict("grunt", REGISTRY, SOL) as { text: string }).text, /lists exact-model-guard, so the spawned agent's pinned model cannot be verified/);
	assert.equal(verdict("inherits", REGISTRY, OPUS).kind, "stop"); // extensions: true is not an explicit listing
	assert.equal(verdict("nobody", REGISTRY, OPUS).kind, "stop");
	assert.match((verdict(undefined, REGISTRY, OPUS) as { text: string }).text, /cannot identify this agent/);
	assert.deepEqual(verdict("reviewer", REGISTRY, SOL, false), { kind: "skip" }); // process root
	const upper = agents([{ name: "r", model: "anthropic/claude-opus-5-5", extensions: [" EXACT-Model-Guard "] }]);
	assert.deepEqual(verdict("r", upper, OPUS), { kind: "ok" }); // listing is case-insensitive like pi-subagents
});

/** Starts a main session first so later harnesses are children, as in a real pi process. */
async function freshProcess() {
	resetProcessRoot();
	const main = harness(async () => REGISTRY, { hasUI: true, sessionName: "main" });
	await main.handlers.session_start({}, main.ctx);
	return main;
}

function harness(load: AgentLoader, opts: { hasUI?: boolean; sessionName?: string; model?: { provider: string; id: string } }) {
	const handlers: Record<string, any> = {};
	const appended: any[] = [];
	let aborts = 0;
	const ctx: any = {
		hasUI: opts.hasUI ?? false,
		cwd: "/nowhere",
		model: opts.model,
		sessionManager: { getSessionName: () => opts.sessionName },
		abort: () => { aborts++; },
	};
	createGuard(load)({ on: (name: string, h: any) => { handlers[name] = h; }, appendEntry: (type: string, data: unknown) => appended.push({ type, data }) } as any);
	return { handlers, ctx, appended, aborts: () => aborts };
}

test("a substituted model aborts before the request, blocks tools and records once; the pinned model passes", async () => {
	await freshProcess();
	const bad = harness(async () => REGISTRY, { sessionName: "reviewer#abcd1234", model: SOL });
	await bad.handlers.session_start({}, bad.ctx);
	await bad.handlers.before_agent_start({}, bad.ctx);
	await bad.handlers.before_provider_request({ payload: {} }, bad.ctx);
	const blocked = await bad.handlers.tool_call({ toolName: "read" }, bad.ctx);
	assert.equal(bad.aborts(), 3);
	assert.equal(blocked.block, true);
	assert.equal(bad.appended.length, 1);
	assert.equal(bad.appended[0].type, GUARD_ENTRY);
	assert.equal(bad.appended[0].data.expected, "anthropic/claude-opus-5-5");

	const good = harness(async () => REGISTRY, { sessionName: "reviewer#abcd1234", model: OPUS });
	await good.handlers.session_start({}, good.ctx);
	await good.handlers.before_provider_request({ payload: {} }, good.ctx);
	assert.equal(await good.handlers.tool_call({ toolName: "read" }, good.ctx), undefined);
	assert.equal(good.aborts(), 0);
	good.ctx.model = SOL; // a later switch mid-run is caught too
	await good.handlers.before_provider_request({ payload: {} }, good.ctx);
	assert.equal(good.aborts(), 1);
});

test("a loader failure fails closed for children; the process root (UI or headless) is untouched and never loads", async () => {
	await freshProcess();
	const failing = harness(async () => { throw new Error("module missing"); }, { sessionName: "reviewer#1", model: OPUS });
	await failing.handlers.session_start({}, failing.ctx);
	await failing.handlers.before_provider_request({ payload: {} }, failing.ctx);
	assert.equal(failing.aborts(), 1);
	let loads = 0;
	const counting: AgentLoader = async () => { loads++; return REGISTRY; };
	const ui = harness(counting, { hasUI: true, sessionName: "reviewer", model: SOL });
	await ui.handlers.session_start({}, ui.ctx);
	await ui.handlers.before_provider_request({ payload: {} }, ui.ctx);
	assert.equal(ui.aborts(), 0);
	resetProcessRoot(); // a headless process: its first session is the root, later ones are children
	const headlessMain = harness(counting, { sessionName: "reviewer", model: SOL });
	await headlessMain.handlers.session_start({}, headlessMain.ctx);
	await headlessMain.handlers.before_provider_request({ payload: {} }, headlessMain.ctx);
	assert.equal(headlessMain.aborts(), 0);
	assert.equal(loads, 0);
	const child = harness(counting, { sessionName: "reviewer#9", model: SOL });
	await child.handlers.session_start({}, child.ctx);
	await child.handlers.before_provider_request({ payload: {} }, child.ctx);
	assert.equal(child.aborts(), 1);
});

test("the default loader resolves agents through pi-subagents' own discovery (project .pi/agents, filename typing)", async (t) => {
	const { subagentsLoader } = await import("../extensions/exact-model-guard.ts");
	const cwd = mkdtempSync(join(tmpdir(), "emg-cwd-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "probe-reviewer.md"), "---\nmodel: anthropic/claude-opus-5-5\nextensions: [exact-model-guard]\n---\nbody\n");
	let loaded: Map<string, AgentDefinition>;
	try {
		loaded = await subagentsLoader(cwd);
	} catch (error) {
		t.skip(`pi-subagents not installed in this agent dir: ${(error as Error).message}`);
		return;
	}
	const probe = loaded.get("probe-reviewer");
	assert.equal(probe?.model, "anthropic/claude-opus-5-5");
	assert.deepEqual(verdict("probe-reviewer", loaded, SOL).kind, "stop");
});

test("ambiguous pins stop: the spawner's (root) definition pins another model than the target dir's", async () => {
	const pinned = (model: string) => agents([{ name: "reviewer", model, extensions: ["exact-model-guard"] }]);
	assert.equal(verdict("reviewer", [pinned("anthropic/claude-opus-5-5"), pinned("openai-codex/gpt-6.1-sol")], OPUS).kind, "stop");
	assert.equal(verdict("reviewer", [pinned("anthropic/claude-opus-5-5"), agents([])], OPUS).kind, "ok"); // root has no such agent
	assert.equal(verdict("reviewer", [pinned("anthropic/claude-opus-5-5"), new Error("x")], OPUS).kind, "stop");

	resetProcessRoot();
	const byDir: AgentLoader = async (cwd) => (cwd === "/main" ? pinned("anthropic/claude-unavailable") : pinned("anthropic/claude-opus-5-5"));
	const main = harness(byDir, { hasUI: true, sessionName: "main" });
	main.ctx.cwd = "/main";
	await main.handlers.session_start({}, main.ctx);
	const child = harness(byDir, { sessionName: "reviewer#1", model: OPUS }); // cwd /nowhere: a worktree target
	await child.handlers.session_start({}, child.ctx);
	await child.handlers.before_provider_request({ payload: {} }, child.ctx);
	assert.equal(child.aborts(), 1);
	assert.equal(child.appended[0].data.expected, "anthropic/claude-unavailable");
});
