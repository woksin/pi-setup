import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isGuardOff } from "../lib/guards.ts";
import { orchLog } from "../lib/orchestration.ts";
import { PUBLICATION_REASON, publicationInput } from "../lib/publish-guard.ts";

export default function publishGuardExtension(pi: ExtensionAPI) {
	pi.on("tool_call", event => {
		if (isGuardOff("publish")) return;
		const code = publicationInput(event.toolName, event.input);
		if (!code) return;
		orchLog("publish", "deny", code);
		const explanation = code === "unsupported-env" ? " Unsupported env execution; use publish or a plain supported invocation." : "";
		return { block: true, reason: PUBLICATION_REASON + explanation };
	});
}
