import { statSync } from "node:fs";
import { join } from "node:path";
import type { MessageRef } from "../backend.ts";
import { expand, UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { buildRoster, readRoster, type RosterRow } from "../roster.ts";
import { humanSources } from "./who.ts";

export const ACK_MINUTES_DEFAULT = 30;
export const ACK_LOOKBACK_HOURS_DEFAULT = 24;
const HUMAN_MESSAGE_LIMIT = 20;
export interface UnackedLanes { rows: RosterRow[]; groups: string[]; broadcast: string }
export interface UnackedRow {
  name: string; from: string; to: string; topic: string; ageMin: number; state: "unread" | "read-no-reply";
  recipient: Pick<RosterRow, "state" | "identity" | "pid">;
}
interface DirectedMessage { message: MessageRef; recipients: string[] }
/** Prefer a known whole ID, then a complete decomposition; ambiguous unknowns stay whole. */
function endpoints(token: string, known: Set<string>): string[] {
  if (known.has(token)) return [token];
  const parts = token.split("-"); const memo = new Map<number, string[] | null>();
  function split(start: number): string[] | null {
    if (start === parts.length) return [];
    if (memo.has(start)) return memo.get(start)!;
    for (let end = parts.length; end > start; end--) {
      const id = parts.slice(start, end).join("-"); if (!known.has(id)) continue;
      const rest = split(end); if (rest === null) continue;
      const result = [id, ...rest]; memo.set(start, result); return result;
    }
    memo.set(start, null); return null;
  }
  return split(0) ?? [token];
}
function directedMessages(messages: MessageRef[], lanes: UnackedLanes): DirectedMessage[] {
  const reserved = new Set(["", "ALL", "BCAST", lanes.broadcast, ...lanes.groups]);
  const known = new Set([...lanes.rows.filter(r => r.identity !== "message-only").map(r => r.lane), ...messages.map(m => m.from), ...reserved]);
  const cache = new Map<string, string[]>();
  const recipients = (token: string) => {
    if (!cache.has(token)) cache.set(token, endpoints(token, known).filter(id => !reserved.has(id)));
    return cache.get(token)!;
  };
  return messages.filter(m => !reserved.has(m.from)).map(message => ({ message,
    recipients: [...new Set(message.to.flatMap(recipients))].filter(id => id !== message.from) }));
}
const pair = (from: string, to: string): string => `${from}\0${to}`;
interface Classification { directed: DirectedMessage[]; markers: Map<string, number>; lanes: UnackedLanes; now: Date; minutes: number; hours: number }
function lastReplies(directed: DirectedMessage[]): Map<string, number> {
  const lastSent = new Map<string, number>();
  for (const { message, recipients } of directed) for (const to of recipients) {
    const key = pair(message.from, to); lastSent.set(key, Math.max(lastSent.get(key) ?? -Infinity, message.at.getTime()));
  }
  return lastSent;
}
function recipientState(row: RosterRow | undefined): UnackedRow["recipient"] {
  return { state: row?.state ?? "unknown", identity: row?.identity ?? "message-only", pid: row?.pid ?? null };
}
function pendingRow(message: MessageRef, to: string, age: number, evidence: { marker?: number; recipient?: RosterRow }): UnackedRow {
  return { name: message.name, from: message.from, to, topic: message.topic, ageMin: Math.floor(age / 60000),
    state: (evidence.marker ?? -Infinity) > message.at.getTime() ? "read-no-reply" : "unread",
    recipient: recipientState(evidence.recipient) };
}
function classifyDirected(input: Classification): UnackedRow[] {
  const { directed, now, minutes, hours } = input; const lastSent = lastReplies(directed); const rows: UnackedRow[] = [];
  const roster = new Map(input.lanes.rows.map(row => [row.lane, row]));
  for (const { message, recipients } of directed) {
    const at = message.at.getTime(); const age = now.getTime() - at;
    if (age < minutes * 60000 || age > hours * 3600000) continue;
    for (const to of recipients) {
      if ((lastSent.get(pair(to, message.from)) ?? -Infinity) <= at) rows.push(pendingRow(message, to, age, { marker: input.markers.get(to), recipient: roster.get(to) }));
    }
  }
  const timestamps = new Map(directed.map(({ message }) => [message.name, message.at.getTime()]));
  return rows.sort((a, b) => timestamps.get(a.name)! - timestamps.get(b.name)! || a.name.localeCompare(b.name) || a.to.localeCompare(b.to));
}
/** Pure classification: reply acknowledges; advancing the marker only proves a read. */
export function classifyUnacked(messages: MessageRef[], markers: Map<string, number>, lanes: UnackedLanes, now: Date, minutes: number, hours = ACK_LOOKBACK_HOURS_DEFAULT): UnackedRow[] {
  return classifyDirected({ directed: directedMessages(messages, lanes), markers, lanes, now, minutes, hours });
}
function readMarkers(dir: string, directed: DirectedMessage[]): Map<string, number> {
  const markers = new Map<string, number>();
  for (const id of new Set(directed.flatMap(m => m.recipients))) {
    try {
      const stat = statSync(join(dir, `${id}-inbox.marker`));
      if (!stat.isFile()) throw new Error(`invalid inbox marker for ${id}`);
      markers.set(id, stat.mtimeMs);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return markers;
}
function humanRow(row: UnackedRow, markers: Map<string, number>): string {
  const recipient = `${row.recipient.state}(${row.recipient.pid ?? "-"})`;
  return `${row.ageMin}m  ${row.from}->${row.to} ${row.topic} ${row.state} recipient=${recipient}${markers.has(row.to) ? "" : " (no marker)"}`;
}
interface RecipientSummary { recipient: string; state: string; unread: number; readNoReply: number; oldest: number }
function recipientSummaries(rows: UnackedRow[]): RecipientSummary[] {
  const summaries = new Map<string, RecipientSummary>();
  for (const row of rows) {
    const summary = summaries.get(row.to) ?? { recipient: row.to, state: row.recipient.state, unread: 0, readNoReply: 0, oldest: 0 };
    if (row.state === "unread") summary.unread++; else summary.readNoReply++;
    summary.oldest = Math.max(summary.oldest, row.ageMin); summaries.set(row.to, summary);
  }
  return [...summaries.values()].sort((a, b) => b.oldest - a.oldest || a.recipient.localeCompare(b.recipient));
}
function humanReport(rows: UnackedRow[], markers: Map<string, number>, ctx: LanesCtx): void {
  for (const summary of recipientSummaries(rows)) {
    ctx.out(`recipient=${summary.recipient} state=${summary.state} unread=${summary.unread} read-no-reply=${summary.readNoReply} oldest=${summary.oldest}m`);
  }
  for (const row of rows.slice(0, HUMAN_MESSAGE_LIMIT)) ctx.out(humanRow(row, markers));
  if (rows.length > HUMAN_MESSAGE_LIMIT) ctx.out(`${rows.length - HUMAN_MESSAGE_LIMIT} message rows omitted; use --json to see all ${rows.length}.`);
}
function selectRecipients(rows: UnackedRow[], includeRetired: boolean): { rows: UnackedRow[]; excluded: { retired: number } } {
  const selected = includeRetired ? rows : rows.filter(row => !["retired", "closed"].includes(row.recipient.state));
  return { rows: selected, excluded: { retired: rows.length - selected.length } };
}
export async function unacked(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (args.length) throw new UsageError("unacked takes no positional arguments");
  const minutes = opts.minutes === undefined ? c.messages.ackMinutes ?? ACK_MINUTES_DEFAULT : Number(opts.minutes);
  const hours = opts.hours === undefined ? c.messages.ackLookbackHours ?? ACK_LOOKBACK_HOURS_DEFAULT : Number(opts.hours);
  const now = ctx.now(); const input = await readRoster(c, root, ctx);
  if (input.sources.messages.status !== "ok") {
    ctx.err(`messages ${input.sources.messages.status}: ${input.sources.messages.detail ?? "unavailable"}`); return 2;
  }
  const roster = buildRoster(input, now);
  const lanes = { rows: roster.rows, groups: c.lanes.flatMap(l => l.group ? [l.group] : []), broadcast: c.messages.broadcast };
  const directed = directedMessages(input.messages, lanes);
  const markers = readMarkers(expand(c.messages.dir, c, root, ctx.home), directed);
  const { rows, excluded } = selectRecipients(classifyDirected({ directed, markers, lanes, now, minutes, hours }), Boolean(opts["include-retired"]));
  if (opts.json) ctx.out(JSON.stringify({ at: now.toISOString(), minutes, hours, rows, excluded, sources: roster.sources }, null, 2));
  else {
    humanReport(rows, markers, ctx);
    humanSources(roster.sources, ctx);
  }
  return rows.length ? 0 : 1;
}
