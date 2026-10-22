/**
 * subagent-integrity — pure parsing for trustworthy subagent results.
 * A failed/aborted/stopped run is not a completion, and a last pi-phase gate
 * with a non-zero exit blocks a "done" claim unless the result hedges or waives it.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface Notification { id: string; status: string; result: string }
export interface GateExit { exit: number; label: string }

const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const HEDGE = /\b(block(?:ed|s)?|fail(?:ed|s|ing|ure)?|unverified|not (?:done|verified|ready|complete[d]?|passing)|incomplete|waiv(?:ed|er)|skipped|timed? ?out|exit(?:ed)?[= ]+[1-9]\d*|pending|not run|awaiting|did not pass|cannot|could not|unable)\b/i;
/** pi-subagents getStatusLabel: Error…, Aborted…, Stopped. "Wrapped up (turn limit)" and "Done" are not failures. */
const FAILED_STATUS = /^(error|aborted|stopped)\b/i;

export function parseNotifications(content: string): Notification[] {
  const out: Notification[] = [];
  for (const match of content.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(match[1])?.[1];
    if (!id) continue;
    out.push({
      id: decode(id),
      status: decode(/<status>([\s\S]*?)<\/status>/.exec(match[1])?.[1] ?? ""),
      result: decode(/<result>([\s\S]*?)<\/result>/.exec(match[1])?.[1] ?? ""),
    });
  }
  return out;
}

export const isFailedStatus = (status: string): boolean => FAILED_STATUS.test(status.trim());
export const hasHedge = (result: string): boolean => HEDGE.test(result);

/** Last pi-phase exit in one tool-result text: "finished kind=K label=L exit=N" or "log=PATH exit=N lines=M". */
export function gateExitInText(text: string): GateExit | undefined {
  let found: GateExit | undefined;
  for (const m of text.matchAll(/^pi-phase: (?:finished kind=\S+ label=(.*?) exit=(\d+)|log=(\S+) exit=(\d+) lines=\d+)\s*$/gm)) {
    found = m[1] !== undefined ? { label: m[1], exit: Number(m[2]) } : { label: m[3].split("/").pop() ?? m[3], exit: Number(m[4]) };
  }
  return found;
}

/** Last pi-phase exit across a JSONL session transcript (bash tool results only). Malformed lines are skipped. */
export function lastGateExit(jsonl: string): GateExit | undefined {
  let found: GateExit | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.includes("exit=")) continue;
    let entry: { message?: { role?: string; toolName?: string; content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry.message;
    if (msg?.role !== "toolResult" || msg.toolName !== "bash" || !Array.isArray(msg.content)) continue;
    const text = msg.content.map((p: { type?: string; text?: string }) => p?.type === "text" ? p.text ?? "" : "").join("\n");
    found = gateExitInText(text) ?? found;
  }
  return found;
}

export const TAIL_BYTES = 2 * 1024 * 1024;

/** Read at most the last `max` bytes of a file; a leading partial line is dropped. */
export function readTail(file: string, max = TAIL_BYTES): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, start + got); if (n <= 0) break; got += n; }
    const text = buf.toString("utf8", 0, got);
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

export function readLastGateExit(sessionFile: string): GateExit | undefined {
  try { return lastGateExit(readTail(sessionFile)); } catch { return undefined; }
}

export interface RecordLike { sessionFile?: string }

/** Warnings (empty when the result is trustworthy). `gate` is injected for tests. */
export function integrityWarnings(
  n: Notification,
  record: RecordLike | undefined,
  gate: (file: string) => GateExit | undefined = readLastGateExit,
): string[] {
  const warnings: string[] = [];
  if (isFailedStatus(n.status)) {
    warnings.push(`subagent ${n.id}: status "${n.status}" — this is NOT a completion; any text below is partial output, not a result.`);
    return warnings;
  }
  if (!record?.sessionFile) return warnings;
  const last = gate(record.sessionFile);
  if (last && last.exit !== 0 && !hasHedge(n.result)) {
    warnings.push(`subagent ${n.id}: last gate exit=${last.exit} (${last.label}); treat as NOT done unless waived`);
  }
  return warnings;
}
