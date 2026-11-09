import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addressed, type MessageRef } from "../src/lanes/backend.ts";
import { type RegistryEvent } from "../src/lanes/issue-register.ts";
import { buildRoster, filterRows, indexRosterRegistry, matchedSessions, suggestTarget, type RosterInputs } from "../src/lanes/roster.ts";

const now = new Date("2026-01-20T12:00:00Z");
function input(): RosterInputs {
  return { lanes: [], processes: { ok: true, procs: [] }, register: { events: [], leases: [], liveness: new Map(),
    sources: { registry: { status: "ok", count: 0 }, leases: { status: "ok", count: 0 } } },
    heartbeats: [], sessions: [], statuses: new Map(), messages: [], idle: new Map(), sources: {}, broadcast: "NOTICE" };
}
function message(name: string, from: string, to: string[], ageMin = 0): MessageRef {
  return { name, from, to, topic: "test", at: new Date(now.getTime() - ageMin * 60000) };
}
function expectedLast(messages: MessageRef[]) {
  const last = messages.sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name))[0];
  return last ? { name: last.name, ageMin: Math.max(0, Math.floor((now.getTime() - last.at.getTime()) / 60000)) } : null;
}
function assertMessages(data: RosterInputs, lane: string) {
  const row = buildRoster(data, now).rows.find(r => r.lane === lane)!;
  const group = data.lanes.find(l => l.id === lane)?.group;
  const recipients = [lane, "ALL", data.broadcast, ...(group ? [group] : [])];
  assert.deepEqual(row.lastInbound, expectedLast(data.messages.filter(m => m.from !== lane && recipients.some(id => addressed(m, id)))));
  assert.deepEqual(row.lastOutbound, expectedLast(data.messages.filter(m => m.from === lane)));
}

test("indexed messages preserve direct, compound, broadcast, group, self-exclusion and tie semantics", () => {
  const data = input();
  data.lanes = ["W1", "W2", "W-3"].map(id => ({ id, cwd: `/${id}`, group: "TEAM-A" }));
  data.messages = [message("old", "OLD", ["W1"], 15 * 24 * 60), message("direct", "W2", ["W1"], 8),
    message("compound", "W1", ["W2-W-3"], 7), message("all", "W2", ["ALL"], 6),
    message("broadcast", "W1", ["NOTICE"], 5), message("group", "W2", ["TEAM-A"], 4),
    message("self-newest", "W1", ["W1", "ALL", "TEAM-A"], 0), message("z-tie", "W2", ["W1"], 1),
    message("a-tie", "W-3", ["W1"], 1)];
  for (const lane of ["W1", "W2", "W-3", "W2-W-3"]) assertMessages(data, lane);
  const rows = buildRoster(data, now).rows;
  assert.equal(rows.find(r => r.lane === "W1")!.lastInbound!.name, "z-tie");
  assert.ok(!rows.some(r => ["OLD", "ALL", "NOTICE", "TEAM-A"].includes(r.lane)));
  const onlyOld = input(); onlyOld.lanes = [{ id: "W1", cwd: "/W1" }]; onlyOld.messages = [data.messages[0]];
  assertMessages(onlyOld, "W1");
});

test("verified process identity takes precedence; cwd is only a no-PID fallback", () => {
  const data = input();
  data.register.leases = [701, 702].map(pid => ({ sessionId: `s${pid}`, pid, startedAt: now.toISOString(), cwd: "/shared" }));
  data.register.liveness = new Map([["s701", { status: "live", pid: 701 }], ["s702", { status: "live", pid: 702 }]]);
  assert.deepEqual(matchedSessions("/shared", [702], data.register), ["s702"]);
  assert.deepEqual(matchedSessions("/shared", [999], data.register), []);
  assert.deepEqual(matchedSessions("/shared", [], data.register), ["s701", "s702"]);
  data.register.liveness.set("s701", { status: "live", pid: 999 });
  assert.deepEqual(matchedSessions("/shared", [], data.register), ["s702"]);
});

