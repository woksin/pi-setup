/** wait-guard: budgets, polling detection, pi-phase budget, handler wiring. Complements guards.test.ts. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGuards } from "./guards.ts";
import waitExtension, { MAX_TIMEOUT_SECONDS, PollTracker, argsOf, assess, executableCommands, piPhaseBudget, repeatedPollMessage } from "../extensions/wait-guard.ts";

const ENV = ["PI_GUARDS_FILE", "PI_GUARDS_OFF", "PI_ORCH_ID", "PI_ORCH_MODE_FILE", "PI_ORCH_REPO_ROOT", "PI_ORCH_MESSAGES_DIR", "PI_GUARD_DECISIONS_LOG"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = Object.fromEntries(ENV.map(n => [n, process.env[n]]));
	const dir = mkdtempSync(join(tmpdir(), "wait-guard-"));
	process.env.PI_GUARDS_FILE = join(dir, "guards.json");
	delete process.env.PI_GUARDS_OFF;
	delete process.env.PI_ORCH_ID;
	process.env.PI_ORCH_MODE_FILE = join(dir, "orchestration-mode");
	process.env.PI_ORCH_REPO_ROOT = join(dir, "repos");
	process.env.PI_ORCH_MESSAGES_DIR = join(dir, "messages");
	process.env.PI_GUARD_DECISIONS_LOG = join(dir, "decisions.jsonl");
	delete (globalThis as any)[Symbol.for("pi.guards")];
});
afterEach(() => {
	for (const [n, v] of Object.entries(saved)) if (v === undefined) delete process.env[n]; else process.env[n] = v;
	delete (globalThis as any)[Symbol.for("pi.guards")];
});

function handler(tools: string[]) {
	let h: any;
	waitExtension({ on: (_: string, fn: any) => { h = fn; }, getActiveTools: () => tools } as any);
	const notices: string[] = [];
	const ctx = { cwd: "/nowhere", hasUI: true, ui: { notify: (t: string) => notices.push(t) } };
	return { call: (command: string, timeout?: number) => {
		const event = { toolName: "bash", input: { command, ...(timeout === undefined ? {} : { timeout }) } };
		return h(event, ctx).then((r: any) => ({ r, event, notices }));
	} };
}

test("timeout budget: 600 s is the limit; 601 needs approval; undefined/small pass", () => {
	assert.equal(MAX_TIMEOUT_SECONDS, 600);
	assert.deepEqual(assess("printf ok", 600, false), {});
	assert.deepEqual(assess("printf ok", undefined, false), {});
	assert.match(assess("printf ok", 601, false).needsApproval ?? "", /timeout 601s exceeds the 600s foreground limit/);
});

test("pi-phase budget: Σ(timeout+queue)+60 slack raises the allowed outer timeout; unapproved >600 does not", () => {
	assert.equal(piPhaseBudget("printf ok"), undefined);
	assert.equal(piPhaseBudget("~/.pi/agent/bin/pi-phase run --kind build --timeout 300 --queue-timeout 120 -- make"), 480);
	assert.equal(piPhaseBudget("pi-phase run --kind test -- x"), 300 + 120 + 60); // defaults
	assert.equal(piPhaseBudget("pi-phase run --timeout 100 --queue-timeout 50 -- a && pi-phase run --timeout 200 --queue-timeout 0 -- b"), 410);
	assert.equal(piPhaseBudget("pi-phase run --timeout 700 --queue-timeout 10 -- x"), undefined);
	assert.equal(piPhaseBudget("pi-phase run --timeout 300 --queue-timeout 700 -- x"), undefined);
	assert.equal(piPhaseBudget("pi-phase run --timeout 300 --queue-timeout 7200 -- x"), undefined);
	assert.ok(assess("pi-phase run --timeout 300 --queue-timeout 7200 -- x", 7560, false).needsApproval);
	assert.equal(piPhaseBudget("pi-phase run --timeout 700 --approved-long-timeout -- x"), undefined);
	const cmd = "pi-phase run --kind build --timeout 500 --queue-timeout 200 -- make"; // budget 760
	assert.deepEqual(assess(cmd, 760, false), {});
	assert.ok(assess(cmd, 761, false).needsApproval);
	assert.ok(assess("make", 700, false).needsApproval);
});

test("sleep budgets: ≥60 s plain sleep blocked (units and sums), 59 s allowed", () => {
	assert.equal(assess("sleep 59", 60, false).block, undefined);
	assert.match(assess("sleep 60", 120, false).block ?? "", /60s of sleep blocked/);
	assert.match(assess("sleep 1m", 120, false).block ?? "", /60s of sleep blocked/);
	assert.match(assess("sleep 30; make; sleep 30", 120, false).block ?? "", /60s of sleep blocked/);
	assert.match(assess("sleep 2h", 120, false).block ?? "", /7200s/);
});

test("loops: CI-status loop and ≥30 s-per-iteration loops blocked; short non-CI loop allowed", () => {
	assert.match(assess("while true; do gh pr checks 1; sleep 5; done", 60, false).block ?? "", /never poll/); // caught by the sleep+status rule first
	assert.match(assess("while true; do gh pr status; sleep 5; done", 60, false).block ?? "", /polling loop over CI\/PR status/);
	assert.match(assess("until make; do sleep 30; done", 60, false).block ?? "", /loop sleeping ≥ 30s per iteration/);
	assert.equal(assess("for i in 1 2 3; do echo $i; sleep 1; done", 60, false).block, undefined);
	assert.equal(assess("while true; do sleep 29; done", 60, false).block, undefined);
});

test("sleep + status query is blocked in any order/separator; sleep alone or gh alone is not", () => {
	for (const c of ["sleep 5 && gh pr checks 1", "gh run view 5; sleep 1", "sleep 1 | gh run list", "sleep 1; gh -R x/y pr view 3", "sleep 2; git ls-remote origin", "sleep 1; gh api repos/o/r/actions/runs"])
		assert.match(assess(c, 60, false).block ?? "", /sleep combined with a CI\/status query/, c);
	for (const c of ["gh pr checks 1", "sleep 5", "sleep 5; gh pr checks 1 --watch", "echo 'sleep 5; gh pr checks 1'", "sleep 5; git status"])
		assert.notEqual(assess(c, 60, false).block?.includes("combined with a CI"), true, c);
});

test("job_start availability: foreground watch blocked only with it; message guidance differs", () => {
	for (const c of ["gh run watch 7 --exit-status", "gh pr checks 3 --watch"]) {
		assert.match(assess(c, 60, true).block ?? "", /foreground CI watch blocked.*job_start/s, c);
		assert.deepEqual(assess(c, 60, false), {}, c);
	}
	assert.match(assess("sleep 120", 60, true).block ?? "", /Use `job_start`/);
	assert.match(assess("sleep 120", 60, false).block ?? "", /report the status and stop/);
	assert.equal(assess("echo gh run watch 7", 60, true).block, undefined); // text, not an invocation
	assert.match(repeatedPollMessage(true), /job_start/);
	assert.match(repeatedPollMessage(false), /Report the current status/);
});

test("argsOf / executableCommands: program position, paths, wrappers, substitutions", () => {
	assert.deepEqual(argsOf(["gh", "pr", "checks"], "gh"), ["pr", "checks"]);
	assert.deepEqual(argsOf(["/usr/bin/gh", "x"], "gh"), ["x"]);
	assert.equal(argsOf(["ghost", "x"], "gh"), undefined);
	assert.equal(argsOf(["echo", "gh"], "gh"), undefined);
	assert.deepEqual(argsOf(["FOO=1", "gh", "x"], "gh"), ["x"]);
	assert.deepEqual(executableCommands("a; b c && d | e"), [["a"], ["b", "c"], ["d"], ["e"]]);
	assert.deepEqual(executableCommands("echo 'x; y'"), [["echo", "x; y"]]);
	assert.ok(executableCommands("echo $(gh pr checks 1)").some(w => argsOf(w, "gh")?.[0] === "pr"));
	assert.ok(executableCommands("cat <<'EOF'\ngh pr checks 1\nEOF").every(w => argsOf(w, "gh") === undefined));
});

test("PollTracker: window edge, per-query keys, no-op for non-gh, push checkpoint", () => {
	const t = new PollTracker();
	const q = "gh run view 5";
	const W = 15 * 60_000;
	assert.equal(t.check(q, 0), false);
	assert.equal(t.check(q, 1), false);
	assert.equal(t.check(q, W - 1), true); // still inside window
	const u = new PollTracker();
	u.check(q, 0); u.check(q, 1);
	assert.equal(u.check(q, W + 1), false); // first one aged out
	const p = new PollTracker();
	p.check(q, 0); p.check(q, 1);
	assert.equal(p.check("git push origin x && gh run view 5", 2), false); // push clears history
	assert.equal(p.check("gh run view 6", 3), false);
	assert.equal(p.check("echo hi", 4), false);
});

test("handler: sets default 600 s timeout, blocks over-limit and polls, ignores non-bash", async () => {
	const h = handler(["bash"]);
	const plain = await h.call("printf ok");
	assert.equal(plain.r, undefined);
	assert.equal((plain.event.input as any).timeout, 600);
	const keep = await h.call("printf ok", 120);
	assert.equal((keep.event.input as any).timeout, 120);
	const over = await h.call("printf ok", 900);
	assert.equal(over.r.block, true);
	assert.match(over.r.reason, /exceeds the 600s foreground limit/);
	assert.equal((await h.call("sleep 90", 120)).r.block, true);
	let fn: any;
	waitExtension({ on: (_: string, f: any) => { fn = f; }, getActiveTools: () => [] } as any);
	assert.equal(await fn({ toolName: "read", input: { command: "sleep 999" } }, {}), undefined);
});

test("handler: repeated identical status poll is blocked the third time, with job_start-aware text", async () => {
	const h = handler(["bash", "job_start"]);
	assert.equal((await h.call("gh pr checks 9 --repo a/b", 60)).r, undefined);
	assert.equal((await h.call("gh pr checks 9 --repo a/b", 60)).r, undefined);
	const third = await h.call("gh pr checks 9 --repo a/b", 60);
	assert.equal(third.r.block, true);
	assert.equal(third.r.reason, repeatedPollMessage(true));
});

test("handler: orchestration allows over-limit timeout; guard off allows blocks and notifies (wait)", async () => {
	process.env.PI_ORCH_ID = "L0";
	const orch = await handler(["bash"]).call("printf ok", 900);
	assert.equal(orch.r, undefined);
	assert.equal((orch.event.input as any).timeout, 900);
	delete process.env.PI_ORCH_ID;
	setGuards("wait", true);
	const off = await handler(["bash"]).call("sleep 300");
	assert.equal(off.r, undefined);
	assert.equal((off.event.input as any).timeout, 600);
	assert.match(off.notices[0], /^wait-guard off: allowed 'sleep 300'/);
});
