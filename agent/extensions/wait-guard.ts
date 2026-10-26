/**
 * wait-guard — deterministic enforcement of the execution-budget rules in AGENTS.md.
 * Turn off with /guards off wait (add --persist); the default 600 s timeout stays active.
 *
 * Instructions alone did not stop agents from blocking the session for ~50 minutes with
 * `sleep 120; while …; do gh pr checks …; sleep 120; done` under a 3550 s timeout. For
 * every foreground `bash` call this extension:
 *   - caps the timeout: a missing timeout becomes 600 s; more than 600 s is blocked outright
 *     (no prompt) with guidance to shorten it or run the work in the background;
 *   - blocks sleep combined with an actual CI/status query, even without a loop,
 *     so short sleep-and-check chains cannot waste repeated model turns;
 *   - blocks polling loops: a loop that sleeps and checks CI/PR status, or any loop that
 *     sleeps ≥ 30 s per iteration;
 *   - blocks long plain waits: ≥ 60 s of `sleep` outside a loop;
 *   - when `job_start` (pi-jobs) is available, blocks foreground `gh run watch` / `gh pr checks --watch`
 *     and points to `job_start` / `job_watch`, whose completion notification wakes the agent.
 *   - blocks repeated status polls across calls: the same `gh pr checks` / `gh run view|list` /
 *     statusCheckRollup query run a third time within 15 minutes (session-local; see PollTracker).
 * pi-jobs tools themselves are not guarded: background waiting is the intended path.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isGuardOff } from "../lib/guards.ts";
import { isOrchestrated, orchLog } from "../lib/orchestration.ts";

export const MAX_TIMEOUT_SECONDS = 600;
const LOOP_SLEEP_LIMIT = 30;
const PLAIN_SLEEP_LIMIT = 60;

const CI_STATUS = /\bgh\s+(?:pr\s+(?:checks|view|status)|run\s+(?:view|list|watch)|api)\b|\bgh\s+.*\b(?:statusCheckRollup|check-runs)\b/;
const LOOP = /\b(?:while|until|for)\b[\s\S]*?\bdo\b([\s\S]*)\bdone\b/;

function sleepSeconds(text: string): number[] {
	const units: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
	return [...text.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g)].map(m => Number(m[1]) * units[m[2]]);
}

const PHASE_SLACK_SECONDS = 60;

/**
 * Outer timeout a pi-phase command legitimately needs: Σ(--timeout + --queue-timeout) per `run`,
 * plus slack. Queue time is not execution time, and pi-phase itself enforces the 600 s execution
 * cap (`--approved-long-timeout`), so the guard should not double-charge it. Queue budgets up to
 * 7200 s need no pi-phase approval, but foreground waits over 600 s still use the normal long-timeout
 * rules (return undefined); long queue waits belong in background jobs (`job_start`).
 */
export function piPhaseBudget(command: string): number | undefined {
	if (!/\bpi-phase\b/.test(command)) return undefined;
	const runs = command.split(/\brun\s+(?=--)/).slice(1);
	if (!runs.length) return undefined;
	let total = 0;
	for (const run of runs) {
		const exec = Number(/--timeout[\s=]+(\d+)/.exec(run)?.[1] ?? 300);
		const queue = Number(/--queue-timeout[\s=]+(\d+)/.exec(run)?.[1] ?? 120);
		const approved = /--approved-long-timeout\b/.test(run);
		if ((exec > MAX_TIMEOUT_SECONDS && !approved) || queue > MAX_TIMEOUT_SECONDS) return undefined;
		if (exec > MAX_TIMEOUT_SECONDS) return undefined; // approved long run: let the user confirm the outer timeout
		total += exec + queue;
	}
	return total + PHASE_SLACK_SECONDS;
}

/** The delimiter a line closes: trimmed for legacy callers, shell-exact (tabs only for `<<-`) when `exact`. */
function heredocTerminator(line: string, mode: { exact: boolean; dash: boolean }): string {
	if (!mode.exact) return line.replace(/^\t+/, "").trim();
	return mode.dash ? line.replace(/^\t+/, "") : line;
}

/**
 * Split a shell command into simple commands (on unquoted `;`, `&`, `|`, parentheses, newlines) and
 * each into words, honouring single/double quotes and backslash escapes. Heredoc bodies and quoted
 * text are data, not commands. Approximate, not a full shell parser: it only has to find real
 * `gh`/`git` invocations without matching text that merely mentions them. Heredoc terminators are
 * trimmed by default (existing callers); `exactHeredoc` opts in to shell-exact matching (whole line, leading
 * tabs stripped only for `<<-`) for callers where a swallowed command matters.
 */
