/** Advise routing definite unwrapped .NET work through pi-phase in orchestrated sessions only. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellGuard } from "../lib/shell-invocations.ts";
import { dotnetBlockReason } from "../lib/dotnet-guard.ts";
import { isGuardOff } from "../lib/guards.ts";
import { isOrchestrated } from "../lib/orchestration.ts";

const MAX_WARNINGS = 50;
const active = (cwd: string) => !isGuardOff("dotnet") && isOrchestrated(process.env, cwd);

function remember(warnings: Map<string, string>, id: string, reason: string) {
	warnings.set(id, reason);
	if (warnings.size > MAX_WARNINGS) warnings.delete(warnings.keys().next().value!);
}

function bashCommand(event: { toolName: string; input: unknown }): string | undefined {
	if (event.toolName !== "bash") return undefined;
	const command = (event.input as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

export default function (pi: ExtensionAPI) {
	const warnings = new Map<string, string>();
	pi.on("tool_call", shellGuard((event, ctx) => {
		const command = active(ctx.cwd) ? bashCommand(event) : undefined;
		const reason = command === undefined ? undefined : dotnetBlockReason(command);
		if (reason) remember(warnings, event.toolCallId, reason);
	}, (_event, ctx) => active(ctx.cwd)));
	pi.on("tool_result", async (event, ctx) => {
		const warning = warnings.get(event.toolCallId);
		warnings.delete(event.toolCallId);
		if (!warning || !active(ctx.cwd)) return;
		return { content: [...event.content, { type: "text" as const, text: "\n[dotnet] " + warning }] };
	});
}
