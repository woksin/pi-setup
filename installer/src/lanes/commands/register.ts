import { statSync } from "node:fs";
import { resolve } from "node:path";
import { UsageError } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId } from "../names.ts";
import { ancestorChain, processCwd } from "../processes.ts";
import { pidAlive, registerSession, unregisterSession } from "../registration.ts";

function explicitPid(value: string): number {
  const pid = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid <= 0) throw new UsageError("--pid must be a positive integer");
  return pid;
}
async function registrationPid(value: string | undefined, ctx: LanesCtx): Promise<number> {
  const pid = value === undefined ? await ancestorChain(ctx) : explicitPid(value);
  if (pid === undefined) throw new Error("no pi process found among ancestors; pass --pid");
  if (!(ctx.pidAlive ?? pidAlive)(pid)) throw new Error(`pid ${pid} is not alive`);
  return pid;
}
async function registrationCwd(opts: Record<string, string>, pid: number, ctx: LanesCtx): Promise<string> {
  let cwd = opts.cwd;
  if (cwd === undefined) {
    try { cwd = await processCwd(ctx, pid); } catch { /* Fall back to the command cwd when discovery fails. */ }
  }
  const canonical = ctx.realpath(resolve(ctx.cwd, cwd ?? ctx.cwd));
  if (!statSync(canonical).isDirectory()) throw new Error(`not a directory: ${canonical}`);
  return canonical;
}
export async function register(id: string, opts: Record<string, string>, root: string, ctx: LanesCtx): Promise<number> {
  if (!validId(id)) throw new UsageError("invalid registration id");
  const pid = await registrationPid(opts.pid, ctx);
  const cwd = await registrationCwd(opts, pid, ctx);
  await registerSession(root, { id, pid, cwd }, ctx);
  ctx.out(`registered ${id} pid=${pid} cwd=${cwd}`);
  return 0;
}
export function unregister(id: string, root: string, ctx: LanesCtx): number {
  unregisterSession(root, id, ctx);
  ctx.out(`unregistered ${id}`);
  return 0;
}