export function simpleCommands(command: string, includeSubstitutions = false, exactHeredoc = false): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | null = null;
	let heredoc: string | null = null, heredocDash = false;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) out.push(words);
		words = [];
	};
	for (const line of command.replace(/\\\r?\n/g, " ").split("\n")) {
		if (heredoc !== null && !quote) {
			if (heredocTerminator(line, { exact: exactHeredoc, dash: heredocDash }) === heredoc) heredoc = null;
			continue;
		}
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (includeSubstitutions && quote !== "'") {
				const substitution = shellSubstitution(line, i);
				if (substitution) {
					out.push(...expandedCommands(substitution.body, 1, true));
					word += line.slice(i, substitution.end + 1);
					inWord = true;
					i = substitution.end;
					continue;
				}
			}
			if (quote) {
				if (c === quote) quote = null;
				else if (c === "\\" && quote === '"' && i + 1 < line.length && "$`\"\\".includes(line[i + 1])) word += line[++i];
				else word += c;
				continue;
			}
			if (c === "'" || c === '"') {
				quote = c;
				inWord = true;
			} else if (c === "\\" && i + 1 < line.length) {
				word += line[++i];
				inWord = true;
			} else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
				const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(i));
				if (m) {
					[heredoc, heredocDash] = [m[3], m[1] === "-"];
					i += m[0].length - 1;
					endWord();
				} else {
					word += c;
					inWord = true;
				}
			} else if (includeSubstitutions && (c === "<" || c === ">")) {
				endWord();
				words.push(c);
			} else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") endCommand();
			else if (c === " " || c === "\t") endWord();
			else if (c === "#" && !inWord) break;
			else {
				word += c;
				inWord = true;
			}
		}
		if (quote) word += "\n";
		else endCommand();
	}
	endCommand();
	return out;
}

const PREFIX_WORDS = new Set(["env", "command", "exec", "rtk", "proxy", "then", "do", "else", "!", "time", "nohup"]);

