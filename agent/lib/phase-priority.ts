import { readFileSync } from "node:fs";

export interface PriorityGrant {
	expires: number;
	uses: number | null;
	granted_by: string;
	created: number;
}

/** Fail closed on missing, malformed, exhausted or expired grants. Times are epoch seconds. */
export function validateGrant(value: unknown, now = Date.now() / 1000): PriorityGrant | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const data = value as PriorityGrant;
	if (Object.keys(data).sort().join(",") !== "created,expires,granted_by,uses" ||
		!Number.isFinite(data.expires) || !Number.isFinite(data.created) ||
		data.expires <= now || data.expires <= data.created ||
		typeof data.granted_by !== "string" || !data.granted_by ||
		(data.uses !== null && (!Number.isInteger(data.uses) || data.uses < 1 || data.uses > 20))) return undefined;
	return data;
}

export function readGrant(path: string, now = Date.now() / 1000): PriorityGrant | undefined {
	try { return validateGrant(JSON.parse(readFileSync(path, "utf8")), now); }
	catch { return undefined; }
}

export interface PriorityRequest { kind: string; label: string }

/** Small shell word splitter: quotes are argument data, heredoc bodies are not commands. */
function simpleCommands(command: string): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const heredocs: { delimiter: string; tabs: boolean }[] = [];
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
	for (const line of command.replace(/\\\r?\n/g, "").split("\n")) {
		if (heredocs.length && !quote) {
			const { delimiter, tabs } = heredocs[0];
			if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) heredocs.shift();
			continue;
		}
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (quote) {
				if (c === quote) quote = undefined;
				else if (c === "\\" && quote === '"' && "$`\"\\".includes(line[i + 1] ?? "\0")) word += line[++i];
				else word += c;
			} else if (c === "'" || c === '"') {
				quote = c;
				inWord = true;
			} else if (c === "\\" && i + 1 < line.length) {
				word += line[++i];
				inWord = true;
			} else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
				const match = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(i));
				if (match) {
					heredocs.push({ delimiter: match[3], tabs: !!match[1] });
					i += match[0].length - 1;
					endWord();
				}
			} else if (";&|(){}".includes(c)) endCommand();
			else if (c === " " || c === "\t" || c === "\r") endWord();
			else if (c === "#" && !inWord) break;
			else { word += c; inWord = true; }
		}
		if (quote) word += "\n";
		else endCommand();
	}
	endCommand();
	return out;
}

const PREFIXES = new Set(["env", "command", "exec", "rtk", "proxy", "then", "do", "else", "!", "time", "nohup"]);
function programIndex(words: string[]): number {
	let i = 0;
	while (i < words.length && (PREFIXES.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
	return i;
}

/** Only wrapper options before the producer's `--` count; repeated options use the last value. */
function request(args: string[]): PriorityRequest | undefined {
	if (args[0] !== "run") return undefined;
	const options: Record<string, string> = {};
	const flags = new Set(["--approved-long-timeout", "--vstest-confirmed"]);
	for (let i = 1; i < args.length && args[i] !== "--"; i++) {
		if (!args[i].startsWith("--")) break; // argparse.REMAINDER: producer starts here
		if (flags.has(args[i])) continue;
		const at = args[i].indexOf("=");
		const key = at === -1 ? args[i] : args[i].slice(0, at);
		options[key] = at === -1 ? (args[++i] ?? "") : args[i].slice(at + 1);
	}
	return options["--priority"] === "high" && options["--kind"] !== "ci" ? {
		kind: options["--kind"] ?? "unknown", label: options["--label"] ?? "unlabelled",
	} : undefined;
}

/** Resolve direct runners and Python script execution without treating Python -c/-m data as a path. */
function phaseArgs(words: string[], index: number): string[] | undefined {
	if (/^python(?:\d+(?:\.\d+)*)?$/.test(words[index]?.split("/").pop() ?? "")) {
		index++;
		while (words[index]?.startsWith("-")) {
			const flag = words[index++];
			if (flag === "--") break;
			if (/^-[cm]/.test(flag)) return undefined;
			if (flag === "-W" || flag === "-X") index++;
		}
	}
	return ["pi-phase", "pi_phase.py"].includes(words[index]?.split("/").pop() ?? "")
		? words.slice(index + 1) : undefined;
}

/** Detect command-position invocations, not mentions in printf/commit messages or heredocs. */
function phaseInvocations(command: string, depth = 0): string[][] {
	if (depth > 3) return [];
	const found: string[][] = [];
	for (const words of simpleCommands(command)) {
		const i = programIndex(words);
		const args = phaseArgs(words, i);
		if (args) found.push(args);
		else if (["bash", "sh", "zsh", "dash"].includes(words[i]?.split("/").pop() ?? "")) {
			const c = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
			if (c > i && words[c + 1]) found.push(...phaseInvocations(words[c + 1], depth + 1));
		}
	}
	return found;
}

export function highPriorityRequests(command: string): PriorityRequest[] {
	return phaseInvocations(command).flatMap(args => {
		const high = request(args);
		return high ? [high] : [];
	});
}

/** Explicit grant creation always needs approval, even when a grant already exists. */
export function grantPriorityRequests(command: string): string[][] {
	return phaseInvocations(command).filter(args => args[0] === "grant-priority").map(args => args.slice(1));
}

/** Raw grant-file access is never approved through agent tools, including mentions in bash data. */
const PROTECTED_FILES = ["priority-grant.json", "priority-orchestrators.json"];
export function referencesGrantFile(toolName: string, input: { command?: unknown; path?: unknown }): boolean {
	if (toolName === "bash") return PROTECTED_FILES.some(file => String(input.command ?? "").includes(file));
	return (toolName === "write" || toolName === "edit") &&
		typeof input.path === "string" && PROTECTED_FILES.some(file => (input.path as string).endsWith(file));
}

/** Pids of pi processes the user designated as orchestrators (they may grant high priority without a prompt). */
export function readOrchestrators(path: string, alive: (pid: number) => boolean): number[] {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as { pids?: unknown };
		return Array.isArray(value.pids) ? value.pids.filter((pid): pid is number => Number.isInteger(pid) && alive(pid)) : [];
	} catch { return []; }
}

/** Orchestrator self-grants stay bounded: at most 10 uses or 120 minutes per grant. */
export function withinOrchestratorCap(args: string[]): boolean {
	const text = args.join(" ");
	const minutes = /--minutes[= ](\d+)/.exec(text);
	if (minutes) return Number(minutes[1]) >= 1 && Number(minutes[1]) <= 120;
	const uses = /--uses[= ](\d+)/.exec(text);
	if (uses) return Number(uses[1]) >= 1 && Number(uses[1]) <= 10;
	return true;
}

export function priorityCommandArgs(input: string): string[] {
	const words = input.trim().split(/\s+/).filter(Boolean);
	if (!words.length || (words.length === 1 && words[0] === "status")) return ["status"];
	if (words.length === 1 && words[0] === "revoke") return ["revoke-priority"];
	if (words.length === 1 && words[0] === "allow-once") return ["grant-priority", "--uses", "1"];
	if (words[0] === "allow" && words.length <= 2) {
		const minutes = words[1] ?? "30";
		if (/^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 480)
			return ["grant-priority", "--minutes", String(Number(minutes))];
	}
	throw new Error("Usage: /phase-priority [status | allow [minutes (1-480)] | allow-once | revoke]");
}
