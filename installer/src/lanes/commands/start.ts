import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { expand, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { laneTarget } from "../sessions.ts";
import { runningPi } from "../processes.ts";
import { prune } from "../retention.ts";
import { preapprove } from "../preapprove.ts";
import { detectBackend, launchCommand, terminalBackend } from "../terminal.ts";
export async function start(id: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  rejectRetired(id, c);
  const { coordinator, lane, cwd } = laneTarget(id, c, root, ctx);
  const prompt = expand(coordinator ? c.coordinator.prompt : lane!.prompt, c, root, ctx.home);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd not found: ${cwd}`);
  if (!existsSync(prompt) || !statSync(prompt).isFile()) throw new Error(`prompt not found: ${prompt}`);
  const duplicate = (await runningPi(ctx)).find((p) => p.cwd === ctx.realpath(cwd));
  if (duplicate) throw new Error(`already running in ${cwd} (pid ${duplicate.pid}); not starting a second session`);
  if (!coordinator || !c.launch.preapproveMcp) await preapprove(ctx, cwd, c.launch.preapproveMcp);
  const backend = detectBackend(opts.terminal || c.terminal.backend, ctx);
  let wrapper = ctx.which(c.launch.wrapper);
  if (!wrapper) {
    wrapper = ctx.which("pi");
    if (wrapper) ctx.err("pi-session not found; starting pi directly (no relaunch after a context handoff)");
    else if (backend === "print") { wrapper = c.launch.wrapper; ctx.err(`${c.launch.wrapper} and pi not found; printing the command only`); }
    else throw new Error("pi not found");
  }
  if (c.messages.retention?.auto) {
    try { prune(c, root, ctx); }
    catch (e) { ctx.err(`warning: message prune failed: ${(e as Error).message.replace(/\s+/g, " ")}`); }
  }
  const command = launchCommand(c, root, cwd, coordinator ? c.coordinator.id : id, prompt, wrapper, expand(c.messages.dir, c, root, ctx.home));
  return terminalBackend(backend).start(ctx, { id: coordinator ? c.coordinator.id : id, cwd, command });
}

function rejectRetired(id: string, c: Config): void {
  if (c.lanes.find(l => l.id === id)?.retired) throw new Error(`lane ${id} is retired; add a fresh lane instead`);
}
