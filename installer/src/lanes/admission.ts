import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanesCtx } from "./ctx.ts";

export interface AdmissionProcess { pid: number; ppid: number; start: string; pi: boolean; cwd?: string }
interface Identity { pid: number; start: string }
interface Lease {
  version: 1; token: string; owner: Identity; child?: Identity; priorPi?: Identity[];
  root: string; cwd: string; id: string; pool: "worker" | "orchestration";
}
export interface AdmissionRequest {
  root: string; cwd: string; id: string; pool: Lease["pool"]; localLimit: number; localCwds?: string[];
}
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("admission inventory timed out")), 5000); })]); }
  finally { clearTimeout(timer!); }
}
/** One complete process snapshot, including start identities. Never substitute an empty inventory. */
export async function inventory(ctx: LanesCtx): Promise<AdmissionProcess[]> {
  const rows = await bounded(ctx.admissionInventory ? ctx.admissionInventory() : nativeInventory(ctx));
  if (!Array.isArray(rows) || rows.length > 20000 || rows.some(r => !Number.isSafeInteger(r.pid) || r.pid < 1
    || !Number.isSafeInteger(r.ppid) || r.ppid < 0 || typeof r.start !== "string" || !r.start.trim()
    || typeof r.pi !== "boolean" || (r.pi && !r.cwd)) || new Set(rows.map(r => r.pid)).size !== rows.length) {
    throw new Error("admission inventory malformed or identity unavailable");
  }
  return rows;
}
async function nativeInventory(ctx: LanesCtx): Promise<AdmissionProcess[]> {
  const result = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { timeoutMs: 4000 });
  if (result.code !== 0 || result.timedOut || !result.stdout.trim()) throw new Error("admission inventory unavailable");
  const rows: AdmissionProcess[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    const m = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line.trim());
    if (!m) throw new Error("admission inventory malformed");
    const row: AdmissionProcess = { pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, " "), pi: basename(m[4]) === "pi" };
    if (row.pi) {
      if (ctx.readCwd) row.cwd = await ctx.readCwd(row.pid);
      else {
        const cwd = ctx.platform === "darwin"
          ? await ctx.run("lsof", ["-a", "-p", String(row.pid), "-d", "cwd", "-Fn"], { timeoutMs: 4000 })
          : await ctx.run("readlink", [`/proc/${row.pid}/cwd`], { timeoutMs: 4000 });
        if (cwd.code !== 0 || cwd.timedOut) throw new Error(`admission cwd unavailable for ${row.pid}`);
        row.cwd = ctx.platform === "darwin" ? cwd.stdout.split("\n").find(s => s.startsWith("n"))?.slice(1) : cwd.stdout.trim();
      }
      if (row.cwd) row.cwd = ctx.realpath(row.cwd);
    }
    rows.push(row);
  }
  return rows;
}
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("admission directory must be private and not a symlink");
}
async function locked<T>(dir: string, work: () => Promise<T>): Promise<T> {
  privateDir(dir); const lock = join(dir, "lock"); const deadline = Date.now() + 2000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw new Error("admission lock busy/uncertain; retry after inspecting its controller (no age-based removal)");
      await pause(20);
    }
  }
  try { return await work(); } finally { rmdirSync(lock); }
}
function identity(value: any): value is Identity { return value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start === "string" && value.start.length > 0; }
function readLease(file: string): Lease {
  if (!lstatSync(file).isFile()) throw new Error("admission lease is not a regular file");
  const v = JSON.parse(readFileSync(file, "utf8"));
  if (v?.version !== 1 || !identity(v.owner) || (v.child !== undefined && !identity(v.child))
    || (v.priorPi !== undefined && (!Array.isArray(v.priorPi) || !v.priorPi.every(identity)))
    || !["worker", "orchestration"].includes(v.pool) || [v.token, v.root, v.cwd, v.id].some(s => typeof s !== "string" || !s)) throw new Error("admission lease malformed");
  return v;
}
function store(file: string, lease: Lease): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(lease), { mode: 0o600, flag: "wx" }); renameSync(temp, file);
}
function alive(id: Identity, rows: AdmissionProcess[]): boolean {
  const row = rows.find(r => r.pid === id.pid);
  if (row && row.start !== id.start) throw new Error(`admission identity uncertain: pid ${id.pid} reused`);
  return Boolean(row);
}
function below(row: AdmissionProcess, owner: Identity, rows: AdmissionProcess[]): boolean {
  const seen = new Set<number>(); let at: AdmissionProcess | undefined = row;
  while (at && !seen.has(at.pid)) {
    if (at.pid === owner.pid) return at.start === owner.start;
    seen.add(at.pid); at = rows.find(r => r.pid === at!.ppid);
  }
  return false;
}
/** A reparented Pi with a changed cwd cannot be proven to belong to an exited wrapper.
 * Only processes present before admission or owned by another verified controller are unrelated. */
