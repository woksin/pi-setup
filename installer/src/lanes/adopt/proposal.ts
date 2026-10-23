import { existsSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { expand, laneDir, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { absolute } from "../reap/process.ts";
import type { Discovery } from "./discover.ts";

interface MergeEnv { c: Config; root: string; ctx: LanesCtx }
export function mergeDiscovered(c: Config, rows: Discovery[], root: string, ctx: LanesCtx): void {
  for (const row of rows) {
    if (ready(row)) mergeLane(row, { c, root, ctx });
  }
}
function ready(row: Discovery): boolean { return !!row.id && !row.excluded && !row.warnings.length; }
function mergeLane(row: Discovery, env: MergeEnv): void {
  const { c } = env;
  if (row.id === c.coordinator.id) { c.coordinator.cwd = row.cwd; return; }
  const existing = c.lanes.find(l => l.id === row.id);
  if (directoryConflict(row, env) || existing?.retired) { row.warnings.push("conflict: existing lane directory or retired id"); return; }
  if (orchestratorConflict(row, c)) { row.warnings.push("conflict: existing repository orchestrator"); return; }
  const lane = adoptedLane(row, existing, env);
  if (existing) c.lanes[c.lanes.indexOf(existing)] = lane; else c.lanes.push(lane);
}
function directoryConflict(row: Discovery, { c, root, ctx }: MergeEnv): boolean {
  return c.lanes.filter(l => l.id !== row.id && !l.retired).some(l => configuredDirectory(laneDir(l, c, root, ctx), ctx) === row.cwd);
}
function orchestratorConflict(row: Discovery, c: Config): boolean {
  if (!row.id!.startsWith("R-")) return false;
  const others = c.lanes.filter(l => !l.retired && l.id !== row.id);
  return others.some(l => l.role === "repo-orch" && l.repo === row.repo);
}
function adoptedLane(row: Discovery, existing: Lane | undefined, { c, root, ctx }: MergeEnv): Lane {
  const lane: Lane = { ...existing, id: row.id!, repo: row.repo!, branch: row.branch!,
    role: row.id!.startsWith("R-") ? "repo-orch" : "lane",
    worktree: basename(row.cwd), group: existing?.group ?? null, prompt: existing?.prompt ?? `prompts/${row.id}.md` };
  const managed = configuredDirectory(expand(c.worktreesDir, c, root, ctx.home), ctx);
  if (dirname(row.cwd) === managed) { lane.worktree = relative(managed, row.cwd); delete lane.cwd; }
  else lane.cwd = row.cwd;
  return lane;
}
function configuredDirectory(path: string, ctx: LanesCtx): string {
  return existsSync(path) ? absolute(ctx, path) : path;
}
export function missingLanes(c: Config, rows: Discovery[]): string[] {
  const found = new Set(rows.filter(r => !r.excluded).map(r => r.id));
  return [c.coordinator.id, ...c.lanes.map(l => l.id)].filter(id => !found.has(id));
}
interface Proposal { rows: Discovery[]; missing: string[]; before: string; after: string }
export function printProposal({ rows, missing, before, after }: Proposal, ctx: LanesCtx): void {
  ctx.out("LANE\tTTY\tCWD\tSESSION\tID SOURCE\tWARNINGS");
  for (const r of rows) ctx.out([r.id ?? "?", r.tty, r.cwd, r.sessionId ?? "?", r.source ?? "?", r.warnings.join("; ")].join("\t"));
  for (const id of missing) ctx.out(`${id}\t?\t?\t?\t?\tmissing (preserved)`);
  const active = rows.filter(r => !r.excluded);
  const mapped = active.filter(r => r.id && !r.warnings.length).length;
  const unmapped = active.filter(r => !r.id).length;
  ctx.out(`found=${active.length} mapped=${mapped} unmapped=${unmapped} conflicts=${active.length - mapped - unmapped} excluded=${rows.length - active.length}`);
  if (before === after) { ctx.out("lanes.json: no changes"); return; }
  ctx.out("--- lanes.json (existing)\n+++ lanes.json (proposed)");
  ctx.out(`@@ -1,${before ? before.trimEnd().split("\n").length : 0} +1,${after.trimEnd().split("\n").length} @@`);
  if (before) ctx.out(before.trimEnd().split("\n").map(l => `-${l}`).join("\n"));
  ctx.out(after.trimEnd().split("\n").map(l => `+${l}`).join("\n"));
}
