import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expand } from "../config.ts";
import { messageTokenMatch, parseMessageName } from "../names.ts";
import { suppressed } from "../status-line.ts";
import { optionalText } from "./files.ts";
import type { EvidenceContext, Signals } from "./signals.ts";

function validMarker(time: number, now: number): boolean { return Number.isFinite(time) && time > 0 && time <= now; }
function markerTime(s: Signals, root: string, dir: string, now: number): number | undefined {
  const times: number[] = [];
  const canonical = join(dir, `${s.id}-inbox.marker`);
  if (existsSync(canonical)) times.push(statSync(canonical).mtimeMs);
  const watcher = join(root, ".state", `inbox-${s.id}.marker`);
  if (existsSync(watcher)) {
    const value = readFileSync(watcher, "utf8").trim();
    times.push(/^\d+$/.test(value) ? Number(value) * 1000 : NaN);
  }
  if (!times.length) { (s.notes ??= []).push("inbox marker missing"); return undefined; }
  if (times.some(time => !validMarker(time, now))) {
    s.asks.push("inbox marker invalid"); return undefined;
  }
  // Conflicting readers cannot prove the newer marker consumed the older reader's mail.
  return Math.min(...times);
}
function addressed(name: string, ids: string[], message: ReturnType<typeof parseMessageName>): boolean {
  if (!message) return ids.some(id => messageTokenMatch(name, id));
  return ids.some(id => message.to.some(to => messageTokenMatch(`${to}.md`, id)));
}
function pendingWithoutWatch(s: Signals, marker: number | undefined): boolean {
  return s.unread.length > 0 && marker === undefined && !s.inboxWatch;
}
function checkMessage(name: string, s: Signals, options: { dir: string; ids: string[]; since: number | undefined }): void {
  if (!name.endsWith(".md")) return;
  const message = parseMessageName(name);
  if (message?.from === s.id) return;
  if (!addressed(name, options.ids, message)) return;
  if (options.since === undefined || statSync(join(options.dir, name)).mtimeMs <= options.since) return;
  if (!message) s.asks.push("message name ambiguous (token match)");
  s.unread.push(name);
}
export function inboxAndStatus(s: Signals, env: EvidenceContext): void {
  const { c, root, ctx, lane } = env; const dir = expand(c.messages.dir, c, root, ctx.home);
  const marker = markerTime(s, root, dir, ctx.now().getTime());
  const since = marker ?? s.lastWrite;
  const ids = [s.id, c.messages.broadcast, "ALL", lane.group].filter((id): id is string => Boolean(id));
  for (const name of existsSync(dir) ? readdirSync(dir) : []) checkMessage(name, s, { dir, ids, since });
  s.keeps.push(...s.unread.map(() => "unread inbox"));
  if (pendingWithoutWatch(s, marker)) s.asks.push("pending inbound; inbox marker and watch evidence missing");
  s.status = optionalText(join(dir, "status", `${s.id}.status`));
  if (suppressed(s.status?.trim(), ctx.now())) s.keeps.push("declared wait until future");
}
