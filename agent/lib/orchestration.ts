/**
 * orchestration — shared helpers so guards never stall an orchestrated lane.
 *
 * In orchestration sessions every guard decision is immediate: allow (logged) or deny with an
 * actionable reason. Interactive prompts that remain are bounded (≤ 60 s); a timed-out prompt
 * resolves to the guard's default decision and posts an ALL notice to the lanes' message board.
 *
 * Orchestrated when: PI_ORCH_ID is set, OR the operator switch file exists
 * (~/.pi/agent/orchestration-mode), OR cwd is under the Cratis repos root while the lane message
 * directory exists (both set in ~/.pi/agent/user.json as orchRepoRoot/orchMessagesDir). Path overrides (tests/operators): PI_ORCH_MODE_FILE, PI_ORCH_REPO_ROOT,
 * PI_ORCH_MESSAGES_DIR, PI_GUARD_DECISIONS_LOG. Nothing here ever throws.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const PROMPT_TIMEOUT_MS = 60_000;

const agentDir = () => join(homedir(), ".pi", "agent");
export const modeFile = (env: NodeJS.ProcessEnv = process.env) => env.PI_ORCH_MODE_FILE || join(agentDir(), "orchestration-mode");
/** Per-user defaults from ~/.pi/agent/user.json: `orchRepoRoot` and `orchMessagesDir` (both optional). */
function userConfig(): { orchRepoRoot?: string; orchMessagesDir?: string } {
	try { return JSON.parse(readFileSync(join(agentDir(), "user.json"), "utf8")) ?? {}; } catch { return {}; }
}
export const repoRoot = (env: NodeJS.ProcessEnv = process.env) => env.PI_ORCH_REPO_ROOT || userConfig().orchRepoRoot || "";
export const messagesDir = (env: NodeJS.ProcessEnv = process.env) => {
	const root = repoRoot(env);
	return env.PI_ORCH_MESSAGES_DIR || userConfig().orchMessagesDir || (root ? join(root, ".ai-work", "messages") : "");
};
export const decisionsLog = (env: NodeJS.ProcessEnv = process.env) => env.PI_GUARD_DECISIONS_LOG || join(agentDir(), "logs", "guard-decisions.jsonl");

function under(child: string, parent: string): boolean {
	const c = resolve(child), p = resolve(parent);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** True when this session is part of an orchestration (L0/lane) system. */
export function isOrchestrated(env: NodeJS.ProcessEnv = process.env, cwd: string | undefined = undefined): boolean {
	try {
		if (env.PI_ORCH_ID?.trim()) return true;
		if (existsSync(modeFile(env))) return true;
		const root = repoRoot(env), messages = messagesDir(env);
		return !!cwd && !!root && !!messages && under(cwd, root) && existsSync(messages);
	} catch {
		return false;
	}
}

/** Append one JSON line describing a guard decision. Never throws. */
export function orchLog(guard: string, decision: string, detail: string, env: NodeJS.ProcessEnv = process.env): void {
	try {
		const file = decisionsLog(env);
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, session: env.PI_SESSION_ID, orch: env.PI_ORCH_ID, guard, decision, detail: detail.slice(0, 2000) }) + "\n");
	} catch { /* logging must never affect a decision */ }
}

/** Post ALL-guard-<guard>-<HHMM>.md into the lane message directory, if it exists. Never throws. */
export function postAllNotice(guard: string, text: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string | undefined {
	try {
		const dir = messagesDir(env);
		if (!existsSync(dir)) return undefined;
		const hhmm = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
		const safe = guard.replace(/[^A-Za-z0-9_-]/g, "-");
		let file = join(dir, `ALL-guard-${safe}-${hhmm}.md`);
		for (let n = 2; existsSync(file); n++) file = join(dir, `ALL-guard-${safe}-${hhmm}-${n}.md`);
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `# Guard notice: ${guard} (${now.toISOString()})\n\n${text}\n`);
		renameSync(tmp, file);
		return file;
	} catch {
		return undefined;
	}
}

interface DialogUI {
	select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
}

/**
 * A guard prompt that cannot hang: pi's own dialog timeout plus an independent timer that
 * dismisses the dialog, in case a UI ignores the timeout option.
 */
export async function boundedSelect(ui: DialogUI, title: string, options: string[], ms = PROMPT_TIMEOUT_MS): Promise<{ choice: string | undefined; timedOut: boolean }> {
	const controller = new AbortController();
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"timeout">(done => { timer = setTimeout(() => { controller.abort(); done("timeout"); }, ms); });
	try {
		const result = await Promise.race([ui.select(title, options, { signal: controller.signal, timeout: ms }), expired]);
		if (result === "timeout") return { choice: undefined, timedOut: true };
		// pi's own timeout resolves undefined; treat an unanswered dialog near the limit as timed out.
		return { choice: result, timedOut: controller.signal.aborted || (result === undefined && Date.now() - started >= ms - 1000) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A bounded guard prompt. On timeout the decision is logged and, in orchestration sessions, an ALL
 * notice tells the lanes which call was resolved to the default (`fallback`) instead of waiting.
 */
export async function guardSelect(ui: DialogUI, guard: string, title: string, options: string[],
	fallback: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string; ms?: number } = {}): Promise<{ choice: string | undefined; timedOut: boolean }> {
	const env = opts.env ?? process.env;
	const result = await boundedSelect(ui, title, options, opts.ms ?? PROMPT_TIMEOUT_MS);
	if (result.timedOut) {
		orchLog(guard, `timeout:${fallback}`, title, env);
		if (isOrchestrated(env, opts.cwd)) postAllNotice(guard,
			`A ${guard} guard prompt got no answer within ${Math.round((opts.ms ?? PROMPT_TIMEOUT_MS) / 1000)} s and resolved to: ${fallback}.\n\n` +
			`Session: ${env.PI_SESSION_ID ?? "unknown"} (pid ${process.pid}).\n\nPrompt:\n\n${title.slice(0, 1500)}`, env);
	}
	return result;
}
