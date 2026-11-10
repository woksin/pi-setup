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

export interface DesiredActiveInput { active: string[]; browserNames: string[]; enabled: boolean; mode: GateMode }

/**
 * The active tool set the gate wants. Always derived from the current active set so other extensions' choices
 * survive. Eager mode and sessions without browser tools carry no loader; gated sessions show the loader and,
 * once enabled, every browser tool.
 */
export function desiredActive({ active, browserNames, enabled, mode }: DesiredActiveInput): string[] {
	const others = active.filter((name) => name !== LOADER_NAME && !browserNames.includes(name));
	if (mode === "eager") return [...new Set(active.filter((name) => name !== LOADER_NAME))];
	if (browserNames.length === 0) return others;
	return [...new Set([...others, ...(enabled ? browserNames : []), LOADER_NAME])];
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

/**
 * Whether the browser tools are already enabled in a recorded session. A transcript that declared its tools is
 * authoritative; an undeclared transcript with messages predates declarations and keeps its (eager) tools only
 * when `legacyKeeps`; an empty one starts gated.
 */
export function enabledFromTranscript(messages: any[], browserNames: string[], legacyKeeps: boolean): boolean | undefined {
	const declared = transcriptToolNames(messages);
	if (declared) return browserNames.some((name) => declared.has(name));
	return legacyKeeps && (messages ?? []).length > 0 ? true : undefined;
}
