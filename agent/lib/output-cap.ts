/**
 * Pure logic for the output-cap (C4) and observation-mask (C5) extensions, plus the shared
 * efficiency config (`~/.pi/agent/efficiency.json`) and main/subagent role detection.
 *
 * C4: a text tool result over `maxChars` is cut to head (~60%) + kept failure lines (bash
 * test/build output only, at most ~2k chars) + tail (~40%) + a marker naming the offload file
 * with the full text. Applied once, in `tool_result`, so nothing already in context changes.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------------------------
// Config and gating
// ---------------------------------------------------------------------------------------------

export type Scope = "all" | "subagents" | "main" | "off";
export type Role = "main" | "subagent" | "unknown";

export interface EfficiencyConfig {
	outputCap: { enabled: boolean; maxChars: number; scope: Scope };
	observationMask: { enabled: boolean; keep: number; batchTokens: number; minChars: number; scope: Scope };
}

/** Values used for fields the file leaves out. A missing or unreadable file disables both features. */
export const DEFAULTS: EfficiencyConfig = {
	outputCap: { enabled: true, maxChars: 12000, scope: "all" },
	observationMask: { enabled: true, keep: 15, batchTokens: 30000, minChars: 1000, scope: "subagents" },
};
export const DISABLED: EfficiencyConfig = {
	outputCap: { ...DEFAULTS.outputCap, enabled: false },
	observationMask: { ...DEFAULTS.observationMask, enabled: false },
};

