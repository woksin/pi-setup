// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// Deterministic lease clocks exercise terminal refusals before normal renewals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DirectLease } from "./direct-link-lease.ts";
import type { LeaseClock, LeaseTransport } from "./direct-link-lease.ts";
import type { DirectError, Result, Renewal, WorkState } from "./direct-link-mcp.ts";
import { parseWorkItem } from "./direct-link-workitem.ts";
import { stubWorkPayload } from "./direct-link-stub.ts";
const initial = Date.parse("2026-01-01T00:00:00Z");
function setup(failure?: DirectError, heartbeatEvery = 20_000) {
	let now = initial; let calls = 0; let clears = 0;
	const tasks = new Map<object, { fn: () => void; at: number }>();
	const next = () => [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
	const states: (WorkState | undefined)[] = [];
	const clock: LeaseClock = { now: () => now, setTimeout: (fn, ms) => { const id = {}; tasks.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => { tasks.delete(id as object); clears++; } };
	const transport: LeaseTransport = {
		heartbeat: async (context, state): Promise<Result<Renewal>> => {
			calls++; states.push(state); assert.equal(context.epoch, 1);
			return failure ? { ok: false, error: failure } : { ok: true, value: { epoch: context.epoch, leaseUntil: new Date(now + 90_000).toISOString(), state } };
		}, release: async () => { calls++; return { ok: true, value: {} }; },
	};
	const item = parseWorkItem({ ...stubWorkPayload(now), heartbeatEvery }, now);
	const lease = new DirectLease(item, transport, clock);
	return { lease, states, transport, calls: () => calls, delay: () => next()?.[1].at! - now, clears: () => clears, advance: (ms: number) => { now += ms; },
		tick: async () => { const task = next(); assert.ok(task); tasks.delete(task[0]); now = Math.max(now, task[1].at); task[1].fn(); await new Promise(setImmediate); }, pending: () => tasks.size > 0 };
}
for (const error of [{ kind: "stale-epoch" }, { kind: "cancelled", reason: "Journey changed" }, { kind: "grant-expired" }, { kind: "lease-lost" }, { kind: "fatal-stop" }] as DirectError[]) {
	test(`${error.kind} loses lease, cancels scheduler and fences every later write`, async () => {
		const s = setup(error); s.lease.start(); await s.tick();
		assert.equal(s.lease.lost, true); assert.equal(s.pending(), false);
		assert.deepEqual(await s.lease.setState("working"), { ok: false, error });
		assert.deepEqual(await s.lease.write(async () => { assert.fail("must not write"); }), { ok: false, error });
		assert.deepEqual(await s.lease.release({ outcome: "abandoned", note: "stopped" }), { ok: false, error });
		s.lease.start(); assert.equal(s.pending(), false); assert.equal(s.calls(), 1);
	});
}
test("queued writes behind a terminal failure never reach the transport", async () => {
	const s = setup({ kind: "stale-epoch" });
	const results = await Promise.all([s.lease.renew(), s.lease.renew(), s.lease.setState("blocked")]);
	assert.ok(results.every((r) => !r.ok)); assert.equal(s.calls(), 1);
});
test("local expiry fences writes even if no timer fired", async () => {
	const s = setup(); s.advance(90_000);
	assert.equal(s.lease.lost, true); await s.lease.renew(); assert.equal(s.calls(), 0);
});
test("heartbeat schedule is min(heartbeatEvery, remaining TTL/3) and renews periodically", async () => {
	for (const [every, expected] of [[20_000, 20_000], [60_000, 30_000]]) {
		const s = setup(undefined, every); s.lease.start(); s.lease.start(); assert.equal(s.delay(), expected);
		await s.tick(); await s.tick(); assert.equal(s.calls(), 2);
		assert.equal(s.pending(), true); s.lease.stop(); assert.equal(s.pending(), false);
	}
});
test("only changed state is sent; periodic renewal sends the current state", async () => {
	const s = setup();
	await Promise.all([s.lease.setState("working"), s.lease.setState("working")]);
	await s.lease.renew(); await s.lease.setState("waiting-ci"); await s.lease.setState("waiting-ci");
	assert.deepEqual(s.states, ["working", "working", "waiting-ci"]);
});
test("transient failure does not lose a still-valid lease", async () => {
	const s = setup({ kind: "unavailable" }); await s.lease.renew();
	assert.equal(s.lease.lost, false); await s.lease.renew(); assert.equal(s.calls(), 2);
});
test("successful release stops timers and refuses subsequent writes locally", async () => {
	const s = setup(); s.lease.start();
	assert.equal((await s.lease.release({ outcome: "delivered", note: "done" })).ok, true);
	assert.equal(s.pending(), false); assert.equal((await s.lease.renew()).ok, false); assert.equal(s.calls(), 1);
});
test("stop permanently fences queued writes and ignores a late heartbeat success", async () => {
	const s = setup(); let finish!: (result: Result<Renewal>) => void;
	s.transport.heartbeat = async () => new Promise(resolve => { finish = resolve; });
	const pending = s.lease.renew("working"); await new Promise(setImmediate);
	let sent = false;
	const queued = s.lease.write(async () => { sent = true; return { ok: true, value: undefined }; });
	s.lease.stop();
	assert.equal((await pending).ok, false); assert.equal((await queued).ok, false);
	finish({ ok: true, value: { leaseUntil: new Date(initial + 180_000).toISOString(), epoch: 1 } }); await new Promise(setImmediate);
	assert.equal(sent, false); assert.equal(s.lease.lost, true); assert.equal(s.pending(), false);
});
test("expiry watchdog aborts hung renewals without waiting for their transport", async () => {
	const s = setup(); let calls = 0;
	s.transport.heartbeat = async () => { calls++; return new Promise(() => {}); };
	s.lease.start(); await s.tick(); assert.equal(calls, 1);
	await s.tick();
	assert.equal(s.lease.lost, true); assert.equal(s.pending(), false);
	assert.equal((await s.lease.renew()).ok, false); assert.equal(calls, 1);
});
test("expiry ignores late responses and notifies independently", async () => {
	let now = initial, expire!: () => void, finish!: (result: Result<Renewal>) => void, lost = 0;
	const lease = new DirectLease(parseWorkItem(stubWorkPayload(now), now), {
		heartbeat: async () => new Promise(resolve => { finish = resolve; }), release: async () => ({ ok: true, value: null }),
	}, { now: () => now, setTimeout: fn => { expire = fn; return 1; }, clearTimeout: () => {} }, () => { lost++; });
	const pending = lease.renew(); await new Promise(setImmediate);
	now += 90_000; expire();
	assert.equal(lost, 1); assert.equal((await pending).ok, false);
	finish({ ok: true, value: { leaseUntil: new Date(now + 90_000).toISOString(), epoch: 1 } }); await new Promise(setImmediate);
	assert.equal(lease.lost, true); assert.equal(lost, 1);
});
test("thrown transport errors are safe and cannot break the write queue", async () => {
	const s = setup();
	assert.deepEqual(await s.lease.write(async () => { throw new Error("dpat_FAKE0000"); }), { ok: false, error: { kind: "unavailable" } });
	assert.equal((await s.lease.renew()).ok, true);
});
