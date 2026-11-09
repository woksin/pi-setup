import { spawn } from "node:child_process";
import { constants } from "node:os";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { admit, inventory } from "../admission.ts";
import { expand, laneDir, type Config } from "../config.ts";
import type { InheritedChild, LanesCtx } from "../ctx.ts";
import { laneTarget } from "../sessions.ts";
import { preapprove } from "../preapprove.ts";
import { backendFor } from "../backend.ts";
import { parseStatus } from "../status-line.ts";
import { retireRegistration, writeRegistration } from "../registration.ts";

function nativeSpawn(exe: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): InheritedChild {
  const child = spawn(exe, args, { ...options, stdio: "inherit", shell: false });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { pid: child.pid ?? 0, done, signal: signal => { child.kill(signal); } };
}
/** The only actual Pi launcher. The lease spans the wrapper, including all relaunches. */
export async function run(id: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx, beforeLaunch?: () => Promise<void>): Promise<number> {
  const target = laneTarget(id, c, root, ctx);
  if (target.lane?.retired) throw new Error(`lane ${id} is retired; add a fresh lane instead`);
  if (!opts["from-handoff"] && parseStatus(await backendFor(c, ctx, root).status(target.id)).kind === "closed") throw new Error(`lane ${id} is closed`);
  const prompt = expand(target.coordinator ? c.coordinator.prompt : target.lane!.prompt, c, root, ctx.home);
  if (!existsSync(target.cwd) || !statSync(target.cwd).isDirectory()) throw new Error(`cwd not found: ${target.cwd}`);
  if (!existsSync(prompt) || !statSync(prompt).isFile()) throw new Error(`prompt not found: ${prompt}`);
  let wrapper = ctx.which(c.launch.wrapper);
  if (!wrapper) {
    wrapper = ctx.which("pi"); if (!wrapper) throw new Error("pi not found");
    ctx.err("pi-session not found; starting pi directly (no relaunch after a context handoff)");
  }
  if (!target.coordinator || !c.launch.preapproveMcp) await preapprove(ctx, target.cwd, c.launch.preapproveMcp);
  const lease = await admit(ctx, { root: ctx.realpath(root), cwd: ctx.realpath(target.cwd), id: target.id,
    pool: target.coordinator || ["repo-orch", "sub-orch"].includes(target.lane?.role ?? "") ? "orchestration" : "worker" }, beforeLaunch);
  const env = { ...ctx.env };
  for (const name of c.launch.unsetEnv) delete env[name];
  const messages = expand(c.messages.dir, c, root, ctx.home);
  Object.assign(env, { PI_ORCH_ID: target.id, LANES_DIR: root, INBOX_DIR: messages, LANE_STATUS_DIR: join(messages, "status") });
  let child: InheritedChild;
  try { child = (ctx.spawnInherited ?? nativeSpawn)(wrapper, [`@${prompt}`], { cwd: target.cwd, env }); }
  catch (e) { await lease.release(); throw e; }
  // Attach rejection handling before probing identity (a failed executable may exit immediately).
  let settled = false;
  const outcome = child.done.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  if (child.pid > 0) {
    try { writeRegistration(root, { id: target.id, pid: child.pid, cwd: target.cwd, startedAt: ctx.now().toISOString() }); }
    catch (e) { ctx.err(`registration: ${(e as Error).message}`); }
  }
  let verified!: (start: string | undefined) => void;
  // A signal received while lease.child is probing waits for that exact verification.
  // Failed verification resolves undefined: a later inventory cannot invent an identity.
  const identity = new Promise<string | undefined>(resolve => { verified = resolve; });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => { void identity.then(async start => {
      if (settled) return;
      if (start) {
        const rows = await inventory(ctx);
        if (settled) return;
        const row = rows.find(r => r.pid === child.pid);
        if (row?.start === start) { child.signal(signal); return; }
      }
      ctx.err("admission cancellation identity uncertain; child not signalled, lease retained until confirmed exit");
    }).catch(e => ctx.err((e as Error).message)); };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    try {
      verified((await lease.child(child.pid)).start);
    } catch (e) { verified(undefined); ctx.err((e as Error).message); }
    const completed = await outcome;
    if ("error" in completed) throw completed.error;
    result = completed.value;
  } finally {
    settled = true; verified(undefined);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (child.pid > 0) {
      try { retireRegistration(root, target.id, ctx.now().toISOString()); }
      catch (e) { ctx.err(`registration: ${(e as Error).message}`); }
    }
    try { await lease.release(); } catch (e) { ctx.err((e as Error).message); }
  }
  if (result.signal) {
    if (!ctx.spawnInherited) process.kill(process.pid, result.signal);
    return 128 + (constants.signals[result.signal] ?? 0);
  }
  return result.code ?? 1;
}