const SCOPES = new Set<Scope>(["all", "subagents", "main", "off"]);
const num = (v: unknown, d: number, min: number) => (typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : d);
const scope = (v: unknown, d: Scope): Scope => (SCOPES.has(v as Scope) ? (v as Scope) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

export function parseConfig(raw: unknown): EfficiencyConfig {
	if (!raw || typeof raw !== "object") return DISABLED;
	const r = raw as Record<string, any>;
	const c = r.outputCap ?? {}, m = r.observationMask ?? {};
	const d = DEFAULTS;
	return {
		outputCap: {
			enabled: r.outputCap ? bool(c.enabled, d.outputCap.enabled) : false,
			maxChars: num(c.maxChars, d.outputCap.maxChars, 1000),
			scope: scope(c.scope, d.outputCap.scope),
		},
		observationMask: {
			enabled: r.observationMask ? bool(m.enabled, d.observationMask.enabled) : false,
			keep: num(m.keep, d.observationMask.keep, 0),
			batchTokens: num(m.batchTokens, d.observationMask.batchTokens, 0),
			minChars: num(m.minChars, d.observationMask.minChars, 0),
			scope: scope(m.scope, d.observationMask.scope),
		},
	};
}

export function configPath(): string {
	return process.env.PI_EFFICIENCY_FILE || join(homedir(), ".pi", "agent", "efficiency.json");
}

let cache: { path: string; mtimeMs: number; size: number; config: EfficiencyConfig } | undefined;

/** Re-read per event, but only parse when the file's mtime/size changed. */
export function loadConfig(path = configPath()): EfficiencyConfig {
	let st;
	try { st = statSync(path); } catch { cache = undefined; return DISABLED; }
	if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.config;
	let config = DISABLED;
	try { config = parseConfig(JSON.parse(readFileSync(path, "utf8"))); } catch { /* invalid file: disabled */ }
	cache = { path, mtimeMs: st.mtimeMs, size: st.size, config };
	return config;
}

export function scopeAllows(s: Scope, role: Role): boolean {
	if (s === "all") return true;
	if (s === "subagents") return role === "subagent";
	if (s === "main") return role === "main";
	return false;
}

/**
 * Main vs subagent. pi-subagents runs children in-process via createAgentSession, so there is
 * no env var or API flag. Rule (process-global, shared by both extensions):
 *  - the first session to start in the process is the main session;
 *  - a session_start with reason new/resume/fork comes from the interactive runtime switching
 *    the main session (subagents always start with reason "startup"), so it becomes main;
 *  - any other session id is a subagent. "reload" keeps the current role.
 */
export class SessionRoles {
	primary?: string;
	start(sessionId: string, reason: string | undefined): Role {
		if (!this.primary || reason === "new" || reason === "resume" || reason === "fork") this.primary = sessionId;
		return this.role(sessionId);
	}
	role(sessionId: string | undefined): Role {
		if (!sessionId || !this.primary) return "unknown";
		return sessionId === this.primary ? "main" : "subagent";
	}
}

export function processRoles(): SessionRoles {
	const key = Symbol.for("pi-efficiency.session-roles");
	const g = globalThis as Record<symbol, unknown>;
	g[key] ??= new SessionRoles();
	return g[key] as SessionRoles;
}

// ---------------------------------------------------------------------------------------------
// Capping
// ---------------------------------------------------------------------------------------------

export interface TextPart { type: "text"; text: string }
export type Part = TextPart | { type: string; [k: string]: unknown };

export const EXEMPT_TOOLS = new Set(["edit", "write"]);
export const FAILURE_LINE = /\b(?:error|errors|fail|failed|failure|failures|exception)\b|\bFAIL\b|exit=|✗/i;
const TEST_COMMAND = /\b(?:test|tests|build|dotnet|npm|npx|yarn|pnpm|jest|vitest|mocha|pytest|cargo|go\s+test|make|tsc|mvn|gradle|pi-phase|node\s+--test|eslint|lint)\b/;
const TEST_OUTPUT = /\b(?:Passed!|Failed!|Tests?:|Test Run|Build (?:succeeded|FAILED)|error [A-Z]{2,}\d+|npm ERR!|\d+ passing|\d+ failing|# (?:pass|fail) \d+)/;
export const FAILURE_BUDGET = 2000;

/** Whether this result is a candidate at all (text-only, not edit/write, over the limit). */
export function capText(toolName: string, content: Part[], maxChars: number): string | undefined {
	if (EXEMPT_TOOLS.has(toolName)) return undefined;
	if (!content.length || content.some(p => p.type !== "text")) return undefined;
	const text = content.map(p => (p as TextPart).text).join("\n");
	return text.length > maxChars ? text : undefined;
}

export function looksLikeTestOrBuild(toolName: string, input: Record<string, unknown>, text: string): boolean {
	if (toolName !== "bash") return false;
	const command = typeof input.command === "string" ? input.command : "";
	return TEST_COMMAND.test(command) || TEST_OUTPUT.test(text.slice(0, 4000)) || TEST_OUTPUT.test(text.slice(-4000));
}

export function countLines(text: string): number {
	if (!text) return 0;
	let n = 1;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
	return text.endsWith("\n") ? n - 1 : n;
}

/** Cut at a line break near `at` when one is reasonably close, so lines are not split. */
function headEnd(text: string, budget: number): number {
	const nl = text.lastIndexOf("\n", budget);
	return nl > budget * 0.5 ? nl + 1 : budget;
}
function tailStart(text: string, budget: number): number {
	const start = text.length - budget;
	const nl = text.indexOf("\n", start);
	return nl !== -1 && nl - start < budget * 0.5 ? nl + 1 : start;
}

export function marker(path: string | undefined, lines: number, chars: number): string {
	return path
		? `[full output: ${path}, ${lines} lines, ${chars} chars; use read with offset/limit or grep]`
		: `[output truncated: ${lines} lines, ${chars} chars; full output could not be saved, re-run with a narrower command]`;
}

/**
 * Build the capped text: head + elision note (+ failure lines) + tail + marker.
 * The head/tail/failure parts together stay within `maxChars`; the notes and marker are extra.
 */
export function truncate(text: string, maxChars: number, opts: { keepFailures: boolean; path?: string }): string {
	const lines = countLines(text);
	let failures: string[] = [];
	let failChars = 0;
	const failBudget = opts.keepFailures ? Math.min(FAILURE_BUDGET, Math.floor(maxChars * 0.2)) : 0;
	let body = maxChars;
	let hEnd = headEnd(text, Math.floor(body * 0.6));
	let tStart = Math.max(hEnd, tailStart(text, body - hEnd));
	if (failBudget > 0) {
		const middle = text.slice(hEnd, tStart).split("\n");
		for (const line of middle) {
			if (!FAILURE_LINE.test(line)) continue;
			const l = line.length > 300 ? `${line.slice(0, 300)}…` : line;
			if (failChars + l.length + 1 > failBudget) break;
			failures.push(l);
			failChars += l.length + 1;
		}
		if (failures.length) {
			body = maxChars - failChars;
			hEnd = headEnd(text, Math.floor(body * 0.6));
			tStart = Math.max(hEnd, tailStart(text, body - hEnd));
		}
	}
	const elided = countLines(text.slice(hEnd, tStart));
	const parts = [text.slice(0, hEnd).replace(/\n$/, "")];
	parts.push(`[... ${elided} lines elided ...]`);
	if (failures.length) parts.push(`[failure-like lines from the elided part:]\n${failures.join("\n")}\n[... end of kept lines ...]`);
	parts.push(text.slice(tStart).replace(/\n$/, ""));
	parts.push(marker(opts.path, lines, text.length));
	return parts.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Offload location
// ---------------------------------------------------------------------------------------------

export function safeName(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "call";
}

export function repoRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
}

/** Candidate directories, in order: `<repo root>/.ai-work/tool-out/<session>`, then `~/.ai-work/tool-out/<session>`. */
export function offloadDirs(cwd: string, sessionId: string, home = homedir()): string[] {
	const s = safeName(sessionId);
	const root = repoRoot(cwd);
	const dirs = root ? [join(root, ".ai-work", "tool-out", s)] : [];
	dirs.push(join(home, ".ai-work", "tool-out", s));
	return dirs;
}

/** Write the full text to the first writable candidate; returns the path or undefined. */
export function offload(text: string, dirs: string[], toolCallId: string): string | undefined {
	for (const dir of dirs) {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const path = join(dir, `${safeName(toolCallId)}.txt`);
			writeFileSync(path, text, { mode: 0o600 });
			return path;
		} catch { /* try next */ }
	}
	return undefined;
}

/** Full C4 decision for one result. Returns replacement content, or undefined to leave it alone. */
export function capResult(
	event: { toolName: string; toolCallId: string; input: Record<string, unknown>; content: Part[] },
	maxChars: number,
	dirs: string[],
): TextPart[] | undefined {
	const text = capText(event.toolName, event.content, maxChars);
	if (text === undefined) return undefined;
	const path = offload(text, dirs, event.toolCallId);
	const keepFailures = looksLikeTestOrBuild(event.toolName, event.input ?? {}, text);
	return [{ type: "text", text: truncate(text, maxChars, { keepFailures, path }) }];
}

// ---------------------------------------------------------------------------------------------
// Error log + retention
// ---------------------------------------------------------------------------------------------

export function errorLogPath(): string {
	return process.env.PI_EFFICIENCY_ERRORS_FILE || join(homedir(), ".pi", "agent", "logs", "efficiency-errors.jsonl");
}

/** Append one JSON line {ts, ext, event, message}. Never throws. */
export function logError(ext: string, event: string, err: unknown, file = errorLogPath()): void {
	try {
		const message = err instanceof Error ? err.message : String(err);
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ext, event, message }) + "\n");
	} catch { /* logging must never throw */ }
}

