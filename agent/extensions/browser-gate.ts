/**
 * browser-gate — hides the ~35 pi-browser-use `browser_*` tool schemas (prompt floor) until the model calls the
 * `browser_enable` loader, mirroring pi-web-access's `web_enable`. pi-browser-use registers its tools inside its
 * own async `session_start` (and again every session), so the set is pruned in `before_agent_start` too.
 * Opt out with PI_BROWSER_GATE=off or browser-gate.json {"mode":"eager"}. Never throws into the session.
 */
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { desiredActive, enabledFromTranscript, LOADER_NAME, loadGateConfig, splitBrowserTools, type GateMode } from "../lib/browser-gate.ts";

export const GUIDELINE = "browser_* skills: call browser_enable before any browser_* tool.";
const text = (value: string) => [{ type: "text" as const, text: value }];

const readMessages = (ctx: any): any[] => buildSessionContext(ctx.sessionManager.getBranch()).messages;

export function registerBrowserGate(pi: ExtensionAPI, messagesOf: (ctx: any) => any[] = readMessages): void {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	let enabled = false;
	let seen: string[] = [];
	let mode: GateMode | undefined; // latched at session_start so a config flip mid-session never strands hidden tools
	const browserNames = () => splitBrowserTools(pi.getAllTools());
	const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((name, i) => name === b[i]);

	const apply = () => {
		try {
			mode ??= loadGateConfig().mode;
			const active = pi.getActiveTools();
			const next = desiredActive({ active, browserNames: browserNames(), seen, enabled, mode });
			seen = next.seen;
			if (!sameSet(next.active, active)) pi.setActiveTools(next.active);
		} catch { /* the gate must never disturb a turn */ }
	};
	/** Latches enablement and activates every registered browser tool; tools registered later are activated by apply(). */
	const enable = (names: string[]) => {
		enabled = true;
		seen = [...new Set([...seen, ...names])];
		const active = pi.getActiveTools();
		const next = [...new Set([...active, ...names])];
		if (!sameSet(next, active)) pi.setActiveTools(next);
	};
	const fromSession = (ctx: any, isStart: boolean) => {
		if (isStart) { enabled = false; seen = []; mode = loadGateConfig().mode; }
		try {
			if (!enabled && enabledFromTranscript(messagesOf(ctx), isStart)) enable(browserNames());
		} catch { /* keep the in-memory state */ }
		apply();
	};

	const parameters: any = { type: "object", properties: {}, additionalProperties: false };
	pi.registerTool({
		name: LOADER_NAME,
		label: "Enable browser tools",
		description: "Enable the pi-browser-use browser_* tools (pages, screenshots, console, network). Does not open anything. Tools are available on the next model request.",
		promptSnippet: "If you need to drive a browser (pages, screenshots, console, network), call browser_enable first; browser_* tools appear on the next model request.",
		promptGuidelines: [GUIDELINE],
		parameters,
		async execute() {
			const names = browserNames();
			if (names.length === 0) return { isError: true, content: text("No browser_* tools are registered (pi-browser-use not loaded or not started)."), details: { enabled: [] } };
			try {
				enable(names);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { isError: true, content: text(`Activation failed: ${message}.`), details: { error: message } };
			}
			return { content: text(`Enabled: ${names.join(", ")}.`), details: { enabled: names } };
		},
	});

	pi.on("session_start", (_event, ctx) => fromSession(ctx, true));
	pi.on("session_tree", (_event, ctx) => fromSession(ctx, false));
	pi.on("before_agent_start", () => { apply(); });
}

export default function (pi: ExtensionAPI) {
	registerBrowserGate(pi);
}
