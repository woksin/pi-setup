import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaults, expand, findRoot, loadConfig, saveConfig, UsageError, validate, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId } from "../names.ts";
import { discover } from "../adopt/discover.ts";
import { inventory } from "../adopt/inventory.ts";
import { mergeDiscovered, missingLanes, printProposal } from "../adopt/proposal.ts";

export async function adopt(opts: Record<string, string>, ctx: LanesCtx): Promise<number> {
  const root = adoptionRoot(opts.dir, ctx);
  const path = join(root, "lanes.json"); const exists = existsSync(path);
  const c = exists ? loadConfig(root) : defaults(root, ctx.home);
  configure(c, opts, root, ctx);
  const excluded = excludedTtys(opts);
  const entries = inventory(opts.inventory ? resolve(ctx.cwd, opts.inventory) : undefined);
  const rows = await discover(ctx, entries, excluded);
  mergeDiscovered(c, rows, root, ctx); validate(c, root, ctx.home);
  const before = exists ? readFileSync(path, "utf8") : "";
  const after = JSON.stringify(c, null, 2) + "\n";
  printProposal({ rows, missing: missingLanes(c, rows), before, after }, ctx);
  if (opts.write && before !== after) { saveConfig(root, c); ctx.out(`wrote ${path}`); }
  return 0;
}
function configure(c: Config, opts: Record<string, string>, root: string, ctx: LanesCtx): void {
  if (opts.coordinator) c.coordinator.id = opts.coordinator;
  if (!validCoordinator(c)) throw new UsageError("invalid or reserved coordinator id");
  if (opts.messages) c.messages.dir = expand(opts.messages, c, root, ctx.home);
}
function validCoordinator(c: Config): boolean {
  return validId(c.coordinator.id) && c.coordinator.id !== "ALL" && !c.lanes.some(l => l.id === c.coordinator.id);
}
function excludedTtys(opts: Record<string, string>): string[] {
  const excluded = opts["exclude-tty"]?.split(",") ?? [];
  if (excluded.some(tty => !/^ttys\d+$/.test(tty))) throw new UsageError("--exclude-tty requires ttysNNN");
  return excluded;
}
function adoptionRoot(dir: string | undefined, ctx: LanesCtx): string {
  if (dir) return resolve(ctx.cwd, dir);
  try { return findRoot(undefined, ctx.env, ctx.cwd); }
  catch (e) { if (!(e instanceof UsageError)) throw e; return resolve(ctx.cwd); }
}
