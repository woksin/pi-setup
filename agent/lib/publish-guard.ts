/** Cooperative executable-position checks only. Never reads payloads or expands opaque execution. */
import { basename } from "node:path";
import { simpleCommands } from "../extensions/wait-guard.ts";

export type PublicationCode = "gh-publication" | "http-publication" | "unsupported-env";
export const PUBLICATION_REASON = "publish guard: use the publish tool for GitHub text. It scans the exact captured payload before sending. Rewrite refused text; do not evade checks. Only the user may disable this guard with /guards off publish.";
interface Executable { words: string[]; unsupported?: boolean }
const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
const help = (word: string) => ["--help", "--version"].includes(word);
function envCommand(words: string[]): Executable {
	let index = 1;
	while (index < words.length) {
		const word = words[index++];
		if (help(word)) return { words: [] };
		if (word === "--") return { words: words.slice(index) };
		if (assignment(word) || ["-i", "--ignore-environment"].includes(word)) continue;
		if (["-u", "--unset", "-C", "--chdir"].includes(word)) { if (index >= words.length) return { words: [], unsupported: true }; index++; continue; }
		if (/^(?:--(?:unset|chdir)=|-[uC].+)/.test(word)) continue;
		if (word.startsWith("-")) return { words: [], unsupported: true };
		return { words: words.slice(index - 1) };
	}
	return { words: [] };
}
function wrapper(words: string[]): Executable | undefined {
	const name = basename(words[0] ?? "");
	if (name === "env") return envCommand(words);
	if (name === "rtk" && words[1] === "proxy") return { words: words.slice(2) };
	if (!["command", "exec", "nohup"].includes(name)) return;
	if (help(words[1]) || ["-v", "-V"].includes(words[1])) return { words: [] };
	let index = 1;
	while (["--", "-p", "-c", "-l"].includes(words[index])) index++;
	if (name === "exec" && words[index] === "-a") index += 2;
	return { words: words.slice(index) };
}
function executable(tokens: string[]): Executable {
	let words = tokens;
	for (let depth = 0; depth < 8; depth++) {
		while (assignment(words[0] ?? "")) words = words.slice(1);
		const next = wrapper(words);
		if (!next) return { words };
		if (next.unsupported) return next;
		words = next.words;
	}
	return { words: [], unsupported: true };
}
function ghCommand(words: string[]): { args: string[]; unknown?: boolean } {
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
const textFlag = (word: string) => /^--(?:title|body|body-file|comment|subject)(?:=|$)/.test(word) || /^-[^-]*[tbFc]/.test(word);
function apiWrite(args: string[]): boolean {
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
function ghWrite(words: string[]): boolean {
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
function githubUrl(value: string): boolean {
	try { return ["api.github.com", "uploads.github.com"].includes(new URL(value).hostname); }
	catch { return false; }
}
const HTTP_VALUES = new Set(["-H", "--header", "-o", "--output", "-u", "--user", "-K", "--config", "-x", "--proxy", "--user-agent", "-A", "--referer", "-e", "--connect-timeout", "--max-time"]);
function httpPayload(word: string): boolean {
	return /^--(?:data(?:-[a-z]+)?|json|form|upload-file|post-data|post-file|body-data|body-file)(?:=|$)|^-[dFT]/.test(word);
}
function attachedHttpValue(word: string): boolean {
	return /^--[^=]+=|^-[dFTX].+/.test(word);
}
interface HttpState { target: boolean; write: boolean }
function httpMethod(state: HttpState, word: string, next: string): number {
	if (["--request", "-X", "--method"].includes(word)) { state.write ||= !["GET", "HEAD"].includes(next.toUpperCase()); return 2; }
	if (/^(?:--(?:request|method)=|-X.)/.test(word)) {
		state.write ||= !["GET", "HEAD"].includes(word.replace(/^(?:--(?:request|method)=|-X)/, "").toUpperCase()); return 1;
	}
	return 0;
}
function httpArgument(cursor: { words: string[]; index: number; state: HttpState }): number {
	const { words, index, state } = cursor, word = words[index];
	const method = httpMethod(state, word, words[index + 1] ?? "");
	if (method) return method;
	if (httpPayload(word)) { state.write = true; return attachedHttpValue(word) ? 1 : 2; }
	if (HTTP_VALUES.has(word)) return 2;
	if (word === "--url") { state.target ||= githubUrl(words[index + 1] ?? ""); return 2; }
	state.target ||= githubUrl(word.replace(/^--url=/, ""));
	return 1;
}
function httpWrite(words: string[]): boolean {
	const state: HttpState = { target: false, write: false };
	for (let index = 1; index < words.length;) index += httpArgument({ words, index, state });
	return state.target && state.write;
}
/** Literal top-level commands only: no interpreter/eval/script/xargs/substitution inspection. */
export function publicationGuard(command: string): PublicationCode | undefined {
	for (const tokens of simpleCommands(command.replace(/\\\r?\n/g, ""), false)) {
		const { words, unsupported } = executable(tokens);
		if (unsupported) return "unsupported-env";
		const name = basename(words[0] ?? "");
		if (name === "gh" && ghWrite(words)) return "gh-publication";
		if (["curl", "wget"].includes(name) && httpWrite(words)) return "http-publication";
	}
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Matches the host's explicit job and nested-tool shapes, without searching arbitrary string fields. */
export function publicationInput(name: string, value: unknown, depth = 0): PublicationCode | undefined {
	if (depth > 4 || !record(value)) return;
	if (name === "multi_tool_use.parallel") {
		const children = value.tool_uses;
		if (!Array.isArray(children)) return;
		for (const child of children) {
			if (!record(child) || typeof child.recipient_name !== "string") continue;
			const code = publicationInput(child.recipient_name.replace(/^functions\./, ""), child.parameters, depth + 1);
			if (code) return code;
		}
		return;
	}
	if (!["bash", "job_start", "job_watch"].includes(name)) return;
	for (const key of ["command", "check"]) {
		if (typeof value[key] !== "string") continue;
		const code = publicationGuard(value[key]);
		if (code) return code;
	}
}
