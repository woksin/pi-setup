import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { LanesCtx } from "../ctx.ts";
import type { Signals } from "./signals.ts";
export function absolute(ctx: LanesCtx, path: string): string { return normalize(ctx.realpath(path)); }
export function requireProbe(result: { code: number; timedOut: boolean }, message: string): void { if (result.code !== 0 || result.timedOut) throw new Error(message); }
export async function processCwd(ctx: LanesCtx, pid: number): Promise<string> {
  if (ctx.readCwd) return canonicalCwd(ctx, await ctx.readCwd(pid));
  const token = String(pid);
  const probe = ctx.platform === "darwin" ? await ctx.run("lsof", ["-a", "-p", token, "-d", "cwd", "-Fn"], { timeoutMs: 4000 }) : await ctx.run("readlink", [`/proc/${token}/cwd`], { timeoutMs: 4000 });
  requireProbe(probe, "pi cwd unknown");
  const cwd = ctx.platform === "darwin" ? probe.stdout.split("\n").find(l => l.startsWith("n"))?.slice(1) : probe.stdout.trim();
  return canonicalCwd(ctx, cwd);
}
export async function processIds(ctx: LanesCtx, cwd: string): Promise<number[]> {
  const probe = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 4000 });
  if (probe.timedOut || ![0, 1].includes(probe.code)) throw new Error("pi process list unknown");
  const tokens = probe.stdout.trim().split(/\s+/).filter(Boolean);
  const ids: number[] = [];
  for (const token of tokens) { if (!/^\d+$/.test(token)) throw new Error("pi process list malformed"); const pid = Number(token); if (await processCwd(ctx, pid) === cwd) ids.push(pid); }
  return ids;
}
async function busyChildren(s: Signals, ctx: LanesCtx): Promise<void> {
  const ps = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 4000 }); requireProbe(ps, "process descendants unknown");
  const rows = ps.stdout.split("\n").map(line => /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())).filter(Boolean);
  const owned = new Set([s.pid]);
  const addChild = (row: RegExpExecArray | null) => { if (!owned.has(Number(row![2])) || owned.has(Number(row![1]))) return false; owned.add(Number(row![1])); return true; };
  let changed = true; while (changed) { changed = rows.map(addChild).some(Boolean); }
  if (owned.size > 1) s.keeps.push("busy child process");
}
async function openJobs(s: Signals, ctx: LanesCtx): Promise<void> {
  const files = await ctx.run("lsof", ["-p", String(s.pid), "-Fn"], { timeoutMs: 4000 }); requireProbe(files, "open files unknown");
  const jobs = files.stdout.split("\n").filter(l => l.startsWith("n" + join(ctx.piAgentDir, "jobs") + "/"));
  for (const path of jobs) { readFileSync(path.slice(1), "utf8"); s.keeps.push("job/watch running (log open)"); }
}
async function foreground(s: Signals, ctx: LanesCtx): Promise<void> {
  const tty = await ctx.run("ps", ["-o", "tty=", "-p", String(s.pid)], { timeoutMs: 4000 }); requireProbe(tty, "TTY unknown");
  s.tty = tty.stdout.trim(); if (!/^[A-Za-z0-9/]+$/.test(s.tty)) throw new Error("foreground not the expected pi (no TTY)");
  const fg = await ctx.run("ps", ["-t", s.tty, "-o", "pid=,stat=,command="], { timeoutMs: 4000 }); requireProbe(fg, "foreground unknown");
  const rows = fg.stdout.split("\n").filter(l => /^\s*\d+\s+\S*\+/.test(l));
  const expected = new RegExp(`^\\s*${s.pid}\\s+\\S*\\+\\s+(?:\\S*/)?pi(?:\\s|$)`);
  if (rows.length !== 1 || !expected.test(rows[0])) throw new Error("foreground not the expected pi");
}
export async function processEvidence(s: Signals, ctx: LanesCtx): Promise<void> {
  await busyChildren(s, ctx); await openJobs(s, ctx);
  const start = await ctx.run("ps", ["-p", String(s.pid), "-o", "lstart="], { timeoutMs: 4000 }); requireProbe(start, "process start unknown");
  s.procStart = start.stdout.trim(); if (!s.procStart) throw new Error("process start unknown");
  await foreground(s, ctx);
}

function canonicalCwd(ctx: LanesCtx, cwd: string | undefined): string { if (!cwd) throw new Error("pi cwd unknown"); return absolute(ctx, cwd); }
