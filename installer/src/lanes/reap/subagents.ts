import { join } from "node:path";
import { jsonFiles } from "./files.ts";
import type { LanesCtx } from "../ctx.ts";
import type { Signals } from "./signals.ts";

type Status = Record<string, any>;
function owned(status: Status, s: Signals): boolean {
  if (status.role !== "subagent") return false;
  if (status.primarySessionId !== undefined) return status.primarySessionId === s.sessionId;
  return s.pid !== undefined && status.pid === s.pid;
}
function fresh(status: Status, now: number): boolean {
  if (status.state === "ended") return false;
  const age = typeof status.at === "string" ? now - Date.parse(status.at) : NaN;
  return Number.isFinite(age) && age >= 0 && age <= 600000;
}
export function subagents(s: Signals, ctx: LanesCtx): void {
  const statuses = jsonFiles(join(ctx.piAgentDir, "context-budget/status"));
  if (statuses.some(status => owned(status, s) && fresh(status, ctx.now().getTime()))) s.keeps.push("subagent running");
}
