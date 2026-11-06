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
  const request = { root: ctx.home, cwd: join(ctx.home, "work"), id: "L1", pool: "worker" as const, localLimit: 6 };
  mkdirSync(request.cwd); return { ctx, request };
}
test("six workers and two orchestrators are separate non-borrowing pools", async () => {
  for (const count of [5, 6]) {
    const { ctx, request } = setup(Array.from({ length: count }, (_, i) => pi(i + 100)));
    if (count === 6) await assert.rejects(admit(ctx, request), /workers=6/);
    else { const lease = await admit(ctx, request); await lease.release(); }
  }
  const { ctx, request } = setup();
  const a = await admit(ctx, { ...request, pool: "orchestration" });
  const b = await admit(ctx, { ...request, pool: "orchestration", cwd: ctx.home, id: "L0" });
  await assert.rejects(admit(ctx, { ...request, pool: "orchestration", cwd: "/third" }), /orchestrators=2/);
  const worker = await admit(ctx, { ...request, cwd: "/worker" });
  await worker.release(); await b.release(); await a.release();
});
test("two roots race atomically for the last shared worker slot; pending counts", async () => {
  const { ctx, request } = setup(Array.from({ length: 5 }, (_, i) => pi(i + 100)));
  const results = await Promise.allSettled([admit(ctx, request), admit(ctx, { ...request, root: "/other-root", cwd: "/other-work" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  for (const r of results) if (r.status === "fulfilled") await r.value.release();
});
test("verified child deduplicates once, extra Pi and unmanaged Pi count as workers", async () => {
  const rows: AdmissionProcess[] = [];
  const { ctx, request } = setup(rows);
  const lease = await admit(ctx, request);
  rows.push({ pid: 20, ppid: process.pid, start: "child", pi: false });
  await lease.child(20);
  rows.push(pi(30, request.cwd, 20), pi(31, "/extra", 20));
  await assert.rejects(admit(ctx, { ...request, cwd: "/new", localLimit: 1 }), /local=1/);
  rows.splice(0); await lease.release();
});
test("local limit, duplicate canonical cwd, malformed inventory and leases fail closed", async () => {
  const { ctx, request } = setup(); const lease = await admit(ctx, request);
  await assert.rejects(admit(ctx, request), /already running/);
  await assert.rejects(admit(ctx, { ...request, cwd: "/new", localLimit: 1 }), /local=1/);
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
