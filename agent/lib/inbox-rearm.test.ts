import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inboxRearm, { lostInboxWatch, parkedStatus } from "../extensions/inbox-rearm.ts";

const params = { check: "INBOX_DIR=/tmp/inbox ~/.pi/agent/bin/inbox-watch --alias R-AI L1 GROUP", until: "success", intervalSeconds: 120, timeoutSeconds: 3600, cwd: "/tmp/lane", label: "L1 inbox" };
const message = (m: object) => ({ type: "message", message: m });
const start = (id = "j1", input = params): any[] => [
	message({ role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "job_watch", arguments: input }] }),
	message({ role: "toolResult", toolName: "job_watch", toolCallId: `call-${id}`, details: { id, kind: "watch", command: input.check, status: "running" } }),
];
const finish = (status = "matched", id = "j1", check = params.check) => ({ type: "custom_message", customType: "pi-jobs", details: { completions: [{ job: { id, kind: "watch", command: check, status } }] } });

const subscription = (status = "running", overrides = {}) => ({
	id: "s1", kind: "subscription", command: "./check-inbox", status, lane: "L1", inboxDir: "/tmp/inbox",
	cwd: "/tmp/lane", logPath: "/tmp/s1.log", startedAt: 2000, timeoutSeconds: 3600, intervalSeconds: 120,
	checkTimeoutSeconds: 30, statusPath: "/tmp/inbox/status/L1.status", deadline: 3602000, matchSequence: 0, checks: 0,
	...overrides,
});
const result = (toolName: string, details: any) => message({ role: "toolResult", toolName, details });
const subscriptionEvent = (job = subscription(), event = "match", sequence = 1) => ({
	type: "custom_message", customType: "pi-jobs", details: { deliveryId: `d${sequence}`, completions: [{
		completionId: `c${sequence}`, part: 0, job, event, sequence, capture: { bytes: 12, truncated: false },
	}] },
});

test("subscription results, lists, output and repeated matches suppress stale watch recovery across reload", () => {
	const old = [...start(), finish()];
	for (const tool of ["job_subscribe", "job_list", "job_output", "job_kill"]) {
		const job = subscription();
		const entries = [...old, result(tool, tool === "job_list" ? { jobs: [job] } : job)];
		assert.equal(lostInboxWatch(entries, "L1"), undefined);
		assert.equal(lostInboxWatch(JSON.parse(JSON.stringify([...entries, subscriptionEvent(), subscriptionEvent(subscription(), "match", 2)])), "L1"), undefined);
	}
	assert.equal(lostInboxWatch([...old, subscriptionEvent()], "L1"), undefined);
});

test("terminal or killed subscription supersedes old watches, but not newer ordinary watches", () => {
	for (const status of ["failed", "timed_out", "killed", "succeeded"]) {
		const entries = [...start(), finish(), result("job_subscribe", subscription()),
			result(status === "killed" ? "job_kill" : "job_output", subscription(status))];
		assert.equal(lostInboxWatch(entries, "L1"), undefined);
		assert.equal(lostInboxWatch([...entries, subscriptionEvent()], "L1"), undefined); // Replayed stale running snapshot.
		assert.deepEqual(lostInboxWatch([...entries, ...start("j2"), finish("matched", "j2")], "L1"), { id: "j2", params });
		assert.equal(lostInboxWatch([...entries, ...start("j2"), subscriptionEvent(subscription(status), "terminal")], "L1"), undefined);
	}
	assert.equal(lostInboxWatch([...start(), result("job_subscribe", subscription("failed"))], "L1"), undefined);
});

test("snapshot creation order, not delayed observations, decides whether an ordinary watch is newer", () => {
	const entries = [...start(), finish(), result("job_subscribe", subscription()), ...start("j2"), finish("matched", "j2"),
		result("job_list", { jobs: [
			{ id: "j2", kind: "watch", command: params.check, status: "matched", startedAt: 3000 },
			subscription("failed"), subscription("running", { id: "older-sub", startedAt: 1000 }),
		] })];
	assert.deepEqual(lostInboxWatch(entries, "L1"), { id: "j2", params });
	assert.equal(lostInboxWatch([...entries, result("job_output", { id: "j2", kind: "watch", command: params.check, status: "matched", startedAt: 1000 })], "L1"), undefined);
});

