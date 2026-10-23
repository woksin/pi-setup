import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { Config, Lane } from "../config.ts";
import { expand } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { sessionDirFor, parseMessageName } from "../names.ts";
import { parseStatus } from "../status-line.ts";
import { optionalText, jsonFiles, mtime } from "./files.ts";
import { gitEvidence, type GitEvidence } from "./git.ts";
import type { DecisionSignals } from "./verdict.ts";
export interface Claim { repo: string; issue: number; sessionId: string; cwd?: string; source: string; state?: string; note?: string; pr?: string }
export interface Signals extends DecisionSignals {
  id: string; cwd: string; pid?: number; pids: number[]; sessionId?: string; sessionFile?: string; lastWrite?: number; procStart?: string; tty?: string;
  claims: Claim[]; git: GitEvidence; unread: string[]; status?: string;
}
function absolute(ctx: LanesCtx, path: string): string { return normalize(ctx.realpath(path)); }
function requireProbe(result: { code: number; timedOut: boolean }, message: string): void { if (result.code !== 0 || result.timedOut) throw new Error(message); }
async function processEvidence(s: Signals, ctx: LanesCtx): Promise<void> {
  const ps = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 4000 }); requireProbe(ps, "process descendants unknown");
  const children = ps.stdout.split("\n").map(line => /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())).filter(Boolean);
  const owned = new Set([s.pid]); let changed = true;
  while (changed) { changed = false; for (const row of children) if (owned.has(Number(row![2])) && !owned.has(Number(row![1]))) { owned.add(Number(row![1])); changed = true; } }
  if (owned.size > 1) s.keeps.push("busy child process");
  const files = await ctx.run("lsof", ["-p", String(s.pid), "-Fn"], { timeoutMs: 4000 }); requireProbe(files, "open files unknown");
  for (const path of files.stdout.split("\n").filter(l => l.startsWith("n")).map(l => l.slice(1))) {
    if (path.startsWith(join(ctx.piAgentDir, "jobs") + "/")) { readFileSync(path, "utf8"); s.keeps.push("job/watch running (log open)"); }
  }
  const start = await ctx.run("ps", ["-p", String(s.pid), "-o", "lstart="], { timeoutMs: 4000 }); requireProbe(start, "process start unknown");
  s.procStart = start.stdout.trim(); if (!s.procStart) throw new Error("process start unknown");
  const tty = await ctx.run("ps", ["-o", "tty=", "-p", String(s.pid)], { timeoutMs: 4000 }); requireProbe(tty, "TTY unknown");
  s.tty = tty.stdout.trim(); if (!s.tty || s.tty === "??" || s.tty === "?") throw new Error("foreground not the expected pi (no TTY)");
  const fg = await ctx.run("ps", ["-t", s.tty, "-o", "pid=,stat=,command="], { timeoutMs: 4000 }); requireProbe(fg, "foreground unknown");
  const foreground = fg.stdout.split("\n").filter(l => /^\s*\d+\s+\S*\+/.test(l));
  if (foreground.length !== 1 || !new RegExp(`^\\s*${s.pid}\\s+\\S*\\+\\s+(?:\\S*/)?pi(?:\\s|$)`).test(foreground[0])) throw new Error("foreground not the expected pi");
}
function resolveSession(s: Signals, ctx: LanesCtx): void {
  const dir = sessionDirFor(s.cwd, ctx.piAgentDir);
  try { readdirSync(dir); } catch { throw new Error("sessions directory unreadable or missing"); }
  const leases = jsonFiles(join(ctx.piAgentDir, "issue-work/sessions"));
  const leasesHere = leases.filter(l => l.pid === s.pid && l.cwd && absolute(ctx, l.cwd) === s.cwd);
  const good = leasesHere.filter(l => l.procStart === s.procStart);
  if (leasesHere.length && good.length !== 1) throw new Error("lease/process start mismatch");
  const lease = good[0];
  const heartbeats = jsonFiles(join(ctx.home, ".pi/orch/heartbeats"));
  const beats = heartbeats.filter(h => h.pid === s.pid && (!h.cwd || absolute(ctx, h.cwd) === s.cwd));
  if (beats.length > 1 || (lease && beats[0]?.sessionId && beats[0].sessionId !== lease.sessionId)) throw new Error("signals disagree: session identity");
  const identity = lease || beats[0];
  s.sessionId = identity?.sessionId; s.sessionFile = identity?.sessionFile;
  // Do not pick the newest file: a same-cwd idle session may not own it.
  if (!s.sessionFile && s.sessionId) {
    const names = readdirSync(dir).filter(n => n.endsWith(".jsonl") && n.includes(s.sessionId!));
    if (names.length === 1) s.sessionFile = join(dir, names[0]);
  }
  if (!s.sessionId || !s.sessionFile || !isAbsolute(s.sessionFile) || !absolute(ctx, s.sessionFile).startsWith(absolute(ctx, dir) + "/")) throw new Error("session file unknown");
  s.lastWrite = mtime(s.sessionFile);
  const heartbeat = beats[0];
  if (heartbeat) {
    const stamp = Date.parse(heartbeat.at || heartbeat.updatedAt || "");
    const recent = ctx.now().getTime() - s.lastWrite < 10 * 60000;
    if (!Number.isFinite(stamp) || ctx.now().getTime() - stamp > 10 * 60000 || (heartbeat.state === "working" && !recent)) throw new Error("signals disagree: heartbeat stale/working versus session write");
    if (heartbeat.state === "working") s.keeps.push("heartbeat working");
  }
}
function inboxAndStatus(s: Signals, c: Config, root: string, ctx: LanesCtx): void {
  const dir = expand(c.messages.dir, c, root, ctx.home); const lane = c.lanes.find(l => l.id === s.id)!;
  const marker = join(dir, `${s.id}-inbox.marker`); let since: number;
  try { since = mtime(marker); } catch { s.asks.push("inbox watch never ran (marker missing/unreadable)"); return; }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const message = parseMessageName(name); if (!message) { s.asks.push(`unparseable message ${name}`); continue; }
    if ([s.id, c.messages.broadcast, "ALL", lane.group].some(id => id && message.to.some(to => to === id || (`-${to}-`).includes(`-${id}-`))) && message.from !== s.id && mtime(join(dir, name)) > since) s.unread.push(name);
  }
  if (s.unread.length) s.keeps.push("unread inbox");
  s.status = optionalText(join(dir, "status", `${s.id}.status`));
  if (s.status) { const status = parseStatus(s.status.trim()); if (status.until !== undefined && status.until > ctx.now().getTime()) s.keeps.push("declared wait until future"); }
}
function claimsAndOwnership(s: Signals, lane: Lane, root: string, ctx: LanesCtx): void {
  const text = optionalText(join(ctx.piAgentDir, "issue-work/registry.jsonl")); const folded = new Map<string, Claim>();
  for (const line of (text || "").split("\n").filter(l => l.trim())) {
    let ev: Claim; try { ev = JSON.parse(line); } catch { throw new Error("cannot read issue-work registry"); }
    if (!ev.repo || !Number.isInteger(ev.issue) || !ev.sessionId || !ev.source) throw new Error("cannot read issue-work registry");
    const key = `${ev.repo.toLowerCase()}#${ev.issue}`; folded.set(key, { ...folded.get(key), ...ev });
  }
  for (const claim of folded.values()) {
    if (claim.repo.toLowerCase() !== lane.repo.toLowerCase()) continue;
    if (claim.sessionId !== s.sessionId || claim.source !== "tool") { s.asks.push("claim from another tool or unmapped session"); continue; }
    s.claims.push(claim);
    if (claim.state === "in-progress") s.keeps.push("in-progress claim");
    else if (!["done", "in-review"].includes(claim.state || "") && !(["blocked", "planned"].includes(claim.state || "") && claim.note?.trim())) s.asks.push("claim needs named ready/blocked note or completion evidence");
  }
  const paths = [join(root, "coordinator/NOW.md"), join(root, "coordinator/WATCHES.md")];
  const pattern = new RegExp(`(^|[^A-Z0-9-])${s.id}([^A-Z0-9-]|$)`);
  for (const path of paths) if (pattern.test(optionalText(path) || "")) s.asks.push(`named in ${path.split("/").at(-1)}`);
  for (const task of jsonFiles(join(ctx.home, ".pi/orch/tasks"))) {
    if ((task.assignee === s.sessionId || task.assignee === s.id || task.assignee?.sessionId === s.sessionId) && ["claimed", "blocked", "ready"].includes(task.state || task.status)) s.asks.push("assigned pi-orch task requires handoff");
  }
  for (const status of jsonFiles(join(ctx.piAgentDir, "context-budget/status"))) {
    if (status.role === "subagent" && !["done", "failed", "cancelled", "stopped"].includes(status.phase || status.state)) {
      // Unknown parent identity is not absence of a running subagent.
      if (status.pid === s.pid || status.parentPid === s.pid || status.sessionId === s.sessionId || status.parentSessionId === s.sessionId) s.keeps.push("subagent running");
      else s.asks.push("subagent ownership unknown");
    }
  }
}
export async function collect(c: Config, lane: Lane, root: string, ctx: LanesCtx, minutes: number): Promise<Signals> {
  const s: Signals = { id: lane.id, cwd: "", asks: [], keeps: [], finished: false, takeover: false, pids: [], claims: [], git: {}, unread: [] };
  try {
    s.cwd = absolute(ctx, join(expand(c.worktreesDir, c, root, ctx.home), lane.worktree));
    const processes = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 4000 });
    if (processes.timedOut || ![0, 1].includes(processes.code)) throw new Error("pi process list unknown");
    for (const token of processes.stdout.trim().split(/\s+/).filter(Boolean)) {
      if (!/^\d+$/.test(token)) throw new Error("pi process list malformed");
      const pid = Number(token);
      let cwd: string | undefined;
      if (ctx.readCwd) cwd = await ctx.readCwd(pid);
      else {
        const probe = ctx.platform === "darwin" ? await ctx.run("lsof", ["-a", "-p", token, "-d", "cwd", "-Fn"], { timeoutMs: 4000 }) : await ctx.run("readlink", [`/proc/${token}/cwd`], { timeoutMs: 4000 });
        requireProbe(probe, "pi cwd unknown"); cwd = ctx.platform === "darwin" ? probe.stdout.split("\n").find(l => l.startsWith("n"))?.slice(1) : probe.stdout.trim();
      }
      if (!cwd) throw new Error("pi cwd unknown");
      if (absolute(ctx, cwd) === s.cwd) s.pids.push(pid);
    }
    if (!s.pids.length) { s.keeps.push("not running"); return s; }
    if (s.pids.length !== 1) { s.asks.push("shared cwd"); return s; }
    s.pid = s.pids[0]; await processEvidence(s, ctx); resolveSession(s, ctx);
    if (ctx.now().getTime() - s.lastWrite! < minutes * 60000) s.keeps.push(`recent write (< ${minutes} minutes)`);
    const snooze = optionalText(join(root, ".state/snooze", lane.id));
    if (snooze !== undefined) { const until = Date.parse(snooze.trim()); if (!Number.isFinite(until)) throw new Error("cannot read snooze"); if (until > ctx.now().getTime()) s.keeps.push("snoozed"); }
    inboxAndStatus(s, c, root, ctx); claimsAndOwnership(s, lane, root, ctx);
    s.git = await gitEvidence(ctx, lane, s.cwd); if (s.git.error) s.asks.push(s.git.error);
    // File messages have no machine-readable delivery acknowledgement or candidate ownership.
    // A merged PR SHA alone cannot establish that this lane has no remaining ownership.
  } catch (e) { s.asks.push((e as Error).message); }
  return s;
}
