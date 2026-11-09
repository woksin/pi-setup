import { statSync } from "node:fs";
import { join } from "node:path";
import type { MessageRef } from "../backend.ts";
import { expand, UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { buildRoster, readRoster, type RosterRow } from "../roster.ts";
import { humanSources } from "./who.ts";

export const ACK_MINUTES_DEFAULT = 30;
const LOOKBACK_MS = 14 * 86_400_000;
export interface UnackedLanes { rows: RosterRow[]; groups: string[]; broadcast: string }
export interface UnackedRow {
  name: string; from: string; to: string; topic: string; ageMin: number; state: "unread" | "read-no-reply";
  recipient: Pick<RosterRow, "state" | "identity" | "pid">;
}
interface DirectedMessage { message: MessageRef; recipients: string[] }
/** Prefer a known whole ID, then a complete decomposition; ambiguous unknowns stay whole. */
function endpoints(token: string, known: Set<string>): string[] {
  if (known.has(token)) return [token];
  const parts = token.split("-"); const result: string[] = [];
  for (let start = 0; start < parts.length;) {
    let end = parts.length;
    while (end > start && !known.has(parts.slice(start, end).join("-"))) end--;
    if (end === start) return [token];
    result.push(parts.slice(start, end).join("-")); start = end;
  }
  return result;
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
interface Classification { directed: DirectedMessage[]; markers: Map<string, number>; lanes: UnackedLanes; now: Date; minutes: number }
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
  const { directed, now, minutes } = input; const lastSent = lastReplies(directed); const rows: UnackedRow[] = [];
  const roster = new Map(input.lanes.rows.map(row => [row.lane, row]));
  for (const { message, recipients } of directed) {
    const at = message.at.getTime(); const age = now.getTime() - at;
    if (age < minutes * 60000 || age > LOOKBACK_MS) continue;
    for (const to of recipients) {
      if ((lastSent.get(pair(to, message.from)) ?? -Infinity) <= at) rows.push(pendingRow(message, to, age, { marker: input.markers.get(to), recipient: roster.get(to) }));
    }
  }
  const timestamps = new Map(directed.map(({ message }) => [message.name, message.at.getTime()]));
  return rows.sort((a, b) => timestamps.get(a.name)! - timestamps.get(b.name)! || a.name.localeCompare(b.name) || a.to.localeCompare(b.to));
}
/** Pure classification: reply acknowledges; advancing the marker only proves a read. */
export function classifyUnacked(messages: MessageRef[], markers: Map<string, number>, lanes: UnackedLanes, now: Date, minutes: number): UnackedRow[] {
  return classifyDirected({ directed: directedMessages(messages, lanes), markers, lanes, now, minutes });
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
export async function unacked(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (args.length) throw new UsageError("unacked takes no positional arguments");
  const minutes = opts.minutes === undefined ? c.messages.ackMinutes ?? ACK_MINUTES_DEFAULT : Number(opts.minutes);
  const now = ctx.now(); const input = await readRoster(c, root, ctx);
  if (input.sources.messages.status !== "ok") {
    ctx.err(`messages ${input.sources.messages.status}: ${input.sources.messages.detail ?? "unavailable"}`); return 2;
  }
  const roster = buildRoster(input, now);
  const lanes = { rows: roster.rows, groups: c.lanes.flatMap(l => l.group ? [l.group] : []), broadcast: c.messages.broadcast };
  const directed = directedMessages(input.messages, lanes);
  const markers = readMarkers(expand(c.messages.dir, c, root, ctx.home), directed);
  const rows = classifyDirected({ directed, markers, lanes, now, minutes });
  if (opts.json) ctx.out(JSON.stringify({ at: now.toISOString(), minutes, rows, sources: roster.sources }, null, 2));
  else {
    for (const row of rows) ctx.out(humanRow(row, markers));
    humanSources(roster.sources, ctx);
  }
  return rows.length ? 0 : 1;
}
