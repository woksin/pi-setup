import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LanesCtx } from "../ctx.ts";
import { sessionDirFor } from "../names.ts";
import { jsonFiles, mtime } from "./files.ts";
import { absolute } from "./process.ts";
import type { Signals } from "./model.ts";
function sameProcess(value: Record<string, any>, s: Signals, ctx: LanesCtx): boolean {
  if (value.pid !== s.pid) return false;
  return !value.cwd || absolute(ctx, value.cwd) === s.cwd;
}
function leaseFor(s: Signals, ctx: LanesCtx): Record<string, any> | undefined {
  const leases = jsonFiles(join(ctx.piAgentDir, "issue-work/sessions")).filter(l => l.cwd && sameProcess(l, s, ctx));
  if (!leases.length) return undefined;
  const good = leases.filter(l => l.procStart === s.procStart);
  if (good.length !== 1) throw new Error("lease/process start mismatch"); return good[0];
}
function heartbeatFor(s: Signals, ctx: LanesCtx): Record<string, any> | undefined {
  const beats = jsonFiles(join(ctx.home, ".pi/orch/heartbeats")).filter(h => sameProcess(h, s, ctx));
  if (beats.length > 1) throw new Error("signals disagree: session identity"); return beats[0];
}
function checkHeartbeat(beat: Record<string, any> | undefined, s: Signals, ctx: LanesCtx): void {
  if (!beat) return;
  const stamp = Date.parse(beat.at ?? beat.updatedAt);
  if (!Number.isFinite(stamp) || ctx.now().getTime() - stamp > 600000) throw new Error("signals disagree: heartbeat stale");
  if (beat.state !== "working") return;
  if (ctx.now().getTime() - s.lastWrite! >= 600000) throw new Error("signals disagree: heartbeat working versus session write");
  s.keeps.push("heartbeat working");
}
function fileFor(identity: Record<string, any> | undefined, dir: string): string | undefined {
  if (identity?.sessionFile) return identity.sessionFile;
  if (!identity?.sessionId) return undefined;
  const names = readdirSync(dir).filter(n => n.endsWith(".jsonl") && n.includes(identity.sessionId));
  return names.length === 1 ? join(dir, names[0]) : undefined;
}
function checkFile(s: Signals, dir: string, ctx: LanesCtx): void {
  if (!s.sessionId || !s.sessionFile) throw new Error("session file unknown");
  if (!isAbsolute(s.sessionFile)) throw new Error("session file unknown");
  if (!absolute(ctx, s.sessionFile).startsWith(absolute(ctx, dir) + "/")) throw new Error("session file unknown");
  s.lastWrite = mtime(s.sessionFile);
}
export function resolveSession(s: Signals, ctx: LanesCtx): void {
  const dir = sessionDirFor(s.cwd, ctx.piAgentDir);
  try { readdirSync(dir); } catch { throw new Error("sessions directory unreadable or missing"); }
  const lease = leaseFor(s, ctx); const beat = heartbeatFor(s, ctx);
  checkIdentity(lease, beat);
  const identity = lease || beat; s.sessionId = identity?.sessionId; s.sessionFile = fileFor(identity, dir);
  checkFile(s, dir, ctx); checkHeartbeat(beat, s, ctx);
}

function checkIdentity(lease: Record<string, any> | undefined, beat: Record<string, any> | undefined): void {
  if (!lease || !beat?.sessionId) return;
  if (beat.sessionId !== lease.sessionId) throw new Error("signals disagree: session identity");
}
