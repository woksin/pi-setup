/** Cooperative executable-position checks only. Never reads payloads or expands opaque execution. */
import { basename } from "node:path";
import { simpleCommands } from "../extensions/wait-guard.ts";

export type PublicationCode = "gh-publication" | "http-publication" | "unsupported-env";
export const PUBLICATION_REASON = "publish guard: use the publish tool for GitHub text. It scans the exact captured payload before sending. Rewrite refused text; do not evade checks. Only the user may disable this guard with /guards off publish.";
type Word = string;
type Words = Word[];
interface Executable { words: Words; unsupported?: boolean }
const assignment = (word: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const help = (word: Word) => ["--help", "--version"].includes(word);
function envOperand(word: Word): boolean { return ["-u", "--unset", "-C", "--chdir"].includes(word); }
function envSkip(word: Word): boolean {
	return assignment(word) || ["-i", "--ignore-environment"].includes(word) || /^(?:--(?:unset|chdir)=|-[uC].+)/.test(word);
}
function envStep(word: Word, remaining: number): number {
	if (envSkip(word)) return 1;
	if (envOperand(word)) return remaining > 1 ? 2 : -1;
	// Unknown flags (notably -S/--split-string) are deliberately not interpreted.
	return word.startsWith("-") ? -1 : 0;
}
function envCommand(words: Words): Executable {
	let index = 1;
	while (index < words.length) {
		const word = words[index];
		if (help(word)) return { words: [] };
		if (word === "--") return { words: words.slice(index + 1) };
		const step = envStep(word, words.length - index);
		if (step < 0) return { words: [], unsupported: true };
		if (step === 0) return { words: words.slice(index) };
		index += step;
	}
	return { words: [] };
}
function wrapperHelp(word: Word): boolean { return help(word) || ["-v", "-V"].includes(word); }
function wrapperIndex(words: Words, name: string): number {
	let index = 1;
	while (["--", "-p", "-c", "-l"].includes(words[index])) index++;
	if (name === "exec" && words[index] === "-a") index += 2;
	return index;
}
function wrapper(words: Words): Executable | undefined {
	const name = basename(words[0] ?? "");
	if (name === "env") return envCommand(words);
	if (name === "rtk" && words[1] === "proxy") return { words: words.slice(2) };
	if (!["command", "exec", "nohup"].includes(name)) return;
	if (wrapperHelp(words[1])) return { words: [] };
	return { words: words.slice(wrapperIndex(words, name)) };
}
/** Shell reserved words that can precede a command in executable position; the command after them still runs. */
const CONTROL_WORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);
const prefixWord = (word: Word) => assignment(word) || CONTROL_WORDS.has(word);
function skipPrefixes(words: Words): string[] {
	let rest = words;
	while (rest.length) {
		if (rest[0] === "time") rest = rest.slice(rest[1] === "-p" ? 2 : 1);
		else if (prefixWord(rest[0])) rest = rest.slice(1);
		else break;
	}
	return rest;
}
function executable(tokens: Words): Executable {
	let words = tokens;
	for (let depth = 0; depth < 8; depth++) {
		words = skipPrefixes(words);
		const next = wrapper(words);
		if (!next) return { words };
		if (next.unsupported) return next;
		words = next.words;
	}
	return { words: [], unsupported: true };
}
function ghCommand(words: Words): { args: Words; unknown?: boolean } {
	let index = 1;
	while (words[index]?.startsWith("-")) {
		const word = words[index++];
		if (["--help", "--version", "-h"].includes(word)) return { args: [] };
		if (["--repo", "-R", "--hostname", "--config"].includes(word)) { index++; continue; }
		if (/^(?:--(?:repo|hostname|config)=|-R.+)/.test(word)) continue;
		return { args: [], unknown: true };
	}
	return { args: words.slice(index) };
}
const textFlag = (word: Word) => /^--(?:title|body|body-file|comment|subject)(?:=|$)/.test(word) || /^-[^-]*[tbFc]/.test(word);
function apiWrite(args: Words): boolean {
	let method: string | undefined, payload = false;
	for (let index = 1; index < args.length; index++) {
		const word = args[index];
		if (/^(?:\/?graphql|https:\/\/api\.github\.com\/graphql)$/.test(word)) return true;
		if (["--method", "-X"].includes(word)) { method = args[++index] ?? ""; continue; }
		if (/^(?:--method=|-X.)/.test(word)) method = word.replace(/^(?:--method=|-X)/, "");
		if (/^(?:--(?:field|raw-field|input)(?:=|$)|-[fF])/.test(word)) payload = true;
	}
	return method === undefined ? payload : method.toUpperCase() !== "GET";
}
function ghWrite(words: Words): boolean {
	const { args, unknown } = ghCommand(words);
	if (unknown) return true;
	const [family, verb] = args;
	if (family === "api") return apiWrite(args);
	if (["release", "gist"].includes(family)) return ["create", "edit"].includes(verb);
	if (family === "alias") return ["set", "import"].includes(verb);
	if (!["issue", "pr"].includes(family)) return false;
	if (["create", "comment"].includes(verb)) return true;
	return ["edit", "review", "close", "reopen", "merge"].includes(verb) && args.slice(2).some(textFlag);
}
function githubUrl(value: Word): boolean {
	try { return ["api.github.com", "uploads.github.com"].includes(new URL(value).hostname); }
	catch { return false; }
}
const HTTP_VALUES = new Set(["--header", "--output", "--user", "--config", "--proxy", "--user-agent", "--referer", "--connect-timeout", "--max-time"]);
/** Short options that consume a value (rest of the cluster or the next word), per tool. */
const SHORT_VALUES: Record<string, string> = { curl: "AbcCdDeEFHKmoPQrTuUwxXyYzt", wget: "OoaeiBPTtwQUlIXDRAY" };
function httpPayload(word: Word): boolean {
	return /^--(?:data(?:-[a-z]+)?|json|form|upload-file|post-data|post-file|body-data|body-file)(?:=|$)/.test(word);
}
interface HttpState { tool: string; target: boolean; write: boolean }
const readMethod = (value: Word) => ["GET", "HEAD"].includes(value.toUpperCase());
function clusterEffect(state: HttpState, flag: Word, value: Word): void {
	if (state.tool !== "curl") return;
	if (flag === "X") state.write ||= !readMethod(value);
	else if ("dFT".includes(flag)) state.write = true;
}
/** Parses a `-sXPOST`-style cluster left to right; the first value option ends it. Returns words consumed. */
function httpCluster(state: HttpState, word: Word, next: Word): number {
	const valued = SHORT_VALUES[state.tool] ?? "";
	const found = [...word.slice(1)].findIndex(flag => valued.includes(flag));
	if (found < 0) return 1;
	const attached = word.slice(found + 2);
	clusterEffect(state, word[found + 1], attached || next);
	return attached ? 1 : 2;
}
function httpMethod(state: HttpState, word: Word, next: Word): number {
	if (["--request", "--method"].includes(word)) { state.write ||= !readMethod(next); return 2; }
	if (!/^--(?:request|method)=/.test(word)) return 0;
	state.write ||= !readMethod(word.replace(/^--(?:request|method)=/, ""));
	return 1;
}
function httpLong(state: HttpState, word: Word, next: Word): number {
	const method = httpMethod(state, word, next);
	if (method) return method;
	if (httpPayload(word)) { state.write = true; return word.includes("=") ? 1 : 2; }
	if (HTTP_VALUES.has(word)) return 2;
	if (word === "--url") { state.target ||= githubUrl(next); return 2; }
	state.target ||= githubUrl(word.replace(/^--url=/, ""));
	return 1;
}
function httpArgument(cursor: { words: Words; index: number; state: HttpState }): number {
	const { words, index, state } = cursor, word = words[index], next = words[index + 1] ?? "";
	return /^-[^-]/.test(word) ? httpCluster(state, word, next) : httpLong(state, word, next);
}
function httpWrite(words: Words): boolean {
	const state: HttpState = { tool: basename(words[0] ?? ""), target: false, write: false };
	for (let index = 1; index < words.length;) index += httpArgument({ words, index, state });
	return state.target && state.write;
}
function executablePublication(command: Executable): PublicationCode | undefined {
	if (command.unsupported) return "unsupported-env";
	const { words } = command, name = basename(words[0] ?? "");
	if (name === "gh" && ghWrite(words)) return "gh-publication";
	if (["curl", "wget"].includes(name) && httpWrite(words)) return "http-publication";
}
/** Literal top-level commands only: no interpreter/eval/script/xargs/substitution inspection. */
export function publicationGuard(command: string): PublicationCode | undefined {
	for (const tokens of simpleCommands(command.replace(/\\\r?\n/g, ""), false, true)) {
		const code = executablePublication(executable(tokens));
		if (code) return code;
	}
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function nestedTool(child: unknown, depth: number): PublicationCode | undefined {
	if (!record(child) || typeof child.recipient_name !== "string") return;
	return publicationInput(child.recipient_name.replace(/^functions\./, ""), child.parameters, depth + 1);
}
function nestedPublication(children: unknown, depth: number): PublicationCode | undefined {
	if (!Array.isArray(children)) return;
	for (const child of children) {
		const code = nestedTool(child, depth);
		if (code) return code;
	}
}
/** Matches the host's explicit job and nested-tool shapes, without searching arbitrary string fields. */
export function publicationInput(name: string, value: unknown, depth = 0): PublicationCode | undefined {
	if (depth > 4 || !record(value)) return;
	if (name === "multi_tool_use.parallel") return nestedPublication(value.tool_uses, depth);
	if (!["bash", "job_start", "job_watch"].includes(name)) return;
	for (const key of ["command", "check"]) {
		if (typeof value[key] !== "string") continue;
		const code = publicationGuard(value[key]);
		if (code) return code;
	}
}
