/**
 * Subagent requests use the 5-minute cache tier: 1h writes cost 2x base input vs 1.25x,
 * while only ~0.6% of observed subagent gaps exceed 5 minutes (~$100/day gross saving).
 * Unknown/main roles keep 1h. Never change PI_CACHE_RETENTION: children share process env.
 * PI_SUBAGENT_CACHE=long disables this request-local downgrade.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logError, processRoles } from "../lib/output-cap.ts";
import { isShortTierRole, stripLongTtl } from "../lib/subagent-cache.ts";

export default function (pi: ExtensionAPI) {
	const roles = processRoles();
	pi.on("session_start", (event, ctx) => {
		try {
			roles.start(ctx.sessionManager.getSessionId(), event.reason);
		} catch (e) {
			logError("subagent-cache", "session_start", e);
		}
	});
	pi.on("before_provider_request", (event, ctx) => {
		try {
			if (process.env.PI_SUBAGENT_CACHE === "long") return undefined;
			if (!isShortTierRole(roles.role(ctx.sessionManager.getSessionId()))) return undefined;
			return stripLongTtl(event.payload);
		} catch (e) {
			logError("subagent-cache", "before_provider_request", e);
			return undefined;
		}
	});
}
