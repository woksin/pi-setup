import { join } from "node:path";
import { effectiveParent, laneDir } from "../config.ts";
import { optionalText } from "./files.ts";
import { gitEvidence } from "./git.ts";
import { absolute, processEvidence, processIds } from "./process.ts";
import { resolveSession } from "./session.ts";
import { inboxAndStatus } from "./inbox.ts";
import { claimsAndOwnership } from "./ownership.ts";
import type { Config, Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import type { GitEvidence } from "./git.ts";
import type { DecisionSignals } from "./verdict.ts";
export interface Claim {
  repo: string; issue: number; sessionId: string; cwd?: string; source: string;
  state?: string; note?: string; pr?: string; branch?: string; worktree?: string;
}
export interface Signals extends DecisionSignals {
  id: string; cwd: string; pid?: number; pids: number[]; sessionId?: string; sessionFile?: string;
  lastWrite?: number; procStart?: string; tty?: string;
  claims: Claim[]; git: GitEvidence; unread: string[]; status?: string; notes?: string[]; inboxWatch?: boolean; inboxAliases?: string[];
}
export interface EvidenceContext { c: Config; lane: Lane; root: string; ctx: LanesCtx; minutes: number }
export type CommandEnv = Pick<EvidenceContext, "c" | "root" | "ctx">;

function snooze(s: Signals, env: EvidenceContext): void {
  const text = optionalText(join(env.root, ".state/snooze", s.id)); if (text === undefined) return;
  const until = Date.parse(text.trim()); if (!Number.isFinite(until)) throw new Error("cannot read snooze");
  if (until > env.ctx.now().getTime()) s.keeps.push("snoozed");
}
function idle(s: Signals, env: EvidenceContext): void {
  if (env.ctx.now().getTime() - s.lastWrite! < env.minutes * 60000) {
    s.keeps.push(`recent write (< ${env.minutes} minutes)`);
  }
}
export async function collect(env: EvidenceContext): Promise<Signals> {
  const { c, lane, root, ctx } = env;
  const s: Signals = { id: lane.id, cwd: "", asks: [], keeps: [], finished: false, takeover: false,
    pids: [], claims: [], git: {}, unread: [] };
  const protectedReason = callerProtection(env);
  if (protectedReason) { s.keeps.push(protectedReason); return s; }
  try {
    s.cwd = worktreePath(env);
    s.pids = await processIds(ctx, s.cwd);
    if (!s.pids.length) { s.keeps.push("not running"); return s; }
    if (s.pids.length !== 1) { s.asks.push("shared cwd"); return s; }
    s.pid = s.pids[0]; await processEvidence(s, ctx); await resolveSession(s, ctx);
    idle(s, env); snooze(s, env); inboxAndStatus(s, env); claimsAndOwnership(s, env);
    s.git = await gitEvidence(ctx, lane, s.cwd); if (s.git.error) s.asks.push(s.git.error);
    // File messages cannot prove delivery acknowledgement or candidate ownership.
  } catch (e) { s.asks.push((e as Error).message); }
  return s;
}

function worktreePath({ lane, c, root, ctx }: EvidenceContext): string {
  const path = laneDir(lane, c, root, ctx);
  try { return absolute(ctx, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`worktree gone: ${path}`);
    throw error;
  }
}
function callerProtection({ ctx, lane, c }: EvidenceContext): string | undefined {
  const id = ctx.env.PI_ORCH_ID;
  if (lane.id === id) return "caller";
  const caller = c.lanes.find(l => l.id === id);
  if (caller && effectiveParent(caller, c) === lane.id) return "caller's parent";
  return undefined;
}
