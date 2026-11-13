// No lease/tool-ready value escapes startup until the single-use proof claim succeeds.
import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { DirectCredentials } from "./direct-link-credentials.ts";
import { DirectDaemon } from "./direct-link-daemon.ts";
import { DirectMcp } from "./direct-link-mcp.ts";
import { claimAtStartup } from "./direct-link-lease.ts";
import { DirectStub } from "./direct-link-stub.ts";
const stubs: DirectStub[] = []; afterEach(() => { for (const stub of stubs.splice(0)) stub.dispose(); });
async function fixture() {
	const stub = new DirectStub(); stubs.push(stub);
	await new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", stub.fetch).accept("offer-fake", { person: true });
	const launch = stub.launch(); assert.ok(launch);
	const env: Record<string, string | undefined> = { DIRECT_LINK_WORK_HANDLE: launch.workHandle, DIRECT_LINK_SESSION: launch.session, DIRECT_LINK_HARNESS: "pi", DIRECT_LINK_LAUNCH_PROOF_FILE: launch.launchProofFile };
	const credentials = new DirectCredentials(); const mcp = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", stub.fetch);
	return { stub, launch, env, credentials, mcp, worktree: process.cwd(), harnessVersion: "test" };
}
test("missing file and legacy-env-only startup fail closed as proof-unavailable without a claim", async () => {
	for (const env of [{}, { DIRECT_LINK_LAUNCH_PROOF: "FAKE_LEGACY_PROOF" }, { DIRECT_LINK_LAUNCH_PROOF_FILE: "/fake/missing-proof" }]) {
		const deps = await fixture(); let calls = 0;
		const mcp = { ...deps.mcp, heartbeat: deps.mcp.heartbeat.bind(deps.mcp), release: deps.mcp.release.bind(deps.mcp), claim: async () => { calls++; assert.fail("must not claim"); } };
		assert.deepEqual(await claimAtStartup({ ...deps, env, mcp }), { ok: false, error: { kind: "proof-unavailable" } }); assert.equal(calls, 0);
	}
});
test("wrong-mode proof file startup is proof-unavailable, not tool-ready", async () => {
	const deps = await fixture(); chmodSync(deps.launch.launchProofFile, 0o644);
	assert.deepEqual(await claimAtStartup(deps), { ok: false, error: { kind: "proof-unavailable" } });
	assert.equal(deps.stub.facts.some((fact) => fact.kind === "claim"), false);
});
test("startup awaits claim; proof file and env are gone before claim, and a second startup refuses", async () => {
	const deps = await fixture(); const entered = Promise.withResolvers<void>(); const proceed = Promise.withResolvers<void>(); let calls = 0; let ready = false;
	const mcp = { heartbeat: deps.mcp.heartbeat.bind(deps.mcp), release: deps.mcp.release.bind(deps.mcp), claim: async (request: Parameters<DirectMcp["claim"]>[0]) => {
		calls++; entered.resolve(); await proceed.promise; return deps.mcp.claim(request);
	} };
	const pending = claimAtStartup({ ...deps, mcp }).then((result) => { ready = result.ok; return result; });
	await entered.promise;
	assert.equal(ready, false); assert.equal(existsSync(deps.launch.launchProofFile), false);
	assert.equal(deps.env.DIRECT_LINK_LAUNCH_PROOF_FILE, undefined); assert.equal(deps.credentials.secretsToMask().length, 1);
	proceed.resolve(); const result = await pending; assert.ok(result.ok); assert.equal(ready, true);
	assert.equal((await result.value.renew()).ok, true);
	assert.deepEqual(await claimAtStartup({ ...deps, mcp }), { ok: false, error: { kind: "proof-unavailable" } }); assert.equal(calls, 1);
});
test("wrong proof is consumed locally but cannot produce a ready lease or leak proof in a refusal", async () => {
	const deps = await fixture(); writeFileSync(deps.launch.launchProofFile, "FAKE_WRONG_PROOF");
	assert.deepEqual(await claimAtStartup(deps), { ok: false, error: { kind: "launch-not-authorized" } });
	assert.equal(existsSync(deps.launch.launchProofFile), false); assert.equal(deps.env.DIRECT_LINK_LAUNCH_PROOF_FILE, undefined);
});
test("wrong daemon session cannot become ready with a valid proof", async () => {
	const deps = await fixture(); deps.env.DIRECT_LINK_SESSION = "caller-chosen";
	assert.deepEqual(await claimAtStartup(deps), { ok: false, error: { kind: "launch-not-authorized" } });
});
