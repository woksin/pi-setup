import { basename, dirname } from "node:path";
import { backendFor, type MessageRef } from "../backend.ts";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId } from "../names.ts";
import { alive, descendants } from "../processes.ts";
import { idleMinutes, laneTarget, piIn } from "../sessions.ts";
import { clean, closedLine } from "../status-line.ts";
import { shellQuote } from "../terminal.ts";
import { nudge } from "./nudge.ts";
function closeBody(id: string, to: string | undefined, reason: string | undefined, unread: MessageRef[] | undefined): string {
  const body = [`Lane ${id} is closed.${to ? ` Reassigned to ${to}.` : ""}${reason ? ` Reason: ${clean(reason)}` : ""}`, "",
    `${to ? `${to}: pick up` : "Pick up"} the work and any unread messages of ${id}. No message file was moved or edited.`, ""];
  if (unread === undefined) body.push(`Unread inbox of ${id}: none known (${id}-inbox.marker does not exist).`);
  else if (unread.length) body.push(`Unread inbox files of ${id} (newer than ${id}-inbox.marker):`, ...unread.map((m) => `- ${m.name}`));
  else body.push(`Unread inbox files of ${id}: none.`);
  return `${body.join("\n")}\n`;
}
async function quit(id: string, pid: number, cwd: string, c: Config, root: string, ctx: LanesCtx): Promise<boolean> {
  const busy = (await descendants(ctx, pid)).filter((cmd) => /\bpi-phase run\b/.test(cmd) || /^(dotnet|vstest.*|testhost.*|npm|yarn|pnpm|pi-phase|git|docker|make)$/i.test(basename(cmd.split(/\s+/)[0])));
  if (busy.length) { ctx.err(`REFUSED: busy children: ${busy.join(" ")}`); return false; }
  const age = idleMinutes(cwd, ctx);
  if (age !== undefined && age < 3) { ctx.err("REFUSED: session wrote less than 180s ago"); return false; }
  if (await nudge(id, "/quit", {}, c, root, ctx) !== 0) return false;
  for (let i = 0; i < 10; i++) {
    await (ctx.sleep ? ctx.sleep(1000) : new Promise((done) => setTimeout(done, 1000)));
    if (!await alive(ctx, pid)) return true;
  }
  ctx.err(`REFUSED: pi ${pid} did not quit`); return false;
}
export async function close(id: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (!c.lanes.some((l) => l.id === id)) throw new UsageError(`not a lane: ${id}`);
  const to = opts["reassign-to"]; const from = opts.from || ctx.env.PI_ORCH_ID || c.coordinator.id;
  if (to && (!validId(to) || to === id)) throw new UsageError("--reassign-to must be a valid id different from the closed lane");
  if (!validId(from)) throw new UsageError("invalid sender id");
  if (to && to !== c.coordinator.id && !c.lanes.some((l) => l.id === to)) ctx.err(`unknown reassignment target: ${to}`);
  const target = laneTarget(id, c, root, ctx); const pid = await piIn(target.cwd, ctx);
  if (pid && opts.quit && !await quit(id, pid, target.cwd, c, root, ctx)) return 1;
  if (pid && !opts.quit) ctx.err(`${id} is still running; type /quit in its session or use --quit`);
  const backend = backendFor(c, ctx, root);
  const unread = await backend.unread(id, { groups: target.lane?.group ? [target.lane.group] : [] });
  const line = closedLine(to, opts.reason, ctx.now());
  await backend.setStatus(id, line);
  const message = await backend.send({ from, to: c.messages.broadcast, topic: `lane-closed-${id.toLowerCase()}`, body: closeBody(id, to, opts.reason, unread) });
  ctx.out(`${id}: ${line}`); ctx.out(message.path);
  const common = await ctx.run("git", ["-C", target.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 10000 });
  if (common.code !== 0 || !common.stdout.trim()) throw new Error("cannot find clone for worktree removal hint");
  const clone = shellQuote(dirname(common.stdout.trim())); const wt = shellQuote(target.cwd);
  ctx.out(`when merged, remove the worktree: git -C ${clone} worktree unlock ${wt} && git -C ${clone} worktree remove ${wt}`);
  return 0;
}
