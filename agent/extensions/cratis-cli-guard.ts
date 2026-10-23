/**
 * cratis-cli-guard — deterministic safety net for `cratis chronicle` commands.
 * Disable confirmations with /guards off cratis (add --persist to keep it across processes).
 * Production-target checks remain active: guard-off permits only non-production mutations.
 *
 * Scope matches the Cratis AI store-mutation hook (Cratis/AI v3.3.0): only the `chronicle`
 * group is guarded. Its read-only commands run freely; every other chronicle command —
 * replay, retry, clearing quarantine, job control, recommendations, adding or removing users,
 * applications and subscriptions, and any chronicle command this list does not know — is
 * state-changing or unknown and:
 *   - with a UI: requires explicit confirmation, showing the command and the active context;
 *   - without a UI (subagents, headless): is blocked, so the agent must report it instead.
 * `cratis prologue start` is guarded the same way: it sets up capture of a running system and enables
 * change data capture / logical replication (publications, replication slots) on the target database,
 * which persists until removed. `prologue interpret` only reads local capture files.
 * Other groups (ai, context, init, screenplay, run, …) only change local state and are not guarded.
 *
 * `cratis` counts only in command position: at the start of a simple command (after ; & | && ||
 * newlines, ( ), $( ) and backticks), after environment assignments and wrappers (sudo, env, time,
 * rtk proxy, …), and inside `bash -c '…'` / `sh -c` / `eval`. Arguments and quoted text — search
 * terms, commit messages, PR titles, paths — are never treated as a call.
 *
 * Layering with the Cratis hooks: where the Cratis Pi hooks are installed under process.cwd() AND their extension is proven loaded (its `cratis_quality_gate` tool is registered from that directory; an untrusted project's hooks never count, and no repository script is run then) (lib/cratis-hooks-detect.ts),
 * this guard runs cratis-guard-store-mutations.sh on a chronicle mutation it would confirm and stands down only when the
 * script itself blocks it (exit 2; a silent no-op such as missing `jq`, a timeout or an error keeps this guard blocking)
 * (one block, one message; CRATIS_HOOKS_ALLOW_STORE_MUTATIONS=1 is the switch, /guards off cratis is not needed) and
 * reads the Cratis read-only list at runtime (falling back to the list below when absent or unparsable). It keeps what
 * Cratis lacks: `prologue start` confirmation, and — when a human has set the Cratis switch — the production check
 * (a production target is still denied; anything else runs without a prompt). Outside such repositories nothing changes.
 *
 * Production (orchestration: state-changing commands only; read-only commands are allowed and logged):
 * besides the prod/production name heuristic, ~/.pi/agent/cratis-production.json (re-read at every check;
 * missing/invalid → built-in defaults, logged) lists production `contexts` (glob `*`, case-insensitive),
 * `clientIds`, `hosts` (substring of a server/connection string) and `portForwardIsProduction` (the localhost
 * port of the effective server is the local port of a running `kubectl port-forward`; a failing `ps` is
 * "unknown" and never denies by itself). A match is denied at once in orchestration; elsewhere the prompt shows it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cratisHookActive, cratisReadOnlyCommands, cratisVerdict, spawnRunner } from "../lib/cratis-hooks-detect.ts";
import type { CratisRunner } from "../lib/cratis-hooks-detect.ts";
import { isGuardOff } from "../lib/guards.ts";
import { guardSelect, isOrchestrated, orchLog } from "../lib/orchestration.ts";

// `cratis chronicle <path>` commands that only read state (cratis llm-context, CLI 3.13–3.15).
const CHRONICLE_READ_ONLY = new Set<string>([
	"diagnose",
	"auth status",
	"applications list",
	"event-stores list",
	"event-types list",
	"event-types show",
	"events get",
	"events tail",
	"failed-partitions list",
	"failed-partitions show",
	"identities list",
	"jobs get",
	"jobs list",
	"namespaces list",
	"observers list",
	"observers show",
	"projections list",
	"projections show",
	"read-models get",
	"read-models instances",
	"read-models list",
	"read-models occurrences",
	"read-models snapshots",
	"recommendations list",
	"subscriptions list",
	"users list",
]);

const normalizePath = (path: string) => path.trim().toLowerCase().split(/\s+/).join(" ");
/** The read-only paths (after `chronicle`): built-in list plus the extraReadOnly list of cratis-production.json. */
export function readOnlyList(extraReadOnly: readonly string[] = []): string[] {
	return [...new Set([...CHRONICLE_READ_ONLY, ...extraReadOnly.map(normalizePath).filter(Boolean)])];
}

