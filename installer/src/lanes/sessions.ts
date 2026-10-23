import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expand, laneDir, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { sessionDirFor } from "./names.ts";
import { runningPi } from "./processes.ts";
export function laneTarget(id: string, c: Config, root: string, ctx: LanesCtx) {
  const coordinator = id === "coordinator" || id === c.coordinator.id;
  const lane = c.lanes.find((l) => l.id === id);
  if (!coordinator && !lane) throw new Error(`lane not found: ${id}`);
  const cwd = coordinator ? expand(c.coordinator.cwd, c, root, ctx.home) : laneDir(lane!, c, root, ctx);
  return { id: coordinator ? c.coordinator.id : id, cwd, coordinator, lane };
}
export function idleMinutes(cwd: string, ctx: LanesCtx): number | undefined {
  try {
    const dir = sessionDirFor(cwd, ctx.piAgentDir);
    const times = readdirSync(dir).map((n) => statSync(join(dir, n))).filter((s) => s.isFile()).map((s) => s.mtimeMs);
    return times.length ? Math.max(0, Math.floor((ctx.now().getTime() - Math.max(...times)) / 60000)) : undefined;
  } catch { return undefined; }
}
export async function piIn(cwd: string, ctx: LanesCtx): Promise<number | undefined> {
  const processes = await runningPi(ctx);
  try { return processes.find((p) => p.cwd === ctx.realpath(cwd))?.pid; } catch { return undefined; }
}