function uncertainPi(lease: Lease, all: Lease[], rows: AdmissionProcess[]): boolean {
  return rows.filter(r => r.pi).some(pi => {
    if (pi.cwd === lease.cwd || below(pi, lease.owner, rows)) return true;
    if (lease.priorPi?.some(prior => prior.pid === pi.pid && prior.start === pi.start)) return false;
    return !all.some(other => other.token !== lease.token
      && [other.owner, other.child].some(id => id && alive(id, rows) && below(pi, id, rows)));
  });
}
function registry(dir: string): { file: string; lease: Lease }[] {
  return readdirSync(dir).filter(n => n.endsWith(".json")).map(n => {
    const file = join(dir, n); return { file, lease: readLease(file) };
  });
}
function leases(dir: string, rows: AdmissionProcess[]): Lease[] {
  const entries = registry(dir); const all = entries.map(e => e.lease);
  return entries.flatMap(({ file, lease }) => {
    if (alive(lease.owner, rows)) { if (lease.child) alive(lease.child, rows); return [lease]; }
    if (!lease.child) throw new Error("admission lease uncertain: dead owner with unrecorded child");
    if (alive(lease.child, rows) || uncertainPi(lease, all, rows)) return [lease];
    unlinkSync(file); return [];
  });
}
export async function admit(ctx: LanesCtx, request: AdmissionRequest, beforeLaunch?: () => Promise<void>) {
  const dir = join(ctx.piAgentDir, "lanes-admission");
  const lease = await locked(dir, async () => {
    const rows = await inventory(ctx); const owner = rows.find(r => r.pid === process.pid);
    if (!owner) throw new Error("admission controller identity unavailable");
    const active = leases(dir, rows); const pis = rows.filter(r => r.pi); const covered = new Set<number>();
    for (const l of active) {
      const child = pis.find(p => !covered.has(p.pid) && below(p, l.child ?? l.owner, rows));
      if (child) covered.add(child.pid);
    }
    const extra = pis.filter(p => !covered.has(p.pid));
    const workers = active.filter(l => l.pool === "worker").length + extra.length;
    const orchestrators = active.filter(l => l.pool === "orchestration").length;
    const local = active.filter(l => l.root === request.root && l.pool === "worker").length
      + extra.filter(p => (request.localCwds ?? [request.cwd]).includes(p.cwd!)).length;
    const counts = `workers=${workers}/6 orchestrators=${orchestrators}/2 local=${local}/${Math.min(request.localLimit, 6)}`;
    if (active.some(l => l.cwd === request.cwd) || pis.some(p => p.cwd === request.cwd)) throw new Error(`already running in ${request.cwd}; ${counts}`);
    if (request.pool === "worker" ? workers >= 6 || local >= Math.min(request.localLimit, 6) : orchestrators >= 2) throw new Error(`admission refused: ${counts}`);
    const value: Lease = { version: 1, token: randomUUID(), owner: { pid: owner.pid, start: owner.start }, root: request.root, cwd: request.cwd, id: request.id, pool: request.pool,
      priorPi: pis.map(p => ({ pid: p.pid, start: p.start })) };
    const file = join(dir, `${value.token}.json`); store(file, value);
    try { await beforeLaunch?.(); } catch (e) { unlinkSync(file); throw e; }
    return value;
  });
  const file = join(dir, `${lease.token}.json`);
  return {
    async child(pid: number) {
      return locked(dir, async () => {
        const row = (await inventory(ctx)).find(r => r.pid === pid);
        if (!row || row.ppid !== process.pid) throw new Error("admission child identity unavailable; lease retained");
        lease.child = { pid, start: row.start }; store(file, lease); return lease.child;
      });
    },
    async release() {
      await locked(dir, async () => {
        const current = readLease(file);
        if (current.token !== lease.token || current.owner.pid !== process.pid || current.owner.start !== lease.owner.start) throw new Error("admission lease ownership changed");
        const rows = await inventory(ctx);
        if ((lease.child && alive(lease.child, rows)) || uncertainPi(lease, registry(dir).map(e => e.lease), rows)) throw new Error("admission child cleanup uncertain; lease retained");
        unlinkSync(file);
      });
    },
  };
}
