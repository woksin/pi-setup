import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";

export interface Finding { kind: string; line: number }
export const MAX_FINDINGS = 20;
const OMIT_PATH = "[path omitted]";
const OMIT_SEGMENT = "[omitted]";
const KINDS = new Set([
	"anthropic-key", "openai-key", "github-token", "aws-key", "google-key", "slack",
	"jwt", "stripe", "mollie", "sendgrid", "private-key", "env-value", "url-credentials",
	"connection-string", "kube-data",
]);
// Prevent path text from creating lines, terminal escapes, bidi or notice delimiters.
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\[\]()<>`]/u;
type Sensitive = (text: string) => boolean;

function absolutePath(path: string, cwd: string | undefined, home: string): string | undefined {
	const requested = path.replace(/^@/, "");
	if (requested === "~") return normalize(home);
	if (requested.startsWith("~/")) return resolve(home, requested.slice(2));
	if (isAbsolute(requested)) return normalize(requested);
	if (cwd && isAbsolute(cwd)) return resolve(cwd, requested);
	return undefined;
}

function hideSegments(path: string, sensitive: Sensitive): string {
	// Always inspect the complete normalized path as well as whole segments.
	// A boolean detector cannot prove a match stops at a segment boundary.
	// Omit the whole path rather than expose a cross-segment value's tail.
	if (sensitive(path)) return OMIT_PATH;
	const segments = path.split("/");
	const safe = segments.map(segment => {
		if (sensitive(segment) || UNSAFE_DISPLAY.test(segment)) {
			return OMIT_SEGMENT;
		}
		return segment;
	}).join("/");
	return sensitive(safe) ? OMIT_PATH : safe;
}

function homeRelative(path: string, home: string): string {
	const prefix = normalize(home);
	if (path === prefix) return "~";
	return path.startsWith(prefix + "/") ? "~" + path.slice(prefix.length) : path;
}

function oversized(value: string | undefined): boolean {
	return value !== undefined && value.length > 4096;
}

function unsafeResolutionInputs(inputs: readonly string[], sensitive: Sensitive): boolean {
	if (inputs.some(oversized)) return true;
	return inputs.some(sensitive);
}

/** Requested context only; never reads a file or asserts content provenance. */
export function sanitizeRequestedPath(value: unknown, sensitive: Sensitive, cwd?: string, home = homedir()): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		// Check all raw inputs before normalize/resolve can collapse credential syntax
		// or remove sensitive components. Home also participates in display shortening.
		if (unsafeResolutionInputs([value, cwd ?? "", home], sensitive)) return OMIT_PATH;
		const path = absolutePath(value, cwd, home);
		if (!path) return undefined;
		if (oversized(path)) return OMIT_PATH;
		const rendered = homeRelative(hideSegments(path, sensitive), home);
		return rendered.length > 160 ? OMIT_PATH : rendered;
	} catch { return OMIT_PATH; }
}

function validFinding(finding: Finding): boolean {
	return KINDS.has(finding.kind) && Number.isSafeInteger(finding.line) && finding.line > 0;
}

function location(finding: Finding, stage: string): string {
	return `${finding.kind} at output line ${finding.line}${stage} (provenance unknown)`;
}

/** Fixed vocabulary and bounded records only; no arbitrary output metadata. */
export function renderDiagnostics(count: number, findings: readonly Finding[], beforeCap = false): string {
	const stage = beforeCap ? " before output-cap truncation" : "";
	const records = findings.slice(0, MAX_FINDINGS).filter(validFinding);
	const locations = records.map(finding => location(finding, stage));
	const omitted = count - records.length;
	if (omitted > 0) locations.push(`${omitted} additional redaction(s): locations omitted`);
	return `[secret-mask] ${count} value(s) redacted: ${locations.join("; ")}. Rotate them; do not try to recover them.`;
}

/** Formatting failure must never prevent an already-masked patch from being returned. */
export function resultNotice(
	result: { count: number; kinds: string[]; findings?: Finding[] },
	event: { toolName: string; input?: Record<string, unknown> },
	options: { sensitive: Sensitive; fallback: (count: number, kinds: readonly string[]) => string; cwd?: string; beforeCap?: boolean },
): string {
	try {
		const notice = renderDiagnostics(result.count, result.findings ?? [], options.beforeCap);
		if (event.toolName !== "read") return notice;
		const path = sanitizeRequestedPath(event.input?.path, options.sensitive, options.cwd);
		return path === undefined ? notice : `${notice} Read request: ${path} (requested path only; content provenance unknown).`;
	} catch { return options.fallback(result.count, result.kinds); }
}
