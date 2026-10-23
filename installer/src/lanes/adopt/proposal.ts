import { existsSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { expand, laneDir, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { absolute } from "../reap/process.ts";
import type { Discovery } from "./discover.ts";
import { validNewId } from "../names.ts";
import type { Role } from "./roles.ts";

interface MergeOptions { root: string; ctx: LanesCtx; existingConfig: boolean; roles: Map<string, Role> }
interface MergeEnv extends MergeOptions { c: Config }
export function mergeDiscovered(c: Config, rows: Discovery[], options: MergeOptions): void {
  for (const row of rows) {
    if (row.id && !row.excluded) mergeLane(row, { c, ...options });
    row.skipped = blockingWarnings(row).join("; ") || undefined;
  }
}
function mergeLane(row: Discovery, env: MergeEnv): void {
  const { c } = env;
  if (row.id === c.coordinator.id) { mergeCoordinator(row, env); return; }
  const existing = c.lanes.find(l => l.id === row.id);
  if (existing) { compareStored(row, existing, env); return; }
  if (!validNewId(row.id!)) row.warnings.push("unsupported id, rename the lane");
  if (blockingWarnings(row).length) return;
  insertLane(row, env);
}
function mergeCoordinator(row: Discovery, { c, root, ctx, existingConfig }: MergeEnv): void {
  if (existingConfig) {
    const stored = configuredDirectory(expand(c.coordinator.cwd, c, root, ctx.home), ctx);
    compareValue(row, "cwd", stored, row.cwd); return;
  }
  if (blockingWarnings(row).length) return;
  Object.assign(c.coordinator, { cwd: row.cwd, tty: row.tty, sessionId: row.sessionId });
}
function compareStored(row: Discovery, lane: Lane, env: MergeEnv): void {
  const stored = configuredDirectory(laneDir(lane, env.c, env.root, env.ctx), env.ctx);
  compareValue(row, "cwd", stored, row.cwd);
  compareValue(row, "repo", lane.repo, row.repo);
  compareValue(row, "branch", lane.branch, row.branch);
  compareValue(row, "role", lane.role ?? "lane", env.roles.get(lane.id));
}
function blockingWarnings(row: Discovery): string[] {
  return row.warnings.filter(w => !["not a git repo", "detached HEAD", "origin repo unknown"].includes(w));
}
function compareValue(row: Discovery, field: string, stored: string | undefined, found: string | undefined): void {
  if (found !== undefined && stored !== found) row.warnings.push(`conflict: stored ${field} ${stored}, found ${found}`);
}
function insertLane(row: Discovery, env: MergeEnv): void {
  if (directoryConflict(row, env)) { row.warnings.push("conflict: existing lane directory or retired id"); return; }
  if (orchestratorConflict(row, env)) { row.warnings.push("conflict: existing repository orchestrator"); return; }
  env.c.lanes.push(adoptedLane(row, env));
}
function directoryConflict(row: Discovery, { c, root, ctx }: MergeEnv): boolean {
  return c.lanes.filter(l => l.id !== row.id && !l.retired).some(l => configuredDirectory(laneDir(l, c, root, ctx), ctx) === row.cwd);
}
function discoveredRole(row: Discovery, env: MergeEnv): Role {
  return env.roles.get(row.id!) ?? (row.id!.startsWith("R-") ? "repo-orch" : "lane");
}
function orchestratorConflict(row: Discovery, env: MergeEnv): boolean {
  if (discoveredRole(row, env) !== "repo-orch" || !row.repo) return false;
  const others = env.c.lanes.filter(l => !l.retired && l.id !== row.id);
  return others.some(l => l.role === "repo-orch" && l.repo === row.repo);
}
function adoptedLane(row: Discovery, env: MergeEnv): Lane {
  const { c, root, ctx } = env;
  const lane: Lane = { id: row.id!, role: discoveredRole(row, env),
    ...(row.repo ? { repo: row.repo } : {}), ...(row.branch ? { branch: row.branch } : {}),
    worktree: basename(row.cwd), group: null, prompt: `prompts/${row.id}.md` };
  const managed = configuredDirectory(expand(c.worktreesDir, c, root, ctx.home), ctx);
  if (!row.repo || !row.branch) return { ...lane, cwd: row.cwd };
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
  const mapped = active.filter(r => r.id && !r.skipped).length;
  const unmapped = active.filter(r => !r.id).length;
  ctx.out(`found=${active.length} mapped=${mapped} unmapped=${unmapped} conflicts=${active.length - mapped - unmapped} excluded=${rows.length - active.length}`);
  for (const row of rows.filter(r => r.skipped)) ctx.out(`${row.id ?? "?"}\t${row.tty}\tskipped: ${row.skipped}`);
  if (before === after) { ctx.out("lanes.json: no changes"); return; }
  ctx.out("--- lanes.json (existing)\n+++ lanes.json (proposed)");
  ctx.out(`@@ -1,${before ? before.trimEnd().split("\n").length : 0} +1,${after.trimEnd().split("\n").length} @@`);
  if (before) ctx.out(before.trimEnd().split("\n").map(l => `-${l}`).join("\n"));
  ctx.out(after.trimEnd().split("\n").map(l => `+${l}`).join("\n"));
}
