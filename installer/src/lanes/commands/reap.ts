import { join } from "node:path";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { collect } from "../reap/signals.ts";
import { atomicJson } from "../reap/files.ts";
import { verdict } from "../reap/verdict.ts";
export async function reap(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (args.length > 1 || (args[0] && !c.lanes.some(l => l.id === args[0] && !l.retired))) throw new UsageError("reap accepts one active lane ID");
  const minutes = Number(opts.minutes || c.idle?.minutes || 90); if (!Number.isFinite(minutes) || minutes < 1) throw new UsageError("--minutes must be positive");
  const rows = [];
  for (const lane of c.lanes.filter(l => !l.retired && (!args[0] || l.id === args[0]))) {
    const signals = await collect(c, lane, root, ctx, minutes); rows.push({ id: lane.id, ...verdict(signals), signals });
  }
  atomicJson(join(root, ".state/reap-plan.json"), { at: ctx.now().toISOString(), minutes, rows });
  if (opts.json) ctx.out(JSON.stringify(rows));
  else { ctx.out("LANE\tVERDICT\tREASON"); for (const row of rows) ctx.out(`${row.id}\t${row.verdict}${row.ground ? ` (${row.ground})` : ""}\t${row.reason}`); }
  return 0;
}
