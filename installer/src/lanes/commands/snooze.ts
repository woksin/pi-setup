import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import type { CommandEnv } from "../reap/signals.ts";

export async function snooze(args: string[], opts: Record<string, string>, env: CommandEnv): Promise<number> {
  const { c, root, ctx } = env;
  const lane = c.lanes.find(l => l.id === args[0] && !l.retired);
  if (invalidRequest(args, lane, opts)) throw new UsageError("snooze requires ID and --until ISO|+90m or --clear");
  const dir = join(root, ".state/snooze"); const path = join(dir, lane!.id);
  if (opts.clear) { clear(path); ctx.out(`snooze cleared ${lane!.id}`); return 0; }
  const date = until(opts.until, ctx);
  if (!Number.isFinite(date) || date <= ctx.now().getTime()) {
    throw new UsageError("--until must be a future ISO timestamp or +90m");
  }
  mkdirSync(dir, { recursive: true }); writeFileSync(path, new Date(date).toISOString() + "\n");
  ctx.out(`snoozed ${lane!.id} until ${new Date(date).toISOString()}`); return 0;
}
function invalidRequest(args: string[], lane: unknown, opts: Record<string, string>): boolean {
  if (args.length !== 1 || !lane) return true;
  return Boolean(opts.clear) === Boolean(opts.until);
}
function until(value: string, ctx: LanesCtx): number {
  const relative = /^\+(\d+)m$/.exec(value);
  return relative ? ctx.now().getTime() + Number(relative[1]) * 60000 : Date.parse(value);
}
function clear(path: string): void {
  try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}
