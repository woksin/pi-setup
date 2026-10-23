import { join } from "node:path";
import { jsonFiles } from "./files.ts";
import { subagentKeys } from "./subagent-completions.ts";
import type { LanesCtx } from "../ctx.ts";
import type { Signals } from "./signals.ts";

type Status = Record<string, any>;
function owned(status: Status, s: Signals): boolean {
  if (status.role !== "subagent") return false;
  if (status.primarySessionId !== undefined) return status.primarySessionId === s.sessionId;
  return s.pid !== undefined && status.pid === s.pid;
}
function evidence(status: Status, completed: Set<string>, now: number): "history" | "running" | "unknown" {
  if (status.state === "ended") return "history";
  const age = typeof status.at === "string" ? now - Date.parse(status.at) : NaN;
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (age <= 600000) return "running";
  return subagentKeys(status).some(key => completed.has(key)) ? "history" : "unknown";
}
export function subagents(s: Signals, ctx: LanesCtx): void {
  const statuses = jsonFiles(join(ctx.piAgentDir, "context-budget/status")).filter(status => owned(status, s));
  const completed = new Set(s.completedSubagents);
  const states = new Set(statuses.map(status => evidence(status, completed, ctx.now().getTime())));
  if (states.has("running")) s.keeps.push("subagent running");
  if (states.has("unknown")) s.asks.push("subagent state unknown");
}
