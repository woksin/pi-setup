import { join } from "node:path";
import { createHash } from "node:crypto";
import { terminalBackend, detectBackend } from "../terminal.ts";
import { atomicJson, optionalText } from "./files.ts";
import { collect, type EvidenceContext, type Signals } from "./signals.ts";
import { HEADINGS, expectedSnapshot, readContext, validateContext, type ContextFile } from "./context-format.ts";

interface Receipt { version: string; digest: string; mtime: number }
export function contextPath(env: Pick<EvidenceContext, "root" | "lane">): string {
  return join(env.root, ".state/handoffs", `${env.lane.id}.md`);
}
function receiptPath(env: EvidenceContext): string {
  return join(env.root, ".state/handoffs", `${env.lane.id}.request.json`);
}
function version(s: Signals): string {
  const state = { pid: s.pid, procStart: s.procStart, sessionId: s.sessionId, sessionFile: s.sessionFile,
    lastWrite: s.lastWrite, git: s.git, claims: s.claims };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
function cached(env: EvidenceContext, s: Signals): boolean {
  const text = optionalText(receiptPath(env)); if (text === undefined) return false;
  const receipt: Receipt = JSON.parse(text); if (receipt.version !== version(s)) return false;
  const file = readContext(contextPath(env)); validateContext(file, expectedSnapshot(env, s));
  if (file.digest !== receipt.digest || file.mtime !== receipt.mtime) throw new Error("lane handoff changed after validation");
  return true;
}
async function request(env: EvidenceContext, s: Signals): Promise<number> {
  if (!s.tty) throw new Error("lane handoff TTY unknown");
  const backend = terminalBackend(detectBackend("auto", env.ctx)); let at = env.ctx.now().getTime();
  const text = `Write your own context handoff to ${contextPath(env)}. ` +
    `Use nonempty ## sections: ${HEADINGS.join(", ")}. Preserve user constraints verbatim. ` +
    `Add ## Snapshot with a fenced json object matching ${JSON.stringify(expectedSnapshot(env, s))}. ` +
    "Account for every dirty path, outstanding acknowledgement, candidate and CI run. Do not quit.";
  const result = await backend.nudge(env.ctx, { tty: s.tty, text }, async () => {
    await unchanged(env, s); at = env.ctx.now().getTime();
  });
  if (result !== "sent") throw new Error("could not request lane's own handoff through its terminal"); return at;
}
async function unchanged(env: EvidenceContext, s: Signals): Promise<void> {
  const current = await collect(env);
  if (current.asks.length || current.keeps.length) throw new Error("handoff request safety evidence changed");
  if (version(current) !== version(s)) throw new Error("handoff request safety evidence changed");
}
async function waitForContext(env: EvidenceContext, s: Signals, at: number): Promise<ContextFile> {
  const sleep = env.ctx.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let reason = "lane handoff absent or stale";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const file = readContext(contextPath(env));
      if (file.mtime > at) { validateContext(file, expectedSnapshot(env, s)); return file; }
    } catch (e) { reason = (e as Error).message; }
    await sleep(1000);
  }
  throw new Error(`lane handoff timed out: ${reason}`);
}
export async function ownContext(env: EvidenceContext, s: Signals): Promise<string> {
  if (cached(env, s)) return contextPath(env);
  const at = await request(env, s); const file = await waitForContext(env, s, at);
  const current = await collect(env);
  if (JSON.stringify(current.git) !== JSON.stringify(s.git)) throw new Error("tree changed while writing lane handoff");
  atomicJson(receiptPath(env), { version: version(current), digest: file.digest, mtime: file.mtime });
  // The requested write may legitimately wake the session. Never waive the inactivity checks.
  if (JSON.stringify(current) !== JSON.stringify(s)) throw new Error("lane wrote handoff; wait until idle and review again");
  return contextPath(env);
}
export function verifyOwnContext(env: EvidenceContext, s: Signals): void {
  if (!cached(env, s)) throw new Error("lane handoff no longer matches session/tree evidence");
}
