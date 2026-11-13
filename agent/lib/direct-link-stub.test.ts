// Harness-side Layer A proof against the r2 admission, fencing and observation contract.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DirectStub } from "./direct-link-stub.ts";
import { DirectDaemon } from "./direct-link-daemon.ts";
import { DirectMcp } from "./direct-link-mcp.ts";
import { DirectCredentials } from "./direct-link-credentials.ts";
import { DirectLease } from "./direct-link-lease.ts";
import { DirectReporter } from "./direct-link-report.ts";
import { containsCredential, parseWorkItem } from "./direct-link-workitem.ts";
const stubs: DirectStub[] = []; afterEach(() => { for (const stub of stubs.splice(0)) stub.dispose(); });
const unlaunched = { workHandle: "work-fake", session: "caller-chosen", harness: "pi", harnessVersion: "test", launchProof: "FAKE_PROOF" } as const;
function fixture() {
	let now = Date.parse("2026-01-01T00:00:00Z"); const stub = new DirectStub({ now: () => now }); stubs.push(stub);
	const daemon = new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", stub.fetch);
	const mcp = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", stub.fetch);
	const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
	return { stub, daemon, mcp, clock, advance: (ms: number) => { now += ms; } };
}
async function prepared() {
	const f = fixture(); await f.daemon.accept("offer-fake", { person: true }); const launch = f.stub.launch(); assert.ok(launch);
	const launchProof = await new DirectCredentials().launchProof({ env: { DIRECT_LINK_LAUNCH_PROOF_FILE: launch.launchProofFile }, worktree: process.cwd() });
	return { ...f, request: { workHandle: launch.workHandle, session: launch.session, launchProof, harness: "pi" as const, harnessVersion: "test" } };
}
async function launched() {
	const f = await prepared(); const response = await f.mcp.claim(f.request); assert.ok(response.ok);
	const item = parseWorkItem(response.value, f.clock.now());
	return { ...f, item, context: { workHandle: item.workHandle, claimId: item.claimId, epoch: item.epoch } };
}
test("claim without launch refused, including after own-daemon accept", async () => {
	const f = fixture(); assert.equal((await f.mcp.claim(unlaunched)).ok, false);
	await f.daemon.accept("offer-fake", { person: true });
	assert.deepEqual(await f.mcp.claim(unlaunched), { ok: false, error: { kind: "launch-not-authorized" } });
});
test("same PAT with wrong session, work, harness, missing or wrong proof is refused without echoing proof", async () => {
	const f = await prepared();
	for (const patch of [{ session: "caller-chosen" }, { workHandle: "another-work" }, { harness: "other" }, { launchProof: undefined }, { launchProof: "WRONG_FAKE_PROOF" }]) {
		const response = await f.mcp.claim({ ...f.request, ...patch } as typeof f.request);
		assert.deepEqual(response, { ok: false, error: { kind: "launch-not-authorized" } }); assert.equal(JSON.stringify(response).includes(f.request.launchProof), false);
	}
	assert.equal((await f.mcp.claim(f.request)).ok, true);
});
test("proof is single-use even with the same PAT, session and RPC arguments", async () => {
	const f = await launched(); assert.deepEqual(await f.mcp.claim(f.request), { ok: false, error: { kind: "launch-not-authorized" } });
});
test("expired launch proof cannot claim", async () => {
	const f = await prepared(); f.advance(60_000);
	assert.deepEqual(await f.mcp.claim(f.request), { ok: false, error: { kind: "launch-not-authorized" } });
});
test("stale epoch after takeover is refused by server and fences the old lease locally", async () => {
	const f = await launched(); const lease = new DirectLease(f.item, f.mcp, f.clock); assert.equal(f.stub.takeover(), 2);
	assert.deepEqual(await f.mcp.report(f.context, { kind: "progress", note: "old" }), { ok: false, error: { kind: "stale-epoch" } });
	assert.deepEqual(await lease.renew(), { ok: false, error: { kind: "stale-epoch" } });
	const before = f.stub.facts.length; assert.equal((await lease.release({ outcome: "abandoned", note: "old" })).ok, false);
	assert.equal(f.stub.facts.length, before); assert.equal(lease.lost, true);
});
test("another person's PAT is refused", async () => {
	const f = await prepared(); const other = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE_OTHER", f.stub.fetch);
	assert.equal((await other.claim(f.request)).ok, false);
});
for (const state of [{ paused: true }, { enrolled: false }, { approved: false }, { protocol: 3 }, { online: false }, { capacity: 0 }]) test(`ineligible runner ${JSON.stringify(state)} has no offer or cluster fallback`, async () => {
	const f = fixture(); Object.assign(f.stub.runner, state);
	assert.deepEqual(await f.daemon.listOffers(), []); assert.equal(f.stub.launch(), undefined);
	await assert.rejects(f.daemon.accept("offer-fake", { person: true })); assert.equal(f.stub.facts.length, 0);
});
test("grant expiry and revocation between offer and launch refuse launch", async () => {
	for (const expired of [true, false]) {
		const f = fixture(); await f.daemon.accept("offer-fake", { person: true });
		if (expired) f.advance(600_000); else f.stub.cancel("Grant revoked"); assert.equal(f.stub.launch(), undefined);
	}
});
test("cancel after launch loses lease with a safe server reason", async () => {
	const f = await launched(); const lease = new DirectLease(f.item, f.mcp, f.clock); f.stub.cancel(f.request.launchProof);
	assert.deepEqual(await lease.renew(), { ok: false, error: { kind: "cancelled", reason: "Work cancelled" } }); assert.equal(lease.lost, true);
});
test("server dedupes observations with different keys and detects conflicting idempotency reuse", async () => {
	const f = await launched(); const report = { kind: "progress", note: "implemented" };
	await f.mcp.report(f.context, report, "first"); await f.mcp.report(f.context, report, "different");
	assert.deepEqual(await f.mcp.report(f.context, report, "first"), { ok: true, value: { changed: ["note"] } });
	assert.equal(f.stub.facts.filter((fact) => fact.kind === "progress").length, 1);
	assert.deepEqual(await f.mcp.report(f.context, { ...report, note: "changed" }, "first"), { ok: false, error: { kind: "idempotency-conflict" } });
	const release = { outcome: "abandoned", note: "done" } as const;
	await f.mcp.release(f.context, release, "release"); await f.mcp.release(f.context, release, "release"); assert.equal(f.stub.facts.filter((fact) => fact.kind === "abandoned").length, 1);
});
test("Layer A: secret-free offer, launch, single-use proof claim, agent facts, delivery and mirror", async () => {
	const f = await prepared(); assert.equal(containsCredential(f.stub.offer()), false); assert.equal(f.stub.placementRunner, "runner-person");
	const claim = await f.mcp.claim(f.request); assert.ok(claim.ok);
	const lease = new DirectLease(parseWorkItem(claim.value, f.clock.now()), f.mcp, f.clock); const reporter = new DirectReporter(lease, f.mcp);
	await reporter.progress({ note: "implemented" }); await reporter.progress({ note: "implemented" });
	assert.equal(f.stub.facts.filter((fact) => fact.kind === "progress").length, 1);
	await lease.renew(); await lease.renew(); assert.equal(f.stub.facts.filter((fact) => fact.kind === "state").length, 0);
	await lease.setState("working"); await lease.setState("working"); assert.equal(f.stub.facts.filter((fact) => fact.kind === "state").length, 1);
	await reporter.artifact({ branch: "work/scratch", sha: "abc123", buildResult: "passed" });
	assert.equal((await lease.release({ outcome: "delivered", note: "ready" })).ok, true);
	assert.equal(f.stub.authorizer, "person"); assert.equal(f.stub.sessionId, f.request.session);
	assert.ok(f.stub.facts.filter((fact) => ["progress", "artifact", "delivered", "journey-delivery"].includes(fact.kind)).every((fact) => fact.cause === "pi"));
	assert.equal(f.stub.facts.filter((fact) => fact.kind === "journey-delivery").length, 1); assert.equal(f.stub.mirrorRequests, 1);
	assert.equal((await reporter.progress({ note: "late" })).ok, false);
});
