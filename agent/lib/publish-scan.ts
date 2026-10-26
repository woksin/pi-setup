/** Outbound diagnostics only: no payload, matched value, path or masked text escapes. */
import { MAX_BYTES, scan } from "./secret-mask.ts";
import { MAX_FINDINGS } from "./secret-mask-diagnostics.ts";
import type { Finding } from "./secret-mask-diagnostics.ts";

export interface PublicationContext { home: string; repoRoot?: string }
export interface PublicationScan { kinds: string[]; count: number; findings: Finding[] }
interface PathRule { pattern: RegExp; kind: string; accepts?: (match: RegExpExecArray) => boolean }
interface ConfiguredRoot { path: string; kind: "home-path" | "repo-root" }
interface DecodedLine { text: string; offsets: number[] }

// Delimiters are not blanked: a path in a URL query, fragment or adjacent Markdown is still examined.
const COMPONENT = String.raw`[^\s/\\"'\x60<>\[\](){};,?#&|]+`;
const SUFFIX = String.raw`[^\s"'\x60<>\[\](){};,?#&|]*`;
const PUBLIC_PI_FILE = /^agent\/(?:AGENTS(?:\.subagent)?\.md|(?:pi-phase|lane-policy)\/README\.md)$/;
const PUBLIC_PI_TREE = /^agent\/(?:agents|extensions|early-extensions|lib|workflows|templates|profiles|bin)\/.+/;
const PI_PATH = new RegExp(String.raw`(?:~|\$HOME|\$\{HOME\})[/\\]\.pi(?:[/\\]${SUFFIX})?`, "g");

function concreteHome(match: RegExpExecArray): boolean {
	return !/[/\\]<(?:user|name)>[/\\]?$/.test(match[0]);
}

function piKind(match: RegExpExecArray): string | undefined {
	const suffix = match[0].replace(/^(?:~|\$HOME|\$\{HOME\})[/\\]\.pi[/\\]?/, "").replace(/\\/g, "/");
	if (!suffix) return undefined;
	if (suffix.split("/").some(component => component === "." || component === "..")) return "path-traversal";
	if (PUBLIC_PI_FILE.test(suffix) || PUBLIC_PI_TREE.test(suffix)) return undefined;
	return "pi-private";
}

function rootRule(root: ConfiguredRoot): PathRule | undefined {
	const trimmed = root.path.replace(/[/\\]+$/, "");
	if (!/^(?:\/|[A-Za-z]:[/\\])/.test(trimmed)) return undefined;
	const literal = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { kind: root.kind, pattern: new RegExp(`${literal}(?=$|[/\\\\\\s"'\\x60<>\\[\\](){};,?#&|])`, "g") };
}

function pathRules(context: PublicationContext): PathRule[] {
	const rules: PathRule[] = [
		{ kind: "home-path", pattern: new RegExp(String.raw`(?:/[Uu]sers/|/home/|[A-Za-z]:[/\\]Users[/\\])(?:<(?:user|name)>|${COMPONENT})${SUFFIX}`, "g"), accepts: concreteHome },
		{ kind: "volume-path", pattern: new RegExp(String.raw`/Volumes/${COMPONENT}`, "g") },
		{ kind: "temp-path", pattern: new RegExp(String.raw`/(?:private/)?(?:var/folders|tmp)/${COMPONENT}`, "g") },
		{ kind: "work-folder", pattern: new RegExp(String.raw`\.ai-work[/\\]${COMPONENT}`, "g") },
	];
	const home = rootRule({ path: context.home, kind: "home-path" });
	if (home) rules.push(home);
	const repo = rootRule({ path: context.repoRoot ?? "", kind: "repo-root" });
	if (repo && !rules.some(rule => matchesRule(context.repoRoot!, rule).length > 0)) rules.push(repo);
	return rules;
}

/** Decode valid percent runs once, mapping every decoded character back to its source offset. */
function decodeLine(source: string): DecodedLine {
	let text = "", cursor = 0;
	const offsets: number[] = [];
	function appendPlain(end: number) {
		for (; cursor < end; cursor++) { offsets.push(cursor); text += source[cursor]; }
	}
	for (const match of source.matchAll(/(?:%[0-9a-f]{2})+/gi)) {
		appendPlain(match.index);
		let decoded: string;
		try { decoded = decodeURIComponent(match[0]); }
		catch { appendPlain(match.index + match[0].length); continue; }
		for (const character of decoded) {
			for (let unit = 0; unit < character.length; unit++) offsets.push(cursor);
			text += character;
			cursor += Buffer.byteLength(character, "utf8") * 3;
		}
	}
	appendPlain(source.length);
	return { text, offsets };
}

function matchesRule(text: string, rule: PathRule): RegExpExecArray[] {
	const matches = [...text.matchAll(rule.pattern)], accepts = rule.accepts;
	return accepts ? matches.filter(accepts) : matches;
}

function inspectPaths(text: string, rules: PathRule[], record: (kind: string, index: number) => void): void {
	for (const rule of rules) {
		for (const match of matchesRule(text, rule)) record(rule.kind, match.index);
	}
	inspectPiPaths(text, record);
}

function inspectPiPaths(text: string, record: (kind: string, index: number) => void): void {
	for (const match of text.matchAll(PI_PATH)) {
		const kind = piKind(match);
		if (kind) record(kind, match.index);
	}
}

function pathFindings(text: string, context: PublicationContext): { count: number; findings: Finding[]; kinds: string[] } {
	const rules = pathRules(context), seen = new Set<string>();
	const findings: Finding[] = [], kinds = new Set<string>();
	let line = 0;
	for (const source of text.split("\n")) {
		line++;
		const record = (kind: string, index: number) => {
			const key = `${line}:${index}:${kind}`;
			if (seen.has(key)) return;
			seen.add(key); kinds.add(kind);
			if (findings.length < MAX_FINDINGS) findings.push({ kind, line });
		};
		inspectPaths(source, rules, record);
		if (!/%[0-9a-f]{2}/i.test(source)) continue;
		const decoded = decodeLine(source);
		inspectPaths(decoded.text, rules, (kind, index) => record(kind, decoded.offsets[index]));
	}
	return { count: seen.size, findings, kinds: [...kinds] };
}

/** No configuration reads, allowlists, entropy scoring, URL blanking or code-fence exemptions. */
export function scanPublication(text: string, context: PublicationContext): PublicationScan {
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
		return { count: 1, kinds: ["too-large"], findings: [{ kind: "too-large", line: 1 }] };
	}
	const secrets = scan(text, [], { diagnostics: true, mode: "outbound" });
	const paths = pathFindings(text, context);
	return {
		count: secrets.count + paths.count,
		kinds: [...new Set([...secrets.kinds, ...paths.kinds])],
		findings: [...secrets.findings!, ...paths.findings].sort((a, b) => a.line - b.line).slice(0, MAX_FINDINGS),
	};
}
