import { existsSync } from "node:fs";
import { join } from "node:path";
import { backendFor } from "../backend.ts";
import { expand, effectiveParent, laneTree, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { idleMinutes } from "../sessions.ts";
import { runningPi } from "../processes.ts";
export async function status(c: Config, root: string, ctx: LanesCtx, all = false): Promise<number> {
  const backend = backendFor(c, ctx, root); const processes = await runningPi(ctx);
  const rows = [["LANE", "ROLE", "PARENT", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  const lanes = [{ id: c.coordinator.id, repo: "-", branch: "-", group: null, role: "coord", parent: "-", label: c.coordinator.id, cwd: expand(c.coordinator.cwd, c, root, ctx.home) }, ...laneTree(c, all).map(({ lane: l, depth }) => ({ ...l, role: l.role || "lane", parent: effectiveParent(l, c), label: "  ".repeat(depth) + l.id, cwd: join(expand(c.worktreesDir, c, root, ctx.home), l.worktree) }))];
  for (const lane of lanes) {
    let pid = "missing";
    if (existsSync(lane.cwd)) { try { pid = String(processes.find((p) => p.cwd === ctx.realpath(lane.cwd))?.pid || "-"); } catch { /* disappeared */ } }
    const messages = [...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }), ...await backend.list({ from: lane.id, limit: 1 })].sort((a, b) => b.at.getTime() - a.at.getTime());
    const last = messages[0];
    rows.push([lane.label, lane.role, lane.parent, lane.repo, lane.branch, pid, String(idleMinutes(lane.cwd, ctx) ?? "-"), await backend.status(lane.id) || "-", last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 60000))}m)` : "-"]);
  }
  for (const repo of new Set(c.lanes.filter(l => !l.retired).map(l => l.repo))) {
    const lanes = c.lanes.filter(l => !l.retired && l.repo === repo);
    if (lanes.length > 1 && !lanes.some(l => l.role === "repo-orch")) ctx.err(`warning: ${repo}: ${lanes.length} lanes, no repo-orch`);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  ctx.out(rows.map((r) => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  return 0;
}