/** Index of the real program word, skipping env assignments, prefix words and `timeout [opts] DURATION`. */
function programIndex(words: string[]): number {
	let i = 0;
	for (;;) {
		while (i < words.length && (PREFIX_WORDS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
		if (words[i] === "timeout" || words[i] === "gtimeout") {
			i++;
			while (i < words.length && words[i].startsWith("-")) i += /^-(?:s|k)$|^--(?:signal|kill-after)$/.test(words[i]) ? 2 : 1;
			i++; // duration
			continue;
		}
		return i;
	}
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** Simple commands, expanding `bash -c '<script>'` payloads into their own simple commands. */
export function expandedCommands(command: string, depth = 0, includeSubstitutions = false): string[][] {
	const out: string[][] = [];
	for (const words of simpleCommands(command, includeSubstitutions && depth < 3)) {
		out.push(words);
		const i = programIndex(words);
		const prog = words[i]?.split("/").pop() ?? "";
		if (depth < 3 && SHELLS.has(prog)) {
			const c = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
			if (c > 0 && words[c + 1] !== undefined) out.push(...expandedCommands(words[c + 1], depth + 1, includeSubstitutions));
		}
	}
	return out;
}

/** Arguments after the program name, if this simple command runs `program`. */
export function argsOf(words: string[], program: string): string[] | undefined {
	const i = programIndex(words);
	const w = words[i];
	return w === program || w?.endsWith(`/${program}`) ? words.slice(i + 1) : undefined;
}

function ghInvocations(command: string): string[][] {
	return expandedCommands(command)
		.map(w => argsOf(w, "gh"))
		.filter((a): a is string[] => a !== undefined);
}

function isForegroundWatch(args: string[]): boolean {
	return (args[0] === "run" && args[1] === "watch") || (args[0] === "pr" && args[1] === "checks" && args.includes("--watch"));
}

function isStatusPoll(args: string[]): boolean {
	if (args.some(a => /^--(?:log|log-failed|watch|web)$/.test(a))) return false;
	const [a, b] = args;
	if (a === "pr" && b === "checks") return true;
	if (a === "run" && (b === "view" || b === "list")) return true;
	if (a === "pr" && b === "view") return args.some(x => x.includes("statusCheckRollup"));
	if (a === "api") return args.some(x => /\/(?:check-runs|check-suites|status)\b/.test(x));
	return false;
}

const POLL_WINDOW_MS = 15 * 60 * 1000;
const POLL_REPEAT_LIMIT = 2;
const POLL_KEY_CAP = 500;

/**
 * Detects polling spread over separate calls (each one cheap, so the loop guard never sees it):
 * the identical CI status query (same `gh` arguments) issued more than POLL_REPEAT_LIMIT times within
 * POLL_WINDOW_MS. Only real `gh` invocations count; log reads, watches and other queries are independent.
 * A `git push` starts a new checkpoint and clears the history, so checking after pushing a fix is allowed.
 */
export class PollTracker {
	private seen = new Map<string, number[]>();

	/** Returns true when this call would be a repeated poll; records it otherwise. */
	check(command: string, now: number): boolean {
		const cmds = expandedCommands(command);
		if (cmds.some(w => argsOf(w, "git")?.[0] === "push")) this.seen.clear();
		for (const [key, times] of this.seen) if (times.every(t => now - t >= POLL_WINDOW_MS)) this.seen.delete(key);
		const keys = cmds
			.map(w => argsOf(w, "gh"))
			.filter((a): a is string[] => a !== undefined && isStatusPoll(a))
			.map(a => JSON.stringify(a));
		if (!keys.length) return false;
		const recent = keys.map(k => (this.seen.get(k) ?? []).filter(t => now - t < POLL_WINDOW_MS));
		if (recent.some(r => r.length >= POLL_REPEAT_LIMIT)) return true;
		if (this.seen.size + keys.length > POLL_KEY_CAP) this.seen.clear();
		keys.forEach((k, i) => this.seen.set(k, [...recent[i], now]));
		return false;
	}
}

/** Locate literal $(...) or backtick shell payloads; called only outside single quotes/data. */
function shellSubstitution(text: string, start: number): { body: string; end: number } | undefined {
	const backtick = text[start] === "`";
	if (!backtick && (text[start] !== "$" || text[start + 1] !== "(" || text[start + 2] === "(")) return undefined;
	const bodyStart = start + (backtick ? 1 : 2);
	let depth = 1;
	let quote = "";
	for (let i = bodyStart; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") { i++; continue; }
		if (backtick && c === "`") return { body: text.slice(bodyStart, i), end: i };
		if (c === quote) quote = "";
		else if (!quote && (c === "'" || c === '"')) quote = c;
		else if (!quote && c === "(") depth++;
		else if (!quote && c === ")" && --depth === 0) return { body: text.slice(bodyStart, i), end: i };
	}
	return undefined;
}

/** Opt in only the new guards; legacy poll/watch parsing keeps its existing behaviour. */
export function executableCommands(command: string): string[][] {
	return expandedCommands(command, 0, true);
}

/** Strip gh's value-taking global flags wherever Cobra accepts them in the command path. */
function withoutGhGlobals(args: string[]): string[] {
	const valueFlags = new Set(["-R", "--repo", "--hostname"]);
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (valueFlags.has(arg)) { i++; continue; }
		if (/^--(?:repo|hostname)=|^-R.+/.test(arg)) continue;
		out.push(arg);
	}
	return out;
}

/** Sleep plus a real status query, regardless of shell separator/order or sleep duration. */
export function sleepStatusQuery(command: string): boolean {
	const commands = executableCommands(command).map(words =>
		words.filter((word, i) => i !== 0 || !["while", "until", "if", "{"].includes(word)));
	const sleeps = commands.some(words => argsOf(words, "sleep") !== undefined);
	if (!sleeps) return false;
	return commands.some(words => {
		const invocation = argsOf(words, "gh");
		const gh = invocation ? withoutGhGlobals(invocation) : undefined;
		if (gh) {
			if (gh[0] === "run" && ["list", "view"].includes(gh[1])) return true;
			if (gh[0] === "pr" && ["checks", "view"].includes(gh[1]) && !gh.includes("--watch")) return true;
			if (gh[0] === "api" && gh.some(arg => /(?:^|\/)actions\/runs(?:[/?#]|$)/.test(arg))) return true;
		}
		const git = argsOf(words, "git");
		if (!git) return false;
		let i = 0;
		while (i < git.length && git[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree"].includes(git[i]) ? 2 : 1;
		return git[i] === "ls-remote";
	});
}

export interface Verdict {
	block?: string;
	needsApproval?: string;
}

/** Classify a foreground bash call. `timeout` is the bash tool's timeout in seconds. */
export function assess(command: string, timeout: number | undefined, hasJobStart: boolean): Verdict {
	const waitHelp = hasJobStart
		? "Use `job_start` for the wait, e.g. `gh pr checks <n> --repo <owner/repo> --watch --fail-fast --interval 60` " +
		  "or `gh run watch <id> --exit-status`, with a fitting timeoutSeconds (or `job_watch` to re-run a check until it passes), " +
		  "then end the turn: its completion notification wakes you. Do not sleep, poll, or call job_list/job_output to wait."
		: "Run one `gh pr checks <n> --repo <owner/repo> --watch --fail-fast --interval 60` (or `gh run watch <id> --exit-status`) " +
		  `with timeout ≤ ${MAX_TIMEOUT_SECONDS}; if it is still pending, report the status and stop instead of polling again.`;

	if (sleepStatusQuery(command)) return {
		block: "wait-guard: sleep combined with a CI/status query blocked — never poll. " + waitHelp,
	};
	const loop = LOOP.exec(command);
	if (loop) {
		const sleeps = sleepSeconds(loop[0]);
		if (sleeps.length && CI_STATUS.test(loop[0]))
			return { block: `wait-guard: polling loop over CI/PR status blocked (AGENTS.md: never poll). ${waitHelp}` };
		if (sleeps.some(s => s >= LOOP_SLEEP_LIMIT))
			return { block: `wait-guard: loop sleeping ≥ ${LOOP_SLEEP_LIMIT}s per iteration blocked — this is polling. ${waitHelp}` };
	}
	const outside = loop ? command.replace(loop[0], "") : command;
	const plain = sleepSeconds(outside).reduce((a, b) => a + b, 0);
	if (plain >= PLAIN_SLEEP_LIMIT)
		return { block: `wait-guard: ${plain}s of sleep blocked — do not wait in the foreground. ${waitHelp}` };
	if (hasJobStart && ghInvocations(command).some(isForegroundWatch))
		return { block: `wait-guard: foreground CI watch blocked — it holds the session for the whole CI run. ${waitHelp}` };
	const phaseBudget = piPhaseBudget(command);
	if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS && !(phaseBudget !== undefined && timeout <= phaseBudget))
		return {
			needsApproval:
				`wait-guard: timeout ${timeout}s exceeds the ${MAX_TIMEOUT_SECONDS}s foreground limit — blocked. ` +
				"Do not retry with a long timeout and do not ask the user to approve it. Use a shorter, runtime-based timeout, " +
				"split the phase, or hand the long-running work to a background agent (Agent tool) or job_start.",
		};
	return {};
}

export function repeatedPollMessage(hasJobStart: boolean): string {
	return (
		"wait-guard: the same CI/PR status query ran twice in the last 15 minutes — this is polling (AGENTS.md: never poll). " +
		(hasJobStart
			? "Start one background watch with `job_start` (`gh run watch <run-id> --exit-status` or " +
			  "`gh pr checks <n> --repo <owner/repo> --watch --fail-fast --interval 60`) or `job_watch`, then do other work or end the turn."
			: "Report the current status and stop; check again at a later deliberate checkpoint.")
	);
}

export default function (pi: ExtensionAPI) {
	const polls = new PollTracker();
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const input = event.input as { command?: unknown; timeout?: unknown };
		const command = String(input.command ?? "");
		const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
		const hasJobStart = pi.getActiveTools().includes("job_start");

		let verdict = assess(command, timeout, hasJobStart);
		if (!verdict.block && !verdict.needsApproval && polls.check(command, Date.now()))
			verdict = { block: repeatedPollMessage(hasJobStart) };
		if (isGuardOff("wait")) {
			if (timeout === undefined) input.timeout = MAX_TIMEOUT_SECONDS;
			if (ctx.hasUI && (verdict.block || verdict.needsApproval)) {
				ctx.ui.notify(`wait-guard off: allowed '${command.replace(/\s+/g, " ").slice(0, 180)}'`, "info");
			}
			return undefined;
		}
		if (verdict.block) return { block: true, reason: verdict.block };
		// Orchestration: an over-limit timeout is not a stall risk worth stopping a lane for; allow and log.
		if (verdict.needsApproval && isOrchestrated(process.env, ctx.cwd)) {
			orchLog("wait", "allow", `timeout ${timeout}s: ${command.replace(/\s+/g, " ").slice(0, 300)}`);
			return undefined;
		}
		// Over-limit foreground timeouts are blocked outright (no interactive prompt): the model is
		// told to shorten the timeout or move the work to a background agent / job_start instead.
		if (verdict.needsApproval) return { block: true, reason: verdict.needsApproval };
		// A bash call without a timeout can run forever; bound it.
		if (timeout === undefined) input.timeout = MAX_TIMEOUT_SECONDS;
		return undefined;
	});
}
