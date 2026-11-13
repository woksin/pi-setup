// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import directLink from "../extensions/direct-link.ts";
import type { DirectLinkServices } from "../extensions/direct-link.ts";
import { DirectCredentials } from "./direct-link-credentials.ts";
import { DirectDaemon } from "./direct-link-daemon.ts";
import { DirectStub } from "./direct-link-stub.ts";
import type { Fetch } from "./direct-link-mcp.ts";
import { artifactFromResult, childEnvironment, deliveryEvidence, directToolDenied, maskDirect, parseReport, parseSubmission } from "./direct-link-hooks.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function harness(env: NodeJS.ProcessEnv, services = {}) {
	const handlers: Record<string, Function> = {};
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const notes: string[] = [];
	let aborted = false;
	const ctx = { cwd: process.cwd(), hasUI: true, abort: () => { aborted = true; }, ui: { notify: (text: string) => notes.push(text) } };
	const pi: any = {
		on: (name: string, handler: Function) => { handlers[name] = handler; },
		registerTool: (tool: any) => { tools[tool.name] = tool; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		sendMessage: (message: any) => { notes.push(message.content); },
	};
	directLink(pi, { env, ...services });
	return { handlers, tools, commands, notes, ctx, aborted: () => aborted };
}
async function fixture(overrides: DirectLinkServices = {}) {
	const stub = new DirectStub(); cleanup.push(() => stub.dispose());
	await new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", stub.fetch).accept("offer-fake", { person: true });
	const launch = stub.launch()!;
	const env = { DIRECT_LINK_WORK_HANDLE: launch.workHandle, DIRECT_LINK_SESSION: launch.session, DIRECT_LINK_HARNESS: "pi", DIRECT_LINK_LAUNCH_PROOF_FILE: launch.launchProofFile, DIRECT_LINK_MCP_URL: "https://direct.invalid/mcp", DIRECT_LINK_LAUNCH_PROOF: "FAKE_LEGACY_PROOF", DIRECT_PAT: "dpat_NOT_USED" };
	const credentials = new DirectCredentials();
	const pat = credentials.pat.bind(credentials);
	credentials.pat = () => pat({ runSecurity: async () => "dpat_FAKE0000", env: {} });
	const git = { branch: "work/scratch", sha: "a".repeat(40) };
	const requests: string[] = [];
	const fetch: Fetch = async (url, init) => { requests.push(JSON.parse(String(init.body)).params.name); return stub.fetch(url, init); };
	const app = harness(env, { credentials, fetch, gitArtifact: async () => git, ...overrides });
	cleanup.push(async () => { await app.handlers.session_shutdown({}, app.ctx); });
	const call = (value: unknown) => app.tools.direct_work_report.execute("report", value);
	return { stub, launch, env, credentials, app, call, git, requests };
}

