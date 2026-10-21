/**
 * cratis-cli-guard — deterministic safety net for `cratis chronicle` commands.
 * Turn off with /guards off cratis (add --persist to keep it across processes).
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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { isGuardOff } from "../lib/guards.ts";

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

const HELP_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
// Wrappers that run the next word as the command (their own options are skipped).
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice", "xargs", "timeout", "stdbuf"]);

export interface CratisInvocation {
	text: string;
	path: string;
	readOnly: boolean;
}

/** Recognize only a small literal file-writing grammar; all other headers keep the legacy scan. */
function literalFileWriter(header: string): boolean {
	const tokens: { operator?: string; literal?: string }[] = [];
	const token = /(<<-?|1?>>?)|('[A-Za-z0-9_./:@%+=, \t-]*'|"[A-Za-z0-9_./:@%+=, \t-]*"|[A-Za-z0-9_./:@%+=,-]+)/y;
	let at = 0;
	while (at < header.length) {
		if (header[at] === " " || header[at] === "\t") { at++; continue; }
		token.lastIndex = at;
		const match = token.exec(header);
		if (!match) return false;
		at = token.lastIndex;
		if (match[2] !== undefined) {
			// Do not split concatenated/expanded words or reinterpret an unsupported fd
			// (e.g. 2>f) as a filename followed by a stdout redirection.
			if (at < header.length && !/[ \t<>]/.test(header[at])) return false;
			if (/^\d+$/.test(match[2]) && /[<>]/.test(header[at] ?? "")) return false;
			tokens.push({ literal: match[2].replace(/^(['"])(.*)\1$/, "$2") });
		} else tokens.push({ operator: match[1] });
	}
	const head = tokens.shift()?.literal;
	const cat = ["cat", "/bin/cat", "/usr/bin/cat"].includes(head ?? "");
	const tee = ["tee", "/bin/tee", "/usr/bin/tee"].includes(head ?? "");
	if (!cat && !tee) return false;
	let redirects = 0;
	let files = 0;
	for (let i = 0; i < tokens.length; i++) {
		const item = tokens[i];
		if (item.operator) {
			const target = tokens[++i]?.literal;
			if (target === undefined) return false;
			if (!item.operator.startsWith("<<") && (!target || ++redirects > 1)) return false;
		} else {
			if (!tee || !item.literal || (item.literal.startsWith("-") && item.literal !== "-a")) return false;
			if (item.literal !== "-a") files++;
		}
	}
	return cat ? redirects === 1 : files > 0;
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
	let docCommandSeen = false;
	let commandSeen = false;
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
	const endCommand = () => {
		endWord();
		if (words.length) out.push(words);
		// Later commands might execute the file; earlier commands can redefine cat/tee
		// through eval/source or PATH. Only an isolated writer qualifies for suppression.
		if (words.length && (docCommandSeen || (owned < pending.length && commandSeen))) uncertain = true;
		if (words.length) commandSeen = true;
		const dataOnly = owned < pending.length && literalFileWriter(input.slice(commandStart, i));
		if (owned < pending.length) docCommandSeen = true;
		for (; owned < pending.length; owned++) pending[owned].dataOnly = dataOnly;
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
					simpleCommands(input.slice(i + 2, end), out, depth + 1, false);
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
			simpleCommands(input.slice(i + 2, end), out, depth + 1, false);
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
			i++;
			if (c !== "\n" && c !== ";") uncertain = true;
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
	if (heredocs && sawHeredoc && (uncertain || pending.length)) {
		// Replay the original tokenizer, including all bodies, rather than weakening its
		// behavior in syntax this small lexer cannot prove to be non-executable data.
		out.length = start;
		return simpleCommands(input, out, depth, false);
	}
	return out;
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

function classify(args: string[]): { path: string; readOnly: boolean } | null {
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
		if (CHRONICLE_READ_ONLY.has(sub.slice(0, n).join(" "))) return { path: `chronicle ${sub.slice(0, n).join(" ")}`, readOnly: true };
	}
	return { path: `chronicle ${sub.slice(0, 2).join(" ")}`.trim(), readOnly: false };
}

/** Find every `cratis chronicle` invocation in command position and classify it. */
export function classifyCratisInvocations(command: string, depth = 0): CratisInvocation[] {
	const found: CratisInvocation[] = [];
	if (depth > 4 || !/cratis/i.test(command)) return found;
	// Shell -c/eval strings are another execution context, not standalone file writes.
	for (const words of simpleCommands(command, [], 0, depth === 0)) {
		const cmd = commandWords(words);
		const head = (cmd[0] ?? "").split("/").pop() ?? "";
		if (SHELLS.has(head)) {
			const c = cmd.indexOf("-c");
			if (c !== -1 && cmd[c + 1]) found.push(...classifyCratisInvocations(cmd[c + 1], depth + 1));
		} else if (head === "eval") {
			found.push(...classifyCratisInvocations(cmd.slice(1).join(" "), depth + 1));
		} else if (head === "cratis") {
			const verdict = classify(cmd.slice(1));
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

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!/cratis/.test(command)) return undefined;

		const risky = classifyCratisInvocations(command).filter(i => !i.readOnly);
		if (risky.length === 0) return undefined;
		if (isGuardOff("cratis")) {
			if (ctx.hasUI) ctx.ui.notify(`cratis-cli-guard off: allowed '${risky.map(i => i.text).join("; ").replace(/\s+/g, " ").slice(0, 180)}'`, "info");
			return undefined;
		}

		const list = risky.map(i => `  ${i.text}`).join("\n");
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
		const choice = await ctx.ui.select(
			`⚠️ cratis command that may change state:\n\n${list}\n\nActive context:\n${context}\n\n` +
				"Check the target (--server / CHRONICLE_CONNECTION_STRING override the context). Run it?",
			["No", "Yes, run it"],
		);
		if (choice !== "Yes, run it") return { block: true, reason: "cratis-cli-guard: the user declined this cratis command." };
		return undefined;
	});
}