test("unrelated lanes and malformed subscription records do not suppress ordinary recovery", () => {
	for (const job of [subscription("running", { lane: "L2" }), subscription("running", { inboxDir: null }),
		subscription("running", { inboxDir: "relative" }), subscription("unknown"), subscription("running", { id: 7 }),
		subscription("running", { startedAt: null }), { kind: "subscription", lane: "L1" }]) {
		assert.deepEqual(lostInboxWatch([...start(), finish(), result("job_subscribe", job)], "L1"), { id: "j1", params });
	}
	for (const overrides of [{ event: "unknown" }, { event: "terminal" }, { sequence: -1 }, { part: null },
		{ completionId: null }, { capture: { bytes: "payload", truncated: false } }, { capture: null }]) {
		const entry = subscriptionEvent(); Object.assign(entry.details.completions[0], overrides);
		assert.deepEqual(lostInboxWatch([...start(), finish(), entry], "L1"), { id: "j1", params });
	}
	assert.deepEqual(lostInboxWatch([...start(), finish(), subscriptionEvent(subscription("running", { lane: "L2" })),
		{ type: "custom_message", customType: "pi-jobs-subscription-error", details: { job: subscription("failed", { lane: "L2" }) } }], "L1"), { id: "j1", params });
	assert.deepEqual(lostInboxWatch([...start(), finish(), result("unrelated", subscription()),
		result("job_list", { jobs: {} }), { type: "custom_message", customType: "pi-jobs", details: { completions: {} } }], "L1"), { id: "j1", params });
});

test("subscription failure and expiry diagnose once without waking; kills and matches stay quiet", async () => {
	const dir = mkdtempSync(join(tmpdir(), "inbox-subscription-"));
	const oldLane = process.env.PI_LANE_ID; const oldStatus = process.env.LANE_STATUS_DIR;
	process.env.PI_LANE_ID = "L1"; process.env.LANE_STATUS_DIR = dir;
	try {
		for (const status of ["running", "failed", "timed_out", "killed"]) {
			let settle: any; const notices: string[] = [];
			inboxRearm({ on: (_: string, fn: any) => { settle = fn; } } as any);
			const entries = [...start(), finish(), result("job_subscribe", subscription()),
				subscriptionEvent(subscription(status), status === "running" ? "match" : "terminal")];
			const ctx = { sessionManager: { getBranch: () => JSON.parse(JSON.stringify(entries)) }, ui: { notify(text: string) { notices.push(text); } } };
			assert.equal(await settle({ entries: [] }, ctx), undefined);
			assert.equal(await settle({ entries }, ctx), undefined);
			assert.equal(notices.length, ["failed", "timed_out"].includes(status) ? 1 : 0);
			assert.ok(notices.every(text => !text.includes("job_watch(")));
		}
		let settle: any; const notices: string[] = [];
		inboxRearm({ on: (_: string, fn: any) => { settle = fn; } } as any);
		const entries = [...start(), finish(), { type: "custom_message", customType: "pi-jobs-subscription-error", details: { job: subscription("failed") } }];
		assert.equal(await settle({ entries: [] }, { sessionManager: { getBranch: () => entries }, ui: { notify(text: string) { notices.push(text); } } }), undefined);
		assert.equal(notices.length, 0); // Already diagnosed publicly by pi-jobs, including after reload.
	} finally {
		if (oldLane === undefined) delete process.env.PI_LANE_ID; else process.env.PI_LANE_ID = oldLane;
		if (oldStatus === undefined) delete process.env.LANE_STATUS_DIR; else process.env.LANE_STATUS_DIR = oldStatus;
	}
});

test("completed inbox watch supplies its exact call, but unrelated, running and explicitly killed watches do not", () => {
	for (const status of ["matched", "succeeded", "failed", "timed_out"]) {
		assert.deepEqual(lostInboxWatch([...start(), finish(status)], "L1"), { id: "j1", params });
	}
	assert.equal(lostInboxWatch(start(), "L1"), undefined);
	assert.equal(lostInboxWatch([...start(), finish()], "L2"), undefined);
	assert.equal(lostInboxWatch([...start(), finish("killed")], "L1"), undefined);
	assert.equal(lostInboxWatch([...start("j1", { ...params, check: "echo inbox-watch L1" }), finish()], "L1"), undefined);
	assert.equal(lostInboxWatch([finish()], "L1"), undefined); // No exact call in history: do not invent one.
});

