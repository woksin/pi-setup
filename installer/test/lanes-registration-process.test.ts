import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";

function fixture() {
  const home = tempDir("lanes-registration-process"); const lines: string[] = [];
  const now = new Date("2026-01-20T12:00:00Z"); let parents = "701 1\n702 1";
  const ctx: LanesCtx = { home, cwd: home, env: {}, platform: "linux", now: () => now,
    run: async (_name, args) => ({ code: 0, stdout: args.includes("pid=,ppid=") ? parents
      : args.includes("-axo") ? "701 pi\n702 pi" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false }),
    readCwd: async () => home, realpath: p => p, pidAlive: () => true, which: () => undefined,
    out: s => lines.push(s), err: () => {}, stdinTTY: true, readStdin: async () => "",
    templatesDir: home, piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  saveConfig(home, defaults(home, home));
  const put = (path: string, value: unknown) => { const full = join(home, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, JSON.stringify(value)); };
  for (const pid of [701, 702]) {
    put(`agent/issue-work/sessions/p${pid}.json`, { sessionId: `session-${pid}`, pid, startedAt: now.toISOString(), procStart: "synthetic start", cwd: home });
    put(`.pi/orch/heartbeats/p${pid}.json`, { pid, sessionId: `session-${pid}`, at: now.toISOString(), state: "working" });
  }
  const register = (pid: number, id = "SMOKE1") => put(`.state/roster/${id}.json`, { id, pid, cwd: home, startedAt: now.toISOString() });
  const who = async () => { assert.equal(await main(["who", "--json"], ctx), 0); return JSON.parse(lines.at(-1)!).rows; };
  return { ctx, register, who, put, parents: (value: string) => { parents = value; } };
}
test("a Pi registration takes its exact pid and lease, not another Pi in the same configured cwd", async () => {
  const f = fixture(); f.register(701);
  const rows = await f.who(); const row = rows.find((r: any) => r.lane === "SMOKE1");
  assert.equal(row.pid, 701); assert.equal(row.sessionId, "session-701"); assert.equal(row.state, "working");
  assert.ok(row.evidence.includes("lease")); assert.ok(row.evidence.includes("heartbeat(fresh)"));
  assert.equal(rows.find((r: any) => r.pid === 702).lane, "L0");
});
test("a wrapper registration attaches its Pi descendant through an intermediate shell", async () => {
  const f = fixture(); f.register(20); f.parents("701 1\n702 30\n30 20\n20 1");
  const row = (await f.who()).find((r: any) => r.lane === "SMOKE1");
  assert.equal(row.pid, 702); assert.equal(row.sessionId, "session-702"); assert.equal(row.state, "working");
});
for (const parents of ["701 1\n702 1", "701 30\n30 701\n702 1", ""]) test(`ambiguous wrapper cwd attaches no process or session (${parents || "unavailable ancestry"})`, async () => {
  const f = fixture(); f.register(20); f.parents(parents);
  const row = (await f.who()).find((r: any) => r.lane === "SMOKE1");
  assert.equal(row.pid, null); assert.equal(row.sessionId, null); assert.equal(row.state, "idle");
  assert.ok(row.notes.includes("ambiguous cwd")); assert.ok(row.evidence.includes("registration"));
  assert.ok(!row.evidence.includes("lease")); assert.ok(!row.evidence.includes("heartbeat(fresh)"));
});
test("a configured seed keeps its own Pi when a same-ID wrapper has no descendant", async () => {
  const f = fixture(); f.register(20, "L0");
  const rows = await f.who(); const row = rows.find((r: any) => r.lane === "L0");
  assert.equal(row.pid, 701); assert.equal(row.sessionId, "session-701"); assert.equal(row.state, "working");
  assert.equal(rows.filter((r: any) => r.pid !== null).length, 2);
});
test("a configured wrapper selects its descendant instead of the first cwd match", async () => {
  const f = fixture(); f.register(20, "L0"); f.parents("701 1\n702 20\n20 1");
  const row = (await f.who()).find((r: any) => r.lane === "L0");
  assert.equal(row.pid, 702); assert.equal(row.sessionId, "session-702");
});
test("two registrations for one Pi never attach the second ID to a sibling", async () => {
  const f = fixture(); f.register(701, "AOWNER"); f.register(701, "BOWNER");
  const rows = await f.who();
  assert.equal(rows.find((r: any) => r.lane === "AOWNER").pid, 701);
  assert.equal(rows.find((r: any) => r.lane === "BOWNER").pid, null);
});
test("retiring a registration leaves its live Pi with an independent identity", async () => {
  const f = fixture(); assert.equal(await main(["register", "SMOKE1", "--pid", "702"], f.ctx), 0);
  assert.equal(await main(["unregister", "SMOKE1"], f.ctx), 0);
  const rows = await f.who(); const row = rows.find((r: any) => r.lane === "SMOKE1");
  assert.equal(row.identity, "launched"); assert.equal(row.state, "retired"); assert.equal(row.pid, null); assert.equal(row.sessionId, null);
  assert.ok(!row.evidence.includes("lease")); assert.ok(!row.evidence.includes("heartbeat(fresh)"));
  const live = rows.find((r: any) => r.pid === 702); assert.ok(live); assert.notEqual(live.lane, "SMOKE1"); assert.equal(live.sessionId, "session-702");
});
test("exact owners and configured seeds both outrank a non-descendant wrapper", async () => {
  const f = fixture(); f.register(20, "AWRAP"); f.register(701, "ZOWNER");
  const rows = await f.who();
  assert.equal(rows.find((r: any) => r.lane === "ZOWNER").pid, 701);
  assert.equal(rows.find((r: any) => r.lane === "AWRAP").pid, null);
  assert.equal(rows.find((r: any) => r.lane === "L0").pid, 702);
});
test("send ownership accepts only sessions attributed to the recipient, never a shared cwd", async () => {
  const f = fixture(); f.register(20, "AWRAP"); f.register(701, "ZOWNER");
  f.put("agent/issue-work/registry.jsonl", { ts: f.ctx.now().toISOString(), repo: "example/alpha", issue: 42,
    sessionId: "session-701", state: "in-progress", source: "tool" });
  const send = (to: string) => main(["send", to, "task", "-m", "body", "--from", "C0", "--issue", "example/alpha#42"], f.ctx);
  assert.equal(await send("AWRAP"), 3); assert.equal(await send("ZOWNER"), 0);
});
