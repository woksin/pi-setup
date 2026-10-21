import assert from "node:assert/strict";
import { test } from "node:test";
import { argsSummary, maskMessages, stubText } from "./observation-mask.ts";
import extension from "../extensions/observation-mask.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opts = { keep: 3, batchTokens: 1000, minChars: 1000 };

/** n tool calls, each an assistant message + its result of `size` chars. */
function convo(n: number, size: (i: number) => number, extra: (i: number) => Partial<{ name: string; args: any; isError: boolean; text: string }> = () => ({})) {
	const msgs: any[] = [{ role: "user", content: "go" }];
	for (let i = 0; i < n; i++) {
		const e = extra(i);
		const name = e.name ?? "bash";
		msgs.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name, arguments: e.args ?? { command: `cmd ${i}` } }] });
		msgs.push({ role: "toolResult", toolCallId: `c${i}`, toolName: name, isError: e.isError ?? false, content: [{ type: "text", text: e.text ?? `r${i}:`.padEnd(size(i), "x") }], timestamp: i });
	}
	return msgs;
}
const results = (msgs: any[]) => msgs.filter(m => m.role === "toolResult");
const isStub = (m: any) => m.content[0].text.startsWith("[older tool output masked");

test("below the batch threshold nothing changes", () => {
	const msgs = convo(6, () => 1200); // 3 eligible * 1200 chars = 900 tokens < 1000
	const set = new Set<string>();
	const r = maskMessages(msgs, set, opts);
	assert.equal(r.changed, false);
	assert.equal(r.messages, msgs);
	assert.equal(r.eligibleTokens, 900);
	assert.equal(set.size, 0);
});

test("at the threshold all eligible results are masked at once; last K and small ones are kept", () => {
	const msgs = convo(8, i => (i === 1 ? 500 : 1400)); // eligible c0,c2,c3,c4 = 5600 chars = 1400 tokens
	const set = new Set<string>();
	const r = maskMessages(msgs, set, opts);
	assert.equal(r.changed, true);
	assert.deepEqual(r.newlyMasked, ["c0", "c2", "c3", "c4"]);
	const res = results(r.messages);
	assert.deepEqual(res.map(isStub), [true, false, true, true, true, false, false, false]);
	assert.equal(results(msgs).filter(isStub).length, 0, "input not mutated");
	assert.match(res[0].content[0].text, /bash cmd 0; was 1400 chars, 1 lines\. Re-run or re-read if needed\.\]$/);
});

test("stable across calls: same ids masked, prefix byte-identical, new masking only in batches", () => {
	let msgs = convo(8, () => 1400);
	const set = new Set<string>();
	const first = maskMessages(msgs, set, opts);
	const firstJson = JSON.stringify(first.messages);
	// Two more calls: new eligible c5,c6 = 2800 chars = 700 tokens < 1000 -> no new masking.
	msgs = convo(10, () => 1400);
	const second = maskMessages(msgs, set, opts);
	assert.deepEqual(second.newlyMasked, []);
	assert.ok(JSON.stringify(second.messages).startsWith(firstJson.slice(0, -1)), "earlier prefix is byte-identical");
	assert.equal(results(second.messages).filter(isStub).length, 5);
	// One more: c5,c6,c7 = 1050 tokens -> the whole batch is masked.
	msgs = convo(11, () => 1400);
	const third = maskMessages(msgs, set, opts);
	assert.deepEqual(third.newlyMasked, ["c5", "c6", "c7"]);
	assert.equal(JSON.stringify(third.messages.slice(0, 11)), JSON.stringify(second.messages.slice(0, 11)));
});

test("recomputing from an empty set after a restart masks a superset in one step", () => {
	const msgs = convo(12, () => 1400);
	const a = new Set<string>();
	maskMessages(convo(8, () => 1400), a, opts);
	const r = maskMessages(msgs, new Set(), opts);
	for (const id of a) assert.ok(r.newlyMasked.includes(id));
});

