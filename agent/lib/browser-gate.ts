/**
 * browser-gate — pure logic for hiding the pi-browser-use `browser_*` tool schemas until the model calls
 * `browser_enable`. Selection of the tools, the desired active set, the opt-out config and the transcript
 * scan live here; the extension (extensions/browser-gate.ts) only wires them to pi. Nothing here throws on
 * odd input.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOADER_NAME = "browser_enable";
export const BROWSER_PREFIXES = ["browser_"];
export type GateMode = "gated" | "eager";

/** Names of the gated browser tools: prefix match, never the loader itself. */
export function splitBrowserTools(tools: { name: string }[], prefixes: string[] = BROWSER_PREFIXES): string[] {
	return tools.map((tool) => tool.name).filter((name) => name !== LOADER_NAME && prefixes.some((prefix) => name.startsWith(prefix)));
}

export interface DesiredActiveInput { active: string[]; browserNames: string[]; seen: string[]; enabled: boolean; mode: GateMode }
export interface DesiredActive { active: string[]; seen: string[] }

/**
 * The active tool set the gate wants, derived from the current one so other extensions' choices survive.
 * Only browser tools not seen before are touched: hidden while not enabled, activated once enabled. Tools seen
 * earlier keep whatever state they have, so a tool another extension deactivated stays off. Eager mode carries no
 * loader; gated sessions with browser tools show it.
 */
export function desiredActive({ active, browserNames, seen, enabled, mode }: DesiredActiveInput): DesiredActive {
	if (mode === "eager") return { active: active.filter((name) => name !== LOADER_NAME), seen };
	const fresh = browserNames.filter((name) => !seen.includes(name));
	let next = active.filter((name) => name !== LOADER_NAME && !(!enabled && fresh.includes(name)));
	if (enabled) next = [...new Set([...next, ...fresh])];
	if (browserNames.length > 0) next.push(LOADER_NAME);
	return { active: next, seen: [...seen, ...fresh] };
}

/** `PI_BROWSER_GATE=off|on` beats `browser-gate.json` (`{"mode":"eager"|"gated"}`); default gated; broken file = defaults. */
export function loadGateConfig(env: NodeJS.ProcessEnv = process.env, file = env.PI_BROWSER_GATE_FILE || join(homedir(), ".pi", "agent", "browser-gate.json")): { mode: GateMode } {
	const flag = (env.PI_BROWSER_GATE ?? "").trim().toLowerCase();
	if (flag === "off") return { mode: "eager" };
	if (flag === "on") return { mode: "gated" };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return { mode: raw?.mode === "eager" ? "eager" : "gated" };
	} catch {
		return { mode: "gated" };
	}
}

/** Tool names the transcript declared (`toolsAdded`/`toolsRemoved` system messages); undefined when it never declared any. */
export function transcriptToolNames(messages: any[]): Set<string> | undefined {
	let tools: Set<string> | undefined;
	for (const message of messages ?? []) {
		if (message?.role !== "system" || !("toolsAdded" in message || "toolsRemoved" in message)) continue;
		tools ??= new Set();
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
	}
	return tools;
}

const isBrowserName = (name: unknown): boolean => typeof name === "string" && BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Whether a recorded transcript shows browser tools in use: declared, called, or the loader called. Independent of what is registered now. */
function usedBrowserTools(messages: any[]): boolean {
	for (const message of messages ?? []) {
		if (message?.role === "toolResult" && isBrowserName(message.toolName)) return true;
		const content = message?.role === "assistant" && Array.isArray(message.content) ? message.content : [];
		if (content.some((block: any) => block?.type === "toolCall" && isBrowserName(block.name))) return true;
	}
	return false;
}

/**
 * Whether the browser tools were already enabled in a recorded session. A transcript that declared its tools is
 * authoritative, plus any browser call; an undeclared transcript with messages predates declarations and keeps its
 * (eager) tools only when `legacyKeeps`; otherwise undefined (no evidence).
 */
export function enabledFromTranscript(messages: any[], legacyKeeps: boolean): boolean | undefined {
	const declared = transcriptToolNames(messages);
	if (usedBrowserTools(messages) || (declared && [...declared].some((name) => name !== LOADER_NAME && isBrowserName(name)))) return true;
	if (declared) return undefined;
	return legacyKeeps && (messages ?? []).length > 0 ? true : undefined;
}
