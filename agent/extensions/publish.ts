import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { assessPublication, identity } from "../lib/lane-policy.ts";
import { publicationDecision } from "../lib/candidate-guard.ts";
import { publish } from "../lib/publisher.ts";
import type { PublishResult } from "../lib/publisher.ts";
import { parseCli, publishRequestSchema, validateRequest } from "../lib/publish-request.ts";
import { isOrchestrated, orchLog } from "../lib/orchestration.ts";

export interface PublishServices {
	admit?: typeof assessPublication;
	candidate?: typeof publicationDecision;
	send?: typeof publish;
	env?: NodeJS.ProcessEnv;
	root?: (cwd: string) => string | undefined;
}
function fixed(code: string) {
	return { content: [{ type: "text" as const, text: `publish: ${code}` }], details: { code }, isError: true };
}
function rendered(result: PublishResult): string {
	if (!result.diagnostics) return result.text;
	const { source, findings, count } = result.diagnostics;
	const lines = findings.map(finding => `${source}: line ${finding.line} ${finding.kind}`);
	return [result.text, ...lines, `findings: ${count}`].join("\n");
}
async function executePublication(value: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext, services: PublishServices) {
	let request;
	try { request = validateRequest(value); } catch { return fixed("invalid-request"); }
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
			details: { code: result.code, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) }, isError: result.isError };
	} catch { return fixed("adapter-failed"); }
}
export default function publishExtension(pi: ExtensionAPI, services: PublishServices = {}) {
	pi.registerTool({
		name: "publish", label: "Publish", description: "Publish GitHub text from typed fields after authority admission and exact captured-byte scanning. Prefer bodyFile created with write. No shell, scan override or arbitrary gh flags.",
		parameters: publishRequestSchema as any,
		execute: (_id: string, value: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => executePublication(value, signal, ctx, services),
	} as any);
}
export const PUBLISH_HELP = "Usage: pi-publish KIND --repo OWNER/REPO --number N --body-file FILE ...\npi-publish check --file FILE\nUse the publish tool from pi. CLI requests use the same typed validator and captured-byte scanner; shell lane/candidate admission is separate.\n";
function exitCode(result: PublishResult): number {
	if (!result.isError) return 0;
	if (result.code === "invalid-request") return 2;
	if (result.code === "scan-refused") return 3;
	if (result.code === "cancelled") return 130;
	return ["gh-unavailable", "gh-failed", "gh-timeout", "gh-output-limit"].includes(result.code) ? 5 : 4;
}
/** Trusted script/human adapter; Pi's shell hooks provide CLI authority admission, as for raw gh. */
export async function cliMain(argv: readonly string[], options: { signal?: AbortSignal; send?: typeof publish } = {}): Promise<{ text: string; exitCode: number }> {
	let request;
	try { request = parseCli(argv); } catch { return { text: "publish: invalid-request", exitCode: 2 }; }
	if (request.kind === "help") return { text: PUBLISH_HELP, exitCode: 0 };
	try {
		const cwd = process.cwd();
		const result = await (options.send ?? publish)(request, { cwd, repoRoot: identity(cwd)?.root, signal: options.signal });
		return { text: rendered(result), exitCode: exitCode(result) };
	} catch { return { text: "publish: adapter-failed", exitCode: 4 }; }
}
