import { backendFor } from "../backend.ts";
import type { Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { descendants } from "../processes.ts";
import { idleMinutes, laneTarget, piIn } from "../sessions.ts";
import { parseStatus, suppressed } from "../status-line.ts";
export async function idleCheck(opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const backend = backendFor(c, ctx, root); const silent: string[] = [];
  for (const lane of c.lanes) {
    const line = await backend.status(lane.id);
    if (parseStatus(line).kind === "closed" || suppressed(line, ctx.now())) continue;
    const { cwd } = laneTarget(lane.id, c, root, ctx); const pid = await piIn(cwd, ctx);
    if (!pid || (await descendants(ctx, pid)).some((s) => /\bpi-phase run\b/.test(s))) continue;
    const minutes = idleMinutes(cwd, ctx);
    if (minutes !== undefined && minutes > Number(opts.minutes ?? c.idle?.minutes ?? 75)) silent.push(`${lane.id}:${minutes}m`);
  }
  if (!silent.length) return 1;
  ctx.out(`silent: ${silent.join(" ")}`); return 0;
}