export const RETENTION_MS = 3 * 24 * 3600 * 1000;
export const PRUNE_INTERVAL_MS = 3600 * 1000;

/** A tool-out dir is only prunable if literally named `tool-out` under a parent named `.ai-work`. */
export function isToolOutDir(dir: string): boolean {
	return basename(dir) === "tool-out" && basename(dirname(dir)) === ".ai-work";
}

/**
 * Delete regular files older than `maxAgeMs` in `<toolOut>/<session>/`, then remove emptied session
 * directories. Never follows symlinks. Returns the number of files removed.
 */
export function pruneToolOut(toolOut: string, now = Date.now(), maxAgeMs = RETENTION_MS): number {
	if (!isToolOutDir(toolOut)) return 0;
	let removed = 0;
	const top = lstatSync(toolOut);
	if (!top.isDirectory() || top.isSymbolicLink()) return 0;
	for (const name of readdirSync(toolOut)) {
		const sdir = join(toolOut, name);
		const st = lstatSync(sdir);
		if (!st.isDirectory() || st.isSymbolicLink()) continue;
		for (const f of readdirSync(sdir)) {
			const fp = join(sdir, f);
			const fst = lstatSync(fp);
			if (fst.isFile() && !fst.isSymbolicLink() && now - fst.mtimeMs > maxAgeMs) { unlinkSync(fp); removed++; }
		}
		if (readdirSync(sdir).length === 0) rmdirSync(sdir);
	}
	return removed;
}

let lastPruneAt = 0;
export function resetPruneGuard(): void { lastPruneAt = 0; }

/** Prune home and repo-root tool-out dirs at most once per hour per process. Fail-open, logs errors. */
export function pruneOncePerHour(ext: string, cwd: string, now = Date.now(), home = homedir()): boolean {
	if (lastPruneAt && now - lastPruneAt < PRUNE_INTERVAL_MS) return false;
	lastPruneAt = now;
	const root = (() => { try { return repoRoot(cwd); } catch { return undefined; } })();
	const dirs = [join(home, ".ai-work", "tool-out")];
	if (root) dirs.push(join(root, ".ai-work", "tool-out"));
	for (const d of dirs) {
		try { if (existsSync(d)) pruneToolOut(d, now); } catch (e) { logError(ext, "prune", e); }
	}
	return true;
}
