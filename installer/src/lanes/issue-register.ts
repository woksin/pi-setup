// Port of agent/lib/issue-work*.ts; parity spec in lanes-send-owner.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { probeInBatches } from "./processes.ts";

export const RECENT_DAYS = 14;
const DAY_MS = 86_400_000;
const REPO_RE = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
export type IssueState = "in-progress" | "in-review" | "blocked" | "paused" | "done" | "unknown";
export interface RegistryEvent {
  ts: string; repo: string; issue: number; sessionId: string; state?: IssueState; source: string;
  cwd?: string; branch?: string; pid?: number; note?: string; pr?: string;
}
export interface SessionTouch {
  sessionId: string; lastTs: string; lastState?: IssueState; cwd?: string; branch?: string; pid?: number;
  lastStateTs?: string; note?: string; noteTs?: string; pr?: string;
}
export interface IssueView {
  key: string; repo: string; issue: number; state: IssueState; lastTs: string; branch?: string; sessions: SessionTouch[];
}
export interface Lease { sessionId: string; pid: number; startedAt: string; procStart?: string; cwd?: string; sessionFile?: string }
export interface SessionLiveness { status: "live" | "unknown"; pid: number }
export interface Source { status: "ok" | "missing" | "error"; count: number; detail?: string }
export interface RegisterData {
  events: RegistryEvent[]; leases: Lease[]; liveness: Map<string, SessionLiveness>; sources: Record<string, Source>;
}
interface RegisterContext { events: RegistryEvent[]; liveness: Map<string, SessionLiveness>; now: Date; days?: number; views?: Map<string, IssueView> }
export const issueKey = (repo: string, issue: number): string => `${repo.toLowerCase()}#${issue}`;
export const holding = (state?: string): boolean => state === "in-progress" || state === "in-review";
export const short = (id: string): string => id.slice(0, 12);
const inWindow = (ts: string | undefined, now: Date, days: number): boolean => ts !== undefined && Date.parse(ts) >= now.getTime() - days * DAY_MS;
const windowDays = (days = RECENT_DAYS): number => Math.max(1, Math.min(90, Number.isFinite(days) ? Math.trunc(days) : RECENT_DAYS));

