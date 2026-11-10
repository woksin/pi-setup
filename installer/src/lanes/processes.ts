import type { LanesCtx } from "./ctx.ts";
export async function runningPi(ctx: LanesCtx): Promise<{ pid: number; cwd: string }[]> {
  const result = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 10000 });
  if (result.code !== 0) return [];
  const found: { pid: number; cwd: string }[] = [];
  for (const token of result.stdout.trim().split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number(token);
    const cwd = await processCwd(ctx, pid);
    if (cwd) { try { found.push({ pid, cwd: ctx.realpath(cwd) }); } catch { /* process exited */ } }
  }
  return found;
}
interface CheckedProcess { pid: number; cwd: string; ok: boolean }
async function checkedProcess(ctx: LanesCtx, pid: number): Promise<CheckedProcess> {
  try {
    const cwd = await checkedCwd(ctx, pid);
    if (cwd) return { pid, cwd: ctx.realpath(cwd), ok: true };
  } catch { /* Keep a visible process row when cwd discovery fails. */ }
  return { pid, cwd: "", ok: false };
}
function piPids(text: string): { pids: number[]; ok: boolean } {
  const pids: number[] = []; let ok = true;
  for (const line of text.split("\n").filter(s => s.trim())) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) { ok = false; continue; }
    if (match[2] === "pi") pids.push(Number(match[1]));
  }
  return { pids, ok };
}
/** Share a small worker pool between read-only discovery probes; results retain input order. */
export async function probeInBatches<T, R>(values: T[], probe: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []; let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await probe(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, () => worker()));
  return results;
}
export async function runningPiChecked(ctx: LanesCtx): Promise<{ ok: boolean; procs: { pid: number; cwd: string }[] }> {
  try {
    const result = await ctx.run("ps", ["-axo", "pid=,comm="], { timeoutMs: 2000 });
    if (result.timedOut || result.code !== 0) return { ok: false, procs: [] };
    const parsed = piPids(result.stdout);
    const checked = await probeInBatches(parsed.pids, pid => checkedProcess(ctx, pid));
    return { ok: parsed.ok && checked.every(p => p.ok), procs: checked.map(({ pid, cwd }) => ({ pid, cwd })) };
  } catch { return { ok: false, procs: [] }; }
}
async function checkedCwd(ctx: LanesCtx, pid: number): Promise<string | undefined> {
  if (ctx.readCwd) return ctx.readCwd(pid);
  const r = ctx.platform === "darwin"
    ? await ctx.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 2000 })
    : await ctx.run("readlink", [`/proc/${pid}/cwd`], { timeoutMs: 2000 });
  if (r.code !== 0 || r.timedOut) return undefined;
  return ctx.platform === "darwin" ? r.stdout.split("\n").find(s => s.startsWith("n"))?.slice(1) : r.stdout.trim();
}
export async function ttyOf(ctx: LanesCtx, pid: number): Promise<string | undefined> {
  const r = await ctx.run("ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: 10000 });
  const tty = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9/]+$/.test(tty) ? tty : undefined;
}
export async function processCwd(ctx: LanesCtx, pid: number): Promise<string | undefined> {
  if (ctx.readCwd) return ctx.readCwd(pid);
  const r = ctx.platform === "darwin"
    ? await ctx.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 10000 })
    : await ctx.run("readlink", [`/proc/${pid}/cwd`], { timeoutMs: 10000 });
  if (r.code !== 0 || r.timedOut) return undefined;
  return ctx.platform === "darwin" ? r.stdout.split("\n").find((s) => s.startsWith("n"))?.slice(1) : r.stdout.trim();
}
export async function foregroundPi(ctx: LanesCtx, tty: string, pid: number, cwd: string): Promise<boolean> {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) return false;
  const r = await ctx.run("ps", ["-t", tty, "-o", "pid=,stat=,comm="], { timeoutMs: 10000 });
  const matches = r.code === 0 && !r.timedOut && r.stdout.split("\n").some((line) => {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return m && Number(m[1]) === pid && m[2].includes("+") && m[3].split("/").at(-1) === "pi";
  });
  if (!matches) return false;
  try {
    const current = await processCwd(ctx, pid);
    return Boolean(current && ctx.realpath(current) === ctx.realpath(cwd));
  } catch { return false; }
}
export async function descendants(ctx: LanesCtx, rootPid: number): Promise<string[]> {
  const r = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 10000 });
  if (r.code !== 0) throw new Error("cannot inspect process descendants");
  const rows = r.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3] }] : [];
  });
  const ids = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return rows.filter((r) => r.pid !== rootPid && ids.has(r.pid)).map((r) => r.command);
}
interface Ancestor { pid: number; parent: number; comm: string }
function ancestorRows(text: string): Map<number, Ancestor> {
  const rows = new Map<number, Ancestor>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), comm: match[3] });
  }
  return rows;
}
function nearestPi(rows: Map<number, Ancestor>, startPid: number): number | undefined {
  const visited = new Set<number>(); let pid = startPid;
  for (let hops = 0; hops < 64; hops++) {
    if (visited.has(pid)) return undefined;
    visited.add(pid);
    const row = rows.get(pid); if (!row) return undefined;
    if (row.comm.split("/").at(-1) === "pi") return row.pid;
    pid = row.parent;
  }
  return undefined;
}
/** Resolve a long-lived Pi ancestor instead of registering the short-lived tool shell. */
export async function ancestorChain(ctx: LanesCtx, startPid = process.pid): Promise<number | undefined> {
  try {
    const result = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,comm="], { timeoutMs: 10000 });
    if (result.code !== 0 || result.timedOut) return undefined;
    return nearestPi(ancestorRows(result.stdout), startPid);
  } catch { return undefined; }
}
export async function alive(ctx: LanesCtx, pid: number): Promise<boolean> {
  return (await ctx.run("ps", ["-p", String(pid)], { timeoutMs: 10000 })).code === 0;
}
