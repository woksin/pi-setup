import { terminalBackend, detectBackend } from "../terminal.ts";
import { fingerprint, recipient } from "./handoff.ts";
import { collect, type EvidenceContext, type Signals } from "./signals.ts";
function ready(s: Signals, env: EvidenceContext): void {
  if (env.ctx.now().getTime() - (s.lastWrite || 0) < 180000) throw new Error("quit refused: session wrote less than 180s ago");
  if (!s.pid || !s.tty) throw new Error("quit identity missing");
}
async function revalidate(env: EvidenceContext, s: Signals, to: string): Promise<void> {
  await recipient(env, to); const fresh = await collect(env);
  if (fresh.asks.length || fresh.keeps.length) throw new Error("quit refused: safety evidence changed");
  if (fingerprint(fresh) !== fingerprint(s)) throw new Error("quit refused: safety evidence changed");
}
async function exited(env: EvidenceContext, pid: number): Promise<boolean> {
  const probe = await env.ctx.run("ps", ["-p", String(pid)], { timeoutMs: 2000 });
  if (probe.timedOut) throw new Error("quit exit could not be confirmed");
  if (probe.code === 1) return true;
  if (probe.code !== 0) throw new Error("quit exit could not be confirmed"); return false;
}
async function awaitExit(env: EvidenceContext, pid: number): Promise<void> {
  const sleep = env.ctx.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 5; attempt++) { if (await exited(env, pid)) return; await sleep(200); }
  throw new Error("pi did not exit after /quit; active metadata unchanged");
}
/** The native backend runs the final guard after locating its pane/tab. No process signals. */
export async function safeQuit(env: EvidenceContext, s: Signals, to: string): Promise<void> {
  ready(s, env); const backend = terminalBackend(detectBackend("auto", env.ctx));
  const outcome = await backend.quit(env.ctx, s.tty!, () => revalidate(env, s, to));
  if (outcome !== "sent") throw new Error(`quit refused: ${outcome}`);
  await awaitExit(env, s.pid!);
}
