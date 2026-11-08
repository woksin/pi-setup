/**
 * Pure logic for the delegation-nudge extension: count direct reading (read/grep/find/ls tools and
 * read-like bash commands) in main sessions and, once a window of reads grows past a byte or call
 * threshold without an Agent/SubagentWorkflow call, append a one-line reminder to the tool result.
 *
 * Classification of bash is a conservative command-name allow-list on the command string; it errs
 * towards NOT counting (builds, tests, gh, git bookkeeping and anything writing are `other`).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Part } from "./output-cap.ts";

export type Kind = "read" | "delegation" | "other";
export interface State { bytes: number; calls: number; rearmAt?: number }
export interface Thresholds { thresholdBytes: number; thresholdCalls: number }

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const DELEGATION_TOOLS = new Set(["Agent", "SubagentWorkflow"]);
const READ_COMMANDS = new Set(["cat", "sed", "head", "tail", "nl", "awk", "grep", "rg", "find", "ls", "tree", "wc", "bat"]);
const DIFF_SUMMARY = /(^|\s)--(stat|shortstat|numstat|name-only|name-status)\b/;

function gitReads(args: string[]): boolean {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i += ["-C", "-c"].includes(args[i]) ? 2 : 1;
	const sub = args[i], rest = args.slice(i + 1).join(" ");
	if (sub === "grep" || sub === "show" || sub === "blame") return true;
	if (sub === "diff") return !DIFF_SUMMARY.test(" " + rest);
	if (sub === "log") return /(^|\s)(-p|--patch)\b/.test(rest);
	return false;
}

function segmentReads(segment: string): boolean {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
	const cmd = words[0]?.split("/").pop();
	if (!cmd) return false;
	if (cmd === "git") return gitReads(words.slice(1));
	if (cmd === "sed" && words.some(w => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) return false;
	return READ_COMMANDS.has(cmd);
}

export function classifyResult(toolName: string, input: Record<string, unknown> | undefined): Kind {
	if (READ_TOOLS.has(toolName)) return "read";
	if (DELEGATION_TOOLS.has(toolName)) return "delegation";
	if (toolName !== "bash") return "other";
	const command = typeof input?.command === "string" ? input.command : "";
	const cleaned = command.replace(/\d*>&\d+/g, "").replace(/\d*>\s*\/dev\/null/g, "");
	if (/>|\btee\b/.test(cleaned)) return "other";
	return cleaned.split(/;|&&|\|\||\||\n/).some(segmentReads) ? "read" : "other";
}

export const newState = (): State => ({ bytes: 0, calls: 0 });

/** Advance the window. Fires when bytes or calls reach the threshold; re-arms after another `thresholdBytes`. */
export function step(state: State, kind: Kind, bytes: number, t: Thresholds): { state: State; nudge?: { bytes: number; calls: number } } {
	if (kind === "delegation") return { state: newState() };
	if (kind !== "read") return { state };
	const next: State = { ...state, bytes: state.bytes + bytes, calls: state.calls + 1 };
	const due = next.rearmAt === undefined
		? next.bytes >= t.thresholdBytes || next.calls >= t.thresholdCalls
		: next.bytes >= next.rearmAt;
	if (!due) return { state: next };
	next.rearmAt = next.bytes + t.thresholdBytes;
	return { state: next, nudge: { bytes: next.bytes, calls: next.calls } };
}

export function textBytes(content: Part[]): number {
	let n = 0;
	for (const p of content) if (p.type === "text" && typeof (p as any).text === "string") n += Buffer.byteLength((p as any).text, "utf8");
	return n;
}

export function nudgeText(bytes: number, calls: number): string {
	return `[delegation-nudge] ${calls} direct reads/searches (${bytes} bytes) since your last subagent call: over investigation budget, delegate the next step to Explore (where/how is X implemented) or ops (read/summarise code or logs) and ask for a short answer.`;
}

/** Original parts followed by the nudge; undefined (leave untouched) when the result carries images. */
export function withNudge(content: Part[], text: string): Part[] | undefined {
	if (content.some(p => p.type !== "text")) return undefined;
	return [...content, { type: "text", text }];
}

export interface Telemetry { session: string; cwd: string; bytes: number; calls: number; thresholdBytes: number; thresholdCalls: number; tool: string; kind: Kind }

export function telemetryPath(): string {
	return process.env.PI_DELEGATION_NUDGE_FILE || join(homedir(), ".pi", "agent", "logs", "delegation-nudge.jsonl");
}

/** One JSON line per nudge; no commands or paths from the tool call. Never throws. */
export function appendTelemetry(entry: Telemetry, file = telemetryPath()): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
	} catch { /* logging must never throw */ }
}
