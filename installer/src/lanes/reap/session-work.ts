import type { LanesCtx } from "../ctx.ts";
import type { Signals } from "./signals.ts";
import { scanSession } from "./session-scan.ts";
import { foldSubagentWork, type SubagentWork } from "./subagent-completions.ts";

type Snapshot = Record<string, any>;
const JOB_TOOLS = new Set(["job_start", "job_watch", "job_list", "job_output", "job_kill"]);
function record(jobs: Map<string, Snapshot>, job: Snapshot | undefined): void {
  if (typeof job?.id === "string") jobs.set(job.id, { ...jobs.get(job.id), ...job });
}
function foldJobs(jobs: Map<string, Snapshot>, message: Snapshot): void {
  if (message.role !== "toolResult" || !JOB_TOOLS.has(message.toolName)) return;
  record(jobs, message.details);
  for (const job of message.details?.jobs ?? []) record(jobs, job);
}
function completions(jobs: Map<string, Snapshot>, message: Snapshot): void {
  if (message.customType !== "pi-jobs") return;
  for (const completion of message.details?.completions ?? []) record(jobs, completion?.job);
}
function watch(command: unknown, s: Signals): void {
  if (typeof command !== "string") return;
  const words = command.replace(/["']/g, "").split(/\s+/);
  const start = words.findIndex(word => /(?:^|\/)inbox-watch$/.test(word));
  if (start < 0) return;
  const args = words.slice(start + 1); const aliases: string[] = [];
  while (args[0] === "--alias" && args.length > 1) { aliases.push(args[1]); args.splice(0, 2); }
  if (args[0] !== s.id) return;
  s.inboxWatch = true;
  const envAliases = words.slice(0, start).find(word => word.startsWith("INBOX_ALIASES="));
  aliases.push(...(envAliases?.slice("INBOX_ALIASES=".length).split(",") ?? []));
  s.inboxAliases = [...new Set([...(s.inboxAliases ?? []), ...aliases.filter(Boolean)])];
}
function workTool(name: string): boolean { return name === "subagent" || JOB_TOOLS.has(name); }
function pendingCall(pending: Map<string, string>, part: Snapshot, s: Signals): void {
  if (part.type !== "toolCall") return;
  if (workTool(part.name)) pending.set(part.id, part.name);
  if (part.name === "job_watch") watch(part.arguments?.command, s);
}
function toolCalls(pending: Map<string, string>, message: Snapshot, s: Signals): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) pendingCall(pending, part, s);
}
function toolResult(pending: Map<string, string>, message: Snapshot, s: Signals): void {
  if (message.role !== "toolResult") return;
  pending.delete(message.toolCallId);
  if (message.toolName === "job_watch") watch(message.details?.command, s);
}
function currentJob(job: Snapshot, s: Signals, ctx: LanesCtx): boolean {
  const deadline = job.startedAt + job.timeoutSeconds * 1000;
  return job.cwd === s.cwd && Number.isFinite(deadline) && deadline > ctx.now().getTime();
}
function runningJob(job: Snapshot, s: Signals, ctx: LanesCtx): void {
  if (job.status !== "running") return;
  if (!job.command || !Number.isFinite(job.startedAt)) {
    s.asks.push(`job ${job.id} start evidence missing`); return;
  }
  if (!currentJob(job, s, ctx)) {
    s.asks.push("job/watch last recorded running; current state unknown");
  } else s.keeps.push("job/watch running (session snapshot)");
}
export async function sessionWork(s: Signals, ctx: LanesCtx): Promise<void> {
  const jobs = new Map<string, Snapshot>(); const pending = new Map<string, string>();
  const agents: SubagentWork = { launches: new Map() };
  try {
    await scanSession(s.sessionFile!, line => {
      const entry = JSON.parse(line); const message = entry.type === "message" ? entry.message : entry;
      foldJobs(jobs, message); completions(jobs, message); toolCalls(pending, message, s); toolResult(pending, message, s);
      foldSubagentWork(agents, message);
    });
  } catch (error) {
    s.asks.push((error as Error).message === "session scan incomplete" ? "session scan incomplete" : "session work history malformed"); return;
  }
  if (agents.launches.size) s.asks.push("subagent launched without completion");
  for (const tool of pending.values()) s.keeps.push(`${tool} tool call pending`);
  for (const job of jobs.values()) runningJob(job, s, ctx);
}
