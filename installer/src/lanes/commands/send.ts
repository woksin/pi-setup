import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { backendFor } from "../backend.ts";
import { effectiveParent, UsageError, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId, validTopic } from "../names.ts";
import { age, foldRegistry, holding, issueKey, ownershipOf, parseIssue, readIssueRegister, type RegisterData } from "../issue-register.ts";
import { buildRoster, matchedSessions, readRoster, type RosterRow } from "../roster.ts";
export async function send(
  args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx,
): Promise<number> {
  let [to, topic, file] = args;
  const from = validateMessage({ from: opts.from || ctx.env.PI_ORCH_ID, to, topic, file }, opts);
  const known = [c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.flatMap((l) => [l.id, l.group])];
  if (!known.includes(to)) await warnUnknown(to, { c, root, ctx });
  const refusal = await guardIssue(to, opts, { c, root, ctx });
  if (refusal) return refusal;
  let body = await messageBody(file, opts, ctx);
  if (!body.trim()) throw new UsageError("empty message body");
  if (opts.force !== undefined) body = `Ownership override (--force): ${opts.force}\n\n${body}`;
  to = route({ to, from, direct: opts.direct }, c, ctx);
  ctx.out((await backendFor(c, ctx, root).send({ from, to, topic, body })).path);
  return 0;
}