function validIssueMatch(m: RegExpExecArray): boolean {
  if (m[1] && !REPO_RE.test(m[1])) return false;
  return Number.isSafeInteger(Number(m[2])) && Number(m[2]) > 0;
}
export function parseIssue(text: string): { repo?: string; number: number } {
  const m = /^(?:([^/#]+\/[^/#]+)#|#?)(\d+)$/.exec(text);
  if (!m || !validIssueMatch(m)) {
    throw new UsageError("issue must be N, #N or OWNER/REPO#N");
  }
  return { repo: m[1], number: Number(m[2]) };
}
export function parseRegistry(text: string): RegistryEvent[] {
  return text.split("\n").flatMap(line => {
    try {
      const e = JSON.parse(line);
      return e && REPO_RE.test(e.repo) && typeof e.repo === "string" && Number.isInteger(e.issue) && e.issue > 0
        && typeof e.ts === "string" && typeof e.sessionId === "string" ? [e] : [];
    } catch { return []; }
  });
}
function touchEvent(touch: SessionTouch, ev: RegistryEvent): void {
  if (ev.ts > touch.lastTs) touch.lastTs = ev.ts;
  if (ev.state) { touch.lastState = ev.state; touch.lastStateTs = ev.ts; }
  if (ev.source === "tool" && ev.note !== undefined) { touch.note = ev.note; touch.noteTs = ev.ts; }
  for (const field of ["cwd", "branch", "pr"] as const) if (ev[field]) touch[field] = ev[field];
  if (ev.pid) touch.pid = ev.pid;
}
export function foldRegistry(events: RegistryEvent[]): Map<string, IssueView> {
  const views = new Map<string, IssueView>();
  for (const ev of events) {
    const key = issueKey(ev.repo, ev.issue);
    const view = views.get(key) ?? { key, repo: ev.repo, issue: ev.issue, state: "unknown", lastTs: ev.ts, sessions: [] };
    if (ev.state) view.state = ev.state;
    if (ev.branch) view.branch = ev.branch;
    if (ev.ts > view.lastTs) view.lastTs = ev.ts;
    const touch = view.sessions.find(s => s.sessionId === ev.sessionId) ?? { sessionId: ev.sessionId, lastTs: ev.ts };
    if (!view.sessions.includes(touch)) view.sessions.push(touch);
    touchEvent(touch, ev); views.set(key, view);
  }
  return views;
}
export function parseLeases(texts: string[]): Lease[] {
  return texts.flatMap(text => {
    try {
      const l = JSON.parse(text);
      return l && typeof l.sessionId === "string" && Number.isInteger(l.pid) && l.pid > 0 && typeof l.startedAt === "string" ? [l] : [];
    } catch { return []; }
  });
}
function newestLeases(leases: Lease[]): Lease[] {
  const newest = new Map<number, Lease>();
  for (const l of leases) if (!newest.has(l.pid) || l.startedAt > newest.get(l.pid)!.startedAt) newest.set(l.pid, l);
  return [...newest.values()];
}
function leaseStatus(lease: Lease, current: string | undefined): SessionLiveness | undefined {
  if (current !== undefined && current !== lease.procStart) return undefined;
  return { status: current === undefined ? "unknown" : "live", pid: lease.pid };
}
export function sessionLiveness(leases: Lease[], isPidAlive: (pid: number) => boolean, startTimeOf: (pid: number) => string | undefined): Map<string, SessionLiveness> {
  const out = new Map<string, SessionLiveness>();
  for (const lease of newestLeases(leases)) {
    if (!lease.procStart || !isPidAlive(lease.pid)) continue;
    const status = leaseStatus(lease, startTimeOf(lease.pid));
    if (status && out.get(lease.sessionId)?.status !== "live") out.set(lease.sessionId, status);
  }
  return out;
}
export function deliveries(o: RegisterContext & { key: string; excludeSessionId?: string }): SessionTouch[] {
  const sessions = (o.views ?? foldRegistry(o.events)).get(o.key)?.sessions ?? [];
  const days = windowDays(o.days);
  return sessions.filter(s => s.sessionId !== o.excludeSessionId && inWindow(s.lastTs, o.now, days)
    && (inWindow(s.lastStateTs, o.now, days) && ["in-review", "done"].includes(s.lastState!)
      || inWindow(s.noteTs, o.now, days) && /(?<!\bnot )\bdelivered\b/i.test(s.note ?? "")));
}
function holderReason(view: IssueView, o: RegisterContext): string | undefined {
  const holders = view.sessions.filter(s => holding(s.lastState));
  const live = holders.find(s => o.liveness.get(s.sessionId)?.status === "live");
  if (live) return `held by live session ${short(live.sessionId)} (${live.lastState}), branch ${live.branch ?? "-"}, ${age(live.lastTs, o.now)}`;
  const unknown = holders.find(s => o.liveness.get(s.sessionId)?.status === "unknown");
  if (unknown) return `held by session ${short(unknown.sessionId)} (${unknown.lastState}), branch ${unknown.branch ?? "-"}, ${age(unknown.lastTs, o.now)}; liveness cannot be verified`;
}
export function age(ts: string, now: Date): string {
  return `${Math.max(0, Math.floor((now.getTime() - Date.parse(ts)) / 60000))}m ago`;
}
function recentReason(view: IssueView, o: RegisterContext): string | undefined {
  const found = deliveries({ ...o, key: view.key });
  if (found.length) return `delivered or in review: ${found.map(s => `${short(s.sessionId)} (${s.lastState ?? "unknown"}, branch ${s.branch ?? "-"}, ${age(s.lastStateTs ?? s.lastTs, o.now)})`).join(", ")}`;
  if (["in-progress", "blocked"].includes(view.state) && inWindow(view.lastTs, o.now, windowDays(o.days))) {
    const latest = [...view.sessions].sort((a, b) => b.lastTs.localeCompare(a.lastTs))[0];
    return `ended session ${short(latest.sessionId)} left ${view.state}, branch ${latest.branch ?? "-"}, ${age(view.lastTs, o.now)}; confirm with its owner before reassigning`;
  }
  if (view.state === "paused" && inWindow(view.lastTs, o.now, 1)) return `paused ${age(view.lastTs, o.now)} (under 24 h)`;
}
export function ownershipOf(o: RegisterContext & { view?: IssueView }): { verdict: "OWNED" | "FREE"; reason: string } {
  if (!o.view) return { verdict: "FREE", reason: "no register entry" };
  const reason = holderReason(o.view, o) ?? recentReason(o.view, o);
  return reason ? { verdict: "OWNED", reason } : { verdict: "FREE", reason: "no live holder or recent delivery" };
}

export function sourceFailure(error: unknown): Source {
  return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error", count: 0, detail: (error as Error).message };
}
export function readRegistry(path: string): { events: RegistryEvent[]; source: Source } {
  try {
    const text = readFileSync(path, "utf8"); const events = parseRegistry(text);
    const skipped = text.split("\n").filter(l => l.trim()).length - events.length;
    return { events, source: { status: skipped && !events.length ? "error" : "ok", count: events.length, ...(skipped ? { detail: `${skipped} invalid lines skipped` } : {}) } };
  } catch (e) { return { events: [], source: sourceFailure(e) }; }
}
export function readLeases(path: string): { leases: Lease[]; source: Source } {
  try {
    const names = readdirSync(path).filter(n => n.endsWith(".json")); const leases: Lease[] = []; let skipped = 0;
    for (const name of names) {
      try { const parsed = parseLeases([readFileSync(join(path, name), "utf8")]); leases.push(...parsed); if (!parsed.length) skipped++; }
      catch { skipped++; }
    }
    return { leases, source: { status: skipped ? "error" : "ok", count: leases.length, ...(skipped ? { detail: `${skipped} invalid or unreadable leases skipped` } : {}) } };
  } catch (e) { return { leases: [], source: sourceFailure(e) }; }
}
async function probeLeases(leases: Lease[], ctx: LanesCtx): Promise<Map<string, SessionLiveness>> {
  const alive = new Set<number>(); const starts = new Map<number, string>();
  await probeInBatches([...new Set(leases.map(l => l.pid))], async pid => {
    try {
      const result = await ctx.run("ps", ["-p", String(pid)], { timeoutMs: 2000 });
      if (result.code === 1 && !result.timedOut) return;
      alive.add(pid);
      if (result.code !== 0 || result.timedOut) return;
      const start = await ctx.run("ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 2000 });
      const value = start.stdout.trim().replace(/\s+/g, " ");
      if (start.code === 0 && !start.timedOut && value) starts.set(pid, value);
    } catch { alive.add(pid); }
  });
  return sessionLiveness(leases, pid => alive.has(pid), pid => starts.get(pid));
}
export async function readIssueRegister(ctx: LanesCtx): Promise<RegisterData> {
  const dir = join(ctx.piAgentDir, "issue-work"); const registry = readRegistry(join(dir, "registry.jsonl"));
  const { leases, source } = readLeases(join(dir, "sessions"));
  for (const lease of leases) if (lease.cwd) { try { lease.cwd = ctx.realpath(lease.cwd); } catch { /* Retain recorded cwd when it cannot be canonicalized. */ } }
  return { events: registry.events, leases, liveness: await probeLeases(leases, ctx), sources: { registry: registry.source, leases: source } };
}
