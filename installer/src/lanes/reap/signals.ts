import { join } from "node:path";
import { expand } from "../config.ts";
import { optionalText } from "./files.ts";
import { gitEvidence } from "./git.ts";
import { absolute, processEvidence, processIds } from "./process.ts";
import { resolveSession } from "./session.ts";
import { inboxAndStatus } from "./inbox.ts";
import { claimsAndOwnership } from "./ownership.ts";
import type { EvidenceContext, Signals } from "./model.ts";
export type { EvidenceContext, Signals } from "./model.ts";
function snooze(s: Signals, env: EvidenceContext): void {
  const text = optionalText(join(env.root, ".state/snooze", s.id)); if (text === undefined) return;
  const until = Date.parse(text.trim()); if (!Number.isFinite(until)) throw new Error("cannot read snooze");
  if (until > env.ctx.now().getTime()) s.keeps.push("snoozed");
}
function idle(s: Signals, env: EvidenceContext): void {
  if (env.ctx.now().getTime() - s.lastWrite! < env.minutes * 60000) s.keeps.push(`recent write (< ${env.minutes} minutes)`);
}
export async function collect(env: EvidenceContext): Promise<Signals> {
  const { c, lane, root, ctx } = env;
  const s: Signals = { id: lane.id, cwd: "", asks: [], keeps: [], finished: false, takeover: false, pids: [], claims: [], git: {}, unread: [] };
  try {
    s.cwd = absolute(ctx, join(expand(c.worktreesDir, c, root, ctx.home), lane.worktree)); s.pids = await processIds(ctx, s.cwd);
    if (!s.pids.length) { s.keeps.push("not running"); return s; }
    if (s.pids.length !== 1) { s.asks.push("shared cwd"); return s; }
    s.pid = s.pids[0]; await processEvidence(s, ctx); resolveSession(s, ctx);
    idle(s, env); snooze(s, env); inboxAndStatus(s, env); claimsAndOwnership(s, env);
    s.git = await gitEvidence(ctx, lane, s.cwd); if (s.git.error) s.asks.push(s.git.error);
    // File messages cannot prove delivery acknowledgement or candidate ownership.
  } catch (e) { s.asks.push((e as Error).message); }
  return s;
}
