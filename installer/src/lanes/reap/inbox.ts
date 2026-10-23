import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expand } from "../config.ts";
import { messageTokenMatch, parseMessageName } from "../names.ts";
import { suppressed } from "../status-line.ts";
import { optionalText } from "./files.ts";
import type { EvidenceContext, Signals } from "./signals.ts";

function markerTime(s: Signals, root: string, dir: string, now: number): number | undefined {
  const times: number[] = [];
  const canonical = join(dir, `${s.id}-inbox.marker`);
  if (existsSync(canonical)) times.push(statSync(canonical).mtimeMs);
  const watcher = join(root, ".state", `inbox-${s.id}.marker`);
  if (existsSync(watcher)) {
    const value = readFileSync(watcher, "utf8").trim();
    times.push(/^\d+$/.test(value) ? Number(value) * 1000 : NaN);
  }
  if (!times.length) { s.asks.push("inbox watch never ran (marker missing/unreadable)"); return undefined; }
  if (times.some(time => !Number.isFinite(time) || time <= 0 || time > now)) {
    s.asks.push("inbox marker invalid"); return undefined;
  }
  // Conflicting readers cannot prove the newer marker consumed the older reader's mail.
  return Math.min(...times);
}
function checkMessage(name: string, s: Signals, options: { dir: string; ids: string[]; since: number | undefined }): void {
  if (!name.endsWith(".md")) return;
  const message = parseMessageName(name);
  if (message?.from === s.id) return;
  const addressed = message ? options.ids.some(id => message.to.some(to => messageTokenMatch(`${to}.md`, id)))
    : options.ids.some(id => messageTokenMatch(name, id));
  if (!addressed) return;
  if (!message) s.asks.push("message name ambiguous (token match)");
  if (options.since !== undefined && statSync(join(options.dir, name)).mtimeMs > options.since) s.unread.push(name);
}
export function inboxAndStatus(s: Signals, env: EvidenceContext): void {
  const { c, root, ctx, lane } = env; const dir = expand(c.messages.dir, c, root, ctx.home);
  const since = markerTime(s, root, dir, ctx.now().getTime());
  const ids = [s.id, c.messages.broadcast, "ALL", lane.group].filter((id): id is string => Boolean(id));
  for (const name of existsSync(dir) ? readdirSync(dir) : []) checkMessage(name, s, { dir, ids, since });
  if (s.unread.length) s.keeps.push("unread inbox");
  s.status = optionalText(join(dir, "status", `${s.id}.status`));
  if (suppressed(s.status?.trim(), ctx.now())) s.keeps.push("declared wait until future");
}
