/** Dormant until an operator enrolls a repository. No policy mutation tools are registered. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIONS, assessCommand, identity, loadPolicy, mutate, opaqueReason, policyFile, savePolicy, type Context } from "../lib/lane-policy.ts";

const HELP = `Lane policy (operator TUI command only; all mutations require confirmation):
status | help
bootstrap owner/repo
coordinator session-id [--override]
enroll session-id lane branch ${ACTIONS.join(",")}
writer session-id branch action[,action...]
grant session-id action exact-target 1..60 minutes
revoke session|writer|grants session-id
forbid target | clear-forbidden exact-target
Non-coordinators must append --override. Grants target a branch for push/pr-create, a numeric issue/PR for issue-write/pr-comment. Merge remains blocked in this first slice. No live lanes are enrolled automatically.`;
const context = (ctx: ExtensionContext): Context => ({ cwd: ctx.cwd, session: ctx.sessionManager.getSessionId() });
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export default function (pi: ExtensionAPI) {
	pi.registerCommand("lane-policy", {
		description: "Inspect lane authority or make confirmed operator-only policy changes",
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
					tell(clean(JSON.stringify({ session: actor.session, repository: id, policy: repo ?? "unenrolled", forbidden: policy.forbidden }, null, 2)));
					return;
				}
				if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Lane policy mutation requires an interactive operator TUI; RPC/headless cannot mutate policy.");
				if (!id) throw new Error("Cannot resolve a Git repository here.");
				const expected = JSON.stringify(policy);
				mutate(policy, words, actor, id);
				if (!await ctx.ui.confirm("Change lane policy?", clean(`${args}\nRepository: ${id.common}\nOperator session: ${actor.session}`), { timeout: 30000 })) {
					tell("Lane policy unchanged."); return;
				}
				savePolicy(policy, expected);
				tell("Lane policy updated.");
			} catch (error) { tell((error as Error).message, true); }
		},
	});

	pi.on("tool_call", (event, ctx) => {
		const actor = context(ctx);
		const input = event.input as Record<string, unknown>;
		let reason: string | undefined;
		if (["write", "edit", "apply_patch"].includes(event.toolName)) {
			// apply_patch cannot be attributed to one canonical path; deny it when enrolled.
			const path = input.path ?? input.file_path;
			if (typeof path === "string" && policyFile(path, actor.cwd)) reason = "Lane policy: model-facing writes to policy are forbidden; use /lane-policy.";
			if (event.toolName === "apply_patch") reason ??= opaqueReason(actor);
		} else if (event.toolName === "bash") {
			reason = typeof input.command === "string" ? assessCommand(input.command, actor) : "Lane policy: missing bash command.";
		} else if (!["read", "grep", "find", "ls"].includes(event.toolName)) {
			// This covers MCP direct/proxy/script/codemode, jobs, Agent and SubagentWorkflow,
			// including unknown future tools. No inferred child authority or metadata trust.
			reason = opaqueReason(actor, undefined, JSON.stringify(input));
			if (!reason && typeof input.cwd === "string") reason = opaqueReason({ ...actor, cwd: input.cwd });
		}
		if (reason) return { block: true, reason };
	});
	pi.on("user_bash", (event, ctx) => {
		const reason = assessCommand(event.command, context(ctx));
		if (reason) return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
	});
}
