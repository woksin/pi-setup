import { join, relative } from "node:path";
import { UsageError, type Config, type Lane } from "../config.ts";
import { atomicJson } from "../reap/files.ts";
import { collect, type CommandEnv } from "../reap/signals.ts";
import { accept, handoffRecipient, packPath, prepare } from "../reap/handoff.ts";
export async function handoff(args: string[], opts: Record<string, string>, env: CommandEnv): Promise<number> {
  const { c, root, ctx } = env;
  const lane = activeLane(args, c);
  const minutes = c.idle?.minutes ?? 90;
  if (opts.accept) {
    validateAcceptance(opts);
    await accept({ c, lane, root, ctx, minutes }, opts.from);
    ctx.out(`accepted handoff ${lane.id} by ${opts.from}`); return 0;
  }
  if (opts.from) throw new UsageError("--from requires --accept");
  const s = await collect({ c, lane, root, ctx, minutes });
  const pack = await prepare({ c, lane, root, ctx, minutes }, handoffRecipient(lane, c, opts.to), s);
  atomicJson(join(root, ".state/reap-plan.json"), { at: ctx.now().toISOString(), rows: [{
    id: lane.id, verdict: "handoff", pack: relative(root, packPath({ root, lane })), signals: s,
  }] });
  ctx.out(`handoff ${pack.id}: ${packPath({ root, lane })}`); return 0;
}

function activeLane(args: string[], c: Config): Lane {
  const lane = c.lanes.find(l => l.id === args[0] && !l.retired);
  if (args.length !== 1 || !lane) throw new UsageError("handoff requires an active lane ID"); return lane;
}
function validateAcceptance(opts: Record<string, string>): void {
  if (!opts.from || opts.to) throw new UsageError("handoff --accept requires --from ID and no --to");
}
