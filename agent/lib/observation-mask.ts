/**
 * Pure logic for observation-mask (C5): replace stale, large tool-result bodies with a short stub
 * in the per-call context copy, in batches, keeping the masked set stable so the prompt prefix
 * stays byte-identical between calls.
 *
 * Rules (design.md C5):
 *  - eligible: toolResult older than the last `keep` tool results, text > `minChars`, not
 *    edit/write, no images, its call does not contain `# keep`, not an error from the latest turn;
 *  - new masking happens only when the not-yet-masked eligible total reaches `batchTokens`
 *    (chars / 4), and then all of them are masked at once;
 *  - once masked, always masked (the id stays in the caller's set).
 */
import { EXEMPT_TOOLS, countLines } from "./output-cap.ts";

export interface MaskOptions { keep: number; batchTokens: number; minChars: number }
export interface MaskResult { messages: any[]; newlyMasked: string[]; eligibleTokens: number; changed: boolean }

export const CHARS_PER_TOKEN = 4;
const OFFLOAD = /\[full output: (.+?), \d+ lines, \d+ chars; use read/;

function textOf(msg: any): string | undefined {
	if (!Array.isArray(msg.content) || !msg.content.length) return undefined;
	if (msg.content.some((p: any) => p?.type !== "text")) return undefined;
	return msg.content.map((p: any) => p.text ?? "").join("\n");
}

function oneLine(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function argsSummary(toolName: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const a = args as Record<string, any>;
	if (toolName === "bash" && typeof a.command === "string") return oneLine(a.command, 160);
	if (toolName === "read" && typeof a.path === "string") {
		const range = [a.offset != null ? `offset=${a.offset}` : "", a.limit != null ? `limit=${a.limit}` : ""].filter(Boolean).join(" ");
		return oneLine(`${a.path}${range ? ` ${range}` : ""}`, 160);
	}
	if ((toolName === "grep" || toolName === "find") && typeof a.pattern === "string") {
		return oneLine(`${a.pattern}${a.path ? ` in ${a.path}` : ""}`, 160);
	}
	let json = "";
	try { json = JSON.stringify(args); } catch { json = ""; }
	return oneLine(json, 160);
}

export function stubText(toolName: string, args: Record<string, unknown> | undefined, text: string): string {
	const path = OFFLOAD.exec(text)?.[1];
	const summary = argsSummary(toolName, args);
	const where = path ? `Full output: ${path}` : "Re-run or re-read if needed";
	return `[older tool output masked to save context: ${toolName}${summary ? ` ${summary}` : ""}; was ${text.length} chars, ${countLines(text)} lines. ${where}.]`;
}

function callsById(messages: any[]): Map<string, { name: string; arguments: Record<string, unknown> }> {
	const calls = new Map();
	for (const m of messages) {
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const p of m.content) if (p?.type === "toolCall" && typeof p.id === "string") calls.set(p.id, p);
	}
	return calls;
}

function hasKeep(call: { arguments?: unknown } | undefined): boolean {
	if (!call) return false;
	try { return /#\s*keep\b/i.test(JSON.stringify(call.arguments ?? {})); } catch { return false; }
}

/**
 * Apply masking to a context copy. `masked` is the caller's persistent per-session set and is
 * extended in place when a new batch is masked. Returns new message objects only where changed.
 */
export function maskMessages(messages: any[], masked: Set<string>, opts: MaskOptions): MaskResult {
	const resultIdx: number[] = [];
	let lastAssistant = -1;
	messages.forEach((m, i) => {
		if (m?.role === "toolResult") resultIdx.push(i);
		else if (m?.role === "assistant") lastAssistant = i;
	});
	const protectedFrom = resultIdx.length - Math.max(0, opts.keep);
	const calls = callsById(messages);
	const candidates: number[] = [];
	let eligibleChars = 0;

	resultIdx.forEach((i, n) => {
		const m = messages[i];
		if (masked.has(m.toolCallId)) return;
		if (n >= protectedFrom) return;
		if (EXEMPT_TOOLS.has(m.toolName)) return;
		if (m.isError && i > lastAssistant) return;
		const text = textOf(m);
		if (text === undefined || text.length <= opts.minChars) return;
		if (hasKeep(calls.get(m.toolCallId))) return;
		candidates.push(i);
		eligibleChars += text.length;
	});

	const eligibleTokens = Math.round(eligibleChars / CHARS_PER_TOKEN);
	const newlyMasked: string[] = [];
	if (candidates.length && eligibleTokens >= opts.batchTokens) {
		for (const i of candidates) { masked.add(messages[i].toolCallId); newlyMasked.push(messages[i].toolCallId); }
	}
	if (!masked.size) return { messages, newlyMasked, eligibleTokens, changed: false };

	let changed = false;
	const out = messages.map(m => {
		if (m?.role !== "toolResult" || !masked.has(m.toolCallId)) return m;
		const text = textOf(m);
		if (text === undefined) return m;
		changed = true;
		return { ...m, content: [{ type: "text", text: stubText(m.toolName, calls.get(m.toolCallId)?.arguments, text) }] };
	});
	return { messages: changed ? out : messages, newlyMasked, eligibleTokens, changed };
}
