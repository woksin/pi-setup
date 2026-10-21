/**
 * observation-mask (C5) — batched masking of stale tool output in the per-call context copy.
 *
 * In the `context` event (pi passes a structuredClone; the session file is untouched), tool
 * results older than the last `keep` results and larger than `minChars` are replaced by a stub
 * (tool, args, size, C4 offload path) — but only once the not-yet-masked eligible total reaches
 * `batchTokens`, and then all at once. The masked ids are kept per session in memory, so later
 * calls produce the same prefix. After a restart the set is rebuilt on the first call that
 * crosses the threshold (one prefix change, then stable again).
 *
 * Never masked: the last `keep` results, edit/write, results with images, calls containing
 * `# keep`, error results from the latest turn.
 *
 * Gating: efficiency.json `observationMask.enabled` / `.scope` (all|subagents|main|off).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, logError, processRoles, pruneOncePerHour, scopeAllows } from "../lib/output-cap.ts";
import { maskMessages } from "../lib/observation-mask.ts";

export default function (pi: ExtensionAPI) {
	const roles = processRoles();
	const masked = new Map<string, Set<string>>();

	pi.on("session_start", (event, ctx) => {
		try {
			roles.start(ctx.sessionManager.getSessionId(), event.reason);
			pruneOncePerHour("observation-mask", ctx.cwd);
		} catch (e) {
			logError("observation-mask", "session_start", e);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		masked.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("context", (event, ctx) => {
		try {
			const config = loadConfig().observationMask;
			if (!config.enabled) return undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			if (!scopeAllows(config.scope, roles.role(sessionId))) return undefined;
			let set = masked.get(sessionId);
			if (!set) masked.set(sessionId, (set = new Set()));
			const result = maskMessages(event.messages as any[], set, config);
			return result.changed ? { messages: result.messages } : undefined;
		} catch (e) {
			logError("observation-mask", "context", e);
			return undefined;
		}
	});
}
