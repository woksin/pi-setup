import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { expand, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { laneTarget } from "../sessions.ts";
import { runningPi } from "../processes.ts";
import { preapprove } from "../preapprove.ts";
import { detectBackend, launchCommand, terminalBackend } from "../terminal.ts";
export async function start(id: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
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
  const command = launchCommand(c, root, cwd, coordinator ? c.coordinator.id : id, prompt, wrapper, expand(c.messages.dir, c, root, ctx.home));
  return terminalBackend(backend).start(ctx, { id: coordinator ? c.coordinator.id : id, cwd, command });
}