test("inert without daemon work handle: no hooks, commands, tools or environment mutation", () => {
	const env = { DIRECT_PAT: "dpat_FAKE0000" };
	const app = harness(env);
	assert.deepEqual(app.handlers, {}); assert.deepEqual(app.tools, {}); assert.deepEqual(app.commands, {});
	assert.equal(env.DIRECT_PAT, "dpat_FAKE0000");
});
test("child environment uses an allow-list, not a Direct-only secret deny-list", () => {
	assert.deepEqual(childEnvironment({ PATH: "/fake/bin", HOME: "/fake/home", LC_ALL: "C", DIRECT_PAT: "fake", DIRECT_LINK_LAUNCH_PROOF_FILE: "/fake/proof", GH_TOKEN: "fake", OTHER_PASSWORD: "fake", NODE_OPTIONS: "fake", BASH_ENV: "fake" }), { PATH: "/fake/bin", HOME: "/fake/home", LC_ALL: "C" });
});
test("masking covers nested content, details and keys without exposing learned secrets", () => {
	assert.deepEqual(maskDirect({ "FAKE_PROOF": ["hello FAKE_PROOF", { text: "dpat_FAKE0000" }] }, ["FAKE_PROOF"]), { "[REDACTED:direct]": ["hello [REDACTED:direct]", { text: "[REDACTED:direct]" }] });
});
test("path guard covers relative paths, nested tools, symlinks, runner stores and secret commands", async () => {
	const { credentials, launch } = await fixture();
	const alias = join(dirname(launch.launchProofFile), "proof-alias");
	symlinkSync(launch.launchProofFile, alias); cleanup.push(() => unlinkSync(alias));
	for (const input of [{ path: alias }, { tool_uses: [{ parameters: { path: launch.launchProofFile } }] }, { command: "cat ~/.config/direct/runner-secret" }, { command: "security find-generic-password -w" }, { command: "security -q find-generic-password -w" }, { command: "gh pr create --title test" }, { command: "gh pr new --title test" }, { command: "gh api -X POST repos/fake/repo/pulls -f title=fake" }, { command: "gh api repos/fake/repo/pulls --input fixture.json" }, { command: "cat ~/.config/direct/credentials" }, { command: "cat ~/.config/direct/*" }, { command: "less ~/.config/direct/cred*" }, { command: "cp ~/.config/direct/run/* /fake/destination" }, { command: `cat ${dirname(launch.launchProofFile)}/*` }, { command: "printenv" }]) {
		assert.equal(directToolDenied(input, process.cwd(), credentials, [launch.launchProofFile]), true);
	}
	assert.equal(directToolDenied({ path: "docs/direct-link.md" }, process.cwd(), credentials, [launch.launchProofFile]), false);
});
test("reports validate kinds and field types; automatic artifacts are structured facts, never inferred gate passes", () => {
	assert.deepEqual(parseReport({ kind: "progress", plan: ["one"], note: "working" }), { kind: "progress", plan: ["one"], note: "working" });
	for (const value of [{ kind: "other" }, { kind: "artifact", plan: [] }, { kind: "progress", plan: [1] }, { kind: "progress", note: "dpat_FAKE0000" }, { kind: "artifact", branch: 1 }]) assert.throws(() => parseReport(value));
	assert.equal(artifactFromResult({ isError: true, details: { branch: "work" } }), undefined);
	assert.equal(artifactFromResult({ details: { stdout: "tests passed" } }), undefined);
	assert.deepEqual(artifactFromResult({ details: { directArtifact: { branch: "work", buildResult: "specs passed" } } }), { branch: "work", buildResult: "specs passed" });
	assert.equal(deliveryEvidence({ branch: "work", sha: "short", buildResult: "passed" }), false);
	assert.throws(() => parseSubmission({ kind: "progress", state: "unknown" }));
	assert.throws(() => parseSubmission({ kind: "artifact", outcome: "unknown" }));
});
test("startup consumes proof before tool readiness, scrubs env, claims once and exposes status", async () => {
	const { app, launch, env, stub } = await fixture();
	assert.equal((await app.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, app.ctx)).block, true);
	assert.equal(env.DIRECT_PAT, undefined); assert.equal(env.DIRECT_LINK_LAUNCH_PROOF_FILE, undefined);
	await app.handlers.session_start({}, app.ctx);
	assert.equal(existsSync(launch.launchProofFile), false);
	assert.equal(stub.facts.filter(f => f.kind === "claim").length, 1);
	assert.equal(await app.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, app.ctx), undefined);
	await app.commands.direct.handler("status", app.ctx); assert.match(app.notes.at(-1)!, /Direct: active/);
	await app.handlers.session_start({}, app.ctx);
	assert.equal(stub.facts.filter(f => f.kind === "claim").length, 1);
	assert.equal(app.aborted(), true); assert.match(app.notes.at(-1)!, /new Launch/);
});
test("missing L101 MCP URL fails closed with actionable contract guidance", async () => {
	const stub = new DirectStub(); cleanup.push(() => stub.dispose());
	await new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", stub.fetch).accept("offer-fake", { person: true });
	const launch = stub.launch()!;
	const credentials = new DirectCredentials(); credentials.pat = async () => { assert.fail("URL is required before PAT lookup"); };
	const app = harness({ DIRECT_LINK_WORK_HANDLE: launch.workHandle, DIRECT_LINK_SESSION: launch.session, DIRECT_LINK_HARNESS: "pi", DIRECT_LINK_LAUNCH_PROOF_FILE: launch.launchProofFile, DIRECT_LINK_LOOPBACK_URL: "http://127.0.0.1:7777" }, { credentials, fetch: stub.fetch });
	await app.handlers.session_start({}, app.ctx);
	assert.equal(existsSync(launch.launchProofFile), false); assert.equal(app.aborted(), true);
	assert.equal(stub.facts.some(fact => fact.kind === "claim"), false);
	assert.ok(app.notes.some(note => /DIRECT_LINK_MCP_URL.*L101.*discovery/.test(note)));
});
test("claimed work text is masked without rejecting a consumed proof", async () => {
	let transport!: Fetch;
	const forwarding: Fetch = async (url, init) => {
		const response = await transport(url, init);
		if (JSON.parse(String(init.body)).params.name !== "direct_work_claim") return response;
		const body = await response.json(), payload = body.result.structuredContent.payload;
		payload.title = "Use dpat_FAKE_IN_TITLE"; payload.brief = "Use Bearer FAKE_IN_BRIEF";
		payload.acceptanceCriteria = ["a".repeat(64)];
		return Response.json(body);
	};
	const f = await fixture({ fetch: forwarding }); transport = f.stub.fetch;
	await f.app.handlers.session_start({}, f.app.ctx);
	assert.equal(f.app.aborted(), false); assert.equal(existsSync(f.launch.launchProofFile), false);
	const notices = f.app.notes.join("\n"); assert.match(notices, /claimed.*\[REDACTED:direct\]/); assert.doesNotMatch(notices, /dpat_FAKE|FAKE_IN_BRIEF/);
});
test("missing proof fails closed without claim, including legacy proof environment", async () => {
	const { app, launch, stub } = await fixture(); unlinkSync(launch.launchProofFile);
	await app.handlers.session_start({}, app.ctx);
	assert.equal(stub.facts.some(f => f.kind === "claim"), false);
	assert.equal((await app.handlers.tool_call({ toolName: "bash", input: { command: "true" } }, app.ctx)).block, true);
	assert.match(app.notes.at(-1)!, /lease lost.*new Launch/);
});
test("manual and tool-result artifacts are change-only; delivery releases only with branch, SHA and gate evidence", async () => {
	const { app, call, stub, git } = await fixture(); await app.handlers.session_start({}, app.ctx);
	assert.equal((await call({ kind: "artifact", outcome: "delivered" })).isError, true);
	const event = { toolName: "bash", input: { command: "git push origin work/scratch" }, content: [{ type: "text", text: "pushed" }], details: {}, isError: false };
	await app.handlers.tool_result(event); await app.handlers.tool_result(event);
	assert.equal(stub.facts.filter(f => f.kind === "artifact").length, 2);
	assert.equal((await call({ kind: "artifact", ...git, buildResult: "specs: exit 0", outcome: "delivered" })).isError, false);
	assert.equal(stub.facts.filter(f => f.kind === "delivered").length, 1);
	await app.handlers.session_shutdown({}, app.ctx);
	assert.equal(stub.facts.filter(f => f.kind === "delivered").length, 1);
});
test("state changes and shutdown outcomes reach Direct; shell escapes stay blocked", async () => {
	for (const outcome of ["abandoned", "failed"] as const) {
		const { app, call, stub } = await fixture(); await app.handlers.session_start({}, app.ctx);
		for (const state of ["working", "waiting-ci", "waiting-review", "blocked", "idle"]) {
			assert.equal((await call({ kind: "progress", state })).isError, false);
		}
		assert.deepEqual(stub.facts.filter(f => f.kind === "state").map(f => f.value), ["working", "waiting-ci", "waiting-review", "blocked", "idle"]);
		assert.equal(app.handlers.user_bash({ command: "true" }).result.exitCode, 1);
		if (outcome === "failed") await call({ kind: "progress", outcome });
		await app.handlers.session_shutdown({}, app.ctx);
		assert.equal(stub.facts.filter(f => f.kind === outcome).length, 1);
	}
});
test("terminal refusal aborts work and stops later reports, tools and release writes", async () => {
	const { app, call, stub } = await fixture(); await app.handlers.session_start({}, app.ctx);
	stub.takeover();
	assert.equal((await call({ kind: "progress", note: "one" })).isError, true);
	const count = stub.facts.length;
	await call({ kind: "progress", note: "two" }); await app.handlers.session_shutdown({}, app.ctx);
	assert.equal(stub.facts.length, count); assert.equal(app.aborted(), true);
	assert.equal((await app.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, app.ctx)).block, true);
});
test("heartbeat follows the lease interval and refusal stops rescheduling and writes", async () => {
	let now = Date.now();
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let sequence = 0;
	const clock = { now: () => now, setTimeout: (fn: () => void, ms: number) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
	const { app, stub, requests } = await fixture({ clock }); await app.handlers.session_start({}, app.ctx);
	const tick = async () => {
		const [id, timer] = [...timers].sort((a, b) => a[1].ms - b[1].ms)[0]; timers.delete(id); now += timer.ms; await timer.fn();
	};
	assert.equal(Math.min(...[...timers.values()].map(timer => timer.ms)), 20_000);
	await tick(); assert.equal(requests.filter(name => name === "direct_work_heartbeat").length, 1);
	assert.equal(timers.size, 2);
	stub.takeover(); await tick(); assert.equal(timers.size, 0); assert.equal(app.aborted(), true);
	const count = stub.facts.length;
	await app.handlers.agent_start(); assert.equal(stub.facts.length, count);
});
test("transient heartbeat and report failures stay recoverable before expiry", async () => {
	let fail = false, transport!: Fetch;
	const forwarding: Fetch = async (url, init) => fail ? new Response("", { status: 503 }) : transport(url, init);
	const f = await fixture({ fetch: forwarding }); transport = f.stub.fetch;
	const app = f.app;
	await app.handlers.session_start({}, app.ctx);
	fail = true;
	assert.equal((await app.tools.direct_work_report.execute("report", { kind: "progress", note: "retry" })).isError, true);
	await app.handlers.agent_start(); assert.equal(app.aborted(), false);
	assert.equal(await app.handlers.tool_call({ toolName: "read", input: { path: "README.md" } }, app.ctx), undefined);
	fail = false;
	assert.equal((await app.tools.direct_work_report.execute("report", { kind: "progress", note: "retry" })).isError, false);
});
test("expiry aborts active extension work even when a heartbeat never settles", async () => {
	let now = Date.now(), sequence = 0;
	const timers = new Map<number, { fn: () => void; at: number }>();
	const clock = { now: () => now, setTimeout: (fn: () => void, ms: number) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
	let transport!: Fetch;
	const forwarding: Fetch = async (url, init) => JSON.parse(String(init.body)).params.name === "direct_work_heartbeat" ? new Promise(() => {}) : transport(url, init);
	const f = await fixture({ clock, fetch: forwarding }); transport = f.stub.fetch;
	await f.app.handlers.session_start({}, f.app.ctx);
	const pending = f.app.handlers.agent_start(); await new Promise(setImmediate);
	// The watchdog exists independently of the hung heartbeat.
	now += 100_000;
	const watchdog = [...timers.values()].sort((a, b) => b.at - a.at)[0];
	watchdog.fn(); await pending;
	assert.equal(f.app.aborted(), true); assert.equal(timers.size, 0);
	assert.equal((await f.call({ kind: "progress" })).isError, true);
});
test("tool results redact learned proof/PAT in text and details before session storage", async () => {
	const { app, credentials } = await fixture(); await app.handlers.session_start({}, app.ctx);
	const proof = credentials.secretsToMask()[0];
	const result = await app.handlers.tool_result({ toolName: "read", input: {}, isError: false, content: [{ type: "text", text: proof }], details: { nested: "dpat_FAKE0000" } });
	assert.doesNotMatch(JSON.stringify(result), /dpat_FAKE0000/);
	assert.equal(JSON.stringify(result).includes(proof), false);
});
