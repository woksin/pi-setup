/** Conservative command-position detection, not a shell interpreter. Unknown syntax is allowed. */
interface Word { value: string; start: number; end: number }
interface Command { words: Word[]; text: string }

function commands(source: string): Command[] | undefined {
	const out: Command[] = [];
	let words: Word[] = [];
	let value = "";
	let start = -1;
	let quote = "";
	const endWord = (end: number) => {
		if (start >= 0) words.push({ value, start, end });
		start = -1;
		value = "";
	};
	const endCommand = (end: number) => {
		endWord(end);
		if (words.length) out.push({ words, text: source.slice(words[0].start, words.at(-1)!.end) });
		words = [];
	};
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === quote) quote = "";
			else if (ch === "\\" && quote === '"' && /[$`"\\\n]/.test(source[i + 1] ?? "")) {
				if (++i >= source.length) return undefined;
				if (source[i] !== "\n") value += source[i];
			} else value += ch;
		} else if (ch === "'" || ch === '"') {
			if (start < 0) start = i;
			quote = ch;
		} else if (ch === "\\") {
			if (++i >= source.length) return undefined;
			if (source[i] === "\n") continue;
			if (start < 0) start = i - 1;
			value += source[i];
		} else if (ch === "#" && start < 0) {
			endCommand(i);
			while (i < source.length && source[i] !== "\n") i++;
		} else if ("<>`(){}".includes(ch)) {
			return undefined; // redirections, heredocs, substitutions and compound syntax
		} else if (";&|\n".includes(ch)) endCommand(i);
		else if (/\s/.test(ch)) endWord(i);
		else {
			if (start < 0) start = i;
			value += ch;
		}
	}
	if (quote) return undefined;
	endCommand(source.length);
	return out;
}

const basename = (word: string) => word.split("/").pop() ?? "";
const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** Only unwrap known, literal prefixes; never search arbitrary arguments for a program name. */
function programIndex(words: Word[]): number {
	let i = 0;
	while (i < words.length) {
		const word = words[i].value;
		if (assignment(word) || ["command", "exec", "nohup"].includes(word)) { i++; continue; }
		if (basename(word) === "env") {
			i++;
			if (words[i]?.value === "--") i++;
			while (words[i] && assignment(words[i].value)) i++;
			continue;
		}
		if (basename(word) === "nice") {
			i++;
			if (words[i]?.value === "-n" || words[i]?.value === "--adjustment") i += 2;
			else if (/^-(?:\d+|n\d+|-adjustment=\d+)$/.test(words[i]?.value ?? "")) i++;
			if (words[i]?.value === "--") i++;
			continue;
		}
		return i;
	}
	return i;
}

const BUILD_COMMANDS = new Set(["build", "test", "publish", "pack", "msbuild", "run"]);

/** Return an actionable replacement for the first definite unwrapped .NET invocation. */
export function dotnetBlockReason(source: string, depth = 0): string | undefined {
	if (depth > 3) return undefined;
	for (const command of commands(source) ?? []) {
		const words = command.words;
		const i = programIndex(words);
		const program = basename(words[i]?.value ?? "");
		const args = words.slice(i + 1).map(word => word.value);
		if (program === "pi-phase" && args[0] === "run" && args.includes("--")) continue;
		if (["bash", "sh", "dash", "zsh"].includes(program)) {
			let flag = 0;
			while (flag < args.length && /^(?:-[a-z]+|--noprofile|--norc)$/.test(args[flag]) &&
				!/^-[a-z]*c[a-z]*$/.test(args[flag])) flag++;
			const script = /^-[a-z]*c[a-z]*$/.test(args[flag] ?? "") ? args[flag + 1] : undefined;
			if (script && !/[$`]/.test(script)) {
				const reason = dotnetBlockReason(script, depth + 1);
				if (reason) return reason;
			}
		}
		if (program !== "dotnet" || !BUILD_COMMANDS.has(args[0])) continue;
		const kind = args[0] === "test" ? "test" : "build";
		// A direct executable follows pi-phase's --; turn shell assignments into env arguments.
		const original = assignment(words[0].value) ? `env ${command.text}` : command.text;
		return "dotnet guard: run .NET work inside pi-phase:\n" +
			`~/.pi/agent/bin/pi-phase run --kind ${kind} --label 'dotnet ${args[0]}' --timeout 300 --queue-timeout 600 -- ${original}`;
	}
	return undefined;
}
