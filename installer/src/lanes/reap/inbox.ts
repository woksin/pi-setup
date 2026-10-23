import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expand } from "../config.ts";
import { parseMessageName } from "../names.ts";
import { suppressed } from "../status-line.ts";
import { optionalText, mtime } from "./files.ts";
import type { EvidenceContext, Signals } from "./signals.ts";
function isAddressed(to: string[], ids: (string | null)[]): boolean {
  return ids.filter(Boolean).some(id => to.some(recipient => recipient === id || (`-${recipient}-`).includes(`-${id}-`)));
}
function checkMessage(name: string, s: Signals, options: { dir: string; ids: (string | null)[]; since: number }): void {
  if (!name.endsWith(".md")) return;
  const message = parseMessageName(name); if (!message) { s.asks.push(`unparseable message ${name}`); return; }
  if (message.from === s.id || !isAddressed(message.to, options.ids)) return;
  if (mtime(join(options.dir, name)) > options.since) s.unread.push(name);
}
export function inboxAndStatus(s: Signals, env: EvidenceContext): void {
  const { c, root, ctx, lane } = env; const dir = expand(c.messages.dir, c, root, ctx.home);
  let since: number;
  try { since = mtime(join(dir, `${s.id}-inbox.marker`)); } catch { s.asks.push("inbox watch never ran (marker missing/unreadable)"); return; }
  const ids = [s.id, c.messages.broadcast, "ALL", lane.group];
  for (const name of readdirSync(dir)) checkMessage(name, s, { dir, ids, since });
  if (s.unread.length) s.keeps.push("unread inbox");
  s.status = optionalText(join(dir, "status", `${s.id}.status`));
  if (suppressed(s.status?.trim(), ctx.now())) s.keeps.push("declared wait until future");
}
