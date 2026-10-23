import { backendFor } from "../backend.ts";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { foregroundPi, ttyOf } from "../processes.ts";
import { laneTarget, piIn } from "../sessions.ts";
import { parseStatus } from "../status-line.ts";
import { detectBackend, terminalBackend } from "../terminal.ts";
export async function nudge(id: string, text: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  text = text.trim().replace(/[\r\n]/g, " ");
  if (!text || text.length > 2000) throw new UsageError("nudge text must be between 1 and 2000 characters");
  const target = laneTarget(id, c, root, ctx);
  const refuse = (why: string) => { ctx.err(`NOT SENT: ${why}`); return 3; };
  if (parseStatus(await backendFor(c, ctx, root).status(target.id)).kind === "closed") return refuse(`${target.id} is closed`);
  const pid = await piIn(target.cwd, ctx);
  if (!pid) return refuse(`no pi running in ${target.cwd}`);
  const tty = await ttyOf(ctx, pid);
  if (!tty) return refuse(`${target.id} has no tty`);
  if (!await foregroundPi(ctx, tty)) return refuse(`no foreground pi on ${tty} (lane stopped or busy in a subshell)`);
  const backend = detectBackend(opts.terminal || c.terminal.backend, ctx);
  if (backend === "print") { ctx.out(`nudge ${target.id} (tty ${tty}): type this into its pi session: ${text}`); return 4; }
  if (await terminalBackend(backend).nudge(ctx, { tty, text }) !== "sent") return 4;
  ctx.out(`nudged ${target.id}`); return 0;
}
