/** Route definite unwrapped .NET work through pi-phase in orchestrated sessions only. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dotnetBlockReason } from "../lib/dotnet-guard.ts";
import { isGuardOff } from "../lib/guards.ts";
import { isOrchestrated } from "../lib/orchestration.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || isGuardOff("dotnet") || !isOrchestrated(process.env, ctx.cwd)) return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return;
		const reason = dotnetBlockReason(command);
		if (reason) return { block: true, reason };
	});
}