function validateMessage(input: { from?: string; to: string; topic: string; file?: string }, opts: Record<string, string>): string {
  if (!input.from) throw new UsageError("set --from or PI_ORCH_ID");
  if (!validId(input.from)) throw new UsageError("invalid from");
  if (!validId(input.to)) throw new UsageError("invalid to");
  if (!validTopic(input.topic)) throw new UsageError("invalid topic");
  if (opts.m !== undefined && input.file !== undefined) throw new UsageError("choose a file or -m, not both");
  return input.from;
}
async function messageBody(file: string | undefined, opts: Record<string, string>, ctx: LanesCtx): Promise<string> {
  if (opts.m !== undefined) return opts.m;
  if (file && file !== "-") return readFileSync(resolve(ctx.cwd, file), "utf8");
  return file === "-" || !ctx.stdinTTY ? await ctx.readStdin() : "";
}
interface LiveRoster { rows: RosterRow[]; registered: Set<string> }
async function liveRoster({ c, root, ctx }: SendContext): Promise<LiveRoster> {
  try {
    const input = await readRoster(c, root, ctx);
    const registered = new Set(input.registrations?.filter(r => r.alive).map(r => r.id));
    const rows = buildRoster(input, ctx.now()).rows.filter(row => liveCandidate(row, registered));
    return { rows, registered };
  } catch { return { rows: [], registered: new Set() }; }
}
function liveCandidate(row: RosterRow, registered: Set<string>): boolean {
  if (["retired", "stopped", "unknown"].includes(row.state)) return false;
  return row.pid !== null || registered.has(row.lane);
}
function sharedPrefix(a: string, b: string): number {
  let length = 0;
  while (length < Math.min(a.length, b.length) && a[length] === b[length]) length++;
  return length;
}
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) current.push(Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + Number(a[i] !== b[j])));
    previous = current;
  }
  return previous[b.length];
}
function closestLive(to: string, rows: RosterRow[]): string {
  const target = to.toLowerCase();
  const ranked = rows.map(row => ({ row, prefix: sharedPrefix(target, row.lane.toLowerCase()), distance: editDistance(target, row.lane.toLowerCase()) }));
  ranked.sort((a, b) => b.prefix - a.prefix || a.distance - b.distance || Number(b.row.state === "idle") - Number(a.row.state === "idle") || a.row.lane.localeCompare(b.row.lane));
  return ranked.slice(0, 3).map(({ row }) => `${row.lane} [${row.identity}] ${row.repo ?? "-"} ${row.state}`).join(", ");
}
async function warnUnknown(to: string, deps: SendContext): Promise<void> {
  const live = await liveRoster(deps);
  if (live.registered.has(to)) return;
  deps.ctx.err(`warning: unknown recipient ${to}; sending anyway`);
  const candidates = closestLive(to, live.rows);
  if (candidates) deps.ctx.err(`closest live: ${candidates}`);
}
function assignmentRepo(to: string, c: Config): string | undefined {
  const lanes = c.lanes.filter(l => l.id === to && !l.retired && !l.closed);
  return lanes.length === 1 ? lanes[0].repo : undefined;
}
function concreteRecipient(to: string, c: Config): void {
  if (["ALL", "BCAST", c.messages.broadcast, ...c.lanes.map(l => l.group)].includes(to)) {
    throw new UsageError("--issue requires a concrete recipient, not a broadcast or group");
  }
}
interface SendContext { c: Config; root: string; ctx: LanesCtx }
function validateForce(opts: Record<string, string>): void {
  if (opts.force === undefined) return;
  if (opts.issue === undefined || !opts.force.trim()) throw new UsageError("--force requires --issue and a non-blank reason");
}
function unavailableReason(data: RegisterData): string | undefined {
  if (data.sources.registry.status === "error") return `ownership unavailable: ${data.sources.registry.detail ?? "registry read failed"}`;
  if (data.sources.leases.status === "error") return `ownership unavailable: ${data.sources.leases.detail}`;
}
async function guardIssue(to: string, opts: Record<string, string>, deps: SendContext): Promise<number> {
  const { c, ctx } = deps; validateForce(opts);
  if (opts.issue === undefined) return 0;
  concreteRecipient(to, c);
  const issue = parseIssue(opts.issue); const repo = issue.repo ?? assignmentRepo(to, c);
  if (!repo) throw new UsageError("issue needs a repo: use OWNER/REPO#N");
  const data = await readIssueRegister(ctx); const source = data.sources.registry;
  if (source.status === "missing") { ctx.err("issue register not found; ownership not checked"); return forceNote(opts, ctx); }
  const reason = unavailableReason(data) ?? await conflictingOwner(to, { repo, number: issue.number }, deps, data);
  if (!reason) return forceNote(opts, ctx);
  ctx.err(`${repo}#${issue.number}: ${reason}${opts.force === undefined ? "; use lanes who --issue OWNER/REPO#N, choose the holder, or --force <reason>" : ""}`);
  if (opts.force !== undefined) return forceNote(opts, ctx);
  return 3;
}
function forceNote(opts: Record<string, string>, ctx: LanesCtx): number {
  if (opts.force !== undefined) ctx.err(`ownership override (--force): ${opts.force}`);
  return 0;
}
async function recipientSessions(to: string, deps: SendContext, data: RegisterData): Promise<string[]> {
  const input = await readRoster(deps.c, deps.root, deps.ctx, data);
  const recipient = buildRoster(input, deps.ctx.now()).rows.find(r => r.lane === to);
  if (!recipient) return [];
  const pids = input.processes.procs.filter(p => p.cwd && p.cwd === recipient.worktree).map(p => p.pid);
  return matchedSessions(recipient.worktree, pids, data);
}
async function conflictingOwner(to: string, issue: { repo: string; number: number }, deps: SendContext, data: RegisterData): Promise<string | undefined> {
  const view = foldRegistry(data.events).get(issueKey(issue.repo, issue.number));
  const { ctx } = deps;
  const now = ctx.now(); const ownership = ownershipOf({ ...data, view, now });
  if (ownership.verdict === "FREE") return undefined;
  const sessions = await recipientSessions(to, deps, data);
  const conflicts = view!.sessions.filter(s => holding(s.lastState) && data.liveness.has(s.sessionId));
  if (conflicts.length && conflicts.every(s => data.liveness.get(s.sessionId)?.status === "live" && sessions.includes(s.sessionId))) return undefined;
  const details = view!.sessions.map(s => `${s.sessionId}, branch ${s.branch ?? view!.branch ?? "-"}, ${s.lastState ?? view!.state}, ${age(s.lastTs, now)}`).join("; ");
  return `${ownership.reason}; ${details}`;
}

function route(input: { to: string; from: string; direct?: string }, c: Config, ctx: LanesCtx): string {
  const sender = c.lanes.find(l => l.id === input.from && !l.retired);
  if (!routeToParent(input, sender, c)) return input.to;
  const parent = effectiveParent(sender!, c);
  if (parent !== input.to) {
    const relationship = sender!.repo ? `repo orchestrator of ${sender!.repo}` : `parent of ${sender!.id}`;
    ctx.err(`routed to ${parent} (${relationship}); --direct to bypass`);
    return parent;
  }
  return input.to;
}
function routeToParent(input: { to: string; direct?: string }, sender: Lane | undefined, c: Config): boolean {
  if (input.direct || input.to !== c.coordinator.id) return false;
  return Boolean(sender && sender.role !== "repo-orch");
}
