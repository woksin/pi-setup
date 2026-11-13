// Observation baselines advance only after successful writes through the lease fence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectReporter } from "./direct-link-report.ts";
import type { Report } from "./direct-link-report.ts";
import { DirectLease } from "./direct-link-lease.ts";
import { parseWorkItem } from "./direct-link-workitem.ts";
import { stubWorkPayload } from "./direct-link-stub.ts";
import type { DirectError } from "./direct-link-mcp.ts";
function setup() {
	const now = Date.now(); const sent: Report[] = []; let failure: DirectError | undefined;
	const transport = {
		heartbeat: async () => ({ ok: true as const, value: { epoch: 1, leaseUntil: new Date(now + 90_000).toISOString(), state: "idle" as const } }),
		release: async () => ({ ok: true as const, value: {} }),
		report: async (_context: unknown, report: Report) => {
			sent.push(structuredClone(report));
			return failure ? { ok: false as const, error: failure } : { ok: true as const, value: {} };
		},
	};
	const lease = new DirectLease(parseWorkItem(stubWorkPayload(now), now), transport);
	return { lease, reporter: new DirectReporter(lease, transport), sent, fail: (error?: DirectError) => { failure = error; } };
}
test("lost lease refuses even unchanged or empty reports locally", async () => {
	const s = setup(); s.fail({ kind: "cancelled", reason: "Cancelled by person" });
	await s.reporter.progress({ note: "first" });
	assert.equal(s.lease.lost, true);
	assert.equal((await s.reporter.progress({ note: "first" })).ok, false);
	assert.equal((await s.reporter.artifact({})).ok, false); assert.equal(s.sent.length, 1);
});
test("credential-shaped reports are refused without echoing or sending", async () => {
	const s = setup(); const response = await s.reporter.progress({ note: "dpat_FAKE0000" });
	assert.deepEqual(response, { ok: false, error: { kind: "unavailable" } }); assert.equal(s.sent.length, 0);
});
test("same report twice sends nothing; each field diff is independent", async () => {
	const s = setup(); const progress = { plan: ["implement"], completed: ["specs"], note: "ready" };
	await s.reporter.progress(progress); await s.reporter.progress(progress);
	await s.reporter.progress({ ...progress, note: "review" });
	const artifact = { branch: "work/scratch", sha: "abc123", prUrl: "https://example.invalid/pr/1", buildResult: "passed" };
	await s.reporter.artifact(artifact); await s.reporter.artifact(artifact);
	await s.reporter.artifact({ ...artifact, sha: "def456" });
	assert.deepEqual(s.sent, [{ kind: "progress", ...progress }, { kind: "progress", note: "review" }, { kind: "artifact", ...artifact }, { kind: "artifact", sha: "def456" }]);
});
test("concurrent identical observations send once and snapshot mutable lists", async () => {
	const s = setup(); const plan = ["first"];
	const first = s.reporter.progress({ plan }); plan.push("later");
	await Promise.all([first, s.reporter.progress({ plan: ["first"] })]);
	assert.deepEqual(s.sent, [{ kind: "progress", plan: ["first"] }]);
});
test("failed observations are retried rather than cached; empty observations send nothing", async () => {
	const s = setup(); await s.reporter.progress({}); await s.reporter.artifact({}); assert.equal(s.sent.length, 0);
	s.fail({ kind: "unavailable" }); await s.reporter.progress({ note: "retry" });
	s.fail(); await s.reporter.progress({ note: "retry" }); await s.reporter.progress({ note: "retry" });
	assert.equal(s.sent.length, 2);
});
test("explicit empty values clear previous facts; absent fields are not cleared", async () => {
	const s = setup(); await s.reporter.progress({ plan: ["step"], note: "note" });
	await s.reporter.progress({ plan: [], note: "" }); await s.reporter.progress({ note: undefined });
	assert.deepEqual(s.sent[1], { kind: "progress", plan: [], note: "" }); assert.equal(s.sent.length, 2);
});
