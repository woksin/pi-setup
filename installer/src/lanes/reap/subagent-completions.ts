type Snapshot = Record<string, any>;
export interface SubagentWork { launches: Map<string, string | undefined>; completed: Set<string> }
function text(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
}
function agentId(message: Snapshot): string | undefined {
  const id = message.details?.agentId ?? message.details?.id;
  if (typeof id === "string" && id) return id;
  return /\bAgent ID:\s*(\S+)/.exec(text(message.content))?.[1];
}
function agentCall(part: Snapshot): boolean {
  return part.type === "toolCall" && part.name === "Agent" && typeof part.id === "string";
}
function launch(work: SubagentWork, part: Snapshot): void {
  if (agentCall(part)) work.launches.set(part.id, undefined);
}
function calls(work: SubagentWork, message: Snapshot): void {
  if (message.role === "toolCall") launch(work, { ...message, type: "toolCall" });
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content) launch(work, part);
}
function agentResult(message: Snapshot): boolean {
  return message.role === "toolResult" && message.toolName === "Agent";
}
function result(work: SubagentWork, message: Snapshot): void {
  if (!agentResult(message) || !work.launches.has(message.toolCallId)) return;
  if (message.isError) work.launches.delete(message.toolCallId);
  else work.launches.set(message.toolCallId, agentId(message));
}
function terminal(status: unknown): boolean {
  return typeof status === "string" && /^(done|completed|failed|error|aborted|stopped|wrapped up)\b/i.test(status.trim());
}
function completion(work: SubagentWork, record: Snapshot | undefined): void {
  if (!record || !terminal(record.status)) return;
  const id = record.agentId ?? record.id;
  if (typeof id === "string" && id) work.completed.add(id);
}
const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function notificationRecord(block: string): Snapshot {
  const id = /<(?:task-id|agent-id)>([^<]+)<\/(?:task-id|agent-id)>/.exec(block)?.[1];
  return { id: id && decode(id), status: /<status>([^<]+)<\/status>/.exec(block)?.[1] };
}
/** Only completion notifications settle launches; quoted text and tool receipts do not. */
export function foldSubagentWork(work: SubagentWork, message: Snapshot): void {
  calls(work, message); result(work, message);
  if (message.customType !== "subagent-notification") return;
  completion(work, message.details);
  for (const block of text(message.content).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) completion(work, notificationRecord(block[1]));
}
