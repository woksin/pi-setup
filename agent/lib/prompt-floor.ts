/**
 * prompt-floor — measures the fixed prompt every turn starts from (system prompt sections, context files,
 * tool schemas) and loads the small config shared with the skill compaction. Pure functions plus a tolerant
 * config reader; nothing here throws on odd input. Token figures are estimates from a regression over
 * 167 real first turns: tokens ≈ 12700 + 0.338 × bytes.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_BASE = 12_700;
export const TOKENS_PER_BYTE = 0.338;
export const DEFAULT_WARN_TOKENS = 100_000;

export interface FloorTool { name: string; description?: string; parameters?: unknown }
export interface FloorInput {
	/** Fully rendered system prompt text. */
	systemPrompt: string;
	systemPromptOptions?: { contextFiles?: { path: string; content: string }[]; skills?: unknown[] };
	/** The tools sent to the model (active ones). */
	tools: FloorTool[];
}
export interface FloorMeasurement {
	/** Bytes per top-level system prompt section; the untagged lead is `preamble`. */
	sections: Record<string, number>;
	skillsBytes: number;
	contextFileBytes: Record<string, number>;
	/** Tools sorted by size, largest first. */
	tools: { name: string; bytes: number }[];
	toolsBytes: number;
	promptBytes: number;
	totalBytes: number;
	estTokens: number;
}

export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
export const estimateTokens = (bytes: number): number => Math.round(TOKEN_BASE + TOKENS_PER_BYTE * bytes);

/** Splits a rendered prompt into `<name>…</name>` blocks joined by blank lines; text before the first block is the preamble. */
export function splitSections(prompt: string): Record<string, number> {
	const result: Record<string, number> = {};
	const open = /(^|\n\n)<([a-z][a-z0-9_-]*)>\n/g;
	let start = 0;
	let match: RegExpExecArray | null;
	let first = true;
	while ((match = open.exec(prompt))) {
		const name = match[2];
		const close = prompt.indexOf(`\n</${name}>`, match.index + match[0].length);
		if (close < 0) continue;
		const blockStart = match.index + match[1].length;
		const end = close + `\n</${name}>`.length;
		if (first) { result.preamble = byteLength(prompt.slice(0, match.index)); first = false; }
		else if (prompt.slice(start, blockStart).trim()) result.other = (result.other ?? 0) + byteLength(prompt.slice(start, blockStart));
		result[name] = (result[name] ?? 0) + byteLength(prompt.slice(blockStart, end));
		start = end;
		open.lastIndex = end;
	}
	if (first) return { preamble: byteLength(prompt) };
	const tail = prompt.slice(start);
	if (tail.trim()) result.other = (result.other ?? 0) + byteLength(tail);
	return result;
}

export function measureFloor(input: FloorInput): FloorMeasurement {
	const sections = splitSections(input.systemPrompt ?? "");
	const contextFileBytes: Record<string, number> = {};
	for (const file of input.systemPromptOptions?.contextFiles ?? []) contextFileBytes[file.path] = byteLength(file.content ?? "");
	const tools = (input.tools ?? [])
		.map((tool) => ({ name: tool.name, bytes: byteLength(tool.description ?? "") + byteLength(JSON.stringify(tool.parameters ?? {})) }))
		.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	const toolsBytes = tools.reduce((sum, tool) => sum + tool.bytes, 0);
	const promptBytes = byteLength(input.systemPrompt ?? "");
	const totalBytes = promptBytes + toolsBytes;
	return { sections, skillsBytes: sections.skills ?? 0, contextFileBytes, tools, toolsBytes, promptBytes, totalBytes, estTokens: estimateTokens(totalBytes) };
}

export const formatKb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
export const statusText = (m: FloorMeasurement, warnTokens = DEFAULT_WARN_TOKENS): string =>
	`floor ~${Math.round(m.estTokens / 1000)}k${m.estTokens > warnTokens ? " !" : ""}`;

/** Human-readable table for `/floor`. */
export function formatFloor(m: FloorMeasurement, warnTokens = DEFAULT_WARN_TOKENS): string {
	const lines = [`${statusText(m, warnTokens)} tokens (est.), ${formatKb(m.totalBytes)} total: prompt ${formatKb(m.promptBytes)}, tools ${formatKb(m.toolsBytes)} (${m.tools.length})`];
	lines.push("Sections:");
	for (const [name, bytes] of Object.entries(m.sections).sort((a, b) => b[1] - a[1])) lines.push(`  ${name}: ${formatKb(bytes)}`);
	const files = Object.entries(m.contextFileBytes).sort((a, b) => b[1] - a[1]);
	if (files.length) { lines.push("Context files:"); for (const [path, bytes] of files) lines.push(`  ${path}: ${formatKb(bytes)}`); }
	lines.push("Largest tools:");
	for (const tool of m.tools.slice(0, 10)) lines.push(`  ${tool.name}: ${formatKb(tool.bytes)}`);
	return lines.join("\n");
}

export interface FloorConfig {
	warnTokens: number;
	skills: { projectMode: "compact" | "full"; keepFull: string[]; descChars: number; maxBytes: number };
}
export const DEFAULT_CONFIG: FloorConfig = {
	warnTokens: DEFAULT_WARN_TOKENS,
	skills: { projectMode: "compact", keepFull: [], descChars: 80, maxBytes: 24_000 },
};

const positive = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** Config from `prompt-floor.json` (PI_FLOOR_FILE or ~/.pi/agent/prompt-floor.json) plus env overrides; missing or broken file = defaults. */
export function loadFloorConfig(env: NodeJS.ProcessEnv = process.env, file = env.PI_FLOOR_FILE || join(homedir(), ".pi", "agent", "prompt-floor.json")): FloorConfig {
	let raw: any = {};
	try { raw = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch { /* defaults */ }
	const skills = raw && typeof raw.skills === "object" && raw.skills ? raw.skills : {};
	const keepFull = [
		...(Array.isArray(skills.keepFull) ? skills.keepFull.filter((x: unknown): x is string => typeof x === "string") : []),
		...(env.PI_FLOOR_FULL_SKILLS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
	];
	const off = (env.PI_FLOOR ?? "").trim().toLowerCase() === "off";
	return {
		warnTokens: positive(raw.warnTokens, DEFAULT_CONFIG.warnTokens),
		skills: {
			projectMode: off || skills.projectMode === "full" ? "full" : "compact",
			keepFull,
			descChars: positive(skills.descChars, DEFAULT_CONFIG.skills.descChars),
			maxBytes: positive(skills.maxBytes, DEFAULT_CONFIG.skills.maxBytes),
		},
	};
}
