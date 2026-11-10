import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { assessPublication, identity } from "../lib/lane-policy.ts";
import { publicationDecision } from "../lib/candidate-guard.ts";
import { publish } from "../lib/publisher.ts";
import type { PublishResult } from "../lib/publisher.ts";
import { InvalidRequest, kindSummary, parseCli, publishRequestSchema, validateRequest } from "../lib/publish-request.ts";
import { isOrchestrated, orchLog } from "../lib/orchestration.ts";

export interface PublishServices {
	admit?: typeof assessPublication;
	candidate?: typeof publicationDecision;
	send?: typeof publish;
	env?: NodeJS.ProcessEnv;
	root?: (cwd: string) => string | undefined;
}
function fixed(code: string, detail?: string) {
	return { content: [{ type: "text" as const, text: `publish: ${code}` + (detail ? `\ndetail: ${detail}` : "") }], details: { code, ...(detail ? { detail } : {}) }, isError: true };
}
function adapterFailure(step: "cwd-unavailable" | "publish-threw", error: unknown) {
	const code = (error as { code?: unknown } | null)?.code;
	const errno = typeof code === "string" && /^E[A-Z0-9_]{2,19}$/.test(code) ? ` ${code}` : "";
	return fixed("adapter-failed", step + errno);
}
function invalidResult(error: unknown) {
	return fixed("invalid-request", error instanceof InvalidRequest ? error.detail : undefined);
}
function publicationDetails(result: PublishResult) {
	return { code: result.code, ...(result.detail ? { detail: result.detail } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
}
function rendered(result: PublishResult): string {
	const text = result.text + (result.detail ? `\ndetail: ${result.detail}` : "");
	if (!result.diagnostics) return text;
	const { source, findings, count } = result.diagnostics;
	const lines = findings.map(finding => `${source}: line ${finding.line} ${finding.kind}`);
	return [text, ...lines, `findings: ${count}`].join("\n");
}
async function executePublication(value: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext, services: PublishServices) {
	let request;
	try { request = validateRequest(value); } catch (error) { return invalidResult(error); }
	try {
		const actor = { cwd: ctx.cwd, session: ctx.sessionManager.getSessionId() };
		if ((services.admit ?? assessPublication)(request, actor)) return fixed("admission-denied");
		const candidate = await (services.candidate ?? publicationDecision)(request, { cwd: ctx.cwd, env: services.env ?? process.env, orchestrated: isOrchestrated(services.env ?? process.env, ctx.cwd) });
		if (candidate.block) return fixed("admission-denied");
		if (candidate.log) orchLog("publish", "allow", "candidate-exception");
		if (candidate.warn) orchLog("publish", "warn", "candidate-warning");
		const result = await (services.send ?? publish)(request, { cwd: ctx.cwd, repoRoot: (services.root ?? (cwd => identity(cwd)?.root))(ctx.cwd), signal });
		const warning = candidate.warn ? "\npublish: candidate-warning" : "";
		return { content: [{ type: "text" as const, text: rendered(result) + warning }],
			details: publicationDetails(result), isError: result.isError };
	} catch (error) { return adapterFailure("publish-threw", error); }
}
export default function publishExtension(pi: ExtensionAPI, services: PublishServices = {}) {
	pi.registerTool({
		name: "publish", label: "Publish", description: "Publish GitHub text from typed fields after authority admission and exact captured-byte scanning. Prefer bodyFile created with write. api: arrays/objects of objects need a JSON bodyFile (no fields); fields are flat gh -f/-F values. No shell, scan override or arbitrary gh flags. Optional host (repository kinds and api only) targets GitHub Enterprise; default github.com. It needs a stored `gh auth login --hostname HOST` credential; env tokens are never sent to it. Required fields: " + kindSummary(),
		parameters: publishRequestSchema as any,
		execute: (_id: string, value: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => executePublication(value, signal, ctx, services),
	} as any);
}
export const PUBLISH_HELP = [
	"Usage: pi-publish KIND --repo OWNER/REPO [--host HOST] --number N --body-file FILE ...",
	"       pi-publish check --file FILE",
	"Publish GitHub issue and PR text (create, comment, edit, close, reopen) through the same typed validator and captured-byte scanner as the pi publish tool.",
	"Shell lane/candidate admission is separate. Use the publish tool from pi where possible.",
	"Payload errors name the resolved path; gh errors give exit code, category, HTTP status and a redacted API message.",
	"api: arrays/objects of objects need a JSON bodyFile (no fields); fields are flat gh -f/-F values.",
	"--host HOST targets a GitHub Enterprise host (default github.com). It needs a stored `gh auth login --hostname HOST` credential; env tokens are never sent to it.",
	"",
	"Examples:",
	"  pi-publish --help                      # this text, nothing is published",
	"  pi-publish check --file body.md        # scan a body file; publishes nothing",
	"  pi-publish issue-comment --repo OWNER/REPO --number 39 --body-file body.md   # state-changing: posts a comment",
	"  pi-publish issue-comment --repo OWNER/REPO --host ghe.example.com --number 39 --body-file body.md   # same, on a GitHub Enterprise host",
	"Exit codes:",
	"  0 ok",
	"  2 invalid request",
	"  3 secret scan refused the body",
	"  4 payload unreadable, cleanup failed or adapter failed",
	"    Adapter failures print a detail: step line (cwd-unavailable or publish-threw, with optional errno).",
	"  5 gh unavailable, failed, timed out or over the output limit, or the --host is not authenticated in gh",
	"  130 cancelled",
	"See also: docs/reference.md, README.md",
	"",
].join("\n");
function exitCode(result: PublishResult): number {
	if (!result.isError) return 0;
	if (result.code === "invalid-request") return 2;
	if (result.code === "scan-refused") return 3;
	if (result.code === "cancelled") return 130;
	return ["gh-unavailable", "gh-failed", "gh-timeout", "gh-output-limit", "host-unauthenticated"].includes(result.code) ? 5 : 4;
}
/** Trusted script/human adapter; Pi's shell hooks provide CLI authority admission, as for raw gh. */
export async function cliMain(argv: readonly string[], options: { signal?: AbortSignal; send?: typeof publish; cwd?: () => string } = {}): Promise<{ text: string; exitCode: number }> {
	let request;
	try { request = parseCli(argv); } catch (error) { return { text: invalidResult(error).content[0].text, exitCode: 2 }; }
	if (request.kind === "help") return { text: PUBLISH_HELP, exitCode: 0 };
	let cwd: string;
	try { cwd = (options.cwd ?? (() => process.cwd()))(); }
	catch (error) { return { text: adapterFailure("cwd-unavailable", error).content[0].text, exitCode: 4 }; }
	try {
		const result = await (options.send ?? publish)(request, { cwd, repoRoot: identity(cwd)?.root, signal: options.signal });
		return { text: rendered(result), exitCode: exitCode(result) };
	} catch (error) { return { text: adapterFailure("publish-threw", error).content[0].text, exitCode: 4 }; }
}
