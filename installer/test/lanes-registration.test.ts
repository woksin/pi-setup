import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import type { AdmissionProcess } from "../src/lanes/admission.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { run } from "../src/lanes/commands/run.ts";
import { main } from "../src/lanes/main.ts";
import { pidAlive, registrationState } from "../src/lanes/registration.ts";
import { readRoster } from "../src/lanes/roster.ts";

function fixture() {
  const home = tempDir("lanes-registration"); const lines: string[] = []; const errors: string[] = [];
  let now = new Date("2026-01-20T12:00:00Z");
  const ctx: LanesCtx = { home, cwd: home, env: {}, platform: "linux", now: () => now,
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), which: () => "/fake/pi-session",
    realpath: p => p, pidAlive: () => false, out: s => lines.push(s), err: s => errors.push(s),
    stdinTTY: true, readStdin: async () => "", templatesDir: home, piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  const c = defaults(home, home); mkdirSync(join(home, "prompts")); writeFileSync(join(home, c.coordinator.prompt), "test");
  saveConfig(home, c);
  const record = join(home, ".state/roster/L0.json");
  const put = (id: string, value: unknown) => { mkdirSync(join(home, ".state/roster"), { recursive: true }); writeFileSync(join(home, `.state/roster/${id}.json`), JSON.stringify(value)); };
  const who = async () => { lines.length = 0; assert.equal(await main(["who", "--json"], ctx), 0); return JSON.parse(lines.at(-1)!); };
  return { home, ctx, c, record, put, who, errors, tick: () => { now = new Date(now.getTime() + 60000); } };
}
function launch(f: ReturnType<typeof fixture>, pid = 20) {
  const rows: AdmissionProcess[] = [{ pid: process.pid, ppid: 1, start: "owner", pi: false }];
  let finish!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let fail!: (error: Error) => void; let ready!: () => void;
  const spawned = new Promise<void>(resolve => { ready = resolve; });
  f.ctx.admissionInventory = async () => rows;
  f.ctx.spawnInherited = () => {
    if (pid) rows.push({ pid, ppid: process.pid, start: "wrapper", pi: false });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { finish = resolve; fail = reject; });
    ready(); return { pid, done, signal: () => {} };
  };
  const running = run("coordinator", {}, f.c, f.home, f.ctx);
  return { running, spawned, finish: (code: number | null = 0, signal: NodeJS.Signals | null = null) => { rows.splice(1); finish({ code, signal }); }, fail: () => { rows.splice(1); fail(new Error("synthetic child failure")); } };
}
for (const outcome of ["zero", "nonzero", "signal", "rejection"]) test(`run registers the wrapper before exit and retires on ${outcome}`, async () => {
  const f = fixture(); const child = launch(f); await child.spawned;
  // The spawn callback resolves before run continues synchronously through registration.
  const started = JSON.parse(readFileSync(f.record, "utf8"));
  assert.deepEqual(started, { id: "L0", pid: 20, cwd: f.home, startedAt: f.ctx.now().toISOString() });
  f.tick();
  if (outcome === "rejection") { child.fail(); await assert.rejects(child.running, /synthetic child failure/); }
  else { child.finish(outcome === "nonzero" ? 17 : outcome === "signal" ? null : 0, outcome === "signal" ? "SIGTERM" : null); assert.equal(await child.running, outcome === "nonzero" ? 17 : outcome === "signal" ? 143 : 0); }
  assert.deepEqual(JSON.parse(readFileSync(f.record, "utf8")), { ...started, retiredAt: f.ctx.now().toISOString() });
});
test("a subsequent launch overwrites a retired record", async () => {
  const f = fixture(); const first = launch(f); await first.spawned; first.finish(); await first.running; f.tick();
  const second = launch(f, 21); await second.spawned;
  assert.deepEqual(JSON.parse(readFileSync(f.record, "utf8")), { id: "L0", pid: 21, cwd: f.home, startedAt: f.ctx.now().toISOString() });
  second.finish(); await second.running;
});
test("unknown child pid writes no registration", async () => {
  const f = fixture(); const child = launch(f, 0); await child.spawned; child.finish(); assert.equal(await child.running, 0);
  assert.equal(existsSync(f.record), false);
});
test("registration I/O errors warn without changing the child exit code", async () => {
  const f = fixture(); writeFileSync(join(f.home, ".state"), "not a directory");
  const child = launch(f); await child.spawned; child.finish(19); assert.equal(await child.running, 19);
  assert.match(f.errors.join("\n"), /registration/i);
});
test("retirement I/O errors warn without changing the child exit code", async () => {
  const f = fixture(); const child = launch(f); await child.spawned;
  writeFileSync(f.record, "broken JSON"); child.finish(18); assert.equal(await child.running, 18);
  assert.match(f.errors.join("\n"), /registration/i);
});
for (const mode of ["matched", "unmatched", "unavailable", "dead"] as const) test(`who registration liveness: ${mode}`, async () => {
  const f = fixture(); f.ctx.pidAlive = () => mode !== "dead";
  f.ctx.run = async () => ({ code: mode === "unavailable" ? 2 : 0, stdout: mode === "matched" ? "701 pi" : "", stderr: "", timedOut: false });
  f.ctx.readCwd = async () => f.home;
  f.put("L0", { id: "L0", pid: 20, cwd: f.home, startedAt: f.ctx.now().toISOString() });
  const report = await f.who(); const row = report.rows.find((r: any) => r.lane === "L0");
  assert.equal(row.state, ["matched", "unavailable"].includes(mode) ? "idle" : "stopped");
  if (["matched", "unavailable"].includes(mode)) assert.ok(row.evidence.includes("registration"));
  else assert.ok(row.notes.includes("registration stale (no exit recorded)"));
  assert.equal(row.pid, mode === "matched" ? 701 : null);
});
for (const seeded of [true, false]) for (const retired of [true, false]) test(`who joins ${seeded ? "seeded" : "launched"} ${retired ? "ended" : "stale"} registration`, async () => {
  const f = fixture(); const id = seeded ? "L0" : "EXTRA"; const at = f.ctx.now().toISOString();
  f.put(id, { id, pid: 20, cwd: f.home, startedAt: at, ...(retired ? { retiredAt: at } : {}) });
  const report = await f.who(); const row = report.rows.find((r: any) => r.lane === id);
  assert.equal(row.identity, seeded ? "registered" : "launched"); assert.equal(row.state, !seeded && retired ? "retired" : "stopped");
  assert.ok(row.notes.includes(retired ? `session ended ${at}` : "registration stale (no exit recorded)"));
});
test("a dead wrapper with no Pi in its cwd is stopped", async () => {
  const f = fixture(); f.ctx.run = async () => ({ code: 0, stdout: "701 pi", stderr: "", timedOut: false });
  f.ctx.readCwd = async () => join(f.home, "elsewhere");
  f.put("L0", { id: "L0", pid: 20, cwd: f.home, startedAt: f.ctx.now().toISOString() });
  assert.equal((await f.who()).rows.find((r: any) => r.lane === "L0").state, "stopped");
});
for (const orch of [true, false]) test(`live unseeded registration merges with ${orch ? "orch" : "anonymous"} process`, async () => {
  const f = fixture(); const cwd = join(f.home, "other"); f.ctx.pidAlive = () => true;
  f.ctx.run = async () => ({ code: 0, stdout: "701 pi", stderr: "", timedOut: false }); f.ctx.readCwd = async () => cwd;
  f.put("EXTRA", { id: "EXTRA", pid: 20, cwd, startedAt: f.ctx.now().toISOString() });
  if (orch) { mkdirSync(join(f.home, ".pi/orch/sessions"), { recursive: true }); writeFileSync(join(f.home, ".pi/orch/sessions/p701.json"), JSON.stringify({ id: "EXTRA", pid: 701, cwd })); }
  const rows = (await f.who()).rows.filter((r: any) => r.worktree === cwd);
  assert.equal(rows.length, 1); assert.equal(rows[0].lane, "EXTRA"); assert.equal(rows[0].pid, 701);
  assert.equal(rows[0].identity, orch ? "orch" : "launched"); assert.ok(rows[0].evidence.includes("registration"));
});
for (const retired of [true, false]) for (const seeded of [true, false]) for (const evidence of ["process", "heartbeat", "lease"]) test(`${retired ? "ended" : "stale"} registration cannot override ${evidence} liveness (${seeded ? "configured" : "launched"})`, async () => {
  const f = fixture(); const id = seeded ? "L0" : "EXTRA"; const at = f.ctx.now().toISOString();
  f.put(id, { id, pid: 20, cwd: f.home, startedAt: at, ...(retired ? { retiredAt: at } : {}) });
  f.ctx.run = async (_name, args) => ({ code: 0, stdout: args.includes("-axo") ? evidence === "lease" ? "" : "701 pi" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false });
  f.ctx.readCwd = async () => f.home;
  // Unconfigured records must join an independently discovered anonymous process, not add a stopped duplicate.
  if (!seeded) { f.c.coordinator.cwd = join(f.home, "coordinator"); saveConfig(f.home, f.c); }
  if (evidence === "heartbeat") { mkdirSync(join(f.home, ".pi/orch/heartbeats"), { recursive: true }); writeFileSync(join(f.home, ".pi/orch/heartbeats/p701.json"), JSON.stringify({ pid: 701, at, state: "working" })); }
  if (evidence === "lease") { mkdirSync(join(f.home, "agent/issue-work/sessions"), { recursive: true }); writeFileSync(join(f.home, "agent/issue-work/sessions/worker.json"), JSON.stringify({ sessionId: "worker", pid: 701, startedAt: at, procStart: "synthetic start", cwd: f.home })); }
  const rows = (await f.who()).rows.filter((r: any) => r.worktree === f.home);
  assert.equal(rows.length, 1); const row = rows[0]; assert.equal(row.lane, id); assert.equal(row.pid, 701);
  assert.equal(row.state, evidence === "heartbeat" ? "working" : "idle");
  assert.ok(row.notes.includes(retired ? `session ended ${at}` : "registration stale (no exit recorded)"));
});
for (const evidence of ["lease", "heartbeat(fresh)"]) test(`registrationState defers to independent ${evidence} evidence without a process PID`, async () => {
  const f = fixture(); const at = f.ctx.now().toISOString(); f.put("L0", { id: "L0", pid: 20, cwd: f.home, startedAt: at, retiredAt: at });
  const row = (await f.who()).rows.find((r: any) => r.lane === "L0"); row.pid = null; row.evidence = [evidence];
  assert.equal(registrationState(row, await readRoster(f.c, f.home, f.ctx)), undefined);
});
for (const days of [undefined, 2, 14]) test(`who ignores expired retired registrations using ${days ?? "fallback 14"} days without deleting them`, async () => {
  const f = fixture(); if (days === undefined) delete f.c.messages.retention; else f.c.messages.retention!.maxAgeDays = days; saveConfig(f.home, f.c);
  const at = (age: number) => new Date(f.ctx.now().getTime() - age * 86400000).toISOString();
  f.put("EXPIRED", { id: "EXPIRED", pid: 20, cwd: f.home, startedAt: at(100), retiredAt: at((days ?? 14) + 1) });
  f.put("BOUNDARY", { id: "BOUNDARY", pid: 20, cwd: f.home, startedAt: at(100), retiredAt: at(days ?? 14) });
  f.put("STALE", { id: "STALE", pid: 20, cwd: f.home, startedAt: at(100) });
  const report = await f.who(); assert.equal(report.rows.some((r: any) => r.lane === "EXPIRED"), false);
  assert.equal(report.rows.find((r: any) => r.lane === "BOUNDARY").state, "retired");
  assert.equal(report.rows.find((r: any) => r.lane === "STALE").state, "stopped");
  assert.equal(report.sources.registrations.count, 2); assert.ok(existsSync(join(f.home, ".state/roster/EXPIRED.json")));
});
test("default pidAlive regards EPERM as alive and ESRCH as dead", t => {
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  assert.equal(pidAlive(20), true);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); });
  assert.equal(pidAlive(20), false);
});
test("corrupt and invalid registrations are counted as errors without failing who", async () => {
  const f = fixture();
  for (const [id, value] of Object.entries({ badpid: { id: "badpid", pid: 0, cwd: f.home, startedAt: f.ctx.now().toISOString() }, baddate: { id: "baddate", pid: 1, cwd: f.home, startedAt: "invalid" } })) f.put(id, value);
  writeFileSync(f.record, "broken JSON"); const report = await f.who();
  assert.equal(report.sources.registrations.status, "error"); assert.equal(report.sources.registrations.count, 0);
});
