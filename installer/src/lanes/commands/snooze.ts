import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
export async function snooze(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const lane = c.lanes.find(l => l.id === args[0] && !l.retired);
  if (args.length !== 1 || !lane || Boolean(opts.clear) === Boolean(opts.until)) throw new UsageError("snooze requires ID and --until ISO|+90m or --clear");
  const dir = join(root, ".state/snooze"); const path = join(dir, lane.id);
  if (opts.clear) { try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } ctx.out(`snooze cleared ${lane.id}`); return 0; }
  const relative = /^\+(\d+)m$/.exec(opts.until); const date = relative ? ctx.now().getTime() + Number(relative[1]) * 60000 : Date.parse(opts.until);
  if (!Number.isFinite(date) || date <= ctx.now().getTime()) throw new UsageError("--until must be a future ISO timestamp or +90m");
  mkdirSync(dir, { recursive: true }); writeFileSync(path, new Date(date).toISOString() + "\n"); ctx.out(`snoozed ${lane.id} until ${new Date(date).toISOString()}`); return 0;
}
