import { existsSync } from "node:fs";
import { join } from "node:path";
import { backendFor, type MessageRef } from "../backend.ts";
import { expand, effectiveParent, laneTree, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { idleMinutes } from "../sessions.ts";
import { runningPi } from "../processes.ts";

interface StatusLane { id: string; repo: string; branch: string; group: string | null;
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
      lane.label, lane.role, lane.parent, lane.repo, lane.branch, pid,
      String(idleMinutes(lane.cwd, ctx) ?? "-"), await backend.status(lane.id) || "-",
      lastMessage(messages[0], ctx),
    ]);
  }
  warnMissingOrchestrators(c, ctx);
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  ctx.out(rows.map(r => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  return 0;
}
function statusLanes(env: { c: Config; root: string; ctx: LanesCtx }, all: boolean): StatusLane[] {
  const { c, root, ctx } = env;
  return [
    { id: c.coordinator.id, repo: "-", branch: "-", group: null, role: "coord", parent: "-",
      label: c.coordinator.id, cwd: expand(c.coordinator.cwd, c, root, ctx.home) },
    ...laneTree(c, all).map(({ lane, depth }) => ({
      ...lane, role: lane.role || "lane", parent: effectiveParent(lane, c), label: "  ".repeat(depth) + lane.id,
      cwd: join(expand(c.worktreesDir, c, root, ctx.home), lane.worktree),
    })),
  ];
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
  for (const repo of new Set(c.lanes.filter(l => !l.retired).map(l => l.repo))) {
    const lanes = c.lanes.filter(l => !l.retired && l.repo === repo);
    if (lanes.length > 1 && !lanes.some(l => l.role === "repo-orch")) {
      ctx.err(`warning: ${repo}: ${lanes.length} lanes, no repo-orch`);
    }
  }
}
