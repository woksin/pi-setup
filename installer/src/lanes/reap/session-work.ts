import { readFileSync, statSync } from "node:fs";
import type { LanesCtx } from "../ctx.ts";
import type { Signals } from "./signals.ts";

const JOB_TOOLS = new Set(["job_start", "job_watch", "job_list", "job_output", "job_kill"]);
function record(jobs: Map<string, Record<string, any>>, job: Record<string, any> | undefined): void {
  if (typeof job?.id === "string" && typeof job.command === "string") jobs.set(job.id, job);
}
function fold(jobs: Map<string, Record<string, any>>, entry: Record<string, any>): void {
  const message = entry.type === "message" ? entry.message : entry;
  if (message?.role === "toolResult" && JOB_TOOLS.has(message.toolName)) {
    record(jobs, message.details);
    for (const job of message.details?.jobs ?? []) record(jobs, job);
  }
  if (message?.customType === "pi-jobs") {
    for (const completion of message.details?.completions ?? []) record(jobs, completion?.job);
  }
}
function subagents(pending: Set<string>, entry: Record<string, any>): void {
  const message = entry.type === "message" ? entry.message : entry;
  if (message?.role === "assistant") {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === "toolCall" && part.name === "subagent") pending.add(part.id);
    }
  }
  if (message?.role === "toolResult" && message.toolName === "subagent") pending.delete(message.toolCallId);
}
export function sessionWork(s: Signals, ctx: LanesCtx): void {
  if (statSync(s.sessionFile!).size > 32 * 1024 * 1024) { s.asks.push("session work scan exceeds size limit"); return; }
  const jobs = new Map<string, Record<string, any>>(); const pending = new Set<string>();
  try {
    for (const line of readFileSync(s.sessionFile!, "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line); fold(jobs, entry); subagents(pending, entry);
    }
  } catch { s.asks.push("session work history malformed"); return; }
  if (pending.size) s.keeps.push("subagent tool call pending");
  for (const job of jobs.values()) {
    if (job.status !== "running") continue;
    const deadline = job.startedAt + job.timeoutSeconds * 1000;
    if (job.cwd !== s.cwd || !Number.isFinite(deadline) || deadline <= ctx.now().getTime()) {
      s.asks.push("job/watch last recorded running; current state unknown");
    } else s.keeps.push("job/watch running (session snapshot)");
  }
}
