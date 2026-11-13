// r2 JSON-RPC schemas and typed, secret-safe refusals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectMcp, protocol } from "./direct-link-mcp.ts";
import type { Fetch } from "./direct-link-mcp.ts";
const context = { workHandle: "fake-work", claimId: "fake-claim", epoch: 4 };
const claim = { workHandle: "fake-work", harness: "pi", session: "fake-session", harnessVersion: "test", launchProof: "FAKE_PROOF" } as const;
const rpcError = (code: string, reason?: string): Fetch => async (_url, init) => Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, error: { code: -32000, data: { code, reason }, message: "dpat_FAKE0000 FAKE_PROOF" } });
for (const kind of [...protocol.errors, "unknown"]) test(`MCP maps ${kind}`, async () => {
	const result = await new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", rpcError(kind)).report(context, {});
	if (kind === "cancelled") assert.deepEqual(result, { ok: false, error: { kind, reason: "Work cancelled" } });
	else assert.deepEqual(result, { ok: false, error: { kind: kind === "unknown" ? "fatal-stop" : kind } });
});
test("cancel reason preserved unless it contains PAT, credential shapes or the launch proof", async () => {
	for (const reason of ["Journey changed", "Bearer FAKE", "dpat_FAKE0000", "FAKE_PROOF"]) {
		const client = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", rpcError("cancelled", reason));
		assert.deepEqual(await client.claim(claim), { ok: false, error: { kind: "cancelled", reason: reason === "Journey changed" ? reason : "Work cancelled" } });
	}
});
for (const status of [401, 403, 302, 503]) test(`MCP HTTP ${status} is typed`, async () => {
	const client = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", async () => new Response("dpat_FAKE0000", { status }));
	assert.deepEqual(await client.report(context, {}), { ok: false, error: { kind: status === 401 || status === 403 ? "unauthorized" : "unavailable" } });
});
test("network, parse, redirect and invalid envelopes never expose secrets", async () => {
	const redirected = Response.json({}); Object.defineProperty(redirected, "redirected", { value: true });
	for (const fetch of [async () => { throw new Error("FAKE_PROOF"); }, async () => new Response("invalid"), async () => redirected, async () => Response.json({ result: {} })]) {
		assert.deepEqual(await new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", fetch).claim(claim), { ok: false, error: { kind: "unavailable" } });
	}
});
test("four tools send the exact r2 arguments with PAT and no redirects", async () => {
	const writes: { params: { name: string; arguments: Record<string, unknown> }; id: string }[] = []; let counter = 0;
	const client = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", async (_url, init) => {
		assert.equal(init.redirect, "error"); assert.equal(init.method, "POST");
		assert.equal(new Headers(init.headers).get("Authorization"), "Bearer dpat_FAKE0000");
		const body = JSON.parse(String(init.body)); assert.equal(body.jsonrpc, "2.0"); assert.equal(body.method, "tools/call"); writes.push(body);
		return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: {} } });
	}, () => `key-${++counter}`);
	await client.claim(claim); await client.heartbeat(context, "working");
	await client.report(context, { kind: "progress", note: "implemented" }, "report-key"); await client.release(context, { outcome: "abandoned", note: "stopped" }, "release-key");
	assert.deepEqual(writes.map((w) => w.params.name), Object.values(protocol.tools));
	assert.deepEqual(writes[0].params.arguments, claim);
	assert.deepEqual(writes[1].params.arguments, { ...context, state: "working" });
	assert.deepEqual(writes[2].params.arguments, { ...context, kind: "progress", note: "implemented", idempotencyKey: "report-key" });
	assert.deepEqual(writes[3].params.arguments, { ...context, outcome: "abandoned", note: "stopped", idempotencyKey: "release-key" });
	assert.equal(new Set(writes.map((w) => w.id)).size, 4);
});
test("an explicit retry keeps its idempotency key but gets a new RPC request id", async () => {
	const keys: string[] = []; const ids: string[] = [];
	const client = new DirectMcp("https://direct.invalid/mcp", "dpat_FAKE0000", async (_url, init) => {
		const body = JSON.parse(String(init.body)); keys.push(body.params.arguments.idempotencyKey); ids.push(body.id);
		return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: {} } });
	});
	await client.report(context, {}, "retry-key"); await client.report(context, {}, "retry-key");
	assert.deepEqual(keys, ["retry-key", "retry-key"]); assert.notEqual(ids[0], ids[1]);
});
