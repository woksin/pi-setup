/**
 * output-cap (C4) — cap large text tool results when they are created and offload the full text.
 *
 * Results over `outputCap.maxChars` (efficiency.json, default 12000) are written in full to
 * `<repo root>/.ai-work/tool-out/<session>/<toolCallId>.txt` (fallback `~/.ai-work/tool-out/...`)
 * and replaced by head ~60% + tail ~40% + a marker with the path. Bash test/build output keeps
 * failure-like lines from the elided middle. edit/write results, results with images, and
 * results under the limit are untouched. Only the new result is changed, so the cache prefix of
 * earlier context stays stable.
 *
 * Gating: `~/.pi/agent/efficiency.json` (or PI_EFFICIENCY_FILE), re-read on mtime change;
 * `outputCap.enabled` and `outputCap.scope` (all|subagents|main|off). Missing file = off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capResult, loadConfig, logError, pruneOncePerHour, offloadDirs, processRoles, scopeAllows } from "../lib/output-cap.ts";

export default function (pi: ExtensionAPI) {
	const roles = processRoles();

	pi.on("session_start", (event, ctx) => {
		try {
			roles.start(ctx.sessionManager.getSessionId(), event.reason);
			pruneOncePerHour("output-cap", ctx.cwd);
		} catch (e) {
			logError("output-cap", "session_start", e);
		}
	});

	pi.on("tool_result", (event, ctx) => {
		try {
			const config = loadConfig().outputCap;
			if (!config.enabled) return undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			if (!scopeAllows(config.scope, roles.role(sessionId))) return undefined;
			const content = capResult(event as any, config.maxChars, offloadDirs(ctx.cwd, sessionId));
			return content ? { content } : undefined;
		} catch (e) {
			logError("output-cap", "tool_result", e);
			return undefined;
		}
	});
}
