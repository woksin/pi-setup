import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneCtx } from "./lanes-terminal.test.ts";
import { admit, inventory, legacyStartUtc, type AdmissionProcess } from "../src/lanes/admission.ts";

const owner = { pid: process.pid, ppid: 1, start: "owner", pi: false };
const pi = (pid: number, cwd = `/work/${pid}`, ppid = 1): AdmissionProcess => ({ pid, ppid, start: `start-${pid}`, pi: true, cwd });
function setup(rows: AdmissionProcess[] = []) {
  const ctx = laneCtx({ admissionInventory: async () => [owner, ...rows] });
  const request = { root: ctx.home, cwd: join(ctx.home, "work"), id: "L1", pool: "worker" as const };
  mkdirSync(request.cwd); return { ctx, request };
}
test("worker and orchestration admissions are never refused for counts", async () => {
  const { ctx, request } = setup(Array.from({ length: 8 }, (_, i) => pi(i + 100)));
  const leases = [];
  for (let i = 0; i < 4; i++) leases.push(await admit(ctx, { ...request, cwd: `/worker-${i}`, id: `W${i}` }));
  for (let i = 0; i < 4; i++) leases.push(await admit(ctx, { ...request, pool: "orchestration", cwd: `/orch-${i}`, id: `O${i}` }));
  for (const l of leases) await l.release();
});
test("lease child registration works; unrelated Pi processes do not block other cwds", async () => {
  const rows: AdmissionProcess[] = [];
  const { ctx, request } = setup(rows);
  const lease = await admit(ctx, request);
  rows.push({ pid: 20, ppid: process.pid, start: "child", pi: false });
  await lease.child(20);
  rows.push(pi(30, "/elsewhere", 20), pi(31, "/extra", 20));
  const other = await admit(ctx, { ...request, cwd: "/new", id: "L2" }); 
  await assert.rejects(admit(ctx, { ...request, cwd: "/extra", id: "L3" }), /already running/);
  rows.splice(0); await other.release(); await lease.release();
});
test("duplicate canonical cwd, malformed inventory and leases fail closed", async () => {
  const { ctx, request } = setup(); const lease = await admit(ctx, request);
  await assert.rejects(admit(ctx, request), /already running/);
  ctx.admissionInventory = async () => [];
  await assert.rejects(admit(ctx, { ...request, cwd: "/new" }), /identity/);
  ctx.admissionInventory = async () => [owner]; await lease.release();
  writeFileSync(join(ctx.piAgentDir, "lanes-admission", "bad.json"), "{}");
  await assert.rejects(admit(ctx, request), /lease/);
});
const oldOwner = { pid: 999, start: "old" };
const oldChild = { pid: 998, start: "old-child" };
function oldLease({ ctx, request }: ReturnType<typeof setup>, child?: typeof oldChild, version = 2) {
  const dir = join(ctx.piAgentDir, "lanes-admission"); const file = join(dir, "old.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...request, version, token: "old", owner: oldOwner, child }));
  return file;
}
for (const [scenario, rows] of [
  ["missing", []],
  ["reused owner", [{ ...oldOwner, start: "reused" }]],
  ["reused child", [{ ...oldChild, start: "reused" }]],
] as const) test(`stale lease with ${scenario} identities does not block admission`, async () => {
  const f = setup(rows.map(row => ({ ...row, ppid: 1, pi: false })));
  const active = await admit(f.ctx, { ...f.request, cwd: "/active", id: "L2" });
  const file = oldLease(f, oldChild);
  const next = await admit(f.ctx, f.request);
  assert.ok(!existsSync(file));
  await assert.rejects(admit(f.ctx, { ...f.request, cwd: "/active" }), /already running/);
  await next.release(); await active.release();
});
test("a reused owner PID does not release a lease with a live recorded child", async () => {
  const f = setup([{ ...oldOwner, start: "reused", ppid: 1, pi: false }, { ...oldChild, ppid: 1, pi: false }]);
  const file = oldLease(f, oldChild);
  await assert.rejects(admit(f.ctx, f.request), /already running/);
  const next = await admit(f.ctx, { ...f.request, cwd: "/new" });
  assert.ok(existsSync(file));
  await next.release();
});
for (const [scenario, rows, child] of [
  ["unrecorded child", [], undefined],
  ["unreadable owner start", [{ ...oldOwner, start: "" }], oldChild],
  ["unreadable child start", [{ ...oldChild, start: "" }], oldChild],
] as const) test(`${scenario} refuses admission and identifies the retained lease`, async () => {
  const f = setup(rows.map(row => ({ ...row, ppid: 1, pi: false })));
  const file = oldLease(f, child);
  await assert.rejects(admit(f.ctx, { ...f.request, cwd: "/new" }), (error: Error) => error.message.includes(file));
  assert.ok(existsSync(file));
});
test("unattributed reparented Pi retains its lease even after its cwd changes", async () => {
  const rows: AdmissionProcess[] = []; const { ctx, request } = setup(rows); const lease = await admit(ctx, request);
  rows.push({ pid: 201, ppid: process.pid, start: "wrapper", pi: false }); await lease.child(201);
  rows.splice(0, 1, pi(202, "/changed"));
  await assert.rejects(lease.release(), /cleanup uncertain/);
  const dir = join(ctx.piAgentDir, "lanes-admission"); const file = join(dir, readdirSync(dir)[0]);
  const persisted = JSON.parse(readFileSync(file, "utf8")); persisted.owner.pid = 998; writeFileSync(file, JSON.stringify(persisted));
  await assert.rejects(admit(ctx, request), /already running/);
});
test("failed preparation does not leak a pending reservation", async () => {
  const { ctx, request } = setup();
  await assert.rejects(admit(ctx, request, async () => { throw new Error("changed handoff"); }), /changed handoff/);
  assert.deepEqual(readdirSync(join(ctx.piAgentDir, "lanes-admission")), []);
});
for (const process of [oldOwner, oldChild]) test(`a differing legacy start for PID ${process.pid} retains the lease and refuses admission`, async () => {
  const f = setup([{ ...process, ppid: 1, start: "Thu Jun 11 16:40:00 2026", pi: false }]);
  const file = oldLease(f, oldChild, 1);
  const recorded = JSON.parse(readFileSync(file, "utf8"));
  recorded.owner.start = recorded.child.start = "Thu Jun 11 09:40:00 2026";
  writeFileSync(file, JSON.stringify(recorded));
  await assert.rejects(admit(f.ctx, { ...f.request, cwd: "/new" }), (error: Error) => error.message.includes(file));
  assert.ok(existsSync(file));
});
test("a live legacy owner recorded in local time holds its lease; a dead legacy lease is reclaimed", async () => {
  const tz = process.env.TZ; process.env.TZ = "Europe/Oslo";
  try {
    assert.equal(legacyStartUtc("Sun Nov 22 00:04:17 2026"), "Sat Nov 21 23:04:17 2026");
    assert.equal(legacyStartUtc("Thu Jun  4 10:00:00 2026"), "Thu Jun 4 08:00:00 2026");
    assert.equal(legacyStartUtc("jeu. juin 11 09:40:00 2026"), undefined);
    const f = setup([{ ...oldOwner, ppid: 1, start: "Sat Nov 21 23:04:17 2026", pi: false }]);
    const file = oldLease(f, oldChild, 1);
    const recorded = JSON.parse(readFileSync(file, "utf8"));
    recorded.owner.start = "Sun Nov 22 00:04:17 2026"; recorded.child.start = "Sun Nov 22 00:04:19 2026";
    writeFileSync(file, JSON.stringify(recorded));
    await assert.rejects(admit(f.ctx, f.request), /already running/);
    const next = await admit(f.ctx, { ...f.request, cwd: "/new" });
    assert.ok(existsSync(file));
    await next.release();
    f.ctx.admissionInventory = async () => [owner];
    const after = await admit(f.ctx, f.request);
    assert.ok(!existsSync(file));
    await after.release();
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});
test("native lease owner and child are recorded and compared in UTC and the C locale", async () => {
  const { ctx, request } = setup();
  delete ctx.admissionInventory;
  const childPid = process.pid + 1;
  const utcStart = "Thu Jun 11 16:40:00 2026";
  let childLive = true;
  ctx.run = async (_cmd, _args, options) => {
    const utc = options?.env?.TZ === "UTC" && options.env.LC_ALL === "C";
    const start = utc ? utcStart : "jeu. juin 11 09:40:00 2026";
    const child = childLive ? `\n${childPid} ${process.pid} ${start} wrapper` : "";
    return { code: 0, stdout: `${process.pid} 1 ${start} node${child}\n`, stderr: "", timedOut: false };
  };
  const lease = await admit(ctx, request);
  await lease.child(childPid);
  const dir = join(ctx.piAgentDir, "lanes-admission");
  const { owner, child } = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
  assert.equal(owner.start, utcStart);
  assert.equal(child.start, utcStart);
  await assert.rejects(lease.release());
  childLive = false;
  await lease.release();
});
test("native inventory never treats probe failure as empty", async () => {
  await assert.rejects(inventory(laneCtx()), /inventory/);
});
