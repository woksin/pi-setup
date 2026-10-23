import { basename, join } from "node:path";
import type { LanesCtx } from "../ctx.ts";
import { validId } from "../names.ts";
import { runningPi, ttyOf } from "../processes.ts";
import { optionalText } from "../reap/files.ts";
import { absolute, processStart } from "../reap/process.ts";
import { resolveAdoptSession } from "../reap/session.ts";
import type { Signals } from "../reap/signals.ts";
import type { InventoryEntry } from "./inventory.ts";

export interface Discovery {
  pid: number; tty: string; cwd: string; sessionId?: string; id?: string;
  source?: string; repo?: string; branch?: string; warnings: string[]; excluded?: boolean; skipped?: string;
}
interface Identity { lane: string; sessionId: string }
export async function discover(ctx: LanesCtx, entries: InventoryEntry[], excluded: string[], coordinatorId?: string): Promise<Discovery[]> {
  const rows: Discovery[] = [];
  for (const p of await runningPi(ctx)) {
    const row: Discovery = { pid: p.pid, tty: await ttyOf(ctx, p.pid) ?? "?", cwd: absolute(ctx, p.cwd), warnings: [] };
    rows.push(row);
    if (excluded.includes(row.tty)) { row.excluded = true; row.warnings.push("excluded"); continue; }
    await inspect(row, entries, ctx, coordinatorId);
    warnId(row);
  }
  markDuplicates(rows, "id", "duplicate id");
  markDuplicates(rows, "cwd", "two lanes in one cwd");
  markDuplicates(rows, "sessionId", "duplicate session identity");
  return rows;
}
async function inspect(row: Discovery, entries: InventoryEntry[], ctx: LanesCtx, coordinatorId?: string): Promise<void> {
  try { await identify(row, entries, ctx); if (row.id !== coordinatorId) await gitIdentity(row, ctx); }
  catch (e) { row.warnings.push((e as Error).message); }
}
function warnId(row: Discovery): void {
  if (!row.id) row.warnings.push("unmapped");
  else if (!validId(row.id) || row.id === "ALL") row.warnings.push("unsupported id, rename the lane");
}
async function gitIdentity(row: Discovery, ctx: LanesCtx): Promise<void> {
  const remote = await ctx.run("git", ["-C", row.cwd, "remote", "get-url", "origin"], { timeoutMs: 5000 });
  const branch = await ctx.run("git", ["-C", row.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5000 });
  row.repo = remote.code === 0 ? repoName(remote.stdout.trim()) : undefined;
  discoverBranch(row, branch);
  if (row.branch && !row.repo) row.warnings.push("origin repo unknown");
}
function discoverBranch(row: Discovery, probe: Awaited<ReturnType<LanesCtx["run"]>>): void {
  const branch = probe.stdout.trim();
  if (!validGitBranch(probe)) { row.warnings.push("not a git repo"); return; }
  if (branch === "HEAD") { row.warnings.push("detached HEAD"); return; }
  row.branch = branch;
}
function validGitBranch(probe: Awaited<ReturnType<LanesCtx["run"]>>): boolean {
  return probe.code === 0 && !probe.timedOut && !!probe.stdout.trim();
}
async function identify(row: Discovery, entries: InventoryEntry[], ctx: LanesCtx): Promise<void> {
  const signals = { cwd: row.cwd, pid: row.pid, procStart: await processStart(row.pid, ctx) } as Signals;
  resolveAdoptSession(signals, ctx); row.sessionId = signals.sessionId;
  const map = identityMap(row.sessionId!, ctx);
  const candidates = entries.filter(e => e.tty === row.tty);
  if (candidates.some(e => ![row.cwd, basename(row.cwd)].includes(e.worktree))) throw new Error("conflict: inventory worktree differs from cwd");
  applyInventory(row, map, candidates);
}
function identityMap(sessionId: string, ctx: LanesCtx): Identity | undefined {
  const text = optionalText(join(ctx.piAgentDir, "user-questions/lanes", `${sessionId}.json`));
  if (text === undefined) return undefined;
  const map = JSON.parse(text);
  if (!validIdentity(map, sessionId)) throw new Error("conflict: invalid lane identity map");
  return map;
}
function validIdentity(map: Identity, sessionId: string): boolean {
  return map && map.sessionId === sessionId && typeof map.lane === "string" && !!map.lane;
}
function applyInventory(row: Discovery, map: Identity | undefined, candidates: InventoryEntry[]): void {
  const ids = [...new Set(candidates.map(e => e.id))];
  row.id = map?.lane; row.source = map ? "identity map" : undefined;
  const disagreement = map ? ids.some(id => id !== map.lane) : false;
  if (ids.length > 1 || disagreement) { row.warnings.push("conflict: inventory and identity map disagree"); return; }
  if (!map && ids.length === 1) { row.id = ids[0]; row.source = "inventory"; }
}
function markDuplicates(rows: Discovery[], field: "id" | "cwd" | "sessionId", warning: string): void {
  const active = rows.filter(r => !r.excluded && r[field]);
  for (const row of active) if (active.filter(other => other[field] === row[field]).length > 1) row.warnings.push(warning);
}
function repoName(remote: string): string | undefined {
  const match = /(?:[:/])([^/:\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  return match?.[1];
}
