import { existsSync } from "node:fs";
import { join } from "node:path";
import { backendFor } from "../backend.ts";
import { expand, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { idleMinutes } from "../sessions.ts";
import { runningPi } from "../processes.ts";
export async function status(c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const backend = backendFor(c, ctx, root); const processes = await runningPi(ctx);
  const rows = [["LANE", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  const lanes = [{ id: c.coordinator.id, repo: "-", branch: "-", group: null, cwd: expand(c.coordinator.cwd, c, root, ctx.home) }, ...c.lanes.map((l) => ({ ...l, cwd: join(expand(c.worktreesDir, c, root, ctx.home), l.worktree) }))];
  for (const lane of lanes) {
    let pid = "missing";
    if (existsSync(lane.cwd)) { try { pid = String(processes.find((p) => p.cwd === ctx.realpath(lane.cwd))?.pid || "-"); } catch { /* disappeared */ } }
    const messages = [...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }), ...await backend.list({ from: lane.id, limit: 1 })].sort((a, b) => b.at.getTime() - a.at.getTime());
    const last = messages[0];
    rows.push([lane.id, lane.repo, lane.branch, pid, String(idleMinutes(lane.cwd, ctx) ?? "-"), await backend.status(lane.id) || "-", last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 60000))}m)` : "-"]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  ctx.out(rows.map((r) => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  return 0;
}