test("uncovered verified-live leases supply holder rows without cross-attributing a shared cwd", () => {
  const data = input();
  data.processes.procs = [{ pid: 702, cwd: "/shared" }];
  data.sessions = [{ pid: 701, id: "HOLDER", cwd: "/shared" }, { pid: 702, id: "OTHER", cwd: "/shared" }];
  data.register.leases = [701, 702, 703, 704, 705].map(pid => ({ sessionId: `s${pid}`, pid, startedAt: now.toISOString(), cwd: "/shared" }));
  data.register.liveness = new Map([["s701", { status: "live", pid: 701 }], ["s702", { status: "live", pid: 702 }],
    ["s703", { status: "unknown", pid: 703 }], ["s704", { status: "live", pid: 999 }]]);
  data.register.events = [42, 1082].map((issue, i) => ({ ts: new Date(now.getTime() + i * 60000).toISOString(),
    repo: "example/alpha", issue, sessionId: "s701", state: "in-progress", source: "tool" }));
  const roster = buildRoster(data, now);
  assert.deepEqual(roster.rows.map(r => [r.lane, r.pid, r.sessionId]), [["HOLDER", 701, "s701"], ["OTHER", 702, "s702"]]);
  for (const number of [42, 1082]) {
    const selection = { issue: { repo: "example/alpha", number } };
    const rows = filterRows(roster.rows, selection);
    assert.equal(rows.length, 1); assert.equal(rows[0].lane, "HOLDER"); assert.equal(rows[0].issue!.number, number);
    assert.equal(suggestTarget(rows, data, selection, now).target, rows[0].lane);
  }
  data.processes.procs.push({ pid: 701, cwd: "/shared" });
  assert.equal(buildRoster(data, now).rows.filter(r => r.pid === 701).length, 1);
});

test("a verified lease still supplies an unregistered holder row without orch identity or cwd", () => {
  const data = input();
  data.register.leases = [{ sessionId: "holder", pid: 701, startedAt: now.toISOString() }];
  data.register.liveness.set("holder", { status: "live", pid: 701 });
  data.register.events = [{ ts: now.toISOString(), repo: "example/alpha", issue: 42, sessionId: "holder", state: "in-review", source: "tool" }];
  const row = filterRows(buildRoster(data, now).rows, { issue: { number: 42 } })[0];
  assert.equal(row.pid, 701); assert.equal(row.sessionId, "holder"); assert.equal(row.issue!.holder, true);
  assert.equal(row.identity, "unregistered"); assert.equal(row.state, "idle");
  assert.ok(row.evidence.includes("lease"));
});

function countReads<T>(values: T[]) {
  const counts = { elements: 0, iterations: 0 };
  const array = new Proxy(values, { get(target, key, receiver) {
    if (key === Symbol.iterator) counts.iterations++;
    if (typeof key === "string" && /^\d+$/.test(key)) counts.elements++;
    return Reflect.get(target, key, receiver);
  } });
  return { array, counts };
}
function largeInput(): RosterInputs {
  const data = input();
  data.lanes = Array.from({ length: 1800 }, (_, i) => ({ id: `W${i}`, cwd: `/worker/${i}`, repo: "example/alpha", group: "TEAM" }));
  data.register.events = Array.from({ length: 22000 }, (_, i): RegistryEvent => ({ ts: new Date(now.getTime() - (22000 - i) * 1000).toISOString(),
    repo: "example/alpha", issue: i % 1800 + 1, sessionId: `s${i % 1800}`, state: "in-progress", source: "tool" }));
  data.register.leases = Array.from({ length: 55 }, (_, i) => ({ sessionId: `s${i}`, pid: 700 + i, startedAt: now.toISOString(), cwd: `/worker/${i}` }));
  data.register.liveness = new Map(data.register.leases.map(l => [l.sessionId, { status: "live", pid: l.pid }]));
  data.processes.procs = data.register.leases.map(l => ({ pid: l.pid, cwd: l.cwd! }));
  data.messages = Array.from({ length: 24000 }, (_, i) => message(`m${i}`, `W${i % 1800}`, [`W${(i + 1) % 1800}`], i % 100));
  data.messages.push(message("broadcast", "W0", ["NOTICE"]), message("group", "W1", ["TEAM"]));
  return data;
}

test("22k events, 24k messages and 1800 identities use one fold and one endpoint pass", { timeout: 5000 }, () => {
  const data = largeInput(); const events = countReads(data.register.events); const messages = countReads(data.messages);
  data.register.events = events.array; data.messages = messages.array;
  const registry = indexRosterRegistry(data.register.events);
  const roster = buildRoster(data, now, registry);
  const rows = filterRows(roster.rows, { issue: { repo: "example/alpha", number: 1 } });
  assert.equal(suggestTarget(rows, { ...data, registry }, { issue: { repo: "example/alpha", number: 1 } }, now).target, "W0");
  assert.equal(roster.rows.length, 1800); assert.equal(rows.length, 1);
  assert.equal(events.counts.iterations, 1); assert.equal(events.counts.elements, 44000);
  assert.equal(messages.counts.iterations, 1); assert.equal(messages.counts.elements, 24002);
  // Compare representative rows against the old scan/sort semantics, outside the counted join.
  const rawMessages = [...data.messages];
  for (const lane of ["W0", "W1", "W42", "W1799"]) {
    const row = roster.rows.find(r => r.lane === lane)!;
    const recipients = [lane, "ALL", "NOTICE", "TEAM"];
    assert.deepEqual(row.lastInbound, expectedLast(rawMessages.filter(m => m.from !== lane && recipients.some(id => addressed(m, id)))));
    assert.deepEqual(row.lastOutbound, expectedLast(rawMessages.filter(m => m.from === lane)));
  }
});
