import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoster, suggestTarget, type RosterInputs } from "../src/lanes/roster.ts";
import { attributeProcesses } from "../src/lanes/registration.ts";

const now = new Date("2026-01-20T12:00:00Z");
function fixture(): RosterInputs {
  return { lanes: [{ id: "L0", cwd: "/home" }], processes: { ok: true, procs: [{ pid: 701, cwd: "/home" }] },
    registrations: [{ id: "X", pid: 20, cwd: "/home", startedAt: now.toISOString(), alive: true }],
    registrationParents: new Map([[701, 1], [20, 1]]),
    register: { events: [], leases: [{ sessionId: "holder", pid: 701, cwd: "/home", startedAt: now.toISOString() }],
      liveness: new Map([["holder", { status: "live", pid: 701 }]]), sources: { registry: { status: "ok", count: 0 }, leases: { status: "ok", count: 1 } } },
    heartbeats: [{ pid: 701, sessionId: "holder", at: now.toISOString(), state: "working" }],
    sessions: [], statuses: new Map(), messages: [], idle: new Map(), sources: {}, broadcast: "ALL" };
}
function row(data: RosterInputs, id: string) { return buildRoster(data, now).rows.find(row => row.lane === id)!; }
test("a successfully read non-descendant parent map never lets a wrapper hijack a seed's process", () => {
  const data = fixture(); const rows = buildRoster(data, now).rows;
  const wrapper = rows.find(row => row.lane === "X")!; const seed = rows.find(row => row.lane === "L0")!;
  assert.equal(wrapper.pid, null); assert.equal(wrapper.sessionId, null); assert.equal(wrapper.issue, null);
  assert.ok(!wrapper.evidence.includes("lease")); assert.ok(!wrapper.evidence.includes("heartbeat(fresh)"));
  assert.equal(seed.pid, 701); assert.equal(seed.sessionId, "holder"); assert.equal(seed.state, "working");
});
test("an ambiguous pid-null wrapper cannot be suggested instead of the exact issue owner", () => {
  const data = fixture(); data.processes.procs.push({ pid: 702, cwd: "/home" }, { pid: 703, cwd: "/home" });
  data.registrations![0].id = "AWRAP";
  data.registrations!.push({ id: "ZOWNER", pid: 701, cwd: "/home", startedAt: now.toISOString(), alive: true });
  data.register.events.push({ ts: now.toISOString(), repo: "example/alpha", issue: 42, sessionId: "holder", state: "in-progress", source: "tool" });
  const rows = buildRoster(data, now).rows; const wrapper = rows.find(row => row.lane === "AWRAP")!;
  assert.equal(wrapper.pid, null); assert.equal(wrapper.sessionId, null);
  assert.equal(suggestTarget(rows, data, { issue: { repo: "example/alpha", number: 42 } }, now).target, "ZOWNER");
});
test("a seed and exact registration in different cwds keep their own processes", () => {
  const data = fixture(); data.registrations![0].pid = 702; data.registrations![0].cwd = "/other";
  data.processes.procs.push({ pid: 702, cwd: "/other" });
  assert.equal(row(data, "L0").pid, 701); assert.equal(row(data, "X").pid, 702); assert.equal(row(data, "X").sessionId, null);
});
for (const available of [true, false]) test(`wrapper cwd fallback requires unavailable ancestry (${available ? "readable" : "unavailable"})`, () => {
  const data = fixture(); data.lanes = [];
  if (!available) delete data.registrationParents;
  assert.equal(row(data, "X").pid, available ? null : 701);
});
test("unavailable ancestry never permits a wrapper to take a configured or orch-owned process", () => {
  const data = fixture(); delete data.registrationParents;
  assert.equal(row(data, "L0").pid, 701); assert.equal(row(data, "X").pid, null);
  data.lanes = []; data.sessions = [{ pid: 701, id: "ORCH1", sessionId: "holder" }];
  assert.equal(row(data, "ORCH1").pid, 701); assert.equal(row(data, "X").pid, null);
});
test("orch identity outranks a configured cwd seed but an exact registration outranks orch", () => {
  const data = fixture(); data.sessions = [{ pid: 701, id: "ORCH1", sessionId: "holder" }];
  assert.equal(row(data, "ORCH1").pid, 701); assert.equal(row(data, "L0").pid, null);
  data.registrations![0].pid = 701;
  const rows = buildRoster(data, now).rows;
  assert.equal(rows.find(row => row.lane === "X")!.pid, 701); assert.ok(!rows.some(row => row.lane === "ORCH1"));
});
test("an unreadable parent map with multiple unattributed Pi candidates attaches none", () => {
  const data = fixture(); data.lanes = []; delete data.registrationParents;
  data.processes.procs.push({ pid: 702, cwd: "/home" });
  assert.equal(row(data, "X").pid, null); assert.ok(row(data, "X").notes.includes("ambiguous cwd"));
});
test("the attribution map exposes the winning source in strict precedence order", () => {
  const data = fixture(); data.sessions = [{ pid: 701, id: "ORCH1" }];
  const owner = () => { const { identity, source } = attributeProcesses(data).get(701)!; return { identity, source }; };
  assert.deepEqual(owner(), { identity: "ORCH1", source: "orch" });
  data.registrationParents!.set(701, 20);
  assert.deepEqual(owner(), { identity: "X", source: "registration-descendant" });
  data.registrations![0].pid = 701;
  assert.deepEqual(owner(), { identity: "X", source: "registration-pid" });
  data.registrations![0].pid = 20; data.registrationParents!.set(701, 1); data.sessions = [];
  assert.deepEqual(owner(), { identity: "L0", source: "seed" });
  data.lanes = []; delete data.registrationParents;
  assert.deepEqual(owner(), { identity: "X", source: "registration-cwd" });
});
test("a readable empty parent map is not an unavailable map", () => {
  const data = fixture(); data.lanes = []; data.registrationParents = new Map();
  assert.equal(row(data, "X").pid, null);
});