const HELP_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
// Wrappers that run the next word as the command (their own options are skipped).
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice", "xargs", "timeout", "stdbuf"]);

export interface CratisInvocation {
	text: string;
	path: string;
	readOnly: boolean;
}

const STDIN_FILE_FLAGS = ["-F", "--file", "--body-file", "--notes-file", "--input"];
function readsStdinFile(rest: string[]): boolean {
	return rest.some((w, k) => (STDIN_FILE_FLAGS.includes(w) && rest[k + 1] === "-") || STDIN_FILE_FLAGS.some(f => w === `${f}=-`) || w === "-F-");
}

/**
 * True only for git/gh forms known to treat stdin / a substituted argument as data (message, body, patch).
 * `stdin` demands an explicit stdin-file flag; a `$( )` argument only needs the data-taking subcommand.
 */
function dataConsumer(head: string, args: string[], stdin: boolean): boolean {
	if (head === "gh") {
		const [sub, verb, ...rest] = args;
		if (sub === "api") return !stdin || readsStdinFile(args.slice(1));
		const verbs: Record<string, string[]> = { pr: ["create", "edit", "comment", "review"], issue: ["create", "edit", "comment"], release: ["create", "edit"] };
		return !!verbs[sub]?.includes(verb) && (!stdin || readsStdinFile(rest));
	}
	let k = 0;
	for (;;) {
		const a = args[k];
		if (a === "-C") k += 2;
		else if (a === "-c") {
			if (!args[k + 1] || /^(?:alias|core)\./i.test(args[k + 1])) return false;
			k += 2;
		} else if (a === "--no-pager" || a === "-P" || a === "-p") k++;
		else break;
	}
	const [sub, second, ...more] = args.slice(k);
	if (sub === "apply" || sub === "am") return true;
	const rest = sub === "notes" ? more : [second, ...more].filter(w => w !== undefined);
	if (sub === "notes") return second === "add" && (!stdin || readsStdinFile(rest));
	return (sub === "commit" || sub === "tag") && (!stdin || readsStdinFile(rest));
}

/**
 * Recognize only a small literal file-writing grammar; all other headers keep the legacy scan.
 * Returns the written file names (cat's one redirect target, tee's files), or null.
 */
