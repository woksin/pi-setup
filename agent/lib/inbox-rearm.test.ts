import assert from "node:assert/strict";
import { test } from "node:test";
import inboxRearm, { lostInboxWatch } from "../extensions/inbox-rearm.ts";

const params = { check: "INBOX_DIR=/tmp/inbox ~/.pi/agent/bin/inbox-watch --alias R-AI L1 GROUP", until: "success", intervalSeconds: 120, timeoutSeconds: 3600, cwd: "/tmp/lane", label: "L1 inbox" };
const message = (m: object) => ({ type: "message", message: m });
const start = (id = "j1", input = params): any[] => [
	message({ role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "job_watch", arguments: input }] }),
	message({ role: "toolResult", toolName: "job_watch", toolCallId: `call-${id}`, details: { id, kind: "watch", command: input.check, status: "running" } }),
];
const finish = (status = "matched", id = "j1", check = params.check) => ({ type: "custom_message", customType: "pi-jobs", details: { completions: [{ job: { id, kind: "watch", command: check, status } }] } });

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
	delete process.env.PI_LANE_ID;
	try {
		assert.equal(await settle({ entries: [] }, { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionName: () => undefined } }), undefined);
		const result = await settle({ entries: [] }, ctx);
		assert.equal(result.continue, true);
		assert.ok(result.entries[0].content.includes(`job_watch(${JSON.stringify(params)})`));
		assert.equal(await settle({ entries: [] }, ctx), undefined);
	} finally {
		if (oldLane === undefined) delete process.env.PI_LANE_ID; else process.env.PI_LANE_ID = oldLane;
	}
});
