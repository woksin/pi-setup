// The own-daemon interface never follows redirects or infers confirmation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectDaemon } from "./direct-link-daemon.ts";
import type { PersonConfirmation } from "./direct-link-daemon.ts";
import { DirectStub } from "./direct-link-stub.ts";
for (const url of ["https://direct.invalid", "http://127.0.0.2", "http://[::1]", "http://localhost", "http://localhost.invalid", "file:///local", "http://name:FAKE@127.0.0.1", "not a URL"])
	test(`daemon refuses non-IPv4-loopback or unsafe URL ${url}`, () => {
		assert.throws(() => new DirectDaemon(url, "FAKE_INTERFACE_TOKEN", async () => { throw new Error("must not fetch"); }), { message: "Direct daemon must use IPv4 loopback" });
	});
for (const redirected of [false, true]) test(`daemon refuses ${redirected ? "already followed" : "HTTP"} redirect`, async () => {
	const response = new Response("{}", { status: redirected ? 200 : 302 }); Object.defineProperty(response, "redirected", { value: redirected });
	const daemon = new DirectDaemon("http://127.0.0.1", "FAKE_INTERFACE_TOKEN", async (_url, init) => { assert.equal(init.redirect, "error"); return response; });
	await assert.rejects(daemon.listOffers(), { message: "Direct daemon request refused" });
});
test("missing, false and malformed confirmation cannot auto-accept or call fetch", async () => {
	let calls = 0;
	const daemon = new DirectDaemon("http://127.0.0.1", "FAKE_INTERFACE_TOKEN", async () => { calls++; return Response.json({}); });
	for (const confirmation of [undefined, {}, { person: false }, { person: "true" }]) await assert.rejects(daemon.accept("offer", confirmation as PersonConfirmation), { message: "Person confirmation required" });
	assert.equal(calls, 0);
});
test("r2 header, offer-specific paths, bodies and sessions route match the boundary", async () => {
	const requests: { path: string; body: unknown }[] = [];
	const daemon = new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", async (url, init) => {
		assert.equal(new Headers(init.headers).get("X-Runner-Interface-Token"), "FAKE_INTERFACE_TOKEN");
		requests.push({ path: new URL(url).pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
		return Response.json({ state: "accepted" }, { status: 202 });
	});
	await daemon.accept("offer/1", { person: true }); await daemon.decline("offer/1", "Not now"); await daemon.runnerState();
	assert.deepEqual(requests, [{ path: "/offers/offer%2F1/accept", body: {} }, { path: "/offers/offer%2F1/decline", body: { reason: "Not now" } }, { path: "/sessions", body: undefined }]);
});
test("network errors never expose the interface token", async () => {
	const daemon = new DirectDaemon("http://127.0.0.1", "FAKE_INTERFACE_TOKEN", async () => { throw new Error("FAKE_INTERFACE_TOKEN"); });
	await assert.rejects(daemon.runnerState(), { message: "Direct daemon request refused" });
});
test("listing is read-only; own-daemon accept does not itself authorize launch", async (t) => {
	const stub = new DirectStub(); t.after(() => stub.dispose()); const daemon = new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", stub.fetch);
	assert.equal((await daemon.listOffers()).length, 1); assert.equal(stub.facts.length, 0); assert.equal(stub.launch(), undefined);
	assert.deepEqual(await daemon.accept("offer-fake", { person: true }), { state: "accepted" });
	assert.deepEqual(stub.facts, [{ kind: "accept", cause: "person" }]); assert.ok(stub.launch());
	assert.equal((await daemon.runnerState())[0].harness, "pi");
	await assert.rejects(daemon.accept("offer-fake", { person: true }));
	await assert.rejects(daemon.accept("unknown", { person: true }));
});
test("decline removes the offer without launching", async () => {
	const stub = new DirectStub(); const daemon = new DirectDaemon("http://127.0.0.1:7777", "FAKE_INTERFACE_TOKEN", stub.fetch);
	assert.deepEqual(await daemon.decline("offer-fake"), { state: "declined" });
	assert.deepEqual(await daemon.listOffers(), []); assert.equal(stub.launch(), undefined);
	await assert.rejects(daemon.accept("offer-fake", { person: true }));
});
