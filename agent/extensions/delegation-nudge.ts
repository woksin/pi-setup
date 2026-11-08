/**
 * delegation-nudge — main sessions only. After `delegationNudge.thresholdBytes` of direct
 * reads/searches (or `thresholdCalls` calls) since the last Agent/SubagentWorkflow call, append a
 * one-line reminder to the tool result suggesting Explore/ops. Never blocks; only appends, so the
 * cache prefix of earlier context is unchanged. Gated by efficiency.json (`delegationNudge`,
 * missing block = off). Telemetry: logs/delegation-nudge.jsonl.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, logError, processRoles, scopeAllows } from "../lib/output-cap.ts";
import { appendTelemetry, classifyResult, newState, nudgeText, step, textBytes, withNudge, type State } from "../lib/delegation-nudge.ts";

export default function (pi: ExtensionAPI) {
	const roles = processRoles();
	const states = new Map<string, State>();

	pi.on("session_start", (event, ctx) => {
		try {
			roles.start(ctx.sessionManager.getSessionId(), event.reason);
		} catch (e) {
			logError("delegation-nudge", "session_start", e);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		states.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("tool_result", (event, ctx) => {
		try {
			const config = loadConfig().delegationNudge;
			if (!config.enabled) return undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			if (!scopeAllows(config.scope, roles.role(sessionId))) return undefined;
			const e = event as any;
			const kind = classifyResult(e.toolName, e.input);
			if (kind === "other") return undefined;
			const result = step(states.get(sessionId) ?? newState(), kind, textBytes(e.content ?? []), config);
			states.set(sessionId, result.state);
			if (!result.nudge) return undefined;
			appendTelemetry({ session: sessionId, cwd: ctx.cwd, ...result.nudge, thresholdBytes: config.thresholdBytes, thresholdCalls: config.thresholdCalls, tool: e.toolName, kind });
			const content = withNudge(e.content ?? [], nudgeText(result.nudge.bytes, result.nudge.calls));
			return content ? { content } : undefined;
		} catch (err) {
			logError("delegation-nudge", "tool_result", err);
			return undefined;
		}
	});
}
