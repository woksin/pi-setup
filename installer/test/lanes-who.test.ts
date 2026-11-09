import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tempDir, REPO } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";
import { buildRoster, readRoster, suggestTarget } from "../src/lanes/roster.ts";

function fixture() {
  const home = tempDir("lanes-who"); const lines: string[] = []; const errors: string[] = [];
  const now = new Date("2026-01-20T12:00:00Z");
  const ctx: LanesCtx = { home, cwd: home, env: {}, platform: "linux", now: () => now,
    run: async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? "701 pi" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false }),
    readCwd: async () => join(home, "worker"), realpath: p => p, which: () => undefined,
    out: s => lines.push(s), err: s => errors.push(s), stdinTTY: true, readStdin: async () => "body",
    templatesDir: join(REPO, "installer/lanes/templates"), piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  const c = defaults(home, home);
  c.lanes.push({ id: "W1", repo: "example/alpha", worktree: "worker", cwd: join(home, "worker"), branch: "work-one", group: null, prompt: "prompt.md" });
  mkdirSync(join(home, "worker")); saveConfig(home, c);
  const put = (path: string, value: unknown) => { const full = join(home, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value)); return full; };
  const event = { ts: now.toISOString(), repo: "example/alpha", issue: 42, state: "in-progress", sessionId: "session-worker", source: "tool", branch: "work-one" };
  const lease = () => put("agent/issue-work/sessions/worker.json", { sessionId: "session-worker", pid: 701, startedAt: now.toISOString(), procStart: "synthetic start", cwd: join(home, "worker") });
  const heartbeat = (at = now.toISOString()) => put(".pi/orch/heartbeats/p701.json", { id: "W1", pid: 701, at, state: "working" });
  const who = async (...args: string[]) => { lines.length = 0; const code = await main(["who", "--json", ...args], ctx); return { code, report: lines.length ? JSON.parse(lines.at(-1)!) : null }; };
  return { home, ctx, c, put, event, lease, heartbeat, who, lines, errors };
}

