/**
 * prompt-floor — measures the fixed prompt floor (sections, context files, tool schemas), shows it in the
 * status bar (`floor ~NNk`, `!` above warnTokens).
 * Logs sizes only (no prompt text) to ~/.pi/agent/logs/prompt-floor.jsonl (PI_FLOOR_LOG overrides) on the
 * first turn and whenever the measurement changes. `/floor` prints the table. Config: prompt-floor.json,
 * Never throws into the session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatFloor, loadFloorConfig, measureFloor, statusText, type FloorMeasurement } from "../lib/prompt-floor.ts";

const STATUS = "prompt-floor";
const MAX_LINE = 8000;

export function logLine(m: FloorMeasurement, skillCount: number, compacted: number): string {
	const record = {
		ts: new Date().toISOString(),
		estTokens: m.estTokens, totalBytes: m.totalBytes, promptBytes: m.promptBytes, toolsBytes: m.toolsBytes,
		sections: m.sections, contextFileBytes: m.contextFileBytes,
		skills: skillCount, skillsCompacted: compacted, toolCount: m.tools.length,
		topTools: m.tools.slice(0, 15),
	};
	let line = JSON.stringify(record);
	if (line.length > MAX_LINE) line = JSON.stringify({ ...record, contextFileBytes: undefined, topTools: m.tools.slice(0, 5) });
	return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
}

export default function (pi: ExtensionAPI) {
	let last: FloorMeasurement | undefined;
	let lastSignature = "";
	let warnTokens = 100_000;

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const config = loadFloorConfig();
			warnTokens = config.warnTokens;
			const options = event.systemPromptOptions;
			const active = new Set(pi.getActiveTools());
			const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
			const m = measureFloor({ systemPrompt: event.systemPrompt, systemPromptOptions: options, tools });
			last = m;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS, statusText(m, warnTokens));
			const signature = `${m.totalBytes}:${m.tools.length}`;
			if (signature !== lastSignature) {
				lastSignature = signature;
				const file = process.env.PI_FLOOR_LOG || join(homedir(), ".pi", "agent", "logs", "prompt-floor.jsonl");
				mkdirSync(dirname(file), { recursive: true });
				appendFileSync(file, `${logLine(m, (options.skills ?? []).length, 0)}\n`);
			}
		} catch { /* the meter must never disturb a turn */ }
	});

	pi.registerCommand("floor", {
		description: "Show the fixed prompt floor: sections, context files and the largest tool schemas",
		handler: async (_args, ctx) => {
			const text = last ? formatFloor(last, warnTokens) : "No floor measurement yet; it is taken on the first turn.";
			if (ctx.hasUI) ctx.ui.notify(text, "info");
		},
	});
}
