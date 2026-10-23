/**
 * secret-mask — block credential dumpers and redact text before session storage.
 * Optional ~/.pi/agent/secret-mask.json (re-read per event): enabled=true, scope="all",
 * blockCommands=true, redactResults=true, redactInput=true, allowlist=[]. Scope uses
 * output-cap's all/main/subagents/off roles. Invalid/missing config keeps safe defaults.
 * allowlist entries are regex strings tested against a candidate redaction VALUE only
 * (e.g. ^L13-LOCAL-FAKE); a match exempts that value, NEVER command blocking. Invalid
 * expressions are ignored. Keep this list narrow; its expressions are operator-trusted.
 * Layering with the Cratis hooks: where the repository has cratis-guard-secrets.sh and the Cratis Pi extension
 * (lib/cratis-hooks-detect.ts: its `cratis_quality_gate` tool must be registered in this Pi process from the extension under process.cwd(), so an untrusted project's hooks never count), a command this extension
 * would block is first put to that script (3 s, same script, cwd and payload as the Cratis extension). If Cratis blocks it, this extension stands down: one block, one message. If Cratis allows
 * it (patterns only this extension knows, e.g. helm/op/security) or cannot say (spawn error, timeout), this extension
 * blocks as before. CRATIS_HOOKS_ALLOW_SECRET_READS=1 (set where the harness starts) stands this extension down too.
 * Redaction always stays on. Elsewhere blocking is unchanged.
 * /guards off secrets disables blocking only, NOT redaction. enabled:false disables these
 * handlers, including output-cap pre-masking of offloads. redactResults/redactInput and scope
 * are explicit operator controls, not guard switches.
 * Notifications require rotation: masking does not revoke a credential or erase history.
 * Only text parts <= 2 MiB are scanned; non-text parts, split/encoded/unknown secrets,
 * tool details, streaming updates and user_bash (!/!!) output are not covered
 * (user_bash only exposes the command before execution). output-cap masks before offload;
 * oversized offloads are omitted. PEM/Secret sections over 64 KiB are conservatively hidden.
 * Any command mentioning a GitHub publication scans its entire text for credentials, independently
 * of shell parsing (including quoted text and heredoc bodies). Raw body/notes-file flags also scan
 * referenced files independently of parsing; file-flag '-' inputs and execution wrappers are refused.
 * Internal paths are checked only in payloads/files, so cd and file arguments remain usable.
 * Direct gist stdin from literal echo/printf/heredoc is scanned; unscannable stdin,
 * unreadable/oversized files and relative files with an uncertain cwd are refused. This scan
 * precedes Cratis credential-read delegation and cannot be approved by a dumper prompt.
 * Command matching is conservative, not a full shell interpreter; computed payloads are refused.
 * Logs contain counts/kinds only, never commands or credential values.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { shellSegments } from "./issue-work.ts";
import type { ShellSegment } from "./issue-work.ts";
import { isGuardOff } from "./guards.ts";
import { cratisVerdict, spawnRunner } from "./cratis-hooks-detect.ts";
import { guardSelect, isOrchestrated, orchLog } from "./orchestration.ts";
import { logError, processRoles, scopeAllows } from "./output-cap.ts";
import type { CratisRunner, ToolLister } from "./cratis-hooks-detect.ts";
import type { Role, Scope } from "./output-cap.ts";

export interface Config {
	enabled: boolean;
	scope: Scope;
	blockCommands: boolean;
	redactResults: boolean;
	redactInput: boolean;
	allowlist: string[];
}
export const DEFAULTS: Config = {
	enabled: true, scope: "all", blockCommands: true, redactResults: true, redactInput: true, allowlist: [],
};
export const MAX_BYTES = 2 * 1024 * 1024;
export const INPUT_NOTICE = "secret-mask: a credential was removed from your message before it was stored. Rotate it.";
export const RUN_ANYWAY = "Run anyway (output will still be redacted)";

export function parseConfig(raw: unknown): Config {
	const config = { ...DEFAULTS, allowlist: [] as string[] };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
	const values = raw as Record<string, unknown>;
	for (const key of ["enabled", "blockCommands", "redactResults", "redactInput"] as const) {
		if (typeof values[key] === "boolean") config[key] = values[key];
	}
	if (["all", "main", "subagents", "off"].includes(String(values.scope))) config.scope = values.scope as Scope;
	if (Array.isArray(values.allowlist)) config.allowlist = values.allowlist.filter((v): v is string => typeof v === "string");
	return config;
}

export function loadConfig(file = join(homedir(), ".pi", "agent", "secret-mask.json")): Config {
	try { return parseConfig(JSON.parse(readFileSync(file, "utf8"))); }
	catch { return parseConfig(undefined); }
}

export interface Rule { name: string; alternative: string }
const rule = (name: string, alternative: string): Rule => ({ name, alternative });
const RESOURCE = /(?:^|\s)(?:pods?|po|deploy|deployments?|sts|statefulsets?|ds|daemonsets?|cronjobs?|jobs?|secrets?|configmaps?|cm)(?=[\s/,]|$)/;
const FILE = /(?:^|[\s/<>'"])(?:[^\s'";|]*\/)?(?:kubeconfig[^\s'";|]*|\.env(?:\.[^\s'";|]*)?|[^\s/'";|]*\.(?:pem|key|pfx|ppk)|id_[^\s'";|]*|\.netrc|\.npmrc|auth\.json|[^\s/'";|]*secrets[^\s/'";|]*\.(?:json|ya?ml))(?=[\s'";|)]|$)|(?:\.kube\/(?:config|\*)|\.aws\/credentials|\.docker\/config\.json)(?=[\s'";|)]|$)/i;
const DUMPERS: [RegExp, Rule][] = [
	[/\bhelm\s+get\s+(?:values|manifest|all)\b/, rule("helm-get", "Use `helm status RELEASE` or request a single non-secret field instead of values/manifests.")],
	[/\bdocker\s+compose\b[^;\n|&]*\bconfig\b/, rule("docker-compose-config", "Use `docker compose config --services` or `--images` for a non-secret projection.")],
	[/\bprintenv\b|^\s*[('"\s]*(?:env|set)[)'"\s]*$|\b(?:bash|sh)\s+-c\s+["']?env["']?(?:\s*$|\s*\))|\b(?:kubectl|docker)\s+exec\b[^;\n|&]*\senv(?:\s*$|\s*[)' "])|\bexport\s+-p\b/, rule("environment", "Name the non-secret variable you need instead of dumping the environment.")],
	[/\bgh\s+(?:secret\s+(?:list|get)\b|api\b[^;\n|&]*\/actions\/secrets\b|auth\s+token\b)/, rule("github-secrets", "Use `gh auth status` or request only non-secret repository metadata.")],
	[/\bvault\s+(?:read|kv\s+get|token\s+lookup)\b/, rule("vault", "Use `vault kv metadata get PATH` for metadata, not secret values.")],
	[/\bpulumi\b[^;\n|&]*--show-secrets\b/, rule("pulumi-secrets", "Omit `--show-secrets` so Pulumi keeps secret values encrypted.")],
	[/\baz\s+keyvault\s+secret\s+(?:show|list)\b/, rule("azure-keyvault", "Request only a non-secret field with `--query id -o tsv` instead of dumping secrets.")],
	[/\baws\s+secretsmanager\s+get-secret-value\b/, rule("aws-secretsmanager", "Use `aws secretsmanager describe-secret --secret-id ID` for metadata.")],
	[/\baws\s+ssm\s+get-parameters?\b[^;\n|&]*--with-decryption\b/, rule("aws-ssm", "Omit `--with-decryption` and request only parameter metadata.")],
	[/\bgcloud\s+secrets\s+versions\s+access\b/, rule("gcloud-secrets", "Use `gcloud secrets versions describe VERSION --secret=NAME` for metadata.")],
	[/\bop\s+(?:read|item\s+get)\b/, rule("onepassword", "Use `op item list --fields id,title` for metadata instead of item contents.")],
	[/\bsecurity\s+find-(?:generic|internet)-password\b[^;\n|&]*\s-w\b/, rule("keychain-password", "Omit `-w` and request only non-secret keychain metadata.")],
];

/** Only uppercase assignment patterns indicate a credential search, not code identifiers. */
function recursiveAssignmentPattern(command: string): boolean {
	const args = /\bgrep\b([\s\S]*)/.exec(command)?.[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
	const pattern = args.find(arg => !arg.startsWith("-") || arg.startsWith("--regexp="));
	return /^(?:export\s+)?(?:[A-Z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|CONNECTION_?STRING)[A-Z_]*)=/.test(
		(pattern ?? "").replace(/^--regexp=/, "").replace(/^["']|["']$/g, ""));
}

/** Deliberately do not treat a pipe to jq/grep as proof that a credential dump is safe. */
export function commandRule(command: string): Rule | undefined {
	for (const part of command.split(/[;\n|&]/)) {
		if (/\bgit\b[^;\n|&]*\bgrep\b/.test(part)) continue;
		const kubectl = /\bkubectl\b([\s\S]*)/.exec(part)?.[1];
		if (kubectl) {
			if (/\bconfig\s+view\b[^;\n|&]*--raw\b/.test(kubectl)) return rule("kubectl-config-raw", "Omit `--raw` and request non-secret context names with `kubectl config get-contexts -o name`.");
			const operation = /\b(get|describe)\b([\s\S]*)/.exec(kubectl);
			if (operation && RESOURCE.test(operation[2])) {
				const secret = operation[1] === "get" && /(?:^|\s)secrets?(?=[\s/,]|$)/.test(operation[2]);
				const outputs = [...part.matchAll(/(?:^|\s)(?:-o(?:=|\s*)|--output(?:=|\s+))["']?([^\s"']+)/g)].map(m => m[1]);
				const full = outputs.some(output => /^(?:json|yaml)$/.test(output));
				const secretDump = secret && (outputs.some(output => output !== "name" && output !== "custom-columns=NAME:.metadata.name")
					|| /--template(?:=|\s)/.test(part));
				const envProjection = outputs.some(output => /^jsonpath/.test(output)) && /\.\.?env\b/.test(part);
				if (secretDump || envProjection || operation[1] === "describe" || (!secret && full)) return rule("kubectl-credentials",
					"Use `-o name` or `-o custom-columns=NAME:.metadata.name` for Secret metadata; for non-secret resources project only the field you need.");
			}
		}
		if (/^\s*(?:command\s+)?(?:\/usr\/bin\/)?env\s*(?:-0\s*)?(?:[<>]|$)|\bdeclare\s+-[A-Za-z]*[xp]\s*(?:[<>]|$)/.test(part)) {
			return rule("environment", "Name the non-secret variable you need instead of dumping the environment.");
		}
		if (/(?:\b(?:cat|less|head|tail|bat|more|grep)\s|<)[^;\n|&]*\/proc\/(?:self|\d+|\*)\/environ\b/.test(part)) {
			return rule("environment", "Name the non-secret variable you need instead of dumping the environment.");
		}
		if (/\bgrep\b.*(?:\s-[A-Za-z]*[rR][A-Za-z]*\b|\s--recursive\b)/.test(part)
			&& recursiveAssignmentPattern(part)) {
			return rule("credential-search", "Search for a specific non-secret key instead of recursively printing credential assignments.");
		}
		if (/\bdocker\s+inspect\b/.test(part) && !/--format(?:=|\s)/.test(part)) return rule("docker-inspect", "Use `docker inspect --format '{{.Config.Image}}'` for a non-secret field.");
		if ((/\b(?:cat|less|head|tail|bat|more)\s/.test(part) || /\bgrep\b.*(?:\s-[A-Za-z]*[rR][A-Za-z]*\b|\s--recursive\b)/.test(part) || /\bbase64\b[^;\n|&]*(?:\s-(?:d|D|--decode)\b|--decode\b)[^;\n|&]*</.test(part)) && FILE.test(part)) {
			return rule("credential-file", "Request a non-secret field or file metadata (`ls -l PATH`); do not print credential files.");
		}
		// These projections contain no variable values. Other compose config forms still dump credentials.
		if (/\bdocker\s+compose\b.*\bconfig\s+--(?:services|images)\s*$/.test(part)) continue;
		for (const [pattern, matched] of DUMPERS) if (pattern.test(part)) return matched;
	}
	return undefined;
}

export function blockReason(matched: Rule): string {
	return `secret-mask: ${matched.name} prints credentials. ${matched.alternative}`;
}

interface Candidate { start: number; end: number; kind: string }
export interface Scan { text: string; kinds: string[]; count: number; skipped: boolean }
const TOKEN_PATTERNS: [string, RegExp][] = [
	["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
	["openai-key", /\bsk-(?!ant-)(?:proj-|live-|test-)?[A-Za-z0-9_-]{24,}/g],
	["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
	["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
	["google-key", /\bAIza[0-9A-Za-z_-]{35}/g],
	["slack", /\bxox[abprs]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/g],
	["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
	["stripe", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
	["mollie", /(?<![^\s"'=:])(?:live|test)_[A-Za-z0-9]{30,}/g],
	["sendgrid", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
];

const SECTION_LIMIT = 65536;

/** Split camelCase/acronyms before matching whole underscore/word segments, never BYPASS. */
export function isSecretKey(name: string): boolean {
	const segments = name.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
	if (/(?:_(?:count|limit|type|name|ttl|length)|hash|policy)$/.test(segments)) return false;
	return /password|passwd/i.test(name) || /(?:^|_)(?:password|passwd|pass|pwd|secret|token|api_?key|access_?key|secret_?key|client_?secret|private_?key|credentials?|connection_?string|account_?key|shared_?access_?key|shared_?access_?signature|sas|sig)(?:_|$)/.test(segments);
}

function nonCredentialValue(value: string): boolean {
	// Digits are not exempt: numeric PINs and passwords exist; counts/limits are exempted by key name instead.
	return /^(?:none|null|true|false|fail|pass|bearer)$/i.test(value);
}

function secretValue(value: string, quoted: boolean, terminated: boolean, relaxed = false): boolean {
	if (nonCredentialValue(value) || /^\*+$|^<[^>]*>$|^\$\{[^}]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$|^\[REDACTED:[^\]]+\]$/.test(value)
		|| /^(?:REDACTED|changeme|example|null|true|false|string|number|boolean|undefined|any|unknown|never|void|object|symbol|bigint|Array|Record|Promise|Readonly|Date)(?:<.*>)?$/i.test(value)
		|| /^(?:[\w$.]+\[|[A-Za-z_$][\w$]*<|\(|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.|\())/.test(value)
		|| (!quoted && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(.*\))?[;,]?$/.test(value)
			&& (terminated || /[.();,]/.test(value) || (!relaxed && !/[0-9]/.test(value))))) return false;
	if (relaxed) return true;
	if (!quoted && /^[A-Za-z0-9]+$/.test(value) && /[A-Za-z]/.test(value)) {
		const digits = value.match(/[0-9]/g)?.length ?? 0;
		const letters = value.length - digits;
		return (digits >= 2 && letters >= 2) || (value.length >= 12 && digits >= 1);
	}
	return /[0-9+/=~!@#$%^&*-]/.test(value) || (value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value));
}

function privateKeys(text: string, out: Candidate[]): void {
	const begins = /-----BEGIN [A-Z ]{0,80}PRIVATE KEY-----/g;
	for (let match = begins.exec(text); match; match = begins.exec(text)) {
		const start = match.index + match[0].length;
		// Bounded search, never an unbounded lazy body for each nested BEGIN. An incomplete
		// or over-limit PEM is hidden through EOF rather than leaking a truncated fragment.
		const closing = /-----END [A-Z ]{0,80}PRIVATE KEY-----/.exec(text.slice(start, start + SECTION_LIMIT + 110));
		const end = closing && closing.index <= SECTION_LIMIT ? start + closing.index : text.length;
		if (end > start) out.push({ start, end, kind: "private-key" });
		begins.lastIndex = closing && closing.index <= SECTION_LIMIT ? end + closing[0].length : text.length;
	}
}

function envJson(text: string, out: Candidate[]): void {
	const pairs = /"(name|value)"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"(name|value)"\s*:\s*"((?:\\.|[^"\\])*)"/gd;
	for (const match of text.matchAll(pairs)) {
		if (match[1] === match[3]) continue;
		const name = match[1] === "name" ? match[2] : match[4];
		let decoded: string;
		try { decoded = JSON.parse(`"${name}"`); } catch { decoded = name; }
		if (!isSecretKey(decoded)) continue;
		const [start, end] = match.indices![match[1] === "value" ? 2 : 4]!;
		if (end > start && !nonCredentialValue(text.slice(start, end))) out.push({ start, end, kind: "env-value" });
	}
}

interface EnvField { key: string; value: string; start: number; end: number; indent: number }
function envYaml(line: string, offset: number, previous: EnvField | undefined, out: Candidate[]): EnvField | undefined {
	const match = /^([ \t]*)(-[ \t]+)?(name|value):[ \t]*(?:"((?:\\.|[^"\\])*)"|'((?:''|[^'])*)'|([^#\r\n]*?))[ \t]*(?:#.*)?(?:\r?\n)?$/d.exec(line);
	if (!match) return undefined;
	const group = match[4] !== undefined ? 4 : match[5] !== undefined ? 5 : 6;
	const [start, end] = match.indices![group]!;
	const field: EnvField = { key: match[3], value: match[group], start: offset + start, end: offset + end, indent: match[1].length + (match[2]?.length ?? 0) };
	if (previous && !match[2] && previous.indent === field.indent && previous.key !== field.key) {
		const name = field.key === "name" ? field : previous;
		const value = field.key === "value" ? field : previous;
		if (isSecretKey(name.value) && value.end > value.start && !nonCredentialValue(value.value)) out.push({ start: value.start, end: value.end, kind: "env-value" });
	}
	return field;
}

/**
 * Relax short/letters-only detection only for env-style assignments of an UPPERCASE secret-named key:
 * `KEY=value` (line start, after whitespace/`export `, or inside a quoted/listed entry such as docker's
 * `["DB_PASSWORD=x"]` or `-e KEY=x`, also as a command prefix) and YAML map entries `KEY: value` alone on a line
 * (compose `environment:`). Code (spaces around `=`, lowercase identifiers, trailing `,`/`;`/brackets) keeps the
 * stricter thresholds of `connections`.
 */
const ENV_FORMS = [
	/(?:^|[ \t"'\[,(])(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`;,&|()[\]{}<>\\]+))(?=$|[\s"',\])])/gmd,
	/^[ \t]*(?:-[ \t]+)?([A-Z_][A-Z0-9_]*):[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#"'`;,&|()[\]{}<>\\]+))[ \t]*(?:#.*)?\r?$/gmd,
];
function envAssignments(text: string, out: Candidate[]): void {
	for (const form of ENV_FORMS) {
		for (const match of text.matchAll(form)) {
			if (!isSecretKey(match[1])) continue;
			const group = match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
			const value = match[group];
			if (value.length < 4 || !secretValue(value, group !== 4, false, true)) continue;
			const [start, end] = match.indices![group]!;
			out.push({ start, end, kind: "connection-string" });
		}
	}
	// A whole quoted entry (docker `Env` JSON, list items): the value runs to the closing quote, spaces included.
	const entries = /(["'])(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)=((?:(?!\1)[^\r\n\\]|\\.)+)\1/gd;
	for (const match of text.matchAll(entries)) {
		if (!isSecretKey(match[2])) continue;
		const value = match[3];
		if (value.length < 4 || !secretValue(value, true, false, true)) continue;
		const [start, end] = match.indices![3]!;
		out.push({ start, end, kind: "connection-string" });
	}
}

function connections(text: string, out: Candidate[]): void {
	const fields = /(?<![\w$.-])(["']?)([A-Za-z_$][\w$.-]{0,255})\1[ \t]*[=:][ \t]*(?:(["'])((?:\\.|(?!\3)[^\\\r\n])*)\3|([^\s"';,&]{8,}))/gd;
	for (const match of text.matchAll(fields)) {
		if (!isSecretKey(match[2])) continue;
		const group = match[3] ? 4 : 5;
		const value = match[group];
		const [start, end] = match.indices![group]!;
		// The bare-value capture excludes delimiters; retain that code-expression signal.
		const terminated = text[end] === ";" || text[end] === ",";
		// A JS declaration's regex literal may contain quotes that truncate the capture.
		const regexLiteral = !match[3] && value.startsWith("/")
			&& /\b(?:const|let|var)[ \t]+$/.test(text.slice(text.lastIndexOf("\n", match.index) + 1, match.index));
		if (value.length < 8 || regexLiteral || !secretValue(value, !!match[3], terminated)) continue;
		out.push({ start, end, kind: "connection-string" });
	}
}

function values(text: string, pattern: RegExp, kind: string, out: Candidate[], offset = 0, group = 2): void {
	for (const match of text.matchAll(pattern)) {
		const value = match[group];
		if (!value || value.includes("[REDACTED:")) continue;
		const start = match.index + match[0].indexOf(value, group === 2 ? match[1].length : 0);
		out.push({ start: offset + start, end: offset + start + value.length, kind });
	}
}

interface Container { start: number; end: number; open: string }
/** Indexed JSON ranges avoid a linear .find for every Secret/users/data key. */
function containers(text: string) {
	const stack: Container[] = [];
	const byStart = new Map<number, Container>(), owners = new Map<number, Container>();
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === "\\") i++;
			else if (c === '"') quoted = false;
		} else if (c === '"') {
			const owner = stack.at(-1);
			if (owner?.open === "{" && text.startsWith('"kind"', i)) owners.set(i, owner);
			quoted = true;
		} else if (c === "{" || c === "[") {
			const block: Container = { start: i, end: text.length, open: c };
			stack.push(block); byStart.set(i, block);
		} else if (c === "}" || c === "]") {
			const top = stack.pop();
			if (top) top.end = i + 1;
		}
	}
	return { byStart, owner: (index: number) => owners.get(index) };
}

function kubeCandidates(text: string, out: Candidate[]): void {
	if (!/"(?:users|kind)"|(?:^|\n)[ \t-]*(?:users|kind|data|name|value):/.test(text)) return;
	const blocks = containers(text);
	const userKey = /("(?:client-key-data|client-certificate-data|token|password)"\s*:\s*")([^"\r\n]+)"/g;
	for (const match of text.matchAll(/"users"\s*:\s*\[/g)) {
		const start = match.index + match[0].length - 1;
		const block = blocks.byStart.get(start);
		if (block && block.end - start > SECTION_LIMIT) out.push({ start: start + 1, end: block.end - 1, kind: "kube-data" });
		else if (block) values(text.slice(start, block.end), userKey, "kube-data", out, start);
	}
	for (const match of text.matchAll(/"kind"\s*:\s*"Secret"/g)) {
		const block = blocks.owner(match.index);
		if (!block) continue;
		if (block.end - block.start > SECTION_LIMIT) {
			out.push({ start: block.start + 1, end: block.end - 1, kind: "kube-data" });
			continue;
		}
		const secret = text.slice(block.start, block.end);
		for (const data of secret.matchAll(/"data"\s*:\s*\{/g)) {
			const start = block.start + data.index + data[0].length - 1;
			const body = blocks.byStart.get(start);
			if (body) values(text.slice(start, body.end), /("[^"\r\n]{1,256}"\s*:\s*")([A-Za-z0-9+/=]{40,65536})"/g, "kube-data", out, start);
		}
	}
	let offset = 0;
	// kubectl commonly emits data BEFORE kind. Detect kind over the whole YAML document.
	// Captured separators retain exact source offsets without reserializing any content.
	for (const document of text.split(/(^---[ \t]*\r?$)/m)) {
		const secretDocument = /^[ \t]*kind:[ \t]*Secret[ \t]*\r?$/m.test(document);
		let usersIndent = -1, dataIndent = -1, dataStart = 0;
		let previousEnv: EnvField | undefined;
		function finishData(end: number) {
			if (dataIndent >= 0 && end - dataStart > SECTION_LIMIT) out.push({ start: dataStart, end, kind: "kube-data" });
		}
		for (const line of document.split(/(?<=\n)/)) {
			previousEnv = envYaml(line, offset, previousEnv, out);
			const indent = /^ */.exec(line)![0].length;
			const meaningful = line.trim() !== "" && !/^\s*#/.test(line);
			if (usersIndent >= 0 && meaningful && indent <= usersIndent && !/^\s*-/.test(line)) usersIndent = -1;
			if (/^\s*users:\s*$/.test(line.trimEnd())) usersIndent = indent;
			if (usersIndent >= 0) values(line, /(\b(?:client-key-data|client-certificate-data|token|password):\s*["']?)([^\s"'#]+)(?:["']|\s|$)/g, "kube-data", out, offset);
			if (dataIndent >= 0 && meaningful && indent <= dataIndent) { finishData(offset); dataIndent = -1; }
			if (secretDocument && /^\s*data:\s*$/.test(line.trimEnd())) { dataIndent = indent; dataStart = offset + line.length; }
			if (dataIndent >= 0 && indent > dataIndent && offset - dataStart < SECTION_LIMIT) {
				if (line.length <= SECTION_LIMIT) values(line, /(^[ \t]*[^\s:]{1,256}:[ \t]*["']?)([A-Za-z0-9+/=]{40,65536})(?:["']|\s|$)/g, "kube-data", out, offset);
			}
			offset += line.length;
		}
		finishData(offset);
	}
}

export function scan(text: string, allowlist: readonly string[] = []): Scan {
	const result: Scan = { text, kinds: [], count: 0, skipped: false };
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { ...result, skipped: true };
	const out: Candidate[] = [];
	const protectedSpans = [...text.matchAll(/\[REDACTED:[A-Za-z0-9-]{1,64}\]/g)].map(m => ({ start: m.index, end: m.index + m[0].length }));
	privateKeys(text, out);
	for (const [kind, pattern] of TOKEN_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			if (kind === "openai-key") {
				const body = match[0].replace(/^sk-(?:proj-|live-|test-)?/, "");
				if (body.length < 24 || (body.match(/[0-9]/g)?.length ?? 0) < 2) continue;
			}
			out.push({ start: match.index, end: match.index + match[0].length, kind });
		}
	}
	values(text, /(\baws_secret_access_key\s*=\s*)(\S+)/gi, "aws-key", out);
	envJson(text, out);
	kubeCandidates(text, out);
	values(text, /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)([^\s@/]{3,})@/gi, "url-credentials", out);
	connections(text, out);
	envAssignments(text, out);
	const allowed: RegExp[] = [];
	for (const pattern of allowlist) { try { allowed.push(new RegExp(pattern)); } catch { /* invalid exemptions do not allow anything */ } }
	// Prefer the whole containing value, then the more specific earlier recognizer on ties.
	out.sort((a, b) => a.start - b.start || b.end - a.end);
	let until = 0, renderedUntil = 0, protectedIndex = 0;
	const chunks: string[] = [];
	for (const candidate of out) {
		while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].end <= candidate.start) protectedIndex++;
		const protectedSpan = protectedSpans[protectedIndex];
		const coarse = candidate.kind === "kube-data" && candidate.end - candidate.start > SECTION_LIMIT;
		if (candidate.start < until || (!coarse && protectedSpan && candidate.end > protectedSpan.start)) continue;
		until = candidate.end;
		const value = text.slice(candidate.start, candidate.end);
		if (allowed.some(pattern => pattern.test(value))) continue;
		const marker = `[REDACTED:${candidate.kind}]`;
		// Existing markers inside a large section must not exempt its OTHER raw values.
		const replacement = coarse ? value.split(/(\[REDACTED:[A-Za-z0-9-]{1,64}\])/g)
			.map((part, index) => index % 2 ? part : part ? marker : "").join("") : marker;
		chunks.push(text.slice(renderedUntil, candidate.start), replacement);
		renderedUntil = candidate.end;
		result.count++;
		if (!result.kinds.includes(candidate.kind)) result.kinds.push(candidate.kind);
	}
	if (result.count) result.text = chunks.join("") + text.slice(renderedUntil);
	return result;
}

const OUTBOUND_FLAGS = new Set(["--body", "-b", "--notes", "-n", "--title", "-t", "--comment", "-c", "--desc", "-d", "--filename", "-f"]);
const OUTBOUND_FILES = new Set(["--body-file", "-F", "--notes-file", "--add", "-a"]);
const GH_VALUE_FLAGS = new Set(["--repo", "-R", "--hostname", "-H", "--remove", "-r"]);
const GIST_SWITCHES = new Set(["--public", "-p", "--web", "-w"]);
const PUBLICATION_VERBS: Record<string, string[]> = { gist: ["create", "edit"], release: ["create", "edit"], issue: ["comment", "create", "edit", "close"], pr: ["comment", "create", "edit", "close", "review"] };
const PUBLICATION_TEXT = new RegExp(`\\bgh\\b[\\s\\S]*?\\b(?:${Object.entries(PUBLICATION_VERBS).map(([group, verbs]) => `${group}\\s+(?:${verbs.join("|")})`).join("|")})\\b`);
const INTERNAL_PATH = /\/(?:Users|home)\/[^\s/]+|\.ai-work\/|~\/\.pi\b/;
const EXPANDING_WORD = /[$`*?{}\[\]~\\]/;
const PRODUCER_EXPANSION = /[$`*?{}\[\]~<>]/;
const HEREDOC_EXPANSION = /[$`\\]/;
const INPUT_MARKER = "--pi-outbound-stdin-";
const RAW_PAYLOAD_FILE = /(?:^|[\s"'`;|&(])["']?(--body-file|--notes-file|-F)["']?(?:\s*=\s*|\s+|(?<=-F))("[^"]*"|'[^']*'|[^\s"'`;&|()<>]+)/g;
const RAW_CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s"';&|()]+)\s*&&/;
const RAW_CWD_CHANGE = /\b(?:cd|pushd|popd)\b/;
const RAW_AFTER_CD_UNCERTAIN = /\b(?:cd|pushd|popd)\b|[;()]|\|\|/;
interface Publication { group: string; verb: string; args: string[] }
interface PublicationInput { cwd?: string; stdin?: string; hasStdin: boolean }
interface Payload { value: string; file: boolean }

function executableIndex(tokens: string[]): number {
	return tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !["env", "command", "exec", "rtk", "proxy", "time", "nohup"].includes(token));
}

function publication(tokens: string[]): Publication | undefined {
	const start = executableIndex(tokens);
	if (basename(tokens[start] ?? "") !== "gh") return;
	for (let i = start + 1; i < tokens.length; i++) {
		if (PUBLICATION_VERBS[tokens[i]]?.includes(tokens[i + 1])) return { group: tokens[i], verb: tokens[i + 1], args: tokens.slice(i + 2) };
	}
	return undefined;
}

function outboundFile(file: string, cwd?: string): string | undefined {
	if (EXPANDING_WORD.test(file)) return "outbound-file-unscannable";
	if (!cwd && !isAbsolute(file)) return "outbound-cwd-unscannable";
	try {
		const path = resolve(cwd ?? "/", file);
		const info = statSync(path);
		if (!info.isFile()) return "outbound-file-unreadable";
		if (info.size > MAX_BYTES) return "outbound-payload-too-large";
		return outboundPattern(readFileSync(path, "utf8"));
	} catch { return "outbound-file-unreadable"; }
}

function unquoteRaw(value: string): string {
	return value.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/** Only a leading literal cd with && has a statically known new directory. */
function rawPayloadCwd(prefix: string, cwd: string): string | undefined {
	const cd = RAW_CD.exec(prefix);
	if (!cd) return RAW_CWD_CHANGE.test(prefix) ? undefined : cwd;
	const path = unquoteRaw(cd[1]);
	if (EXPANDING_WORD.test(path)) return undefined;
	if (path === "-") return undefined;
	if (RAW_AFTER_CD_UNCERTAIN.test(prefix.slice(cd[0].length))) return undefined;
	if (process.env.CDPATH && !isAbsolute(path)) return undefined;
	return resolve(cwd, path);
}

/** File discovery must not rely on the shell parser recognizing an executable gh invocation. */
function rawPayloadFiles(command: string, cwd: string): string | undefined {
	for (const match of command.matchAll(RAW_PAYLOAD_FILE)) {
		const file = unquoteRaw(match[2]);
		if (file === "-") return "outbound-stdin-unscannable";
		const kind = outboundFile(file, rawPayloadCwd(command.slice(0, match.index), cwd));
		if (kind) return kind;
	}
	return undefined;
}

/** Conservative text checks also cover quoted/escaped wrapper names and nested invocations. */
function publicationWrapper(command: string, mention: string): boolean {
	if (command.includes("$(") || command.includes("`")) return true;
	if (/\b(?:eval|xargs|exec|nohup|timeout|sudo)\b/.test(mention)) return true;
	if (/\b(?:bash|sh|zsh)\b[^\n;&|]*\s-[^\s]*c/.test(mention)) return true;
	if (/\benv\b[^\n;&|]*(?:--split-string\b|\s-[^\s]*S)/.test(mention)) return true;
	return /(?:^|[;&|()\n])\s*(?:(?:command|builtin|time)\s+|[A-Za-z_]\w*=\S+\s+)*(?:source|\.)\s+\S/.test(mention);
}

function outboundPattern(text: string): string | undefined {
	if (INTERNAL_PATH.test(text)) return "internal-path";
	return outboundSecrets(text);
}

function outboundSecrets(text: string): string | undefined {
	const result = scan(text);
	if (result.skipped) return "outbound-payload-too-large";
	return result.kinds[0];
}

function inlineValueKind(value: string): string | undefined {
	const kind = outboundPattern(value);
	if (kind) return kind;
	return EXPANDING_WORD.test(value) ? "outbound-value-unscannable" : undefined;
}

function payloadKind(payload: Payload, input: PublicationInput): string | undefined {
	if (!payload.file) return inlineValueKind(payload.value);
	if (payload.value !== "-") return outboundFile(payload.value, input.cwd);
	return input.stdin === undefined ? "outbound-stdin-unscannable" : outboundPattern(input.stdin);
}

function splitOutboundFlag(token: string): { flag: string; inline?: string } {
	const compact = /^(-[bFtncfdaRHr])([^=].*)$/.exec(token);
	const [flag, ...value] = (compact ? `${compact[1]}=${compact[2]}` : token).split("=");
	return { flag, inline: value.length ? value.join("=") : undefined };
}

interface PublicationArguments { payloads: Payload[]; positional: string[]; error?: string }
interface PublicationArgument { next: number; payload?: Payload; positional?: string; error?: string }
function outboundFlagKind(flag: string): "file" | "text" | "ignored" | undefined {
	if (OUTBOUND_FILES.has(flag)) return "file";
	if (OUTBOUND_FLAGS.has(flag)) return "text";
	if (GH_VALUE_FLAGS.has(flag)) return "ignored";
	return undefined;
}

function gistSwitch(flag: string): boolean {
	return GIST_SWITCHES.has(flag) || /^-[pw]+$/.test(flag);
}

function readPublicationOption(args: string[], index: number): PublicationArgument {
	const { flag, inline } = splitOutboundFlag(args[index]);
	const kind = outboundFlagKind(flag);
	if (!kind) return { next: index + 1, error: gistSwitch(flag) ? undefined : "outbound-gist-arguments-unscannable" };
	const value = inline ?? args[index + 1];
	const next = inline === undefined ? index + 2 : index + 1;
	if (value === undefined) return { next, error: "outbound-value-missing" };
	return { next, payload: kind === "ignored" ? undefined : { value, file: kind === "file" } };
}

function readPublicationArgument(args: string[], index: number): PublicationArgument {
	const token = args[index];
	if (token.startsWith(INPUT_MARKER)) return { next: index + 1 };
	if (token.startsWith("<")) return { next: index + 2, error: "outbound-stdin-unscannable" };
	if (token === "-" || !token.startsWith("-")) return { next: index + 1, positional: token };
	return readPublicationOption(args, index);
}

function publicationArguments(args: string[]): PublicationArguments {
	const result: PublicationArguments = { payloads: [], positional: [] };
	for (let i = 0; i < args.length;) {
		if (args[i] === "--") { result.positional.push(...args.slice(i + 1)); break; }
		const argument = readPublicationArgument(args, i);
		i = argument.next;
		if (argument.payload) result.payloads.push(argument.payload);
		if (argument.positional !== undefined) result.positional.push(argument.positional);
		result.error = argument.error ?? result.error;
	}
	return result;
}

function gistPayloads(call: Publication, args: PublicationArguments, input: PublicationInput): void {
	if (call.group !== "gist") return;
	const files = call.verb === "edit" ? args.positional.slice(1) : args.positional;
	const implicitStdin = call.verb === "create" || input.hasStdin;
	const sources = files.length ? files : implicitStdin ? ["-"] : [];
	args.payloads.push(...sources.map(value => ({ value, file: true })));
}

function publicationError(call: Publication, error?: string): string | undefined {
	if (call.group === "gist") return error;
	return error === "outbound-gist-arguments-unscannable" ? undefined : error;
}

function publicationKind(call: Publication, input: PublicationInput): string | undefined {
	const args = publicationArguments(call.args);
	const error = publicationError(call, args.error);
	if (error) return error;
	gistPayloads(call, args, input);
	for (const payload of args.payloads) {
		const kind = payloadKind(payload, input);
		if (kind) return kind;
	}
	return undefined;
}

interface HereDoc { start: number; end: number; delimiter: string; quoted: boolean; tabs: boolean }
function hereDocHeader(line: string, start: number): HereDoc | undefined {
	const header = /^<<(-)?[ \t]*(['"]?)([^\s'"<>|;&()]+)\2(?=$|[\s<>|;&()])/.exec(line.slice(start));
	if (!header) return undefined;
	if (header[3].includes("\\")) return undefined;
	if (!header[2] && HEREDOC_EXPANSION.test(header[3])) return undefined;
	return { start, end: start + header[0].length, delimiter: header[3], quoted: !!header[2], tabs: !!header[1] };
}

function hereDocHeaders(line: string, unquoted: string): HereDoc[] | undefined {
	const offsets = [...unquoted.matchAll(/<<-?/g)];
	const headers = offsets.map(match => hereDocHeader(line, match.index)).filter((header): header is HereDoc => header !== undefined);
	return headers.length === offsets.length ? headers : undefined;
}

function readHereDoc(lines: string[], start: number, header: HereDoc) {
	const body: string[] = [];
	let next = start;
	while (next < lines.length) {
		const line = header.tabs ? lines[next++].replace(/^\t+/, "") : lines[next++];
		if (line === header.delimiter) return { next, text: body.join("\n") + "\n" };
		body.push(line);
	}
	return { next, text: undefined };
}

interface HereDocLine { line: string; mask: string; lines: string[]; start: number; input: Map<string, string | undefined> }
function hereDocLine(state: HereDocLine) {
	const headers = hereDocHeaders(state.line, state.mask);
	if (!headers) return undefined;
	let rendered = "", end = 0, next = state.start;
	for (const header of headers) {
		const doc = readHereDoc(state.lines, next, header);
		if (doc.text === undefined) return undefined;
		next = doc.next;
		const key = `${INPUT_MARKER}${state.input.size}`;
		state.input.set(key, header.quoted || !HEREDOC_EXPANSION.test(doc.text) ? doc.text : undefined);
		rendered += state.line.slice(end, header.start) + ` ${key} `;
		end = header.end;
	}
	return { next, text: rendered + state.line.slice(end) };
}

/** Remove heredoc bodies before shell tokenization; they are data, never commands. */
function inlineInputs(command: string) {
	const lines = command.split("\n");
	const unquoted = command.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"|\\.|(?:^|[\s;&|()])#[^\n]*/g, match => match.replace(/[^\n]/g, " ")).split("\n");
	const input = new Map<string, string | undefined>();
	const output: string[] = [];
	for (let i = 0; i < lines.length;) {
		const rendered = hereDocLine({ line: lines[i], mask: unquoted[i], lines, start: i + 1, input });
		if (!rendered) return { segments: [], input, error: "outbound-heredoc-unscannable" };
		i = rendered.next;
		output.push(rendered.text);
	}
	return { segments: shellSegments(output.join("\n")), input, error: undefined };
}

function literalPrintf(args: string[]): string | undefined {
	if (args[0] === "--") args = args.slice(1);
	const [format, ...values] = args;
	if (format === undefined) return undefined;
	if (/[%\\]/.test(format.replace(/%%|%s|\\[nrt\\]/g, ""))) return undefined;
	let index = 0;
	const rendered = format.replace(/\\[nrt\\]|%%|%s/g, token => {
		if (token === "%s") return values[index++] ?? "";
		return ({ "\\n": "\n", "\\r": "\r", "\\t": "\t", "\\\\": "\\", "%%": "%" })[token]!;
	});
	return index < values.length ? undefined : rendered;
}

function literalEcho(args: string[]): string | undefined {
	if (args.some(token => token.includes("\\"))) return undefined;
	if (args[0] === "-n") args.shift();
	if (args[0]?.startsWith("-")) return undefined;
	return args.join(" ");
}

function literalProducer(segment: ShellSegment, input: Map<string, string | undefined>): string | undefined {
	const marker = segment.tokens.findLast(token => token.startsWith(INPUT_MARKER));
	const tokens = segment.tokens.filter(token => !token.startsWith(INPUT_MARKER));
	if (tokens.some(token => PRODUCER_EXPANSION.test(token))) return undefined;
	const [program, ...args] = tokens;
	if (program === "cat") return args.length ? undefined : input.get(marker ?? "");
	if (program === "printf") return literalPrintf(args);
	if (program === "echo") return literalEcho(args);
	return undefined;
}

function segmentInput(segments: ShellSegment[], index: number, input: Map<string, string | undefined>): string | undefined {
	const segment = segments[index];
	const marker = segment.tokens.findLast(token => token.startsWith(INPUT_MARKER));
	if (marker) return input.get(marker);
	return segment.after === "|" ? literalProducer(segments[index - 1], input) : undefined;
}

function literalCdPath(tokens: string[]): string | undefined {
	if (tokens.length !== 2) return undefined;
	if (tokens[1] === "-") return undefined;
	if (EXPANDING_WORD.test(tokens[1])) return undefined;
	return tokens[1];
}

function cdDestination(tokens: string[], next: ShellSegment | undefined, cwd?: string): string | undefined {
	if (next?.after !== "&&") return undefined;
	const path = literalCdPath(tokens);
	if (!path) return undefined;
	if (process.env.CDPATH && !isAbsolute(path)) return undefined;
	if (!cwd && !isAbsolute(path)) return undefined;
	return resolve(cwd ?? "/", path);
}

function uncertainCwd(segment: ShellSegment, tokens: string[]): boolean {
	return ["(", ")"].includes(segment.after) || ["eval", "source", ".", "pushd", "popd"].includes(tokens[0]);
}

function advanceCwd(state: { cwd?: string; conditional: boolean }, segment: ShellSegment, next?: ShellSegment): void {
	if (state.conditional && !["&&", "|"].includes(segment.after)) state.cwd = undefined;
	const tokens = segment.tokens.slice(executableIndex(segment.tokens));
	if (uncertainCwd(segment, tokens)) state.cwd = undefined;
	if (tokens[0] !== "cd") return;
	state.cwd = segment.after === "|" ? undefined : cdDestination(segment.tokens, next, state.cwd);
	state.conditional = true;
}

function segmentHasStdin(segment: ShellSegment): boolean {
	return segment.after === "|" || segment.tokens.some(token => token.startsWith(INPUT_MARKER));
}

function parsedPublicationKind(command: string, cwd: string): string | undefined {
	const parsed = inlineInputs(command);
	if (parsed.error) return parsed.error;
	const state = { cwd: cwd as string | undefined, conditional: false };
	for (let i = 0; i < parsed.segments.length; i++) {
		const segment = parsed.segments[i];
		advanceCwd(state, segment, parsed.segments[i + 1]);
		const call = publication(segment.tokens);
		if (!call) continue;
		const kind = publicationKind(call, { cwd: state.cwd, stdin: segmentInput(parsed.segments, i, parsed.input), hasStdin: segmentHasStdin(segment) });
		if (kind) return kind;
	}
	return undefined;
}

/** Secret scanning never depends on shell parsing; no candidate text is included in a refusal. */
export function outboundReason(command: string, cwd: string): string | undefined {
	const mention = command.replace(/\\\r?\n/g, "").replace(/['"\\]/g, "");
	if (!PUBLICATION_TEXT.test(mention)) return undefined;
	const secret = outboundSecrets(command);
	const files = rawPayloadFiles(command, cwd);
	const wrapped = publicationWrapper(command, mention);
	const payload = wrapped ? "outbound-wrapper-unscannable" : parsedPublicationKind(command, cwd);
	const kind = secret ?? files ?? payload;
	const advice = wrapped ? "publication must be a direct gh command so its payload can be scanned" : "Remove credentials and internal paths from public text; payloads must be readable literal text within 2 MiB, with a known cwd for relative files and scannable stdin.";
	return kind ? `secret-mask: GitHub publication blocked (${kind}). ${advice}` : undefined;
}

export function summary(count: number, kinds: readonly string[]): string {
	return `[secret-mask] ${count} value(s) redacted (${kinds.join(", ")}). Rotate them; do not try to recover them.`;
}

export function logRedaction(session: string, tool: string, kinds: string[], count: number,
	file = join(homedir(), ".pi", "agent", "logs", "secret-mask.jsonl")): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), session, tool, kinds, count }) + "\n", { mode: 0o600 });
	} catch { logError("secret-mask", "log", "Unable to append redaction metadata"); }
}

interface Dependencies {
	config: () => Config;
	guardOff: () => boolean;
	orchestrated: (cwd: string) => boolean;
	cratisRunner: CratisRunner;
	tools?: ToolLister;
	cratisSecrets: (cwd: string, command: string) => boolean;
	select: typeof guardSelect;
	decision: typeof orchLog;
	record: typeof logRedaction;
	error: (event: string) => void;
	role: (session: string) => Role;
}
export function createHandlers(overrides: Partial<Dependencies> = {}) {
	const roles = processRoles();
	const deps: Dependencies = {
		config: loadConfig,
		guardOff: () => isGuardOff("secrets"),
		orchestrated: cwd => isOrchestrated(process.env, cwd),
		cratisRunner: spawnRunner,
		cratisSecrets: (cwd, command) => cratisVerdict("secrets", cwd, command, { run: overrides.cratisRunner ?? spawnRunner, tools: overrides.tools }) !== "none",
		select: guardSelect, decision: orchLog, record: logRedaction,
		error: event => logError("secret-mask", event, "Secret masking could not complete; no credential values logged"),
		role: session => roles.role(session), ...overrides,
	};
	let loggedOversize = false;
	function active(ctx: ExtensionContext): Config | undefined {
		const config = deps.config();
		return config.enabled && scopeAllows(config.scope, deps.role(ctx.sessionManager.getSessionId())) ? config : undefined;
	}
	function inspect(text: string, config: Config): Scan {
		const result = scan(text, config.allowlist);
		if (result.skipped && !loggedOversize) { loggedOversize = true; deps.error("part-over-2MiB-skipped"); }
		return result;
	}
	function report(ctx: ExtensionContext, tool: string, kinds: string[], count: number, notice: string): void {
		// A failing notification/audit sink must never discard the redacted patch.
		try { deps.record(ctx.sessionManager.getSessionId(), tool, kinds, count); }
		catch { deps.error("audit-failed"); }
		if (ctx.hasUI) {
			try { ctx.ui.notify(notice, "warning"); }
			catch { deps.error("notify-failed"); }
		}
	}
	function publicationGuard(command: string, cwd: string) {
		if (deps.guardOff()) return;
		const reason = outboundReason(command, cwd);
		return reason ? { block: true as const, reason } : undefined;
	}
	async function credentialCommand(command: string, ctx: ExtensionContext) {
		const matched = commandRule(command);
		if (!matched) return;
		if (deps.cratisSecrets(ctx.cwd, command)) { deps.decision("secrets", "stand-down:cratis-hook", matched.name); return; }
		if (deps.guardOff()) { deps.decision("secrets", "allow:guard-off", matched.name); return; }
		const reason = blockReason(matched);
		if (deps.orchestrated(ctx.cwd) || !ctx.hasUI) {
			deps.decision("secrets", "deny", matched.name);
			return { block: true as const, reason };
		}
		const { choice } = await deps.select(ctx.ui, "secrets", reason, [RUN_ANYWAY, "Block"], "deny", { cwd: ctx.cwd });
		const allow = choice === RUN_ANYWAY;
		deps.decision("secrets", allow ? "allow" : "deny", matched.name);
		return allow ? undefined : { block: true as const, reason };
	}
	return {
		sessionStart(event: { reason?: string }, ctx: ExtensionContext) {
			roles.start(ctx.sessionManager.getSessionId(), event.reason);
		},
		async toolCall(event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext) {
			try {
				if (event.toolName !== "bash") return;
				const config = active(ctx);
				if (!config?.blockCommands) return;
				const command = String(event.input.command ?? "");
				return publicationGuard(command, ctx.cwd) ?? await credentialCommand(command, ctx);
			} catch {
				deps.error("tool-call-failed");
				return undefined;
			}
		},
		toolResult<T extends { type: string; text?: string }>(event: { toolName: string; content: T[] }, ctx: ExtensionContext) {
			const config = active(ctx);
			if (!config?.redactResults) return;
			let count = 0;
			const kinds = new Set<string>();
			const content = event.content.map(part => {
				if (part.type !== "text" || typeof part.text !== "string") return part;
				const result = inspect(part.text, config);
				count += result.count;
				for (const kind of result.kinds) kinds.add(kind);
				return result.count ? { ...part, text: result.text } : part;
			});
			if (!count) return;
			const notice = summary(count, [...kinds]);
			const last = content.findLastIndex(part => part.type === "text");
			content[last] = { ...content[last], text: content[last].text + "\n" + notice };
			report(ctx, event.toolName, [...kinds], count, notice);
			return { content };
		},
		input(event: { text: string }, ctx: ExtensionContext) {
			const config = active(ctx);
			if (!config?.redactInput) return;
			const result = inspect(event.text, config);
			if (!result.count) return;
			report(ctx, "input", result.kinds, result.count, INPUT_NOTICE);
			return { action: "transform" as const, text: result.text };
		},
	};
}
