import { join } from "node:path";
import { optionalText, jsonFiles } from "./files.ts";
import type { Claim, EvidenceContext, Signals } from "./signals.ts";
function registry(text: string): Claim[] {
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
  if (claim.sessionId !== s.sessionId || claim.source !== "tool") { s.asks.push("claim from another tool or unmapped session"); return; }
  s.claims.push(claim);
  if (claim.state === "in-progress") { s.keeps.push("in-progress claim"); return; }
  if (readyClaim(claim)) return;
  s.asks.push("claim needs named ready/blocked note or completion evidence");
}
function namedNotes(s: Signals, env: EvidenceContext): void {
  const pattern = new RegExp(`(^|[^A-Z0-9-])${s.id}([^A-Z0-9-]|$)`);
  for (const name of ["NOW.md", "WATCHES.md"]) if (pattern.test(optionalText(join(env.root, "coordinator", name)) || "")) s.asks.push(`named in ${name}`);
}
function assigned(task: Record<string, any>, s: Signals): boolean { return [s.sessionId, s.id].includes(task.assignee) || task.assignee?.sessionId === s.sessionId; }
function openTask(task: Record<string, any>): boolean { return ["claimed", "blocked", "ready"].includes(task.state || task.status); }
function subagentRunning(status: Record<string, any>): boolean { return status.role === "subagent" && !["done", "failed", "cancelled", "stopped"].includes(status.phase || status.state); }
function subagentOwned(status: Record<string, any>, s: Signals): boolean {
  return [status.pid, status.parentPid].includes(s.pid) || [status.sessionId, status.parentSessionId].includes(s.sessionId);
}
function orchestration(s: Signals, env: EvidenceContext): void {
  const { ctx } = env;
  for (const task of jsonFiles(join(ctx.home, ".pi/orch/tasks"))) if (assigned(task, s) && openTask(task)) s.asks.push("assigned pi-orch task requires handoff");
  const statuses = jsonFiles(join(ctx.piAgentDir, "context-budget/status")).filter(subagentRunning);
  for (const status of statuses) { if (subagentOwned(status, s)) s.keeps.push("subagent running"); else s.asks.push("subagent ownership unknown"); }
}
export function claimsAndOwnership(s: Signals, env: EvidenceContext): void {
  const text = optionalText(join(env.ctx.piAgentDir, "issue-work/registry.jsonl"));
  const claims = registry(text || "").filter(claim => claim.repo.toLowerCase() === env.lane.repo.toLowerCase());
  for (const claim of claims) classifyClaim(claim, s);
  namedNotes(s, env); orchestration(s, env);
}

function readyClaim(claim: Claim): boolean {
  if (["done", "in-review"].includes(claim.state || "")) return true;
  return ["blocked", "planned"].includes(claim.state || "") && Boolean(claim.note?.trim());
}
