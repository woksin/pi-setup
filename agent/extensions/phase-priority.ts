import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { guardSelect, isOrchestrated, orchLog } from "../lib/orchestration.ts";
import { grantPriorityRequests, highPriorityRequests, priorityCommandArgs, readGrant, readOrchestrators, referencesGrantFile, withinOrchestratorCap } from "../lib/phase-priority.ts";

const APPROVAL_NEEDED = "high priority needs approval from the orchestrator (L0) or the user; ask your parent session/orchestrator, which can grant it";
const GRANT_DENIED = "High queue priority grant denied; use /phase-priority for user approval.";
const STATE_DIR = join(homedir(), ".pi", "agent", "pi-phase", "state");
const ORCHESTRATORS = join(STATE_DIR, "priority-orchestrators.json");

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function isOrchestrator(): boolean { return readOrchestrators(ORCHESTRATORS, alive).includes(process.pid); }
function setOrchestrator(on: boolean) {
	const pids = readOrchestrators(ORCHESTRATORS, alive).filter(pid => pid !== process.pid);
	if (on) pids.push(process.pid);
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(ORCHESTRATORS, JSON.stringify({ pids }, null, 2));
	return pids;
}

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
			// A user-designated orchestrator session decides queue priority itself, within a bounded grant.
			if (isOrchestrator()) return grants.every(withinOrchestratorCap) ? undefined : {
				block: true, reason: "orchestrator grants are capped at 10 uses or 120 minutes",
			};
			if (!ctx.hasUI) return { block: true, reason: APPROVAL_NEEDED };
			if (isOrchestrated(process.env, ctx.cwd)) {
				orchLog("phase-priority", "deny", `grant: ${command.replace(/\s+/g, " ").slice(0, 300)}`);
				return { block: true, reason: GRANT_DENIED };
			}
			const { choice, timedOut } = await guardSelect(ctx.ui, "phase-priority",
				`Agent wants to grant high queue priority: ${grants.map(args => args.join(" ")).join("; ")}`,
				["Allow", "Deny"], "deny", { cwd: ctx.cwd });
			return choice === "Allow" ? undefined : {
				block: true, reason: timedOut ? `No answer within 60 s. ${GRANT_DENIED}` : GRANT_DENIED,
			};
		}
		const requests = highPriorityRequests(command);
		if (!requests.length || readGrant(join(STATE_DIR, "priority-grant.json"))) return undefined;
		if (isOrchestrator()) {
			try { await phaseCommand(["grant-priority", "--uses", "1"]); return undefined; }
			catch (error) { return { block: true, reason: `Cannot grant high priority: ${(error as Error).message}` }; }
		}
		if (!ctx.hasUI) return {
			block: true,
			reason: APPROVAL_NEEDED,
		};
		const { kind, label } = requests[0];
		if (isOrchestrated(process.env, ctx.cwd)) {
			// Orchestration: never prompt; without a valid grant, deny at once with the actionable reason.
			orchLog("phase-priority", "deny", `${kind} '${label}'`);
			return { block: true, reason: `${APPROVAL_NEEDED} (/phase-priority); otherwise rerun without --priority high.` };
		}
		const { choice, timedOut } = await guardSelect(ctx.ui, "phase-priority", `Agent asks for high queue priority: ${kind} '${label}'`,
			["Allow once", "Allow for 30 minutes", "Deny"], "deny", { cwd: ctx.cwd });
		if (choice !== "Allow once" && choice !== "Allow for 30 minutes") return {
			block: true, reason: timedOut ? "No answer within 60 s; high queue priority denied; rerun without --priority high." : "High queue priority denied; rerun without --priority high.",
		};
		try {
			await phaseCommand(choice === "Allow once" ? ["grant-priority", "--uses", "1"] : ["grant-priority", "--minutes", "30"]);
		} catch (error) {
			return { block: true, reason: `Cannot grant high priority: ${(error as Error).message}` };
		}
		return undefined;
	});
	pi.registerCommand("phase-priority", {
		description: "Queue priority approval: status | allow [minutes] | allow-once | revoke | orchestrator on|off",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/);
			if (words[0] === "orchestrator") {
				if (words[1] !== "on" && words[1] !== "off") {
					notify(ctx, `orchestrator: ${isOrchestrator() ? "on" : "off"} (pid ${process.pid}); usage: /phase-priority orchestrator on|off`, "info");
					return;
				}
				const pids = setOrchestrator(words[1] === "on");
				notify(ctx, `this session ${words[1] === "on" ? "may now grant" : "no longer grants"} high priority without a prompt (orchestrators: ${pids.join(", ") || "none"})`, "info");
				return;
			}
			try { notify(ctx, await phaseCommand(priorityCommandArgs(args)), "info"); }
			catch (error) { notify(ctx, (error as Error).message, "error"); }
		},
	});
}
