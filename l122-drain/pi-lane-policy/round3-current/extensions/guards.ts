/**
 * /guards — show agent guard status; /guards off|on [named-guard|all] [--persist].
 * Without --persist changes last for this process (including in-process subagents).
 * session > persisted file > env > on. A corrupt file makes every guard on, and the env is ignored.
 * Explicit session overrides still apply; with no file, PI_GUARDS_OFF=cratis,mcp or all applies.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUARD_NAMES, guardStatus, isGuardOff, setGuards } from "../lib/guards.ts";
import { mcpReason } from "../lib/lane-policy.ts";

interface ApprovalRequest {
	prefixedToolName: string;
	serverName?: string;
	args?: unknown;
	claim(handler: () => "allow_once" | "deny"): boolean;
}
const USAGE = `Usage: /guards [off|on [${GUARD_NAMES.join("|")}|all] [--persist]]`;

export default function (pi: ExtensionAPI) {
	let currentContext: ExtensionContext | undefined;
	const refresh = (ctx: ExtensionContext) => {
		currentContext = ctx;
		if (!ctx.hasUI) return;
		const off = guardStatus().filter(entry => entry.off).map(entry => entry.name);
		ctx.ui.setStatus("guards", off.length ? `guards off: ${off.join(",")}` : undefined);
	};
	const show = (ctx: ExtensionContext) => {
		const text = guardStatus().map(({ name, off, source }) => `${name}: ${off ? "off" : "on"} (${source})`).join("\n");
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		else console.log(text);
	};

	pi.registerCommand("guards", {
		description: `Show or switch agent approval guards: off|on [${GUARD_NAMES.join("|")}|all] [--persist]`,
		getArgumentCompletions: prefix => {
			const match = /^(.*\s)?(\S*)$/.exec(prefix);
			if (!match) return null;
			const before = match[1] ?? "";
			const word = match[2];
			const tokens = before.trim().split(/\s+/).filter(Boolean);
			const options = tokens.length === 0 ? ["off", "on"] :
				["off", "on"].includes(tokens[0]) ? [...GUARD_NAMES, "all", "--persist"] : [];
			const items = options.filter(option => option.startsWith(word) && !tokens.includes(option))
				.map(option => ({ value: `${before}${option}`, label: option }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (tokens.length) {
					const action = tokens.shift();
					if (action !== "off" && action !== "on") throw new Error(USAGE);
					const persist = tokens.includes("--persist");
					const names = tokens.filter(token => token !== "--persist");
					if (tokens.filter(token => token === "--persist").length > 1 || names.some(name => name.startsWith("--"))) {
						throw new Error(USAGE);
					}
					setGuards(names.length ? names : ["all"], action === "off", { persist });
				}
				refresh(ctx);
				show(ctx);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify((error as Error).message, "error");
				else console.error((error as Error).message);
			}
		},
	});

	// claim() is accepted only during synchronous emission, not after an await.
	pi.events.on("pi-mcp-adapter:tool-approval-request", data => {
		const request = data as ApprovalRequest;
		const actor = currentContext?.cwd && currentContext.sessionManager ? { cwd: currentContext.cwd, session: currentContext.sessionManager.getSessionId() } : undefined;
		const reason = mcpReason(actor, request.prefixedToolName, request.serverName, JSON.stringify(request.args));
		if (reason) { request.claim(() => "deny"); return; }
		if (!isGuardOff("mcp")) return;
		request.claim(() => {
			if (currentContext?.hasUI) {
				currentContext.ui.notify(`mcp guard off: allowed '${request.prefixedToolName}'`, "info");
			}
			return "allow_once";
		});
	});

	pi.on("session_start", (_event, ctx) => { refresh(ctx); });
	pi.on("before_agent_start", (_event, ctx) => { refresh(ctx); });
	pi.on("tool_call", (_event, ctx) => { refresh(ctx); });
	pi.on("agent_end", (_event, ctx) => { refresh(ctx); });
	pi.on("session_shutdown", () => { currentContext = undefined; });
}
