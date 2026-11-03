/** Prevent shared-machine process kills by name or pattern before bash executes. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { killBlockReason } from "../lib/kill-guard.ts";
import { isGuardOff } from "../lib/guards.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", event => {
		if (event.toolName !== "bash" || isGuardOff("kill")) return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const reason = killBlockReason(command);
		if (reason) return { block: true, reason };
	});
}
