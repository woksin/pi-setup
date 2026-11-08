import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyResult, newState, nudgeText, step, textBytes, withNudge, appendTelemetry } from "./delegation-nudge.ts";
import { DISABLED, parseConfig } from "./output-cap.ts";
import extension from "../extensions/delegation-nudge.ts";

const cfg = { thresholdBytes: 1000, thresholdCalls: 3 };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-deleg-nudge-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const text = (t: string) => [{ type: "text", text: t }];

test("classification: read tools, read-like bash, delegation, other", () => {
	for (const t of ["read", "grep", "find", "ls"]) assert.equal(classifyResult(t, {}), "read", t);
	for (const t of ["Agent", "SubagentWorkflow"]) assert.equal(classifyResult(t, {}), "delegation", t);
	for (const t of ["edit", "write", "get_subagent_result", "job_status"]) assert.equal(classifyResult(t, {}), "other", t);
	for (const c of [
		"cat a.ts", "sed -n 1,50p a.ts", "head -20 x", "tail -f x", "nl a", "awk '{print}' a", "grep -rn foo .", "rg foo", "find . -name x", "ls -la", "tree", "wc -l a", "bat a",
		"cd /repo && cat a.ts", "FOO=1 rg x", "git grep foo", "git show HEAD:a", "git diff main", "git -C /r show HEAD", "git log -p -3", "git blame a", "git status | cat a", "echo hi; rg x",
	]) assert.equal(classifyResult("bash", { command: c }), "read", c);
	for (const c of [
		"git status", "git fetch origin", "git log --oneline", "git rev-parse HEAD", "git worktree list", "git add -A", "git commit -m x", "git push", "git merge origin/main",
		"gh pr view 1", "pi-phase run --kind test -- x", "job_status x", "node a.js", "python3 a.py", "npm test", "dotnet build",
		"git diff --stat", "git diff --shortstat main", "git diff --name-only", "git diff --name-status", "cat a > b", "echo x | tee f", "sed -i s/a/b/ f", "cd /repo",
	]) assert.equal(classifyResult("bash", { command: c }), "other", c);
	assert.equal(classifyResult("bash", { command: "cat a 2>&1" }), "read");
	assert.equal(classifyResult("bash", {}), "other");
});

test("window: fires once at the byte or call threshold, re-arms after another threshold of bytes", () => {
	let s = newState();
	let r = step(s, "read", 400, cfg); assert.equal(r.nudge, undefined); s = r.state;
	r = step(s, "read", 400, cfg); assert.equal(r.nudge, undefined); s = r.state;
	r = step(s, "read", 400, cfg); assert.deepEqual(r.nudge, { bytes: 1200, calls: 3 }); s = r.state;
	for (let i = 0; i < 4; i++) { r = step(s, "read", 100, cfg); assert.equal(r.nudge, undefined, `no repeat ${i}`); s = r.state; }
	r = step(s, "read", 600, cfg); assert.equal(r.nudge?.bytes, 2200); s = r.state;
	// bytes threshold alone
	r = step(newState(), "read", 1500, cfg); assert.deepEqual(r.nudge, { bytes: 1500, calls: 1 });
});

test("window: delegation resets and re-arms; other never changes state", () => {
	let s = newState();
	for (let i = 0; i < 3; i++) s = step(s, "read", 10, cfg).state;
	const before = JSON.stringify(s);
	assert.equal(JSON.stringify(step(s, "other", 99999, cfg).state), before);
	assert.equal(step(s, "other", 99999, cfg).nudge, undefined);
	s = step(s, "delegation", 0, cfg).state;
	assert.deepEqual(s, newState());
	let r = step(s, "read", 1000, cfg);
	assert.equal(r.nudge?.bytes, 1000);
});

test("bytes are the UTF-8 length of text parts; images ignored", () => {
	assert.equal(textBytes([...text("åb"), { type: "image", data: "xxxx" }, ...text("c")]), 4);
	assert.equal(textBytes([]), 0);
});

test("nudge text is one short line naming Explore and ops", () => {
	const t = nudgeText(41234, 14);
	assert.ok(t.length <= 300 && !t.trim().includes("\n"), t);
	assert.match(t, /Explore/); assert.match(t, /ops/); assert.match(t, /41234|41 kB|40\.\d kB|41\.\d kB/); assert.match(t, /14/);
});

test("withNudge appends a text part, keeps original, passes images through", () => {
	const orig = [...text("a"), ...text("b")];
	const out = withNudge(orig, "NUDGE")!;
	assert.deepEqual(out.slice(0, 2), orig);
	assert.equal(out.length, 3);
	assert.match((out[2] as any).text, /NUDGE/);
	assert.equal(withNudge([...text("a"), { type: "image", data: "" }], "N"), undefined);
});