function literalFileWriter(header: string): string[] | null {
	const tokens: { operator?: string; literal?: string }[] = [];
	const token = /(<<-?|1?>>?)|('[A-Za-z0-9_./:@%+=, \t-]*'|"[A-Za-z0-9_./:@%+=, \t-]*"|[A-Za-z0-9_./:@%+=,-]+)/y;
	let at = 0;
	while (at < header.length) {
		if (header[at] === " " || header[at] === "\t") { at++; continue; }
		token.lastIndex = at;
		const match = token.exec(header);
		if (!match) return null;
		at = token.lastIndex;
		if (match[2] !== undefined) {
			// Do not split concatenated/expanded words or reinterpret an unsupported fd
			// (e.g. 2>f) as a filename followed by a stdout redirection.
			if (at < header.length && !/[ \t<>]/.test(header[at])) return null;
			if (/^\d+$/.test(match[2]) && /[<>]/.test(header[at] ?? "")) return null;
			tokens.push({ literal: match[2].replace(/^(['"])(.*)\1$/, "$2") });
		} else tokens.push({ operator: match[1] });
	}
	const head = tokens.shift()?.literal;
	// Only proven data-consuming git/gh forms (allowlist); every other subcommand keeps the legacy scan.
	if (head === "git" || head === "gh") {
		const args: string[] = [];
		for (let k = 0; k < tokens.length; k++) {
			if (tokens[k].operator) { if (!tokens[k].operator!.startsWith("<<")) return null; k++; } else args.push(tokens[k].literal ?? "");
		}
		return dataConsumer(head, args, true) ? [] : null;
	}
	const cat = ["cat", "/bin/cat", "/usr/bin/cat"].includes(head ?? "");
	const tee = ["tee", "/bin/tee", "/usr/bin/tee"].includes(head ?? "");
	if (!cat && !tee) return null;
	let redirects = 0;
	let files = 0;
	const targets: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const item = tokens[i];
		if (item.operator) {
			const target = tokens[++i]?.literal;
			if (target === undefined) return null;
			if (!item.operator.startsWith("<<") && (!target || ++redirects > 1)) return null;
			if (!item.operator.startsWith("<<")) targets.push(target);
		} else {
			if (!tee || !item.literal || (item.literal.startsWith("-") && item.literal !== "-a")) return null;
			if (item.literal !== "-a") { files++; targets.push(item.literal); }
		}
	}
	// cat without a redirect prints the heredoc to stdout: still data (a pipe to a shell is caught by the caller).
	return (cat || files > 0) ? targets : null;
}

/** Split a shell command into simple commands (arrays of unquoted words), recursing into $( ) and backticks. */
function simpleCommands(input: string, out: string[][] = [], depth = 0, heredocs = true): string[][] {
	if (depth > 8) return out;
	// Bash does not treat CR as shell whitespace. Alias setup can also change a
	// seemingly data-only consumer into an interpreter. Do not suppress either.
	heredocs = heredocs && !/\r|alias|shopt/.test(input);
	const start = out.length;
	const pending: { delimiter: string; quoted: boolean; tabs: boolean; dataOnly: boolean }[] = [];
	let owned = 0;
	let sawHeredoc = false;
	// Heredoc bodies written by a literal cat/tee are data, even next to other commands, unless
	// something in the command line could execute that file or redefine cat/tee.
	const docTargets: string[] = [];
	const others: string[][] = [];
	let commandStart = 0;
	let i = 0;
	let uncertain = false;
	let words: string[] = [];
	let word = "";
	let inWord = false;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	// A $( ) inside git/gh arguments only supplies data to them, so its heredocs may be classified.
	// Anywhere else (eval, sh -c, bash, ...) the output may be executed: keep the legacy scan.
	const dataArgument = () => heredocs && (words[0] === "git" || words[0] === "gh") && dataConsumer(words[0], words.slice(1), false);
	const endCommand = () => {
		endWord();
		if (words.length) out.push(words);
		const targets = owned < pending.length ? literalFileWriter(input.slice(commandStart, i)) : null;
		if (targets) docTargets.push(...targets.map(t => t.split("/").pop() || t));
		else if (words.length) others.push(words);
		for (; owned < pending.length; owned++) pending[owned].dataOnly = targets !== null;
		// A compound command can pipe a cat/tee's output to a shell after its closing keyword.
		if (["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "coproc", "!"].includes(words[0])) uncertain = true;
		words = [];
	};
	// Index of the matching close for a $( … ) starting after the "(" at i, respecting quotes.
	const closeParen = (s: string, i: number): number => {
		let level = 1;
		let q: string | null = null;
		for (; i < s.length; i++) {
			const c = s[i];
			if (q) {
				if (c === "\\" && q === '"') i++;
				else if (c === q) q = null;
			} else if (c === "'" || c === '"') q = c;
			else if (c === "\\") i++;
			else if (c === "(") level++;
			else if (c === ")" && --level === 0) return i;
		}
		return s.length;
	};
	while (i < input.length) {
		const c = input[i];
		if (heredocs && c === "<" && input[i + 1] === "<" && input[i - 1] !== "<" && input[i + 2] !== "<") {
			sawHeredoc = true;
			// Only complete, unambiguous delimiter words are eligible. Other shell syntax fails closed.
			const match = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\\\n]*)"|([A-Za-z_][A-Za-z0-9_]*))(?=[ \t\r\n;&|<>(){}]|$)/.exec(input.slice(i));
			if (match) pending.push({ delimiter: match[2] ?? match[3] ?? match[4], quoted: match[4] === undefined, tabs: match[1] === "-", dataOnly: false });
			else uncertain = true;
		}
		if (c === "\\") {
			word += input[i + 1] ?? "";
			inWord = true;
			i += 2;
		} else if (c === "'") {
			const end = input.indexOf("'", i + 1);
			const stop = end === -1 ? input.length : end;
			word += input.slice(i + 1, stop);
			inWord = true;
			i = stop + 1;
		} else if (c === '"') {
			i++;
			inWord = true;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length) {
					word += input[i + 1];
					i += 2;
				} else if (input[i] === "$" && input[i + 1] === "(") {
					const end = closeParen(input, i + 2);
					uncertain = true;
					simpleCommands(input.slice(i + 2, end), out, depth + 1, dataArgument());
					word += "$()";
					i = end + 1;
				} else if (input[i] === "`") {
					const end = input.indexOf("`", i + 1);
					const stop = end === -1 ? input.length : end;
					uncertain = true;
					simpleCommands(input.slice(i + 1, stop), out, depth + 1, false);
					word += "``";
					i = stop + 1;
				} else word += input[i++];
			}
			i++;
		} else if (c === "$" && input[i + 1] === "(") {
			const end = closeParen(input, i + 2);
			uncertain = true;
			simpleCommands(input.slice(i + 2, end), out, depth + 1, dataArgument());
			word += "$()";
			inWord = true;
			i = end + 1;
		} else if (c === "`") {
			const end = input.indexOf("`", i + 1);
			const stop = end === -1 ? input.length : end;
			uncertain = true;
			simpleCommands(input.slice(i + 1, stop), out, depth + 1, false);
			word += "``";
			inWord = true;
			i = stop + 1;
		} else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
			endCommand();
			// `&&` and `||` only sequence commands; single `|`/`&`, subshells and groups stay uncertain.
			const sequence = (c === "&" || c === "|") && input[i + 1] === c;
			i += sequence ? 2 : 1;
			if (c !== "\n" && c !== ";" && !sequence) uncertain = true;
			if (heredocs && c === "\n" && pending.length) {
				for (const doc of pending) {
					const bodyStart = i;
					let terminated = false;
					while (i < input.length) {
						const nl = input.indexOf("\n", i);
						const end = nl === -1 ? input.length : nl;
						const line = input.slice(i, end);
						if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
							// Unquoted heredocs expand even inside quote-looking text. Keep the entire
							// legacy scan for expansions, escapes/continuations, and any unknown consumer.
							if (!doc.dataOnly || (!doc.quoted && /[$`\\]/.test(input.slice(bodyStart, i)))) uncertain = true;
							i = nl === -1 ? end : end + 1;
							terminated = true;
							break;
						}
						i = nl === -1 ? end : end + 1;
					}
					if (!terminated) uncertain = true;
				}
				pending.length = 0;
				owned = 0;
			}
			commandStart = i;
		} else if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
		} else if (c === "#" && !inWord) {
			const nl = input.indexOf("\n", i);
			i = nl === -1 ? input.length : nl;
		} else {
			word += c;
			inWord = true;
			i++;
		}
	}
	endCommand();
	// Other commands might execute a written file (it is named again by a non-reader) or redefine
	// cat/tee (interpreters, eval/source, aliases, PATH). Then replay the legacy full scan.
	if (others.some(w => executesOrRedefines(w, docTargets))) uncertain = true;
	if (heredocs && sawHeredoc && (uncertain || pending.length)) {
		// Replay the original tokenizer, including all bodies, rather than weakening its
		// behavior in syntax this small lexer cannot prove to be non-executable data.
		out.length = start;
		return simpleCommands(input, out, depth, false);
	}
	return out;
}

const RISKY_HEADS = new Set([...SHELLS, "ksh", "fish", "eval", "source", ".", "exec", "alias", "unalias", "function", "hash", "enable",
	"builtin", "command", "xargs", "python", "python3", "node", "perl", "ruby", "deno", "bun", "npx", "chmod", "install", "ln", "make", "env"]);
const FILE_READERS = new Set(["cat", "head", "tail", "wc", "ls", "stat", "grep", "rg", "mv", "cp", "rm", "echo", "printf", "mkdir", "touch",
	"test", "[", "diff", "git", "sort", "jq", "true", "date", "cd"]);
function executesOrRedefines(words: string[], targets: string[]): boolean {
	if (words.some(w => /^(?:PATH|BASH_ENV|ENV|CDPATH)=/.test(w))) return true;
	const cmd = commandWords(words);
	const head = cmd[0] ?? "";
	const name = head.split("/").pop() ?? "";
	if (RISKY_HEADS.has(name) || RISKY_HEADS.has(head)) return true;
	return !FILE_READERS.has(name) && words.some(w => targets.some(t => t && w.includes(t)));
}

/** The words of the command a simple command actually runs, after assignments and wrappers. */
function commandWords(words: string[]): string[] {
	let k = 0;
	for (;;) {
		while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
		const head = (words[k] ?? "").split("/").pop() ?? "";
		if (head === "rtk" && words[k + 1] === "proxy") k += 2;
		else if (WRAPPERS.has(head)) {
			k++;
			// Skip the wrapper's own options and, for timeout, its duration.
			while (k < words.length && (words[k].startsWith("-") || (head === "timeout" && /^\d/.test(words[k])))) k++;
		} else break;
	}
	return words.slice(k);
}

function classify(args: string[], extraReadOnly: ReadonlySet<string>): { path: string; readOnly: boolean } | null {
	if (args.length === 0 || args.some(a => HELP_FLAGS.has(a))) return null;
	const positional = args.filter(a => !a.startsWith("-"));
	if (positional[0] === "prologue" && positional.length > 1 && positional[1] !== "interpret") {
		return { path: `prologue ${positional[1] ?? ""}`.trim(), readOnly: false };
	}
	const at = positional.indexOf("chronicle");
	if (at === -1) return null; // not the chronicle group: local-only, not guarded
	if (at !== 0) return { path: positional.join(" "), readOnly: false }; // options before the path: fail closed
	const sub = positional.slice(1);
	for (let n = 1; n <= Math.min(sub.length, 2); n++) {
		const path = sub.slice(0, n).join(" ").toLowerCase();
		if (CHRONICLE_READ_ONLY.has(path) || extraReadOnly.has(path)) return { path: `chronicle ${sub.slice(0, n).join(" ")}`, readOnly: true };
	}
	return { path: `chronicle ${sub.slice(0, 2).join(" ")}`.trim(), readOnly: false };
}

/** Find every `cratis chronicle` invocation in command position and classify it. */
export function classifyCratisInvocations(command: string, depth = 0, extraReadOnly: readonly string[] = []): CratisInvocation[] {
	const extra = new Set(extraReadOnly.map(normalizePath));
	const found: CratisInvocation[] = [];
	if (depth > 4 || !/cratis/i.test(command)) return found;
	// Shell -c/eval strings are another execution context, not standalone file writes.
	for (const words of simpleCommands(command, [], 0, depth === 0)) {
		const cmd = commandWords(words);
		const head = (cmd[0] ?? "").split("/").pop() ?? "";
		if (SHELLS.has(head)) {
			const c = cmd.indexOf("-c");
			if (c !== -1 && cmd[c + 1]) found.push(...classifyCratisInvocations(cmd[c + 1], depth + 1, extraReadOnly));
		} else if (head === "eval") {
			found.push(...classifyCratisInvocations(cmd.slice(1).join(" "), depth + 1, extraReadOnly));
		} else if (head === "cratis") {
			const verdict = classify(cmd.slice(1), extra);
			if (verdict) found.push({ text: cmd.join(" "), ...verdict });
		}
	}
	return found;
}

function activeContext(): Promise<string> {
	return new Promise(resolve => {
		execFile("cratis", ["context", "show", "-o", "plain"], { timeout: 8000, maxBuffer: 65536 }, (error, stdout) => {
			if (error) return resolve("(could not read the active context)");
			// Never display secrets embedded in connection strings.
			resolve(stdout.trim().replace(/(chronicle:\/\/[^:@\s]+:)[^@\s]+@/g, "$1***@").slice(0, 1500));
		});
	});
}

const UNREADABLE_CONTEXT = "(could not read the active context)";

export interface ProductionConfig {
	contexts: string[];
	clientIds: string[];
	hosts: string[];
	portForwardIsProduction: boolean;
	/** Extra read-only `chronicle` paths (first 1-2 words, case-insensitive), merged with the built-in list. */
	extraReadOnly: string[];
}
export const DEFAULT_PRODUCTION_CONFIG: ProductionConfig = {
	contexts: ["prod-studio", "post-deploy-check-*", "ro-verify-*", "ro-diag-*", "ro-check-*", "ro-survey-*", "ro-hierarchy-*", "ro-s677", "l3c-*", "l31-ro-*", "diag-*"],
	clientIds: ["cratis-studio"],
	hosts: ["upcloudlb.com", "studio-production"],
	portForwardIsProduction: true,
	extraReadOnly: [],
};

/** Readers for the production rules; tests replace these. */
export const productionSources = {
	/** Raw text of the production list; throws when it cannot be read. */
	readConfig: (env: NodeJS.ProcessEnv = process.env): string =>
		readFileSync(env.PI_CRATIS_PRODUCTION_FILE ?? join(homedir(), ".pi", "agent", "cratis-production.json"), "utf8"),
	/** Raw text of ~/.cratis/config.json; throws when it cannot be read. */
	readCratisConfig: (env: NodeJS.ProcessEnv = process.env): string =>
		readFileSync(env.PI_CRATIS_CONFIG_FILE ?? join(homedir(), ".cratis", "config.json"), "utf8"),
	/** `ps -Ao args`, bounded to 3 s; throws/rejects on failure. */
	readProcessList: (): Promise<string> => new Promise((resolve, reject) => {
		execFile("ps", ["-Ao", "args"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
	}),
};

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");

/** Read the production list at every check (no cache); fall back to the defaults, logging one line. */
export function loadProductionConfig(): ProductionConfig {
	try {
		const parsed = JSON.parse(productionSources.readConfig());
		if (isStrings(parsed?.contexts) && isStrings(parsed?.clientIds) && isStrings(parsed?.hosts) && typeof parsed?.portForwardIsProduction === "boolean"
			&& (parsed.extraReadOnly === undefined || isStrings(parsed.extraReadOnly))) {
			return { contexts: parsed.contexts, clientIds: parsed.clientIds, hosts: parsed.hosts, portForwardIsProduction: parsed.portForwardIsProduction, extraReadOnly: parsed.extraReadOnly ?? [] };
		}
		orchLog("cratis", "config", "cratis-production.json has an invalid shape; using built-in production defaults");
	} catch {
		orchLog("cratis", "config", "cratis-production.json is missing or invalid; using built-in production defaults");
	}
	return DEFAULT_PRODUCTION_CONFIG;
}

/** Local ports of running `kubectl port-forward` processes, or undefined when they cannot be listed. */
export async function forwardedPorts(): Promise<number[] | undefined> {
	let list: string;
	try { list = await productionSources.readProcessList(); } catch { return undefined; }
	const ports: number[] = [];
	for (const line of list.split("\n")) {
		if (!/(?:^|[\s/])kubectl\s/.test(line) || !/\sport-forward(?:\s|$)/.test(line)) continue;
		for (const word of line.split(/\s+/).slice(1)) {
			const match = /^(\d+)(?::\d+)?$/.exec(word);
			if (match) ports.push(Number(match[1]));
		}
	}
	return ports;
}

export interface NamedContext { server?: string; clientId?: string }
/** `contexts[name]` of ~/.cratis/config.json; null when the file or the context cannot be read. */
export function lookupCratisContext(name: string): NamedContext | null {
	try {
		const contexts = JSON.parse(productionSources.readCratisConfig())?.contexts;
		const key = contexts && typeof contexts === "object" ? Object.keys(contexts).find(k => k === name) ?? Object.keys(contexts).find(k => k.toLowerCase() === name.toLowerCase()) : undefined;
		const entry = key === undefined ? undefined : contexts[key];
		if (!entry || typeof entry !== "object") return null;
		return { server: typeof entry.server === "string" ? entry.server : undefined, clientId: typeof entry.clientId === "string" ? entry.clientId : undefined };
	} catch { return null; }
}

function globMatches(patterns: string[], value: string): string | undefined {
	return patterns.find(p => new RegExp(`^${p.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(value));
}

/**
 * Production check for a state-changing command (callers never ask for read-only ones). The target is the
 * invocation text (incl. --server / --context, inline CHRONICLE_CONNECTION_STRING), the process environment
 * and the active context. `named` is the looked-up `--context` (null = not defined, cannot be ruled out). `ports` are the local kubectl port-forward ports (undefined = unknown).
 * An unreadable context cannot be checked and is denied (immediately, never prompted).
 */
export function productionTarget(
	target: string, context: string, env: NodeJS.ProcessEnv = process.env,
	config: ProductionConfig = DEFAULT_PRODUCTION_CONFIG, ports?: number[], named?: NamedContext | null,
): string | undefined {
	if (context === UNREADABLE_CONTEXT) return "the active cratis context could not be read, so a production target cannot be ruled out";
	const production = /(?:^|[^a-z0-9])prod(?:uction)?(?:[^a-z0-9]|$)/i;
	if (production.test(target)) return "the command names a production target";
	if (production.test(env.CHRONICLE_CONNECTION_STRING ?? "")) return "CHRONICLE_CONNECTION_STRING names a production target";
	if (production.test(context)) return "the active cratis context is a production context";

	const word = (re: RegExp, text: string) => re.exec(text)?.[1];
	const explicitContext = word(/--context(?:=|\s+)["']?([^\s"']+)/, target);
	const activeName = word(/^\s*context:\s*(\S+)/im, context);
	const contextName = explicitContext ?? activeName;
	const listed = contextName === undefined ? undefined : globMatches(config.contexts, contextName);
	if (listed !== undefined) return `context ${contextName} is listed in cratis-production.json`;

	if (explicitContext !== undefined && named === null) return `context ${explicitContext} is not defined in ~/.cratis/config.json, so a production target cannot be ruled out`;

	const clientId = word(/--client-id(?:=|\s+)["']?([^\s"']+)/, target) ?? named?.clientId ?? (explicitContext === undefined ? word(/^\s*client id:\s*(\S+)/im, context) : undefined);
	if (clientId !== undefined && config.clientIds.some(c => c.toLowerCase() === clientId.toLowerCase())) return `client id ${clientId} is listed in cratis-production.json`;

	const flagServer = word(/--server(?:=|\s+)["']?([^\s"']+)/, target);
	const inlineServer = word(/(chronicle:\/\/[^\s"']+)/, target);
	const envServer = env.CHRONICLE_CONNECTION_STRING || undefined;
	const activeServer = explicitContext === undefined ? word(/^\s*server:\s*(\S+)/im, context) : named?.server;
	const servers = [target, envServer ?? "", activeServer ?? ""].join("\n").toLowerCase();
	const host = config.hosts.find(h => h && servers.includes(h.toLowerCase()));
	if (host !== undefined) return `host ${host} (cratis-production.json) appears in the target server`;

	if (config.portForwardIsProduction && ports && ports.length > 0) {
		const effective = flagServer ?? inlineServer ?? envServer ?? activeServer;
		const port = effective === undefined ? undefined : /(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i.exec(effective)?.[1];
		if (port !== undefined && ports.includes(Number(port))) return `localhost:${port} is the local port of a running kubectl port-forward (production via cratis-production.json)`;
	}
	return undefined;
}

async function productionCheck(target: string, context: string, config: ProductionConfig): Promise<string | undefined> {
	const ports = config.portForwardIsProduction ? await forwardedPorts() : undefined;
	const explicit = /--context(?:=|\s+)["']?([^\s"']+)/.exec(target)?.[1];
	return productionTarget(target, context, process.env, config, ports, explicit === undefined ? undefined : lookupCratisContext(explicit));
}

/** The confirmation switch cannot authorize production writes (including headless sessions). */
async function withoutConfirmation(risky: CratisInvocation[], command: string, config: ProductionConfig, ctx: ExtensionContext) {
	const target = [...risky.map(i => i.text), ...(command.match(/CHRONICLE_CONNECTION_STRING=\S+/g) ?? [])].join(" ");
	const production = await productionCheck(target, await activeContext(), config);
	if (production) return {
		block: true,
		reason: `cratis-cli-guard: state-changing cratis command(s) denied on production (/guards off cratis does not cover production). Matched rule: ${production}.\n${risky.map(i => `  ${i.text}`).join("\n")}`,
	};
	if (ctx.hasUI) ctx.ui.notify(`cratis-cli-guard off: allowed '${risky.map(i => i.text).join("; ").replace(/\s+/g, " ").slice(0, 180)}'`, "info");
	return undefined;
}

/** Test seam: how the Cratis store-mutations script is run. */
export let cratisRunner: CratisRunner = spawnRunner;
export function setCratisRunner(run: CratisRunner): void { cratisRunner = run; }

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!/cratis/.test(command)) return undefined;

		const config = /chronicle/.test(command) ? loadProductionConfig() : DEFAULT_PRODUCTION_CONFIG;
		const cratis = { run: cratisRunner, tools: () => pi.getAllTools() };
		const cratisActive = cratisHookActive("store-mutations", cratis);
		const invocations = classifyCratisInvocations(command, 0, [...config.extraReadOnly, ...(cratisActive ? cratisReadOnlyCommands(cratis) ?? [] : [])]);
		let risky = invocations.filter(i => !i.readOnly);
		if (risky.length === 0) {
			// Read-only commands are never production-checked or prompted; in orchestration they are logged.
			if (invocations.length > 0 && isOrchestrated(process.env, ctx.cwd)) orchLog("cratis", "allow", `read-only: ${invocations.map(i => i.text).join("; ")}`);
			return undefined;
		}
		if (isGuardOff("cratis")) return withoutConfirmation(risky, command, config, ctx);

		if (cratisActive) {
			// Chronicle mutations belong to cratis-guard-store-mutations.sh: stand down only where it really blocks them.
			const covered = risky.filter(i => i.path.startsWith("chronicle"));
			const verdict = covered.length > 0 ? cratisVerdict("store-mutations", ctx.cwd, command, cratis) : "none";
			if (verdict !== "none") risky = risky.filter(i => !covered.includes(i));
			if (verdict === "switch") {
				// A human lifted the Cratis block; the production check is the part Cratis does not have.
				const target = [...covered.map(i => i.text), ...(command.match(/CHRONICLE_CONNECTION_STRING=\S+/g) ?? [])].join(" ");
				const production = await productionCheck(target, await activeContext(), config);
				if (production) return { block: true, reason: `cratis-cli-guard: state-changing cratis command(s) denied on production (CRATIS_HOOKS_ALLOW_STORE_MUTATIONS does not cover production). Matched rule: ${production}.\n${covered.map(i => `  ${i.text}`).join("\n")}` };
			}
			if (risky.length === 0) return undefined;
		}

		const list = risky.map(i => `  ${i.text}`).join("\n");
		if (isOrchestrated(process.env, ctx.cwd)) {
			// Orchestration: never prompt. Allow and log, except production writes (denied at once).
			const context = await activeContext();
			const target = [...risky.map(i => i.text), ...(command.match(/CHRONICLE_CONNECTION_STRING=\S+/g) ?? [])].join(" ");
			const production = await productionCheck(target, context, config);
			const detail = `${risky.map(i => i.text).join("; ")} | context: ${context.replace(/\s+/g, " ").slice(0, 300)}`;
			if (production) {
				orchLog("cratis", "deny", detail);
				return {
					block: true,
					reason:
						`cratis-cli-guard: state-changing cratis command(s) denied on production (read-only list: ${readOnlyList(config.extraReadOnly).join(", ")}); ask L0. Matched rule: ${production}.\n${list}\n` +
						"Do not retry or work around this. Report the exact command, the target server/context, what it will change " +
						"and why to the user (or L0), who can run it; non-production targets run without a prompt.",
				};
			}
			orchLog("cratis", "allow", detail);
			if (ctx.hasUI) ctx.ui.notify(`cratis-cli-guard (orchestration): allowed '${risky.map(i => i.text).join("; ").replace(/\s+/g, " ").slice(0, 180)}'`, "info");
			return undefined;
		}
		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					`cratis-cli-guard: state-changing or unrecognised cratis command(s) blocked without a UI:\n${list}\n` +
					"Do not retry or work around this. Report the exact command, the target server/context, " +
					"what it will change and why, so the user can run it or approve it.",
			};
		}

		const context = await activeContext();
		const target = [...risky.map(i => i.text), ...(command.match(/CHRONICLE_CONNECTION_STRING=\S+/g) ?? [])].join(" ");
		const production = context === UNREADABLE_CONTEXT ? undefined : await productionCheck(target, context, config);
		const { choice, timedOut } = await guardSelect(ctx.ui, "cratis",
			`⚠️ cratis command that may change state:\n\n${list}\n\n` + (production ? `🚨 PRODUCTION: ${production}\n\n` : "") + `Active context:\n${context}\n\n` +
				"Check the target (--server / CHRONICLE_CONNECTION_STRING override the context). Run it?",
			["No", "Yes, run it"], "deny", { cwd: ctx.cwd },
		);
		if (timedOut) return {
			block: true,
			reason:
				`cratis-cli-guard: no answer to the confirmation within 60 s, so this command was not run:\n${list}\n` +
				"Do not retry in a loop. Report the exact command, the target server/context and why, so the user can run or approve it.",
		};
		if (choice !== "Yes, run it") return { block: true, reason: "cratis-cli-guard: the user declined this cratis command." };
		return undefined;
	});
}
