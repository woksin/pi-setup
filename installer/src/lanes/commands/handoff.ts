import { join, relative } from "node:path";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { atomicJson } from "../reap/files.ts";
import { collect } from "../reap/signals.ts";
import { accept, handoffRecipient, packPath, prepare } from "../reap/handoff.ts";
export async function handoff(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const lane = c.lanes.find(l => l.id === args[0] && !l.retired); if (args.length !== 1 || !lane) throw new UsageError("handoff requires an active lane ID");
  const minutes = c.idle?.minutes ?? 90;
  if (opts.accept) {
    if (!opts.from || opts.to) throw new UsageError("handoff --accept requires --from ID and no --to");
    await accept({ c, lane, root, ctx, minutes }, opts.from); ctx.out(`accepted handoff ${lane.id} by ${opts.from}`); return 0;
  }
  if (opts.from) throw new UsageError("--from requires --accept");
  const s = await collect({ c, lane, root, ctx, minutes }); const pack = await prepare({ c, lane, root, ctx, minutes }, handoffRecipient(lane, c, opts.to), s);
  atomicJson(join(root, ".state/reap-plan.json"), { at: ctx.now().toISOString(), rows: [{ id: lane.id, verdict: "handoff", pack: relative(root, packPath({ root, lane })), signals: s }] });
  ctx.out(`handoff ${pack.id}: ${packPath({ root, lane })}`); return 0;
}
