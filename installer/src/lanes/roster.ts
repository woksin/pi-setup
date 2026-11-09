import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { addressed, backendFor, type MessageRef } from "./backend.ts";
import { expand, laneDir, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { deliveries, foldRegistry, holding, issueKey, ownershipOf, readIssueRegister, short, sourceFailure, type RegisterData, type Source, type IssueView } from "./issue-register.ts";
import { runningPiChecked } from "./processes.ts";
import { idleMinutes } from "./sessions.ts";
import { parseStatus, suppressed } from "./status-line.ts";

export const HEARTBEAT_STALE_MIN = 15;
interface Heartbeat { pid: number; id?: string; sessionId?: string; at: string; state?: string }
interface OrchSession { pid: number; id?: string; sessionId?: string; cwd?: string; tty?: string }
interface Seed {
  id: string; cwd: string; repo?: string; branch?: string; issue?: number; group?: string | null; retired?: boolean; role?: string;
}
export interface RosterRow {
  lane: string; identity: "registered" | "orch" | "unregistered" | "message-only"; repo: string | null;
  worktree: string | null; branch: string | null; issue: { repo: string; number: number; state: string; holder: boolean } | null;
  state: string; idleMinutes: number | null; contextUse: null; pid: number | null; sessionId: string | null;
  lastInbound: { name: string; ageMin: number } | null; lastOutbound: { name: string; ageMin: number } | null;
  evidence: string[]; notes: string[];
}
export interface RosterInputs {
  lanes: Seed[]; processes: Awaited<ReturnType<typeof runningPiChecked>>; register: RegisterData;
  heartbeats: Heartbeat[]; sessions: OrchSession[]; statuses: Map<string, string>; messages: MessageRef[];
  idle: Map<string, number | null>; sources: Record<string, Source>; broadcast: string;
}
export interface Roster { rows: RosterRow[]; sources: Record<string, Source> }
export interface Selection { repo?: string; issue?: { repo?: string; number: number } }
export interface Suggestion { target: string | null; rule: string; reason: string }

function readJsonDir<T>(dir: string, valid: (value: any) => boolean): { values: T[]; source: Source } {
  try {
    const names = readdirSync(dir).filter(n => n.endsWith(".json")); const values: T[] = []; let skipped = 0;
    for (const name of names) {
      try { const value = JSON.parse(readFileSync(join(dir, name), "utf8")); if (valid(value)) values.push(value); else skipped++; }
      catch { skipped++; }
    }
    return { values, source: { status: skipped ? "error" : "ok", count: values.length, ...(skipped ? { detail: `${skipped} invalid or unreadable files skipped` } : {}) } };
  } catch (e) { return { values: [], source: sourceFailure(e) }; }
}
function readStatuses(dir: string): { values: Map<string, string>; source: Source } {
  const values = new Map<string, string>();
  try {
    const names = readdirSync(dir).filter(n => n.endsWith(".status")); let skipped = 0;
    for (const name of names) {
      try { values.set(name.slice(0, -7), readFileSync(join(dir, name), "utf8").split(/\r?\n/)[0]); }
      catch { skipped++; }
    }
    return { values, source: { status: skipped ? "error" : "ok", count: values.size, ...(skipped ? { detail: `${skipped} unreadable status files` } : {}) } };
  } catch (e) { return { values, source: sourceFailure(e) }; }
}
async function readMessages(c: Config, root: string, ctx: LanesCtx): Promise<{ values: MessageRef[]; source: Source }> {
  try {
    statSync(expand(c.messages.dir, c, root, ctx.home));
    const values = await backendFor(c, ctx, root).list();
    return { values, source: { status: "ok", count: values.length } };
  } catch (e) { return { values: [], source: sourceFailure(e) }; }
}
function canonical(path: string, ctx: LanesCtx): string {
  try { return ctx.realpath(path); } catch { return path; }
}
function rosterSeeds(c: Config, root: string, ctx: LanesCtx): Seed[] {
  return [
    { id: c.coordinator.id, cwd: canonical(expand(c.coordinator.cwd, c, root, ctx.home), ctx), role: "coordinator" },
    ...c.lanes.map(l => ({ ...l, cwd: canonical(laneDir(l, c, root, ctx), ctx), retired: Boolean(l.retired || l.closed) })),
  ];
}
export async function readRoster(c: Config, root: string, ctx: LanesCtx, register?: RegisterData): Promise<RosterInputs> {
  const data = register ?? await readIssueRegister(ctx); const processes = await runningPiChecked(ctx);
  const orch = join(ctx.home, ".pi/orch");
  const heartbeats = readJsonDir<Heartbeat>(join(orch, "heartbeats"), v => v && Number.isInteger(v.pid) && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)));
  const sessions = readJsonDir<OrchSession>(join(orch, "sessions"), v => v && Number.isInteger(v.pid) && (v.id === undefined || typeof v.id === "string"));
  const assignments = readJsonDir(join(orch, "assignments"), v => v && typeof v === "object");
  const statusDir = ctx.env.LANE_STATUS_DIR || (c.messages.dir ? join(expand(c.messages.dir, c, root, ctx.home), "status") : join(ctx.piAgentDir, "lane-status"));
  const statuses = readStatuses(statusDir); const messages = await readMessages(c, root, ctx);
  const lanes = rosterSeeds(c, root, ctx); const idle = new Map<string, number | null>();
  for (const cwd of new Set([...lanes.map(l => l.cwd), ...processes.procs.map(p => p.cwd)])) idle.set(cwd, idleMinutes(cwd, ctx) ?? null);
  return { lanes, processes, register: data, heartbeats: heartbeats.values, sessions: sessions.values, statuses: statuses.values,
    messages: messages.values, idle, broadcast: c.messages.broadcast, sources: { lanes: { status: "ok", count: lanes.length },
      processes: { status: processes.ok ? "ok" : "error", count: processes.procs.length, ...(!processes.ok ? { detail: "process discovery unavailable or incomplete" } : {}) },
      ...data.sources, heartbeats: heartbeats.source, sessions: sessions.source, assignments: assignments.source,
      "status-files": statuses.source, messages: messages.source } };
}
/** Only identity-verified, current leases participate; a reused pid must not name a recipient. */
export function matchedSessions(cwd: string | null, pids: number[], data: RegisterData): string[] {
  return [...new Set(data.leases.filter(l => {
    const live = data.liveness.get(l.sessionId);
    return live?.status === "live" && live.pid === l.pid && (pids.includes(l.pid) || Boolean(cwd && l.cwd === cwd));
  }).map(l => l.sessionId))];
}
function emptyRow(lane: string, identity: RosterRow["identity"]): RosterRow {
  return { lane, identity, repo: null, worktree: null, branch: null, issue: null, state: "unknown", idleMinutes: null,
    contextUse: null, pid: null, sessionId: null, lastInbound: null, lastOutbound: null, evidence: [], notes: [] };
}
function heartbeatFor(pid: number | null, input: RosterInputs): Heartbeat | undefined {
  return input.heartbeats.filter(h => h.pid === pid).sort((a, b) => b.at.localeCompare(a.at))[0];
}
function fresh(h: Heartbeat | undefined, now: Date): boolean {
  return Boolean(h && Date.parse(h.at) >= now.getTime() - HEARTBEAT_STALE_MIN * 60000);
}
function unregisteredProcess(p: { pid: number; cwd: string }, input: RosterInputs): RosterRow {
  const session = input.sessions.find(s => s.pid === p.pid); const h = heartbeatFor(p.pid, input);
  const id = session?.id || h?.id;
  const row = emptyRow(id || `unregistered-p${p.pid}`, id ? "orch" : "unregistered");
  row.pid = p.pid; row.worktree = p.cwd || session?.cwd || null;
  if (session) row.evidence.push("orch-session");
  if (!id) row.notes.push("identity unavailable: unregistered");
  return row;
}
function processRows(input: RosterInputs): RosterRow[] {
  const seeds = input.lanes.map(l => ({ ...emptyRow(l.id, "registered"), repo: l.repo ?? null, worktree: l.cwd, branch: l.branch ?? null, evidence: ["lanes.json"] }));
  const rows = [...seeds];
  for (const p of input.processes.procs) {
    const matched = seeds.find(r => r.worktree && r.worktree === p.cwd);
    if (matched) { if (matched.pid === null) matched.pid = p.pid; continue; }
    rows.push(unregisteredProcess(p, input));
  }
  return rows;
}
function joinIssue(row: RosterRow, sessions: string[], input: RosterInputs): void {
  const events = input.register.events.filter(e => sessions.includes(e.sessionId)).sort((a, b) => b.ts.localeCompare(a.ts));
  const views = foldRegistry(input.register.events);
  const held = [...views.values()].flatMap(v => v.sessions.filter(s => sessions.includes(s.sessionId) && holding(s.lastState)).map(s => ({ v, s })))
    .sort((a, b) => b.s.lastTs.localeCompare(a.s.lastTs))[0];
  if (held) row.issue = { repo: held.v.repo, number: held.v.issue, state: held.s.lastState!, holder: true };
  else if (events[0]) {
    const event = events[0];
    const touch = views.get(issueKey(event.repo, event.issue))?.sessions.find(s => s.sessionId === event.sessionId);
    row.issue = { repo: event.repo, number: event.issue, state: touch?.lastState ?? "unknown", holder: false };
  }
  else {
    const seed = input.lanes.find(l => l.id === row.lane);
    if (seed?.repo && seed.issue) row.issue = { repo: seed.repo, number: seed.issue, state: "unknown", holder: false };
  }
  if (events.length) {
    row.evidence.push("registry"); row.repo ??= events[0].repo; row.branch ??= events[0].branch ?? null;
  }
}
function rowSessions(row: RosterRow, input: RosterInputs): string[] {
  const pids = input.processes.procs.filter(p => p.cwd && p.cwd === row.worktree).map(p => p.pid);
  if (row.pid !== null && !pids.includes(row.pid)) pids.push(row.pid);
  const sessions = matchedSessions(row.worktree, pids, input.register);
  if (sessions.length) {
    row.evidence.push("lease"); row.sessionId = sessions[0];
    row.pid ??= input.register.liveness.get(sessions[0])!.pid;
  } else {
    const orch = input.sessions.find(s => s.pid === row.pid); const h = heartbeatFor(row.pid, input);
    row.sessionId = orch?.sessionId || h?.sessionId || null;
  }
  return sessions;
}
function heartbeatEvidence(row: RosterRow, h: Heartbeat | undefined, now: Date): boolean {
  const current = fresh(h, now);
  if (h) { if (current) row.evidence.push("heartbeat(fresh)"); else row.notes.push("heartbeat stale"); }
  return current;
}
function suppressedState(line: string | undefined, row: RosterRow, now: Date): string | undefined {
  const status = parseStatus(line);
  const expired = status.until !== undefined && !(status.until > now.getTime());
  if (expired) row.notes.push("status expired");
  if (row.issue?.state === "blocked") return "blocked";
  if (!suppressed(line, now)) return undefined;
  if (status.kind === "barred-by") return "blocked";
  if (!expired) return "waiting";
}
function activeState(row: RosterRow, line: string | undefined, h: Heartbeat | undefined, now: Date): string {
  const held = suppressedState(line, row, now); if (held) return held;
  if (parseStatus(line).kind === "working") return "working";
  if (fresh(h, now)) { if (h?.state === "working") return "working"; }
  else row.notes.push("no heartbeat");
  return "idle";
}
function discoveryUnknown(row: RosterRow, input: RosterInputs, heartbeatFresh: boolean): boolean {
  if (input.processes.ok || heartbeatFresh || row.evidence.includes("lease")) return false;
  row.notes.push("processes unavailable"); return true;
}
function stateOf(row: RosterRow, input: RosterInputs, now: Date): string {
  const seed = input.lanes.find(l => l.id === row.lane); const line = input.statuses.get(row.lane);
  if (line) row.evidence.push("status-file");
  const h = heartbeatFor(row.pid, input); const heartbeatFresh = heartbeatEvidence(row, h, now);
  if (seed?.retired || parseStatus(line).kind === "closed") return "retired";
  if (discoveryUnknown(row, input, heartbeatFresh)) return "unknown";
  const live = row.pid !== null || row.evidence.includes("lease") || heartbeatFresh;
  if (!live) return seed ? "stopped" : "unknown";
  return activeState(row, line, h, now);
}
function lastMessage(messages: MessageRef[], now: Date): RosterRow["lastInbound"] {
  const last = [...messages].sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name))[0];
  return last ? { name: last.name, ageMin: Math.max(0, Math.floor((now.getTime() - last.at.getTime()) / 60000)) } : null;
}
function joinMessages(row: RosterRow, input: RosterInputs, now: Date): void {
  const group = input.lanes.find(l => l.id === row.lane)?.group;
  const recipients = [row.lane, "ALL", input.broadcast, ...(group ? [group] : [])];
  row.lastInbound = lastMessage(input.messages.filter(m => m.from !== row.lane && recipients.some(id => addressed(m, id))), now);
  row.lastOutbound = lastMessage(input.messages.filter(m => m.from === row.lane), now);
  if (row.lastInbound || row.lastOutbound) row.evidence.push("messages");
}
function messageRows(rows: RosterRow[], input: RosterInputs, now: Date): void {
  const reserved = new Set(["", "ALL", "BCAST", input.broadcast, ...input.lanes.flatMap(l => l.group ? [l.group] : [])]);
  const ids = input.messages.filter(m => m.at.getTime() >= now.getTime() - 14 * 86_400_000).flatMap(m => [m.from, ...m.to]);
  for (const id of new Set(ids)) if (!reserved.has(id) && !rows.some(r => r.lane === id)) {
    const row = emptyRow(id, "message-only"); row.notes.push("identity known only from messages"); rows.push(row);
  }
}
/** Pure join: no process, filesystem or clock access. */
export function buildRoster(input: RosterInputs, now: Date): Roster {
  const rows = processRows(input); messageRows(rows, input, now);
  for (const row of rows) {
    if (row.pid !== null) row.evidence.push("process");
    const sessions = rowSessions(row, input); joinIssue(row, sessions, input);
    row.idleMinutes = input.idle.get(row.worktree ?? "") ?? null;
    row.state = stateOf(row, input, now); joinMessages(row, input, now);
  }
  return { rows: rows.sort((a, b) => a.lane.localeCompare(b.lane)), sources: input.sources };
}
export function repoMatches(repo: string | null | undefined, filter: string): boolean {
  const value = repo?.toLowerCase(); const target = filter.toLowerCase();
  return value === target || !target.includes("/") && value?.split("/").at(-1) === target;
}
export function filterRows(rows: RosterRow[], selection: Selection): RosterRow[] {
  return rows.filter(r => (!selection.repo || repoMatches(r.repo, selection.repo)) && (!selection.issue || r.issue?.number === selection.issue.number
    && (!selection.issue.repo || repoMatches(r.issue.repo, selection.issue.repo))));
}
function ownershipUnavailable(input: RosterInputs): Suggestion | undefined {
  if ([input.register.sources.registry, input.register.sources.leases].some(s => s.status === "error")) {
    return { target: null, rule: "unverified", reason: "ownership unavailable; verify before assigning" };
  }
}
function liveOwner(rows: RosterRow[], sessionIds: string[], input: RosterInputs): RosterRow | undefined {
  return rows.find(r => r.identity !== "unregistered" && !["retired", "stopped", "unknown"].includes(r.state)
    && matchedSessions(r.worktree, r.pid === null ? [] : [r.pid], input.register).some(id => sessionIds.includes(id)));
}
function viewSuggestion(view: IssueView,
  rows: RosterRow[], input: RosterInputs, now: Date, unique: boolean): Suggestion | undefined {
  const holders = view.sessions.filter(s => holding(s.lastState));
  if (holders.some(s => input.register.liveness.get(s.sessionId)?.status === "unknown")) return { target: null, rule: "unverified", reason: "holder liveness unknown; verify before assigning" };
  const live = holders.filter(s => input.register.liveness.get(s.sessionId)?.status === "live");
  const owner = liveOwner(rows, live.map(s => s.sessionId), input);
  if (live.length) {
    if (owner && live.length === 1 && unique) return { target: owner.lane, rule: "issue-owner", reason: "live issue holder" };
    return { target: null, rule: "unverified", reason: "holder has no unique matched lane; verify before assigning" };
  }
  const delivered = deliveries({ ...input.register, key: view.key, now });
  if (delivered.length) return { target: null, rule: "delivered", reason: `${delivered.map(s => short(s.sessionId)).join(", ")}: do not assign; verify` };
  const ownership = ownershipOf({ ...input.register, view, now });
  if (ownership.verdict === "OWNED") return { target: null, rule: "unverified", reason: ownership.reason };
}
function issueSuggestion(rows: RosterRow[], input: RosterInputs, selection: Selection, now: Date): Suggestion | undefined {
  if (!selection.issue) return undefined;
  const views = [...foldRegistry(input.register.events).values()].filter(v => v.issue === selection.issue!.number
    && (!selection.issue!.repo || repoMatches(v.repo, selection.issue!.repo)) && (!selection.repo || repoMatches(v.repo, selection.repo)));
  for (const view of views) {
    const suggestion = viewSuggestion(view, rows, input, now, views.length === 1);
    if (suggestion) return suggestion;
  }
}
export function suggestTarget(rows: RosterRow[], input: RosterInputs, selection: Selection, now: Date): Suggestion {
  const unavailable = ownershipUnavailable(input); if (unavailable) return unavailable;
  const issue = issueSuggestion(rows, input, selection, now); if (issue) return issue;
  const repo = selection.repo || selection.issue?.repo;
  const candidates = rows.filter(r => repo && repoMatches(r.repo, repo) && r.state === "idle" && r.pid !== null && !r.issue?.holder && r.identity !== "unregistered");
  const roleRank = (r: RosterRow) => input.lanes.find(l => l.id === r.lane)?.role === "repo-orch" ? 1 : 0;
  candidates.sort((a, b) => roleRank(a) - roleRank(b) || (b.idleMinutes ?? -1) - (a.idleMinutes ?? -1) || a.lane.localeCompare(b.lane));
  return candidates.length ? { target: candidates[0].lane, rule: "idle-in-repo", reason: "longest idle lane in repository (ties by lane id; workers before repo orchestrator)" }
    : { target: null, rule: "start-lane", reason: `no live lane for ${repo ?? "matching repositories"}` };
}
