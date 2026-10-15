import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { grantPriorityRequests, highPriorityRequests, priorityCommandArgs, readGrant, referencesGrantFile } from "../lib/phase-priority.ts";

const APPROVAL_NEEDED = "high priority needs user approval; ask the parent session/user, who can run /phase-priority allow";

function phaseCommand(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(join(homedir(), ".pi", "agent", "bin", "pi-phase"), args,
			{ timeout: 8000, maxBuffer: 65536 }, (error, stdout, stderr) => {
				if (error) reject(new Error(stderr.trim() || error.message));
				else resolve(stdout.trim());
			});
	});
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "error") {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else if (type === "error") console.error(message);
	else console.log(message);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as { command?: unknown; path?: unknown };
		if (referencesGrantFile(event.toolName, input)) return {
			block: true, reason: "grants are created only via user approval (/phase-priority)",
		};
		if (event.toolName !== "bash") return undefined;
		const command = String(input.command ?? "");
		const grants = grantPriorityRequests(command);
		if (grants.length) {
			if (!ctx.hasUI) return { block: true, reason: APPROVAL_NEEDED };
			const choice = await ctx.ui.select(
				`Agent wants to grant high queue priority: ${grants.map(args => args.join(" ")).join("; ")}`,
				["Allow", "Deny"]);
			return choice === "Allow" ? undefined : {
				block: true, reason: "High queue priority grant denied; use /phase-priority for user approval.",
			};
		}
		const requests = highPriorityRequests(command);
		if (!requests.length || readGrant(join(homedir(), ".pi", "agent", "pi-phase", "state", "priority-grant.json"))) return undefined;
		if (!ctx.hasUI) return {
			block: true,
			reason: APPROVAL_NEEDED,
		};
		const { kind, label } = requests[0];
		const choice = await ctx.ui.select(`Agent asks for high queue priority: ${kind} '${label}'`,
			["Allow once", "Allow for 30 minutes", "Deny"]);
		if (choice !== "Allow once" && choice !== "Allow for 30 minutes") return {
			block: true, reason: "High queue priority denied; rerun without --priority high.",
		};
		try {
			await phaseCommand(choice === "Allow once" ? ["grant-priority", "--uses", "1"] : ["grant-priority", "--minutes", "30"]);
		} catch (error) {
			return { block: true, reason: `Cannot grant high priority: ${(error as Error).message}` };
		}
		return undefined;
	});
	pi.registerCommand("phase-priority", {
		description: "Queue priority approval: status | allow [minutes] | allow-once | revoke",
		handler: async (args, ctx) => {
			try { notify(ctx, await phaseCommand(priorityCommandArgs(args)), "info"); }
			catch (error) { notify(ctx, (error as Error).message, "error"); }
		},
	});
}
