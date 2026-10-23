type Snapshot = Record<string, any>;
export interface SubagentWork { launches: Map<string, string | undefined> }
function text(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
}
function agentId(message: Snapshot, receipt: Snapshot): string | undefined {
  const id = message.details?.agentId ?? message.details?.id;
  if (typeof id === "string" && id) return id;
  return receipt.id ?? /^Agent (?:started|resumed) in background\.\r?\nAgent ID:\s*(\S+)/.exec(text(message.content))?.[1];
}
function agentCall(part: Snapshot): boolean {
  return part.type === "toolCall" && part.name === "Agent" && typeof part.id === "string";
}
function launch(work: SubagentWork, part: Snapshot): void {
  if (!agentCall(part)) return;
  const resume = part.arguments?.resume;
  work.launches.set(part.id, typeof resume === "string" ? resume : undefined);
}
function calls(work: SubagentWork, message: Snapshot): void {
  if (message.role === "toolCall") launch(work, { ...message, type: "toolCall" });
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) launch(work, part);
}
function completionTool(message: Snapshot): boolean {
  return message.role === "toolResult" && ["Agent", "get_subagent_result"].includes(message.toolName);
}
/** Normalize the legacy text-only receipts observed in real session JSONL. */
function textReceipt(body: string): Snapshot {
  const cleaned = /^Agent not found: "([^"\n]+)"\. It may have been cleaned up\.\s*$/.exec(body);
  if (cleaned) return { id: cleaned[1], status: "completed" };
  const report = /^Agent:\s*(\S+)\r?\nType: [^\n]*?\|\s*Status:\s*([^|\r\n]+)/.exec(body);
  if (report) return { id: report[1], status: report[2] };
  if (/^Agent completed in \d+(?:\.\d+)?s\b/.test(body)) return { status: "completed" };
  return {};
}
function resultRecord(message: Snapshot): Snapshot {
  const receipt = textReceipt(text(message.content));
  return { id: agentId(message, receipt), status: message.details?.status ?? receipt.status };
}
function result(work: SubagentWork, message: Snapshot): void {
  if (!completionTool(message)) return;
  const record = resultRecord(message); const ended = completion(work, record);
  if (message.toolName !== "Agent") return;
  if (message.isError || ended) work.launches.delete(message.toolCallId);
  else if (work.launches.has(message.toolCallId)) work.launches.set(message.toolCallId, record.id ?? work.launches.get(message.toolCallId));
}
function terminal(status: unknown): boolean {
  return typeof status === "string" && /^(done|completed|failed|error|aborted|stopped|wrapped up)\b/i.test(status.trim());
}
function completion(work: SubagentWork, record: Snapshot | undefined): boolean {
  if (!record || !terminal(record.status)) return false;
  const id = record.agentId ?? record.id;
  if (typeof id === "string" && id) settle(work, id);
  return true;
}
function settle(work: SubagentWork, id: string): void {
  for (const [call, agent] of work.launches) if (agent === id) work.launches.delete(call);
}
const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function notificationRecord(block: string): Snapshot {
  const id = /<(?:task-id|agent-id)>([^<]+)<\/(?:task-id|agent-id)>/.exec(block)?.[1];
  return { id: id && decode(id), status: /<status>([^<]+)<\/status>/.exec(block)?.[1] };
}
/** Completion sources: terminal/error Agent receipts, terminal result fetches, and notifications. */
export function foldSubagentWork(work: SubagentWork, message: Snapshot): void {
  calls(work, message); result(work, message);
  if (message.customType !== "subagent-notification") return;
  completion(work, message.details);
  for (const block of text(message.content).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) completion(work, notificationRecord(block[1]));
}
