import type { LanesCtx } from "./ctx.ts";
export async function runningPi(ctx: LanesCtx): Promise<{ pid: number; cwd: string }[]> {
  const result = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 10000 });
  if (result.code !== 0) return [];
  const found: { pid: number; cwd: string }[] = [];
  for (const token of result.stdout.trim().split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number(token);
    let cwd = await ctx.readCwd?.(pid);
    if (!ctx.readCwd) {
      const r = ctx.platform === "darwin"
        ? await ctx.run("lsof", ["-a", "-p", token, "-d", "cwd", "-Fn"], { timeoutMs: 10000 })
        : await ctx.run("readlink", [`/proc/${pid}/cwd`], { timeoutMs: 10000 });
      if (r.code !== 0) continue;
      cwd = ctx.platform === "darwin" ? r.stdout.split("\n").find((s) => s.startsWith("n"))?.slice(1) : r.stdout.trim();
    }
    if (cwd) { try { found.push({ pid, cwd: ctx.realpath(cwd) }); } catch { /* process exited */ } }
  }
  return found;
}
export async function ttyOf(ctx: LanesCtx, pid: number): Promise<string | undefined> {
  const r = await ctx.run("ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: 10000 });
  const tty = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9/]+$/.test(tty) ? tty : undefined;
}
export async function foregroundPi(ctx: LanesCtx, tty: string): Promise<boolean> {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) return false;
  const r = await ctx.run("ps", ["-t", tty, "-o", "stat=,comm="], { timeoutMs: 10000 });
  return r.code === 0 && r.stdout.split("\n").some((line) => {
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
    return m?.[1].includes("+") && m[2].split("/").at(-1) === "pi";
  });
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
export async function alive(ctx: LanesCtx, pid: number): Promise<boolean> {
  return (await ctx.run("ps", ["-p", String(pid)], { timeoutMs: 10000 })).code === 0;
}
