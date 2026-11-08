import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneCtx } from "./lanes-terminal.test.ts";
import { admit, inventory, type AdmissionProcess } from "../src/lanes/admission.ts";

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
test("dead child and owner reclaim, PID reuse and unknown pending state retain", async () => {
  const { ctx, request } = setup(); const lease = await admit(ctx, request); await lease.child(40).catch(() => {});
  const dir = join(ctx.piAgentDir, "lanes-admission"); const file = join(dir, readdirSync(dir).find(n => n.endsWith(".json"))!);
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.owner = { pid: 999, start: "old" }; state.child = { pid: 998, start: "old-child" }; writeFileSync(file, JSON.stringify(state));
  const next = await admit(ctx, request); await next.release();
  state.child = undefined; writeFileSync(file, JSON.stringify(state));
  await assert.rejects(admit(ctx, request), /uncertain/);
  state.child = { pid: 998, start: "old-child" }; writeFileSync(file, JSON.stringify(state));
  ctx.admissionInventory = async () => [owner, { pid: 998, ppid: 1, start: "reused", pi: false }];
  await assert.rejects(admit(ctx, request), /identity|uncertain/);
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
test("native inventory never treats probe failure as empty", async () => {
  await assert.rejects(inventory(laneCtx()), /inventory/);
});
