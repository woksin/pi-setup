/**
 * /guards — show agent guard status; /guards off|on [named-guard|all] [--persist [--reason "text"]].
 * Without --persist changes last for this process (including in-process subagents).
 * session > persisted file > env > on. A corrupt file makes every guard on, and the env is ignored.
 * Explicit session overrides still apply; with no file, PI_GUARDS_OFF=cratis,mcp or all applies.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUARD_NAMES, guardStatus, guardsStatusText, isGuardOff, persistedNote, persistedOffGuards, setGuards } from "../lib/guards.ts";
import { mcpReason } from "../lib/lane-policy.ts";

interface ApprovalRequest {
	prefixedToolName: string;
	serverName?: string;
	args?: unknown;
	claim(handler: () => "allow_once" | "deny"): boolean;
}
const USAGE = `Usage: /guards [off|on [${GUARD_NAMES.join("|")}|all] [--persist [--reason "text"]]] (all excludes publish)`;

/** Whitespace-separated tokens; '…' and "…" group, a backslash escapes the next character. Unmatched quote/trailing backslash → usage error. */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: string | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\") {
			if (++i >= input.length) throw new Error(USAGE);
			current += input[i]; started = true;
		} else if (quote) {
			if (ch === quote) quote = undefined; else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch; started = true;
		} else if (/\s/.test(ch)) {
			if (started) tokens.push(current);
			current = ""; started = false;
		} else { current += ch; started = true; }
	}
	if (quote) throw new Error(USAGE);
	if (started) tokens.push(current);
	return tokens;
}

export default function (pi: ExtensionAPI) {
	let currentContext: ExtensionContext | undefined;
	const refresh = (ctx: ExtensionContext) => {
		currentContext = ctx;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("guards", guardsStatusText());
	};
	const show = (ctx: ExtensionContext) => {
		const notes = new Map(persistedOffGuards().map(entry => [entry.name, persistedNote(entry)]));
		const text = guardStatus().map(({ name, off, source }) =>
			`${name}: ${off ? "off" : "on"} (${source}${notes.has(name) ? `, ${notes.get(name)}` : ""})`).join("\n");
		if (ctx.hasUI) ctx.ui.notify(`${text}\nall excludes publish`, "info");
		else console.log(`${text}\nall excludes publish`);
	};

	pi.registerCommand("guards", {
		description: `Show or switch agent approval guards: off|on [${GUARD_NAMES.join("|")}|all] [--persist [--reason "text"]]; all excludes publish`,
		getArgumentCompletions: prefix => {
			const match = /^(.*\s)?(\S*)$/.exec(prefix);
			if (!match) return null;
			const before = match[1] ?? "";
			const word = match[2];
			const tokens = before.trim().split(/\s+/).filter(Boolean);
			const options = tokens.length === 0 ? ["off", "on"] :
				["off", "on"].includes(tokens[0]) ? [...GUARD_NAMES, "all", "--persist", "--reason"] : [];
			const items = options.filter(option => option.startsWith(word) && !tokens.includes(option))
				.map(option => ({ value: `${before}${option}`, label: option }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				const tokens = tokenize(args);
				if (tokens.length) {
					const action = tokens.shift();
					if (action !== "off" && action !== "on") throw new Error(USAGE);
					let reason: string | undefined;
					const at = tokens.indexOf("--reason");
					if (at >= 0) {
						if (at + 1 >= tokens.length || tokens.indexOf("--reason", at + 1) >= 0) throw new Error(USAGE);
						reason = tokens.splice(at, 2)[1];
					}
					const persist = tokens.includes("--persist");
					const names = tokens.filter(token => token !== "--persist");
					if (tokens.filter(token => token === "--persist").length > 1 || names.some(name => name.startsWith("--"))) {
						throw new Error(USAGE);
					}
					setGuards(names.length ? names : ["all"], action === "off", { persist, ...(reason !== undefined ? { reason } : {}) });
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