test("parking survives reload/assessment, never consumes inbox and working explicitly restores recovery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "inbox-parked-"));
	const old = { status: process.env.LANE_STATUS_DIR, lane: process.env.PI_LANE_ID };
	process.env.LANE_STATUS_DIR = dir; process.env.PI_LANE_ID = "L1";
	try {
		const file = join(dir, "L1.status"); const marker = join(dir, "marker"); writeFileSync(marker, "unread");
		const before = statSync(marker).mtimeMs;
		const ctx = { sessionManager: { getBranch: () => [...start(), finish()] }, ui: { notify() {} } };
		for (const assessment of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
			writeFileSync(file, `parked "review / L0" until ${assessment}\n`);
			let settle: any; inboxRearm({ on: (_: string, fn: any) => { settle = fn; } } as any);
			assert.equal(await settle({ entries: [] }, ctx), undefined);
			assert.equal(await settle({ entries: [] }, ctx), undefined);
			writeFileSync(file, "working since 2026-01-01T00:00:00Z\n");
			assert.equal((await settle({ entries: [] }, ctx)).continue, true);
		}
		let notices = 0; writeFileSync(file, "malformed"); let settle: any;
		inboxRearm({ on: (_: string, fn: any) => { settle = fn; } } as any);
		const badCtx = { ...ctx, ui: { notify() { notices++; } } };
		assert.equal(await settle({ entries: [] }, badCtx), undefined); await settle({ entries: [] }, badCtx);
		assert.equal(notices, 1); assert.equal(statSync(marker).mtimeMs, before); assert.equal(readFileSync(marker, "utf8"), "unread");
		const inbox = join(dir, "inbox"); mkdirSync(join(inbox, "status"), { recursive: true });
		writeFileSync(join(inbox, "status/R-AI.status"), 'parked "owner" until 2000-01-01T00:00:00Z');
		assert.equal(parkedStatus("R-AI", { INBOX_DIR: inbox }), "parked");
		assert.equal(parkedStatus("L1", { LANE_STATUS_DIR: dir, INBOX_DIR: inbox }), "invalid");
	} finally {
		for (const [key, value] of [["LANE_STATUS_DIR", old.status], ["PI_LANE_ID", old.lane]]) {
			if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
		}
	}
});

test("replacement or another running inbox watch suppresses reminder", () => {
	assert.equal(lostInboxWatch([...start(), finish(), ...start("j2")], "L1"), undefined);
	assert.equal(lostInboxWatch([...start(), ...start("j2"), finish()], "L1"), undefined);
	assert.deepEqual(lostInboxWatch([...start(), finish(), ...start("j2"), finish("timed_out", "j2")], "L1"), { id: "j2", params });
});

test("settlement is continued once with exact call; no polling, duplicate loop or non-lane trigger", async () => {
	let settle: any;
	inboxRearm({ on: (_name: string, handler: any) => { settle = handler; } } as any);
	const entries = [...start(), finish()];
	const ctx = { sessionManager: { getSessionName: () => "L1", getBranch: () => entries }, ui: { notify() {} } };
	const oldLane = process.env.PI_LANE_ID;
	const oldOrch = process.env.PI_ORCH_ID; delete process.env.PI_ORCH_ID;
	delete process.env.PI_LANE_ID;
	try {
		assert.equal(await settle({ entries: [] }, { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionName: () => undefined } }), undefined);
		const result = await settle({ entries: [] }, ctx);
		assert.equal(result.continue, true);
		assert.ok(result.entries[0].content.includes(`job_watch(${JSON.stringify(params)})`));
		assert.equal(await settle({ entries: [] }, ctx), undefined);
	} finally {
		if (oldLane === undefined) delete process.env.PI_LANE_ID; else process.env.PI_LANE_ID = oldLane;
		if (oldOrch === undefined) delete process.env.PI_ORCH_ID; else process.env.PI_ORCH_ID = oldOrch;
	}
});
