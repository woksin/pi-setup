import { join } from "node:path";
import { jsonFiles } from "./files.ts";
import type { LanesCtx } from "../ctx.ts";
import type { Signals } from "./signals.ts";

type Status = Record<string, any>;
type Liveness = "alive" | "dead" | "unknown";
function exact(value: unknown, expected: string | number | undefined): boolean {
  return expected !== undefined && value === expected;
}
function owned(status: Status, s: Signals): boolean {
  if (status.role !== "subagent") return false;
  return exact(status.sessionId, s.sessionId) || exact(status.sessionFile, s.sessionFile)
    || exact(status.parentPid, s.pid);
}
async function pidState(pid: unknown, ctx: LanesCtx): Promise<Liveness> {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return "unknown";
  try {
    const probe = await ctx.run("ps", ["-p", String(pid), "-o", "pid="], { timeoutMs: 4000 });
    if (probe.timedOut) return "unknown";
    if (probe.code === 1) return "dead";
    if (probe.code === 0 && probe.stdout.trim() === String(pid)) return "alive";
  } catch { /* Probe failure is uncertainty, not evidence of exit. */ }
  return "unknown";
}
function finishedHistory(at: unknown, now: number): boolean {
  if (typeof at !== "string") return false;
  const age = now - Date.parse(at);
  return Number.isFinite(age) && age > 600000;
}
export async function subagents(s: Signals, ctx: LanesCtx): Promise<void> {
  const statuses = jsonFiles(join(ctx.piAgentDir, "context-budget/status")).filter(status => owned(status, s));
  const pids = new Map<unknown, Liveness>();
  const evidence = new Set<string>();
  for (const status of statuses) {
    if (!pids.has(status.pid)) pids.set(status.pid, await pidState(status.pid, ctx));
    const state = pids.get(status.pid)!;
    if (state === "alive") evidence.add("running");
    else if (state === "unknown" || !finishedHistory(status.at, ctx.now().getTime())) evidence.add("uncertain");
  }
  if (evidence.has("running")) s.keeps.push("subagent running");
  if (evidence.has("uncertain")) s.asks.push("owned subagent liveness uncertain");
}
