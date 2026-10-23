import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { backendFor } from "../backend.ts";
import { effectiveParent, UsageError, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId, validTopic } from "../names.ts";
export async function send(
  args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx,
): Promise<number> {
  let [to, topic, file] = args;
  const from = opts.from || ctx.env.PI_ORCH_ID;
  if (!from) throw new UsageError("set --from or PI_ORCH_ID");
  if (!validId(from)) throw new UsageError("invalid from");
  if (!validId(to)) throw new UsageError("invalid to");
  if (!validTopic(topic)) throw new UsageError("invalid topic");
  if (opts.m !== undefined && file !== undefined) throw new UsageError("choose a file or -m, not both");
  const known = [c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.flatMap((l) => [l.id, l.group])];
  if (!known.includes(to)) ctx.err(`warning: unknown recipient ${to}; sending anyway`);
  const body = opts.m !== undefined ? opts.m
    : file && file !== "-" ? readFileSync(resolve(ctx.cwd, file), "utf8")
    : file === "-" || !ctx.stdinTTY ? await ctx.readStdin() : "";
  if (!body.trim()) throw new UsageError("empty message body");
  to = route({ to, from, direct: opts.direct }, c, ctx);
  ctx.out((await backendFor(c, ctx, root).send({ from, to, topic, body })).path);
  return 0;
}

function route(input: { to: string; from: string; direct?: string }, c: Config, ctx: LanesCtx): string {
  const sender = c.lanes.find(l => l.id === input.from && !l.retired);
  if (!routeToParent(input, sender, c)) return input.to;
  const parent = effectiveParent(sender!, c);
  if (parent !== input.to) {
    ctx.err(`routed to ${parent} (repo orchestrator of ${sender!.repo}); --direct to bypass`);
    return parent;
  }
  return input.to;
}
function routeToParent(input: { to: string; direct?: string }, sender: Lane | undefined, c: Config): boolean {
  if (input.direct || input.to !== c.coordinator.id) return false;
  return Boolean(sender && sender.role !== "repo-orch");
}
