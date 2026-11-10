import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { backendFor, type MessageRef } from "./backend.ts";
import { expand, laneDir, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { deliveries, foldRegistry, holding, issueKey, ownershipOf, readIssueRegister, short, sourceFailure, type RegisterData, type Source, type IssueView, type RegistryEvent } from "./issue-register.ts";
import { runningPiChecked } from "./processes.ts";
import { idleMinutes } from "./sessions.ts";
import { parseStatus, suppressed } from "./status-line.ts";
import { attributeProcesses, checkRegistrations, joinRegistration, livePiProcesses, readRegistrations, registrationCutoff, registrationParents, registrationState, verifiedPidSessions, type CheckedRegistration, type ProcessAttribution } from "./registration.ts";

export const HEARTBEAT_STALE_MIN = 15;
interface Heartbeat { pid: number; id?: string; sessionId?: string; at: string; state?: string }
interface OrchSession { pid: number; id?: string; sessionId?: string; cwd?: string; tty?: string }
interface Seed {
  id: string; cwd: string; repo?: string; branch?: string; issue?: number; group?: string | null; retired?: boolean; role?: string;
}
const heldClaims = Symbol("held claims");
const attributedProcess = Symbol("attributed process");
type RowIssue = NonNullable<RosterRow["issue"]>;
interface Claim { issue: RowIssue; ts: string; order: number }
export interface RegistryIndex {
  views: Map<string, IssueView>;
  latest: Map<string, { event: RegistryEvent; order: number }>;
  held: Map<string, Claim[]>;
}
export interface RosterRow {
  [heldClaims]?: RowIssue[];
  [attributedProcess]?: ProcessAttribution;
  lane: string; identity: "registered" | "orch" | "unregistered" | "message-only" | "launched"; repo: string | null;
  worktree: string | null; branch: string | null; issue: { repo: string; number: number; state: string; holder: boolean } | null;
  state: string; idleMinutes: number | null; contextUse: null; pid: number | null; sessionId: string | null;
  lastInbound: { name: string; ageMin: number } | null; lastOutbound: { name: string; ageMin: number } | null;
  evidence: string[]; notes: string[];
}
export interface RosterInputs {
  lanes: Seed[]; processes: Awaited<ReturnType<typeof runningPiChecked>>; register: RegisterData;
  heartbeats: Heartbeat[]; sessions: OrchSession[]; statuses: Map<string, string>; messages: MessageRef[];
  idle: Map<string, number | null>; sources: Record<string, Source>; broadcast: string;
  registrations?: CheckedRegistration[];
  registrationParents?: Map<number, number>;
}
export interface Roster { rows: RosterRow[]; sources: Record<string, Source> }
export interface Selection { repo?: string; issue?: { repo?: string; number: number } }
export interface Suggestion { target: string | null; rule: string; reason: string }
interface SuggestionContext { input: RosterInputs; selection: Selection; now: Date; registry: RegistryIndex }

export function readJsonDir<T>(dir: string, valid: (value: any) => boolean): { values: T[]; source: Source } {
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
  const registrations = readRegistrations(root, registrationCutoff(c, ctx.now()));
  const checkedRegistrations = checkRegistrations(registrations.values, processes, ctx);
  const parents = await registrationParents(checkedRegistrations, ctx);
  const orch = join(ctx.home, ".pi/orch");
  const heartbeats = readJsonDir<Heartbeat>(join(orch, "heartbeats"), v => v && Number.isInteger(v.pid) && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)));
  const sessions = readJsonDir<OrchSession>(join(orch, "sessions"), v => v && Number.isInteger(v.pid) && (v.id === undefined || typeof v.id === "string"));
  const assignments = readJsonDir(join(orch, "assignments"), v => v && typeof v === "object");
  const statusDir = ctx.env.LANE_STATUS_DIR || (c.messages.dir ? join(expand(c.messages.dir, c, root, ctx.home), "status") : join(ctx.piAgentDir, "lane-status"));
  const statuses = readStatuses(statusDir); const messages = await readMessages(c, root, ctx);
  const lanes = rosterSeeds(c, root, ctx); const idle = new Map<string, number | null>();
  for (const cwd of new Set([...lanes.map(l => l.cwd), ...livePiProcesses(processes.procs, data).map(p => p.cwd)])) idle.set(cwd, idleMinutes(cwd, ctx) ?? null);
  return { lanes, processes, registrations: checkedRegistrations, registrationParents: parents, register: data, heartbeats: heartbeats.values, sessions: sessions.values, statuses: statuses.values,
    messages: messages.values, idle, broadcast: c.messages.broadcast, sources: { lanes: { status: "ok", count: lanes.length },
      processes: { status: processes.ok ? "ok" : "error", count: processes.procs.length, ...(!processes.ok ? { detail: "process discovery unavailable or incomplete" } : {}) },
      ...data.sources, registrations: registrations.source, heartbeats: heartbeats.source, sessions: sessions.source, assignments: assignments.source,
      "status-files": statuses.source, messages: messages.source } };
}
/** Only identity-verified, current leases participate; a reused pid must not name a recipient. */
export function matchedSessions(_cwd: string | null, pids: number[], data: RegisterData): string[] {
  return verifiedPidSessions(pids, data);
}
/** Session evidence is carried from the single process attribution, never inferred from cwd. */
export function sessionsForRow(row: RosterRow): string[] {
  return row[attributedProcess]?.sessions ?? [];
}
function emptyRow(lane: string, identity: RosterRow["identity"]): RosterRow {
  return { lane, identity, repo: null, worktree: null, branch: null, issue: null, state: "unknown", idleMinutes: null,
    contextUse: null, pid: null, sessionId: null, lastInbound: null, lastOutbound: null, evidence: [], notes: [] };
}
function fresh(h: Heartbeat | undefined, now: Date): boolean {
  return Boolean(h && Date.parse(h.at) >= now.getTime() - HEARTBEAT_STALE_MIN * 60000);
}
function attributionIdentity(attribution: ProcessAttribution): RosterRow["identity"] {
  switch (attribution.source) {
    case "seed": return "registered";
    case "orch": return "orch";
    case "unregistered": return "unregistered";
    default: return "launched";
  }
}
function registrationRows(rows: RosterRow[], input: RosterInputs, attributions: Map<number, ProcessAttribution>): void {
  for (const record of input.registrations ?? []) {
    let row = rows.find(row => row.lane === record.id);
    if (!row) { row = { ...emptyRow(record.id, "launched"), worktree: record.cwd }; rows.push(row); }
    if (!record.alive || row[attributedProcess]) continue;
    if ([...attributions.values()].filter(value => value.process.cwd === record.cwd).length > 1) row.notes.push("ambiguous cwd");
  }
}
function processRows(input: RosterInputs, attributions: Map<number, ProcessAttribution>): RosterRow[] {
  const seeds = input.lanes.map(l => ({ ...emptyRow(l.id, "registered"), repo: l.repo ?? null, worktree: l.cwd, branch: l.branch ?? null, evidence: ["lanes.json"] }));
  const rows = [...seeds];
  for (const attribution of attributions.values()) {
    let row = seeds.find(row => row.lane === attribution.identity && row.pid === null);
    if (!row) { row = emptyRow(attribution.identity, attributionIdentity(attribution)); rows.push(row); }
    row[attributedProcess] = attribution; row.pid = attribution.process.pid; row.sessionId = attribution.sessionId;
    row.worktree = attribution.process.cwd || row.worktree;
    if (attribution.orch) row.evidence.push("orch-session");
    if (attribution.source === "unregistered") row.notes.push("identity unavailable: unregistered");
  }
  registrationRows(rows, input, attributions);
  return rows;
}
export function indexRosterRegistry(events: RegistryEvent[]): RegistryIndex {
  const views = foldRegistry(events);
  const latest: RegistryIndex["latest"] = new Map(); const held: RegistryIndex["held"] = new Map();
  events.forEach((event, order) => {
    const previous = latest.get(event.sessionId);
    if (!previous || event.ts > previous.event.ts) latest.set(event.sessionId, { event, order });
  });
  let order = 0;
  for (const view of views.values()) for (const touch of view.sessions) {
    if (!holding(touch.lastState)) continue;
    const claims = held.get(touch.sessionId) ?? [];
    claims.push({ issue: { repo: view.repo, number: view.issue, state: touch.lastState!, holder: true }, ts: touch.lastTs, order: order++ });
    held.set(touch.sessionId, claims);
  }
  return { views, latest, held };
}
function joinIssue(row: RosterRow, sessions: string[], input: RosterInputs, registry: RegistryIndex): void {
  const latest = sessions.flatMap(id => registry.latest.get(id) ?? []).sort((a, b) => b.event.ts.localeCompare(a.event.ts) || a.order - b.order)[0]?.event;
  const claims = sessions.flatMap(id => registry.held.get(id) ?? []).sort((a, b) => b.ts.localeCompare(a.ts) || a.order - b.order);
  row[heldClaims] = claims.map(c => c.issue);
  if (claims.length) row.issue = claims[0].issue;
  else if (latest) {
    const touch = registry.views.get(issueKey(latest.repo, latest.issue))?.sessions.find(s => s.sessionId === latest.sessionId);
    row.issue = { repo: latest.repo, number: latest.issue, state: touch?.lastState ?? "unknown", holder: false };
  } else {
    const seed = input.lanes.find(l => l.id === row.lane);
    if (seed?.repo && seed.issue) row.issue = { repo: seed.repo, number: seed.issue, state: "unknown", holder: false };
  }
  if (latest) {
    row.evidence.push("registry"); row.repo ??= latest.repo; row.branch ??= latest.branch ?? null;
  }
}
function rowSessions(row: RosterRow): string[] {
  const sessions = sessionsForRow(row);
  if (sessions.length) row.evidence.push("lease");
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
  const h = row[attributedProcess]?.heartbeat; const heartbeatFresh = heartbeatEvidence(row, h, now);
  if (seed?.retired || parseStatus(line).kind === "closed") return "retired";
  const registered = row.evidence.includes("registration");
  const live = row.pid !== null || row.evidence.includes("lease") || heartbeatFresh || registered;
  const ended = registrationState(row, input);
  if (!live && ended) return ended;
  if (!registered && discoveryUnknown(row, input, heartbeatFresh)) return "unknown";
  if (!live) return seed ? "stopped" : "unknown";
  return activeState(row, line, h, now);
}
interface MessageIndex {
  inbound: Map<string, MessageRef[]>; outbound: Map<string, MessageRef[]>; identities: Set<string>;
}
const messageOrder = (a: MessageRef, b: MessageRef): number => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name);
function indexMessage(index: Map<string, MessageRef[]>, key: string, message: MessageRef): void {
  const latest = index.get(key) ?? [];
  const sameSender = latest.findIndex(m => m.from === message.from);
  if (sameSender >= 0) {
    if (messageOrder(message, latest[sameSender]) >= 0) return;
    latest.splice(sameSender, 1);
  }
  latest.push(message); latest.sort(messageOrder);
  // Two distinct senders suffice to exclude the row's own messages at lookup.
  index.set(key, latest.slice(0, 2));
}
function messageEndpoints(to: string): Set<string> {
  const parts = to.split("-"); const endpoints = new Set([to]);
  // Preserve addressed(): a hyphen-delimited recipient can itself contain hyphens.
  for (let start = 0; start < parts.length; start++) for (let end = start + 1; end <= parts.length; end++) {
    endpoints.add(parts.slice(start, end).join("-"));
  }
  return endpoints;
}
function indexMessages(messages: MessageRef[], now: Date): MessageIndex {
  const index: MessageIndex = { inbound: new Map(), outbound: new Map(), identities: new Set() };
  for (const message of messages) {
    indexMessage(index.outbound, message.from, message);
    for (const to of message.to) for (const endpoint of messageEndpoints(to)) indexMessage(index.inbound, endpoint, message);
    if (message.at.getTime() >= now.getTime() - 14 * 86_400_000) {
      for (const id of [message.from, ...message.to]) index.identities.add(id);
    }
  }
  return index;
}
function lastMessage(messages: MessageRef[], now: Date): RosterRow["lastInbound"] {
  const last = messages.sort(messageOrder)[0];
  return last ? { name: last.name, ageMin: Math.max(0, Math.floor((now.getTime() - last.at.getTime()) / 60000)) } : null;
}
function joinMessages(row: RosterRow, input: RosterInputs, now: Date, index: MessageIndex): void {
  const group = input.lanes.find(l => l.id === row.lane)?.group;
  const recipients = [row.lane, "ALL", input.broadcast, ...(group ? [group] : [])];
  row.lastInbound = lastMessage(recipients.flatMap(id => (index.inbound.get(id) ?? []).filter(m => m.from !== row.lane)), now);
  row.lastOutbound = lastMessage([...(index.outbound.get(row.lane) ?? [])], now);
  if (row.lastInbound || row.lastOutbound) row.evidence.push("messages");
}
function messageRows(rows: RosterRow[], input: RosterInputs, index: MessageIndex): void {
  const reserved = new Set(["", "ALL", "BCAST", input.broadcast, ...input.lanes.flatMap(l => l.group ? [l.group] : [])]);
  const known = new Set(rows.map(r => r.lane));
  for (const id of index.identities) if (!reserved.has(id) && !known.has(id)) {
    const row = emptyRow(id, "message-only"); row.notes.push("identity known only from messages"); rows.push(row); known.add(id);
  }
}
/** Pure join: no process, filesystem or clock access. */
export function buildRoster(input: RosterInputs, now: Date, registry = indexRosterRegistry(input.register.events)): Roster {
  const messages = indexMessages(input.messages, now);
  const attributions = attributeProcesses(input);
  const rows = processRows(input, attributions); messageRows(rows, input, messages);
  for (const row of rows) {
    joinRegistration(row, input);
    if (row.pid !== null) row.evidence.push("process");
    const sessions = rowSessions(row); joinIssue(row, sessions, input, registry);
    row.idleMinutes = input.idle.get(row.worktree ?? "") ?? null;
    row.state = stateOf(row, input, now); joinMessages(row, input, now, messages);
  }
  return { rows: rows.sort((a, b) => a.lane.localeCompare(b.lane)), sources: input.sources };
}
export function repoMatches(repo: string | null | undefined, filter: string): boolean {
  const value = repo?.toLowerCase(); const target = filter.toLowerCase();
  return value === target || !target.includes("/") && value?.split("/").at(-1) === target;
}
function issueMatches(issue: RowIssue | null, selection: NonNullable<Selection["issue"]>): boolean {
  return issue?.number === selection.number && (!selection.repo || repoMatches(issue.repo, selection.repo));
}
export function filterRows(rows: RosterRow[], selection: Selection): RosterRow[] {
  return rows.flatMap(row => {
    if (selection.issue) {
      const issue = [...row[heldClaims] ?? [], ...(row.issue ? [row.issue] : [])].find(i => issueMatches(i, selection.issue!));
      if (!issue) return [];
      row = { ...row, issue, repo: issue.repo };
    }
    return !selection.repo || repoMatches(row.repo, selection.repo) ? [row] : [];
  });
}
function ownershipUnavailable(input: RosterInputs): Suggestion | undefined {
  if ([input.register.sources.registry, input.register.sources.leases].some(s => s.status === "error")) {
    return { target: null, rule: "unverified", reason: "ownership unavailable; verify before assigning" };
  }
}
function liveOwner(rows: RosterRow[], sessionIds: string[]): RosterRow | undefined {
  return rows.find(r => r.identity !== "unregistered" && !["retired", "stopped", "unknown"].includes(r.state)
    && sessionsForRow(r).some(id => sessionIds.includes(id)));
}
function viewSuggestion(view: IssueView, rows: RosterRow[], context: SuggestionContext, unique: boolean): Suggestion | undefined {
  const { input, now, registry } = context;
  const holders = view.sessions.filter(s => holding(s.lastState));
  if (holders.some(s => input.register.liveness.get(s.sessionId)?.status === "unknown")) return { target: null, rule: "unverified", reason: "holder liveness unknown; verify before assigning" };
  const live = holders.filter(s => input.register.liveness.get(s.sessionId)?.status === "live");
  const owner = liveOwner(rows, live.map(s => s.sessionId));
  if (live.length) {
    if (owner && live.length === 1 && unique) return { target: owner.lane, rule: "issue-owner", reason: "live issue holder" };
    return { target: null, rule: "unverified", reason: "holder has no unique matched lane; verify before assigning" };
  }
  const delivered = deliveries({ ...input.register, views: registry.views, key: view.key, now });
  if (delivered.length) return { target: null, rule: "delivered", reason: `${delivered.map(s => short(s.sessionId)).join(", ")}: do not assign; verify` };
  const ownership = ownershipOf({ ...input.register, views: registry.views, view, now });
  if (ownership.verdict === "OWNED") return { target: null, rule: "unverified", reason: ownership.reason };
}
function issueSuggestion(rows: RosterRow[], context: SuggestionContext): Suggestion | undefined {
  const { selection, registry } = context;
  if (!selection.issue) return undefined;
  const views = [...registry.views.values()].filter(v => v.issue === selection.issue!.number
    && (!selection.issue!.repo || repoMatches(v.repo, selection.issue!.repo)) && (!selection.repo || repoMatches(v.repo, selection.repo)));
  for (const view of views) {
    const suggestion = viewSuggestion(view, rows, context, views.length === 1);
    if (suggestion) return suggestion;
  }
}
export function suggestTarget(rows: RosterRow[], input: RosterInputs & { registry?: RegistryIndex }, selection: Selection, now: Date): Suggestion {
  const unavailable = ownershipUnavailable(input); if (unavailable) return unavailable;
  const registry = input.registry ?? indexRosterRegistry(input.register.events);
  const issue = issueSuggestion(rows, { input, selection, now, registry }); if (issue) return issue;
  const repo = selection.repo || selection.issue?.repo;
  const candidates = rows.filter(r => repo && repoMatches(r.repo, repo) && r.state === "idle" && r[attributedProcess] !== undefined && !r.issue?.holder && r.identity !== "unregistered");
  const roleRank = (r: RosterRow) => input.lanes.find(l => l.id === r.lane)?.role === "repo-orch" ? 1 : 0;
  candidates.sort((a, b) => roleRank(a) - roleRank(b) || (b.idleMinutes ?? -1) - (a.idleMinutes ?? -1) || a.lane.localeCompare(b.lane));
  return candidates.length ? { target: candidates[0].lane, rule: "idle-in-repo", reason: "longest idle lane in repository (ties by lane id; workers before repo orchestrator)" }
    : { target: null, rule: "start-lane", reason: `no live lane for ${repo ?? "matching repositories"}` };
}
