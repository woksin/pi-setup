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