test("who joins registered process, lease, register and fresh heartbeat with stable JSON keys", async () => {
  const f = fixture(); f.lease(); f.heartbeat(); f.put("agent/issue-work/registry.jsonl", JSON.stringify(f.event));
  const { code, report } = await f.who("--issue", "example/alpha#42");
  assert.equal(code, 0); const row = report.rows[0];
  assert.equal(row.lane, "W1"); assert.equal(row.state, "working"); assert.equal(row.sessionId, "session-worker");
  assert.deepEqual(row.issue, { repo: "example/alpha", number: 42, state: "in-progress", holder: true });
  assert.equal(row.contextUse, null); assert.equal(report.suggest.rule, "issue-owner");
  assert.deepEqual(Object.keys(row).sort(), ["lane", "identity", "repo", "worktree", "branch", "issue", "state", "idleMinutes", "contextUse", "pid", "sessionId", "lastInbound", "lastOutbound", "evidence", "notes"].sort());
  assert.ok(!("context" in report.sources));
});
test("absent processes are stopped but failed process discovery is unknown", async () => {
  for (const code of [1, 2]) {
    const f = fixture(); f.ctx.run = async () => ({ code: code === 1 ? 0 : code, stdout: "", stderr: "probe failed", timedOut: false });
    const { report } = await f.who();
    assert.equal(report.rows.find((r: any) => r.lane === "W1").state, code === 1 ? "stopped" : "unknown");
    assert.equal(report.sources.processes.status, code === 1 ? "ok" : "error");
    if (code === 2) { f.lines.length = 0; assert.equal(await main(["who"], f.ctx), 0); assert.match(f.lines.join("\n"), /source: processes error/); }
  }
});
test("unknown running identities are visible, and orch sessions supply identities without registration", async () => {
  const f = fixture(); f.ctx.readCwd = async () => join(f.home, "other");
  let result = await f.who(); assert.ok(result.report.rows.some((r: any) => r.identity === "unregistered" && r.pid === 701));
  f.put(".pi/orch/sessions/p701.json", { pid: 701, id: "ORCH1", cwd: join(f.home, "other") });
  result = await f.who(); assert.ok(result.report.rows.some((r: any) => r.identity === "orch" && r.lane === "ORCH1"));
});
test("orch processes sharing an unregistered cwd remain separate roster rows", async () => {
  const f = fixture(); const cwd = join(f.home, "shared");
  f.ctx.run = async () => ({ code: 0, stdout: "701 pi\n702 pi", stderr: "", timedOut: false });
  f.ctx.readCwd = async () => cwd;
  f.put(".pi/orch/sessions/p701.json", { pid: 701, id: "ORCH1", cwd });
  f.put(".pi/orch/sessions/p702.json", { pid: 702, id: "ORCH2", cwd });
  const { report } = await f.who();
  const rows = report.rows.filter((r: any) => r.identity === "orch");
  assert.deepEqual(rows.map((r: any) => ({ lane: r.lane, pid: r.pid, worktree: r.worktree })), [
    { lane: "ORCH1", pid: 701, worktree: cwd }, { lane: "ORCH2", pid: 702, worktree: cwd },
  ]);
});
test("who projects every held issue and suggestions name the PID-verified row sharing a cwd", async () => {
  const f = fixture(); const cwd = join(f.home, "shared");
  f.ctx.run = async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? "702 pi\n701 pi" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false });
  f.ctx.readCwd = async () => cwd;
  f.lease();
  f.put("agent/issue-work/sessions/worker.json", { sessionId: "session-worker", pid: 701, startedAt: f.ctx.now().toISOString(), procStart: "synthetic start", cwd });
  f.put("agent/issue-work/sessions/other.json", { sessionId: "session-other", pid: 702, startedAt: f.ctx.now().toISOString(), procStart: "synthetic start", cwd });
  f.put(".pi/orch/sessions/p701.json", { pid: 701, id: "HOLDER", cwd });
  f.put(".pi/orch/sessions/p702.json", { pid: 702, id: "OTHER", cwd });
  f.put("agent/issue-work/registry.jsonl", [f.event, { ...f.event, issue: 1082, ts: "2026-01-20T12:01:00Z" },
    { ...f.event, issue: 99, sessionId: "session-other" }].map(e => JSON.stringify(e)).join("\n"));
  const unfiltered = await f.who();
  assert.equal(unfiltered.report.rows.find((r: any) => r.lane === "HOLDER").issue.number, 1082);
  assert.equal(unfiltered.report.rows.find((r: any) => r.lane === "OTHER").sessionId, "session-other");
  for (const issue of [42, 1082]) {
    const { code, report } = await f.who("--issue", `example/alpha#${issue}`);
    assert.equal(code, 0); assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].lane, "HOLDER"); assert.equal(report.rows[0].pid, 701);
    assert.equal(report.rows[0].issue.number, issue); assert.equal(report.suggest.target, report.rows[0].lane);
    assert.equal(report.suggest.rule, "issue-owner");
  }
});
test("a second process sharing a registered cwd retains its own holder row", async () => {
  const f = fixture(); f.lease();
  f.ctx.run = async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? "702 pi\n701 pi" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false });
  f.put(".pi/orch/sessions/p701.json", { pid: 701, id: "HOLDER", cwd: join(f.home, "worker") });
  f.put("agent/issue-work/registry.jsonl", JSON.stringify(f.event));
  const { code, report } = await f.who("--issue", "42");
  assert.equal(code, 0); assert.deepEqual(report.rows.map((r: any) => [r.lane, r.pid]), [["HOLDER", 701]]);
  assert.equal(report.suggest.target, "HOLDER");
});
test("who retains a verified-live holder omitted from process discovery", async () => {
  const f = fixture(); f.lease();
  const run = f.ctx.run;
  f.ctx.run = async (name, args, opts) => args.includes("-axo")
    ? { code: 0, stdout: "702 pi", stderr: "", timedOut: false } : run(name, args, opts);
  f.put(".pi/orch/sessions/p701.json", { pid: 701, id: "HOLDER", cwd: join(f.home, "worker") });
  f.put("agent/issue-work/registry.jsonl", JSON.stringify(f.event));
  const { code, report } = await f.who("--issue", "example/alpha#42");
  assert.equal(code, 0); assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].lane, "HOLDER"); assert.equal(report.rows[0].pid, 701);
  assert.equal(report.rows[0].sessionId, "session-worker"); assert.equal(report.rows[0].issue.number, 42);
  assert.equal(report.suggest.target, report.rows[0].lane); assert.equal(report.suggest.rule, "issue-owner");
});
test("a stateless detected touch preserves the session's blocked state and prevents idle routing", async () => {
  const f = fixture(); f.lease();
  const blocked = { ...f.event, state: "blocked" };
  const detected = { ...f.event, state: undefined, source: "detected", ts: "2026-01-20T12:01:00Z" };
  f.put("agent/issue-work/registry.jsonl", [blocked, detected].map(e => JSON.stringify(e)).join("\n"));
  const { report } = await f.who("--repo", "example/alpha");
  const row = report.rows.find((r: any) => r.lane === "W1");
  assert.equal(row.issue.state, "blocked"); assert.equal(row.state, "blocked");
  assert.equal(report.suggest.target, null); assert.equal(report.suggest.rule, "start-lane");
});
test("message-only identities and last inbound/outbound are retained", async () => {
  const f = fixture(); const path = f.put("messages/GHOST-to-W1-20260120-120000-task.md", "synthetic"); utimesSync(path, f.ctx.now(), f.ctx.now());
  const { report } = await f.who(); const ghost = report.rows.find((r: any) => r.lane === "GHOST");
  assert.equal(ghost.identity, "message-only"); assert.ok(ghost.lastOutbound);
  assert.ok(report.rows.find((r: any) => r.lane === "W1").lastInbound);
});
test("stale heartbeat and expired wait are labelled, never treated as working or waiting", async () => {
  const f = fixture(); f.heartbeat("2026-01-19T12:00:00Z");
  f.put("messages/status/W1.status", 'waiting-on "dependency" until 2026-01-19T12:00:00Z');
  const { report } = await f.who(); const row = report.rows.find((r: any) => r.lane === "W1");
  assert.equal(row.state, "idle"); assert.match(row.notes.join(" "), /heartbeat stale/); assert.match(row.notes.join(" "), /expired/);
});
test("missing orch sources and empty assignments are explicit; corrupt registry lines are counted", async () => {
  const f = fixture(); f.lease(); f.put("agent/issue-work/registry.jsonl", `broken\n${JSON.stringify(f.event)}\n`);
  mkdirSync(join(f.home, ".pi/orch/assignments"), { recursive: true });
  const { report } = await f.who(); assert.equal(report.sources.heartbeats.status, "missing");
  assert.equal(report.sources.assignments.status, "ok"); assert.equal(report.sources.assignments.count, 0);
  assert.match(report.sources.registry.detail, /1/); assert.equal(report.rows.find((r: any) => r.lane === "W1").issue.number, 42);
});
test("recent ended delivery prevents assignment; idle repo selection and start-lane are explicit", async () => {
  const f = fixture(); let result = await f.who("--repo", "ALPHA");
  assert.equal(result.report.suggest.target, "W1"); assert.equal(result.report.suggest.rule, "idle-in-repo");
  f.put("agent/issue-work/registry.jsonl", JSON.stringify({ ...f.event, state: "in-review", ts: "2026-01-18T12:00:00Z" }));
  result = await f.who("--issue", "example/alpha#42"); assert.equal(result.report.suggest.target, null); assert.equal(result.report.suggest.rule, "delivered");
  result = await f.who("--repo", "example/missing"); assert.equal(result.code, 1); assert.equal(result.report.suggest.rule, "start-lane");
});
test("issue filtering preserves same-repo idle suggestions for lanes unrelated to the issue", async () => {
  const f = fixture(); f.lease();
  const unfiltered = await f.who();
  const idle = unfiltered.report.rows.find((r: any) => r.lane === "W1");
  assert.equal(idle.state, "idle"); assert.equal(idle.pid, 701); assert.equal(idle.issue, null);
  const { code, report } = await f.who("--issue", "example/alpha#42");
  assert.equal(code, 1); assert.deepEqual(report.rows, []);
  assert.equal(report.suggest.target, "W1"); assert.equal(report.suggest.rule, "idle-in-repo");
});
test("process timeout, thrown probe and unreadable cwd remain unknown, never stopped", async () => {
  for (const failure of ["timeout", "throw", "cwd"]) {
    const f = fixture();
    if (failure === "timeout") f.ctx.run = async () => ({ code: 0, stdout: "701", stderr: "", timedOut: true });
    if (failure === "throw") f.ctx.run = async () => { throw new Error("synthetic probe failure"); };
    if (failure === "cwd") f.ctx.readCwd = async () => undefined;
    const { report } = await f.who();
    assert.equal(report.sources.processes.status, "error"); assert.equal(report.rows.find((r: any) => r.lane === "W1").state, "unknown");
  }
});
test("all absent optional sources and assignments read errors are represented in JSON", async () => {
  const f = fixture(); f.put(".pi/orch/assignments", "not a directory");
  const { report } = await f.who();
  for (const name of ["heartbeats", "sessions", "registry", "leases", "status-files", "messages"]) assert.equal(report.sources[name].status, "missing");
  assert.equal(report.sources.assignments.status, "error"); assert.equal(report.rows[0].contextUse, null);
});
test("multiple sessions per cwd fold last state and PID reuse does not claim ownership", async () => {
  const f = fixture(); f.lease();
  f.put("agent/issue-work/registry.jsonl", [f.event, { ...f.event, state: "done", ts: "2026-01-20T12:01:00Z" }].map(e => JSON.stringify(e)).join("\n"));
  let result = await f.who(); assert.equal(result.report.rows.find((r: any) => r.lane === "W1").issue.holder, false);
  f.put("agent/issue-work/registry.jsonl", JSON.stringify(f.event));
  f.ctx.run = async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? "701 pi" : args.includes("lstart=") ? "different start" : "701", stderr: "", timedOut: false });
  result = await f.who(); assert.equal(result.report.rows.find((r: any) => r.lane === "W1").sessionId, null);
});
test("unknown holder liveness and corrupt register block suggestions", async () => {
  const f = fixture(); f.lease(); f.put("agent/issue-work/registry.jsonl", JSON.stringify(f.event));
  f.ctx.run = async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? "701 pi" : args.includes("lstart=") ? "" : "701", stderr: "", timedOut: false });
  let result = await f.who("--issue", "example/alpha#42"); assert.equal(result.report.suggest.rule, "unverified"); assert.equal(result.report.suggest.target, null);
  f.put("agent/issue-work/registry.jsonl", "broken"); result = await f.who("--issue", "example/alpha#42");
  assert.equal(result.report.suggest.rule, "unverified");
});
test("retired and suppressed lanes are not candidates; workers win deterministic repo-orch ties", async () => {
  const f = fixture();
  f.c.lanes.push({ ...f.c.lanes[0], id: "W2", worktree: "second", cwd: join(f.home, "second"), parent: "W1" });
  f.c.lanes[0].role = "repo-orch"; saveConfig(f.home, f.c);
  f.ctx.run = async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? "701 pi\n702 pi" : "", stderr: "", timedOut: false });
  f.ctx.readCwd = async pid => join(f.home, pid === 701 ? "worker" : "second");
  let result = await f.who("--repo", "example/alpha"); assert.equal(result.report.suggest.target, "W2");
  f.put("messages/status/W2.status", 'waiting-on "synthetic dependency" until 2026-01-20T13:00:00Z');
  result = await f.who("--repo", "example/alpha"); assert.equal(result.report.suggest.target, "W1");
  f.put("messages/status/W1.status", 'barred-by "synthetic hold" until 2026-01-20T13:00:00Z');
  result = await f.who("--repo", "example/alpha"); assert.equal(result.report.suggest.target, null);
  f.c.lanes[1].retired = true; saveConfig(f.home, f.c); result = await f.who();
  assert.equal(result.report.rows.find((r: any) => r.lane === "W2").state, "retired");
});
test("idle selection sorts longest idle first, then lane id, with unknown idle last", async () => {
  const f = fixture(); const input = await readRoster(f.c, f.home, f.ctx);
  const worker = buildRoster(input, f.ctx.now()).rows.find(r => r.lane === "W1")!;
  const one: typeof worker = { ...worker, idleMinutes: 30 }; const two: typeof worker = { ...worker, lane: "W2", idleMinutes: 60 };
  const pick = () => suggestTarget([two, one], input, { repo: "alpha" }, f.ctx.now());
  assert.equal(pick().target, "W2"); two.idleMinutes = 30; assert.equal(pick().target, "W1");
  one.idleMinutes = null; two.idleMinutes = 0; assert.equal(pick().target, "W2");
  input.register.sources.registry = { status: "error", count: 0, detail: "synthetic error" };
  assert.equal(pick().rule, "unverified");
});
test("who validates issue filters, bounds and help", async () => {
  const f = fixture(); assert.equal(await main(["who", "--issue", "bad"], f.ctx), 2);
  assert.equal(await main(["who", "--issue", "example/alpha42"], f.ctx), 2);
  assert.equal(await main(["who", "extra"], f.ctx), 2);
  assert.equal(await main(["who", "--help"], f.ctx), 0); assert.match(f.lines.at(-1)!, /who \[--repo R\]/);
  assert.equal((await f.who("--issue", "#42")).code, 1);
});
