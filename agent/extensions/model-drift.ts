/**
 * model-drift — a main session on a model other than its expected one always says so.
 *
 * Expected model: profiles/<ACTIVE>/profile.json `mainModel`, else settings.json defaultProvider/defaultModel.
 * Checked on session_start, model_select and before_agent_start. On drift: persistent status
 * ("model-drift") plus one visible message per (current, expected) pair; cleared when they match.
 * Source: user /model (model_select not made by provider-fallback), provider-fallback (state published
 * by extensions/provider-fallback.ts, or restored from its session entries), else profile/default.
 * Only main sessions (ctx.hasUI); headless subagent sessions are skipped.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DriftTracker, expectedModel } from "../lib/model-drift.ts";
import { onFallbackState, readFallbackState, restoreOriginal } from "../lib/provider-fallback-state.ts";

const NOTIFIED_ENTRY = "model-drift-notified";

export default function (pi: ExtensionAPI) {
	const tracker = new DriftTracker();
	let lastCtx: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;

	function check(ctx: ExtensionContext): void {
		lastCtx = ctx;
		if (!ctx.hasUI) return; // subagent / headless session
		try {
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			let fallback = readFallbackState();
			let sessionId: string | undefined;
			try {
				sessionId = ctx.sessionManager.getSessionId();
			} catch {
				// no session id: cannot scope
			}
			// Published state is process-global: ignore another session's.
			if (fallback?.sessionId && sessionId && fallback.sessionId !== sessionId) fallback = undefined;
			if (!fallback?.originalRef) {
				// Published state is process-local and may not exist yet after reload: use the persisted entry.
				try {
					fallback = restoreOriginal(ctx.sessionManager.getBranch()) ?? fallback;
				} catch {
					// entries unavailable
				}
			}
			const result = tracker.evaluate(current, expectedModel(getAgentDir()), fallback);
			ctx.ui.setStatus("model-drift", result.status);
			if (result.log) pi.appendEntry("model-drift", result.log);
			if (result.notifiedPair) pi.appendEntry(NOTIFIED_ENTRY, { pair: result.notifiedPair });
			if (result.message) pi.sendMessage({ customType: "model-drift", content: result.message, display: true, details: result.log }, { triggerTurn: false });
		} catch {
			// never break a session over a notice
		}
	}

	pi.on("session_start", (_event, ctx) => {
		tracker.reset();
		try {
			const pairs: string[] = [];
			for (const e of ctx.sessionManager.getBranch() as { type?: string; customType?: string; data?: { pair?: unknown } }[]) {
				if (e.type === "custom" && e.customType === NOTIFIED_ENTRY && typeof e.data?.pair === "string") pairs.push(e.data.pair);
			}
			tracker.markNotified(pairs);
		} catch {
			// entries unavailable: the notice may repeat once
		}
		// provider-fallback may publish (restore failed, restored, ...) after our own check ran.
		unsubscribe?.();
		unsubscribe = onFallbackState(() => lastCtx && check(lastCtx));
		check(ctx);
	});
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		lastCtx = undefined;
	});
	pi.on("model_select", (event, ctx) => {
		tracker.onModelSelect(event.source, readFallbackState()?.switching === true);
		check(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		check(ctx);
	});
}
