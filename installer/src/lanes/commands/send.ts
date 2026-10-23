import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { backendFor } from "../backend.ts";
import { effectiveParent, UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId, validTopic } from "../names.ts";
export async function send(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  let [to, topic, file] = args;
  const from = opts.from || ctx.env.PI_ORCH_ID;
  if (!from) throw new UsageError("set --from or PI_ORCH_ID");
  if (!validId(from)) throw new UsageError("invalid from");
  if (!validId(to)) throw new UsageError("invalid to");
  if (!validTopic(topic)) throw new UsageError("invalid topic");
  if (opts.m !== undefined && file !== undefined) throw new UsageError("choose a file or -m, not both");
  const known = [c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.flatMap((l) => [l.id, l.group])];
  if (!known.includes(to)) ctx.err(`warning: unknown recipient ${to}; sending anyway`);
  const body = opts.m !== undefined ? opts.m : file && file !== "-" ? readFileSync(resolve(ctx.cwd, file), "utf8") : file === "-" || !ctx.stdinTTY ? await ctx.readStdin() : "";
  if (!body.trim()) throw new UsageError("empty message body");
  const sender = c.lanes.find(l => l.id === from && !l.retired);
  if (!opts.direct && to === c.coordinator.id && sender && sender.role !== "repo-orch") {
    const parent = effectiveParent(sender, c);
    if (parent !== to) { to = parent; ctx.err(`routed to ${parent} (repo orchestrator of ${sender.repo}); --direct to bypass`); }
  }
  ctx.out((await backendFor(c, ctx, root).send({ from, to, topic, body })).path);
  return 0;
}
