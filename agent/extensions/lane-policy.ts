/** Dormant until an operator enrolls a repository. No policy mutation tools are registered. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { isGuardOff } from "../lib/guards.ts";
import { ACTIONS, acknowledge, assessCommand, assessPublication, identity, isSetupWriter, loadPolicy, mutate, mcpReason, policyContext, policyFile, policyStore, savePolicy, tamperReason, type Context } from "../lib/lane-policy.ts";

const HELP = `Lane policy (operator TUI command only; all writes require confirmation):
status | help | ack current-revision
bootstrap owner/repo
coordinator session-id [--override]
enroll session-id lane branch ${ACTIONS.join(",")}
writer session-id branch action[,action...]
grant session-id action exact-target 1..60 minutes
revoke session|writer|grants session-id
forbid owner/repo/#number | clear-forbidden exact-target
Non-coordinators must append --override to authority changes. ACK is for the invoking bound session only; it grants no authority and does not change the revision. All authority changes invalidate older exception grants. Grants target a branch for push/pr-create, a numeric issue/PR for issue-write/pr-comment. Merge remains blocked in this first slice. /guards off|on lane-policy controls enforcement. No live lanes are enrolled automatically.`;
const context = (ctx: ExtensionContext): Context => ({ cwd: ctx.cwd, session: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName?.() });
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Inspect known wrapper shapes without executing tools or trusting declared parent identity. */
function publicationToolReason(name: string, value: unknown, actor: Context, depth = 0): string | undefined {
	if (name === "publish") return assessPublication(value, actor);
	return toolReason(name, value, actor, depth);
}
function toolReason(name: string, value: unknown, actor: Context, depth = 0): string | undefined {
	const input = record(value) ? value : {};
	if (name === "multi_tool_use.parallel" || name === "multi_tool_use") {
		if (depth >= 4 || !Array.isArray(input.tool_uses)) return assessCommand(JSON.stringify(input), actor);
		for (const child of input.tool_uses) {
			if (!record(child) || typeof child.recipient_name !== "string") {
				const reason = assessCommand(JSON.stringify(child), actor);
				if (reason) return reason;
				continue;
			}
			const reason = publicationToolReason(child.recipient_name.replace(/^functions\./, ""), child.parameters, actor, depth + 1);
			if (reason) return reason;
		}
		return;
	}
	if (["write", "edit", "apply_patch"].includes(name)) {
		const path = input.path ?? input.file_path;
		if (typeof path === "string" && policyFile(path, actor.cwd) && !(isSetupWriter(actor) && !policyStore(path, actor.cwd))) return tamperReason(actor);
		if (name === "apply_patch") return assessCommand(`apply_patch ${JSON.stringify(value)}`, actor);
		return;
	}
	if (name === "bash") return typeof input.command === "string" ? assessCommand(input.command, actor) : "Lane policy: missing bash command.";
	if (["read", "grep", "find", "ls"].includes(name)) return;
	const execution = typeof input.cwd === "string" ? { ...actor, cwd: resolve(actor.cwd, input.cwd) } : actor;
	if (name === "job_start" || name === "job_watch") {
		for (const command of [input.command, input.check]) if (typeof command === "string") {
			const reason = assessCommand(command, execution);
			if (reason) return reason;
		}
		return;
	}
	// Delegation is allowed; child publication is checked under the child's real session ID.
	// MCP capability names/server metadata identify GitHub writes, not all opaque tools.
	const tool = [name, input.toolName, input.tool, input.name].filter(x => typeof x === "string").join(" ");
	const server = typeof input.serverName === "string" ? input.serverName : typeof input.server === "string" ? input.server : "";
	return mcpReason(execution, tool, server, JSON.stringify(input));
}

export default function (pi: ExtensionAPI) {
	const refresh = (ctx: ExtensionContext) => {
		const summary = policyContext(context(ctx));
		if (ctx.hasUI) ctx.ui.setStatus("lane-policy", summary ? clean(summary).slice(0, 160) : undefined);
		return summary;
	};
	pi.registerCommand("lane-policy", {
		description: "Inspect/ACK current lane policy or make confirmed operator-only changes",
		handler: async (args, ctx) => {
			const tell = (message: string, error = false) => {
				if (ctx.hasUI) ctx.ui.notify(message, error ? "error" : "info");
				else (error ? console.error : console.log)(message);
			};
			try {
				const words = args.trim().split(/\s+/).filter(Boolean);
				if (words[0] === "help") { tell(HELP); return; }
				const loaded = loadPolicy();
				if (loaded.error) throw new Error(loaded.error);
				const policy = loaded.policy!;
				const actor = context(ctx);
				const id = identity(actor.cwd);
				if (!words.length || words[0] === "status") {
					const repo = policy.repositories.find(r => r.common === id?.common);
					tell(clean(JSON.stringify({ revision: policy.revision, session: actor.session, repository: id, policy: repo ?? "unenrolled", acknowledgements: policy.acknowledgements.filter(a => a.session === actor.session), forbidden: policy.forbidden }, null, 2)));
					refresh(ctx);
					return;
				}
				if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Lane policy mutation requires an interactive operator TUI; RPC/headless cannot mutate policy.");
				if (!id) throw new Error("Cannot resolve a Git repository here.");
				const expected = JSON.stringify(policy);
				if (words[0] === "ack") {
					if (words.length !== 2 || !/^\d+$/.test(words[1])) throw new Error("Usage: ack current-revision");
					acknowledge(policy, actor, id, Number(words[1]));
				} else mutate(policy, words, actor, id);
				if (!await ctx.ui.confirm("Change lane policy?", clean(`${args}\nRevision: ${policy.revision}\nRepository: ${id.common}\nOperator session: ${actor.session}`), { timeout: 30000 })) {
					tell("Lane policy unchanged."); return;
				}
				savePolicy(policy, expected);
				refresh(ctx);
				tell(`Lane policy r${policy.revision} ${words[0] === "ack" ? "acknowledged" : "updated"}.`);
			} catch (error) { tell((error as Error).message, true); }
		},
	});
	pi.on("session_start", (_event, ctx) => { refresh(ctx); });
	pi.on("session_compact", (_event, ctx) => { refresh(ctx); });
	pi.on("before_agent_start", (event, ctx) => {
		const summary = refresh(ctx);
		if (summary) return { systemPrompt: `${event.systemPrompt}\n\n${clean(summary)}` };
	});
	pi.on("tool_call", (event, ctx) => {
		refresh(ctx);
		if (isGuardOff("lane-policy")) return;
		const reason = publicationToolReason(event.toolName, event.input, context(ctx));
		if (reason) return { block: true, reason };
	});
	pi.on("user_bash", (event, ctx) => {
		if (isGuardOff("lane-policy")) return;
		const reason = assessCommand(event.command, context(ctx));
		if (reason) return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
	});
}
