/** Conservative command-position detection, not a shell interpreter. Unknown syntax is allowed. */
interface Word { value: string; start: number; end: number }
interface Command { words: Word[]; text: string; separator: string; output: boolean }

// Only literal output targets and stderr-to-stdout duplication are understood.
const OUTPUT_REDIRECTION = /^(?:2>&1(?=$|[\s;&|])|>>?[^\S\n]*(?:"[^"$`\\]*"|'[^']*'|[^\s;&|<>(){}$`"'\\]+)(?=$|[\s;&|]))/;

function commands(source: string): Command[] | undefined {
	const out: Command[] = [];
	let words: Word[] = [];
	let value = "";
	let start = -1;
	let quote = "";
	let output = false;
	const endWord = (end: number) => {
		if (start >= 0) words.push({ value, start, end });
		start = -1;
		value = "";
	};
	const endCommand = (end: number, separator = "") => {
		endWord(end);
		if (words.length) out.push({ words, text: source.slice(words[0].start, words.at(-1)!.end), separator, output });
		words = [];
		output = false;
	};
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (quote === '"' && (ch === "`" || (ch === "$" && source[i + 1] === "("))) return undefined;
			if (ch === quote) quote = "";
			else if (ch === "\\" && quote === '"' && /[$`"\\\n]/.test(source[i + 1] ?? "")) {
				if (++i >= source.length) return undefined;
				if (source[i] !== "\n") value += source[i];
			} else value += ch;
		} else if (ch === ">" || (ch === "2" && start < 0 && source.startsWith("2>&1", i))) {
			if (ch === ">" && start >= 0 && /^\d+$/.test(value)) return undefined;
			const redirection = source.slice(i).match(OUTPUT_REDIRECTION)?.[0];
			if (!redirection || (!words.length && start < 0)) return undefined;
			endWord(i);
			output = true;
			i += redirection.length - 1;
		} else if (output && !/[\s;&|#]/.test(ch)) {
			return undefined; // Only trailing redirections can be safely removed.
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
		} else if ("<`(){}".includes(ch)) {
			return undefined; // input redirections, heredocs, substitutions and compound syntax
		} else if (";&|\n".includes(ch)) {
			const separator = (ch === "&" || ch === "|") && source[i + 1] === ch ? ch + ch : ch;
			endCommand(i, separator);
			if (separator.length === 2) i++;
		} else if (/\s/.test(ch)) endWord(i);
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
	const parsed = commands(source) ?? [];
	let cwdPrefix = "";
	let leading = true;
	for (let n = 0; n < parsed.length; n++) {
		const command = parsed[n];
		if (leading && command.words.length === 2 && command.words[0].value === "cd" &&
			command.separator === "&&" && !command.output) {
			cwdPrefix += `${command.text} && `;
			continue;
		}
		leading = false;
		let filtered = command.output;
		let knownPipeline = true;
		while (parsed[n]?.separator === "|") {
			const filter = parsed[++n];
			filtered = true;
			if (!filter || !["tail", "head", "grep", "tee"].includes(basename(filter.words[0].value))) knownPipeline = false;
		}
		if (!knownPipeline) continue;
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
				if (reason) return reason.replace("\n", `\n${cwdPrefix}`);
			}
		}
		if (program !== "dotnet" || !BUILD_COMMANDS.has(args[0])) continue;
		const kind = args[0] === "test" ? "test" : "build";
		// A direct executable follows pi-phase's --; turn shell assignments into env arguments.
		let original = assignment(words[0].value) ? `env ${command.text}` : command.text;
		if (words[0].value === "exec") original = command.text.slice(words[1].start - words[0].start);
		const outputHint = filtered ? "\nUse pi-phase's --log FILE --tail N instead of shell output redirections/pipes." : "";
		return "dotnet guard: run .NET work inside pi-phase:\n" +
			`${cwdPrefix}~/.pi/agent/bin/pi-phase run --kind ${kind} --label 'dotnet ${args[0]}' --timeout 300 --queue-timeout 600 -- ${original}${outputHint}`;
	}
	return undefined;
}
