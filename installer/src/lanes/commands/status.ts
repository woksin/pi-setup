import { existsSync } from "node:fs";
import { backendFor, type MessageRef } from "../backend.ts";
import { expand, effectiveParent, laneDir, laneTree, repoOrchestrator, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { idleMinutes } from "../sessions.ts";
import { runningPi } from "../processes.ts";

interface StatusLane { id: string; repo?: string; branch?: string; group: string | null;
  role: string; parent: string; label: string; cwd: string }
export async function status(c: Config, root: string, ctx: LanesCtx, all = false): Promise<number> {
  const backend = backendFor(c, ctx, root); const processes = await runningPi(ctx);
  const rows = [["LANE", "ROLE", "PARENT", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  for (const lane of statusLanes({ c, root, ctx }, all)) {
    const pid = findPid(lane.cwd, processes, ctx);
    const messages = [
      ...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }),
      ...await backend.list({ from: lane.id, limit: 1 }),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    rows.push([
      lane.label, lane.role, lane.parent, lane.repo ?? "-", lane.branch ?? "-", pid,
      String(idleMinutes(lane.cwd, ctx) ?? "-"), await backend.status(lane.id) || "-",
      lastMessage(messages[0], ctx),
    ]);
  }
  warnMissingOrchestrators(c, ctx);
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  ctx.out(rows.map(r => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  if (all) showClosed(c, ctx);
  return 0;
}
function statusLanes(env: { c: Config; root: string; ctx: LanesCtx }, all: boolean): StatusLane[] {
  const { c, root, ctx } = env;
  return [
    { id: c.coordinator.id, repo: "-", branch: "-", group: null, role: "coord", parent: "-",
      label: c.coordinator.id, cwd: expand(c.coordinator.cwd, c, root, ctx.home) },
    ...laneTree(c, all).filter(({ lane }) => !lane.closed).map(({ lane, depth }) => ({
      ...lane, role: lane.role || "lane", parent: effectiveParent(lane, c), label: "  ".repeat(depth) + lane.id,
      cwd: laneDir(lane, c, root, ctx),
    })),
  ];
}
function showClosed(c: Config, ctx: LanesCtx): void {
  const lanes = c.lanes.filter(lane => lane.closed);
  if (!lanes.length) return;
  ctx.out("closed\nLANE\tREASON\tBY\tTIME");
  for (const lane of lanes) {
    const { reason, by, at } = lane.closed!;
    ctx.out(`${lane.id}\t${reason}\t${by}\t${at}`);
  }
}
function findPid(cwd: string, processes: Awaited<ReturnType<typeof runningPi>>, ctx: LanesCtx): string {
  let pid = "missing";
  if (existsSync(cwd)) {
    try { pid = String(processes.find(p => p.cwd === ctx.realpath(cwd))?.pid || "-"); }
    catch { /* disappeared */ }
  }
  return pid;
}
function lastMessage(last: MessageRef | undefined, ctx: LanesCtx): string {
  return last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 60000))}m)` : "-";
}
function warnMissingOrchestrators(c: Config, ctx: LanesCtx): void {
  const active = c.lanes.filter(l => !l.retired && !l.closed);
  for (const repo of new Set(active.filter(l => l.repo).map(l => l.repo))) {
    const lanes = active.filter(l => l.repo === repo);
    if (lanes.length > 1 && !repoOrchestrator(c, repo)) {
      ctx.err(`warning: ${repo}: ${lanes.length} lanes, no repo-orch`);
    }
  }
}