test("config: missing block disables, present block defaults, bounds", () => {
	assert.equal(parseConfig({ outputCap: { enabled: true } }).delegationNudge.enabled, false);
	assert.equal(DISABLED.delegationNudge.enabled, false);
	assert.deepEqual(parseConfig({ delegationNudge: {} }).delegationNudge, { enabled: true, scope: "main", thresholdBytes: 40000, thresholdCalls: 12 });
	assert.deepEqual(parseConfig({ delegationNudge: { enabled: true, scope: "all", thresholdBytes: 10, thresholdCalls: 0 } }).delegationNudge, { enabled: true, scope: "all", thresholdBytes: 40000, thresholdCalls: 12 });
	assert.equal(parseConfig({ delegationNudge: { thresholdBytes: 5000, thresholdCalls: 2 } }).delegationNudge.thresholdBytes, 5000);
});

test("telemetry: JSONL line without command text; failures never throw", () => {
	const f = join(dir, "logs", "n.jsonl");
	appendTelemetry({ session: "s", cwd: "/c", bytes: 5, calls: 2, thresholdBytes: 1, thresholdCalls: 1, tool: "bash", kind: "read" }, f);
	const row = JSON.parse(readFileSync(f, "utf8").trim());
	assert.deepEqual(Object.keys(row).sort(), ["bytes", "calls", "cwd", "kind", "session", "thresholdBytes", "thresholdCalls", "tool", "ts"]);
	writeFileSync(join(dir, "file"), "x");
	appendTelemetry({ session: "s", cwd: "/c", bytes: 5, calls: 2, thresholdBytes: 1, thresholdCalls: 1, tool: "bash", kind: "read" }, join(dir, "file", "sub", "x.jsonl"));
});

test("extension: gating, appending, reset, telemetry", () => {
	const f = join(dir, "eff.json"), log = join(dir, "nudge.jsonl");
	const prev = { e: process.env.PI_EFFICIENCY_FILE, n: process.env.PI_DELEGATION_NUDGE_FILE };
	process.env.PI_EFFICIENCY_FILE = f; process.env.PI_DELEGATION_NUDGE_FILE = log;
	const roleKey = Symbol.for("pi-efficiency.session-roles");
	const prevRoles = (globalThis as any)[roleKey];
	delete (globalThis as any)[roleKey];
	try {
		const h: Record<string, Function> = {};
		extension({ on: (n: string, fn: Function) => { h[n] = fn; } } as any);
		const ctx = (id: string) => ({ cwd: dir, sessionManager: { getSessionId: () => id } });
		h.session_start({ reason: "startup" }, ctx("main"));
		h.session_start({ reason: "startup" }, ctx("sub"));
		const ev = (n = 600, tool = "read") => ({ toolName: tool, toolCallId: "t", input: {}, content: text("x".repeat(n)), isError: false });
		assert.equal(h.tool_result(ev(), ctx("main")), undefined, "no config = off");
		writeFileSync(f, JSON.stringify({ delegationNudge: { enabled: true, thresholdBytes: 1000, thresholdCalls: 50 } }));
		assert.equal(h.tool_result(ev(5000), ctx("sub")), undefined, "scope main skips subagent");
		assert.equal(h.tool_result(ev(), ctx("main")), undefined);
		const r = h.tool_result(ev(), ctx("main"));
		assert.equal(r.content.length, 2);
		assert.equal(r.content[0].text, "x".repeat(600));
		assert.match(r.content[1].text, /Explore/);
		assert.equal(h.tool_result(ev(), ctx("main")), undefined, "once per window");
		assert.equal(h.tool_result({ ...ev(), toolName: "Agent" }, ctx("main")), undefined);
		assert.equal(h.tool_result(ev(1500), ctx("main")).content.length, 2, "re-armed after delegation");
		const rows = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
		assert.equal(rows.length, 2);
		assert.equal(rows[0].session, "main"); assert.equal(rows[0].tool, "read");
		h.session_shutdown({}, ctx("main"));
		assert.equal(h.tool_result(ev(1500), ctx("main")).content.length, 2, "fresh state after shutdown");
	} finally {
		for (const [k, v] of [["PI_EFFICIENCY_FILE", prev.e], ["PI_DELEGATION_NUDGE_FILE", prev.n]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
		if (prevRoles) (globalThis as any)[roleKey] = prevRoles; else delete (globalThis as any)[roleKey];
		assert.equal(existsSync(log), true);
	}
});
