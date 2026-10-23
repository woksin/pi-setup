type RecordLike = Record<string, any>;
export function subagentKeys(record: RecordLike): string[] {
  const fields = { sessionId: "session", sessionFile: "file", agentId: "agent", id: "agent" };
  return Object.entries(fields).flatMap(([field, kind]) =>
    typeof record[field] === "string" && record[field] ? [`${kind}:${record[field]}`] : []);
}
function completed(status: unknown): boolean {
  return typeof status === "string" && /^(done|completed)$/i.test(status.trim());
}
function structured(out: Set<string>, record: RecordLike | undefined): void {
  if (record && completed(record.status)) for (const key of subagentKeys(record)) out.add(key);
}
const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function notificationRecord(block: string): RecordLike {
  const record: RecordLike = { status: /<status>([^<]+)<\/status>/.exec(block)?.[1] };
  for (const [tag, field] of Object.entries({ "task-id": "id", "agent-id": "agentId", "session-id": "sessionId", "session-file": "sessionFile" })) {
    const value = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(block)?.[1];
    if (value) record[field] = decode(value);
  }
  return record;
}
function notifications(out: Set<string>, content: unknown): void {
  const text = typeof content === "string" ? content : "";
  for (const block of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) structured(out, notificationRecord(block[1]));
}
/** Trust only subagent completion channels, never quoted user/assistant text. */
export function foldSubagentCompletions(out: Set<string>, message: RecordLike): void {
  if (message.customType === "subagent-notification") {
    structured(out, message.details); notifications(out, message.content);
  }
  if (message.role === "toolResult" && /^(subagent|get_subagent_result|wait_subagent)$/.test(message.toolName ?? "")) {
    structured(out, message.details);
  }
}
