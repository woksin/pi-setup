import { join } from "node:path";
import { subagents } from "./subagents.ts";
import { localClaims } from "./local-claims.ts";
import { optionalText, jsonFiles } from "./files.ts";
import type { Lane } from "../config.ts";
import type { Claim, EvidenceContext, Signals } from "./signals.ts";
export function registry(text: string): Claim[] {
  const folded = new Map<string, Claim>();
  for (const line of text.split("\n").filter(l => l.trim())) {
    let ev: Claim; try { ev = JSON.parse(line); } catch { throw new Error("cannot read issue-work registry"); }
    if (!validEvent(ev)) throw new Error("cannot read issue-work registry");
    const key = `${ev.repo.toLowerCase()}#${ev.issue}`; folded.set(key, { ...folded.get(key), ...ev });
  }
  return [...folded.values()];
}
function validEvent(ev: Claim): boolean { return Boolean(ev?.repo && Number.isInteger(ev.issue) && ev.sessionId && ev.source); }
function classifyClaim(claim: Claim, s: Signals): void {
  s.claims.push(claim);
  if (activeUnnoted(claim)) { s.keeps.push("in-progress claim"); return; }
  if (readyClaim(claim)) return;
  s.asks.push("claim needs named ready/blocked note or completion evidence");
}
function namedNotes(s: Signals, env: EvidenceContext): void {
  const pattern = new RegExp(`(^|[^A-Z0-9-])${s.id}([^A-Z0-9-]|$)`);
  for (const name of ["NOW.md", "WATCHES.md"]) if (pattern.test(optionalText(join(env.root, "coordinator", name)) || "")) s.asks.push(`named in ${name}`);
}
function assigned(task: Record<string, any>, s: Signals): boolean { return [s.sessionId, s.id].includes(task.assignee) || task.assignee?.sessionId === s.sessionId; }
function openTask(task: Record<string, any>): boolean { return ["claimed", "blocked", "ready"].includes(task.state || task.status); }
function orchestration(s: Signals, env: EvidenceContext): void {
  const { ctx } = env;
  for (const task of jsonFiles(join(ctx.home, ".pi/orch/tasks"))) if (assigned(task, s) && openTask(task)) s.asks.push("assigned pi-orch task requires handoff");
}
export function claimMapsToLane(claim: Claim, s: Signals, lane: Lane): boolean {
  if (lane.repo && claim.repo.toLowerCase() !== lane.repo.toLowerCase()) return false;
  return claim.sessionId === s.sessionId || claim.cwd === s.cwd || claim.worktree === s.cwd
    || Boolean(claim.branch && claim.branch === lane.branch);
}
export async function claimsAndOwnership(s: Signals, env: EvidenceContext): Promise<void> {
  const text = optionalText(join(env.ctx.piAgentDir, "issue-work/registry.jsonl"));
  const claims = registry(text || "").filter(claim => claimMapsToLane(claim, s, env.lane));
  for (const claim of claims) classifyClaim(claim, s);
  localClaims(s, env); namedNotes(s, env); orchestration(s, env); await subagents(s, env.ctx);
}

function readyClaim(claim: Claim): boolean {
  if (["done", "in-review"].includes(claim.state || "")) return true;
  return ["blocked", "planned", "paused", "in-progress"].includes(claim.state || "") && Boolean(claim.note?.trim());
}

function activeUnnoted(claim: Claim): boolean {
  return claim.state === "in-progress" && !claim.note?.trim();
}