test("never mask edit/write, '# keep' calls, latest-turn errors, images", () => {
	const msgs = convo(9, () => 1500, i => (
		i === 0 ? { name: "edit", args: { path: "a" } }
		: i === 1 ? { name: "write", args: { path: "b" } }
		: i === 2 ? { args: { command: "cat big.log # keep" } }
		: {}));
	// Error results from the latest turn: two results after the last assistant message.
	msgs.push({ role: "assistant", content: [{ type: "toolCall", id: "e1", name: "bash", arguments: { command: "x" } }, { type: "toolCall", id: "e2", name: "bash", arguments: { command: "y" } }] });
	const err = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", isError: true, content: [{ type: "text", text: "E".repeat(3000) }] });
	msgs.push(err("e1"), err("e2"));
	// image result, old
	msgs.splice(2, 0, { role: "toolResult", toolCallId: "img", toolName: "read", isError: false, content: [{ type: "text", text: "y".repeat(5000) }, { type: "image", data: "", mimeType: "image/png" }] });
	const set = new Set<string>();
	const r = maskMessages(msgs, set, { keep: 1, batchTokens: 100, minChars: 1000 });
	assert.ok(!set.has("c0") && !set.has("c1") && !set.has("c2") && !set.has("img") && !set.has("e1") && !set.has("e2"));
	assert.ok(set.has("c3") && set.has("c8"));
	// An older error result (not latest turn) can be masked.
	const older = convo(6, () => 1500, i => (i === 0 ? { isError: true } : {}));
	const s2 = new Set<string>();
	maskMessages(older, s2, opts);
	assert.ok(s2.has("c0"));
	assert.ok(r.changed);
});

test("stub uses the C4 offload path and a short args summary", () => {
	const t = `head\n[... 10 lines elided ...]\ntail\n[full output: /r/.ai-work/tool-out/s/c1.txt, 900 lines, 50000 chars; use read with offset/limit or grep]`;
	assert.match(stubText("bash", { command: "dotnet test" }, t), /Full output: \/r\/\.ai-work\/tool-out\/s\/c1\.txt\.\]$/);
	assert.equal(argsSummary("read", { path: "/a/b.ts", offset: 10, limit: 50 }), "/a/b.ts offset=10 limit=50");
	assert.equal(argsSummary("grep", { pattern: "foo", path: "src" }), "foo in src");
	assert.ok(argsSummary("bash", { command: "x".repeat(500) }).length <= 161);
});

test("extension: off without config, gated by scope, stable set per session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-mask-"));
	const f = join(dir, "eff.json");
	const prev = process.env.PI_EFFICIENCY_FILE;
	process.env.PI_EFFICIENCY_FILE = f;
	const roleKey = Symbol.for("pi-efficiency.session-roles");
	const prevRoles = (globalThis as any)[roleKey];
	delete (globalThis as any)[roleKey];
	try {
		const h: Record<string, Function> = {};
		extension({ on: (n: string, fn: Function) => { h[n] = fn; } } as any);
		const ctx = (id: string) => ({ cwd: dir, sessionManager: { getSessionId: () => id } });
		h.session_start({ reason: "startup" }, ctx("main"));
		h.session_start({ reason: "startup" }, ctx("sub"));
		const msgs = convo(30, () => 9000);
		assert.equal(h.context({ messages: msgs }, ctx("sub")), undefined, "no config = off");
		writeFileSync(f, JSON.stringify({ observationMask: { enabled: true, keep: 15, batchTokens: 30000, scope: "subagents" } }));
		assert.equal(h.context({ messages: msgs }, ctx("main")), undefined, "main not in scope");
		const r1 = h.context({ messages: msgs }, ctx("sub"));
		assert.equal(results(r1.messages).filter(isStub).length, 15);
		const r2 = h.context({ messages: convo(31, () => 9000) }, ctx("sub"));
		assert.equal(JSON.stringify(r2.messages.slice(0, 61)), JSON.stringify(r1.messages));
	} finally {
		if (prev === undefined) delete process.env.PI_EFFICIENCY_FILE; else process.env.PI_EFFICIENCY_FILE = prev;
		(globalThis as any)[roleKey] = prevRoles;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension logs a thrown error and fails open", () => {
	const d = mkdtempSync(join(tmpdir(), "pi-mask-err-"));
	const f = join(d, "err.jsonl");
	const prev = process.env.PI_EFFICIENCY_ERRORS_FILE;
	process.env.PI_EFFICIENCY_ERRORS_FILE = f;
	try {
		const h: Record<string, Function> = {};
		extension({ on: (n: string, fn: Function) => { h[n] = fn; } } as any);
		const bad = { cwd: d, sessionManager: { getSessionId: () => { throw new Error("nosession"); } } };
		assert.equal(h.context({ messages: [] }, bad), undefined);
		const row = JSON.parse(readFileSync(f, "utf8").trim());
		assert.deepEqual([row.ext, row.event, row.message], ["observation-mask", "context", "nosession"]);
		assert.ok(row.ts);
	} finally {
		if (prev === undefined) delete process.env.PI_EFFICIENCY_ERRORS_FILE; else process.env.PI_EFFICIENCY_ERRORS_FILE = prev;
		rmSync(d, { recursive: true, force: true });
	}
});
