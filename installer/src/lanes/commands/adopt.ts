import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaults, expand, findRoot, loadConfig, saveConfig, UsageError, validate, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId, validNewId } from "../names.ts";
import { discover } from "../adopt/discover.ts";
import { inventory } from "../adopt/inventory.ts";
import { requestedOrchestrates, requestedRoles } from "../adopt/roles.ts";
import { mergeDiscovered, missingLanes, printProposal } from "../adopt/proposal.ts";

export async function adopt(opts: Record<string, string>, ctx: LanesCtx): Promise<number> {
  const root = adoptionRoot(opts.dir, ctx);
  const path = join(root, "lanes.json"); const exists = existsSync(path);
  const c = exists ? loadConfig(root) : defaults(root, ctx.home);
  configure(c, opts, root, ctx);
  const excluded = excludedTtys(opts);
  const entries = inventory(opts.inventory ? resolve(ctx.cwd, opts.inventory) : undefined);
  const roles = requestedRoles(opts.role, c.coordinator.id);
  const rows = await discover(ctx, entries, excluded, c.coordinator.id);
  const orchestrates = requestedOrchestrates(opts.orchestrates, c.coordinator.id);
  mergeDiscovered(c, rows, { root, ctx, existingConfig: exists, roles, orchestrates });
  for (const [id, repos] of orchestrates) {
    const lane = c.lanes.find(l => l.id === id);
    if (lane?.role !== "repo-orch" || JSON.stringify(lane.orchestrates) !== JSON.stringify(repos)) {
      throw new UsageError(`--orchestrates requires a mapped repo-orch: ${id}`);
    }
  }
  validate(c, root, ctx.home);
  const before = exists ? readFileSync(path, "utf8") : "";
  const after = JSON.stringify(c, null, 2) + "\n";
  printProposal({ rows, missing: missingLanes(c, rows), before, after }, ctx);
  if (opts.write && before !== after) { saveConfig(root, c); ctx.out(`wrote ${path}`); }
  return 0;
}
function configure(c: Config, opts: Record<string, string>, root: string, ctx: LanesCtx): void {
  c.coordinator.id = selectedCoordinator(opts.coordinator, c.coordinator.id);
  if (!validCoordinator(c)) throw new UsageError("invalid or reserved coordinator id");
  if (opts.messages) c.messages.dir = expand(opts.messages, c, root, ctx.home);
}
function selectedCoordinator(requested: string | undefined, current: string): string {
  if (requested === undefined || requested === current) return current;
  if (!validNewId(requested)) throw new UsageError("invalid or reserved coordinator id");
  return requested;
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
