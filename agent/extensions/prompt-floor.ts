/**
 * prompt-floor — measures the fixed prompt floor (sections, context files, tool schemas), shows it in the
 * status bar (`floor ~NNk`, `!` above warnTokens) and compacts the project-skill listing (lib/skill-floor.ts).
 * Logs sizes only (no prompt text) to ~/.pi/agent/logs/prompt-floor.jsonl (PI_FLOOR_LOG overrides) on the
 * first turn and whenever the measurement changes. `/floor` prints the table. Config: prompt-floor.json,
 * PI_FLOOR=off disables compaction. Never throws into the session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatFloor, groupByPrefix, loadFloorConfig, measureFloor, statusText, topPrefixes, type FloorMeasurement, type PrefixTotal } from "../lib/prompt-floor.ts";
import { compactSkills } from "../lib/skill-floor.ts";

const STATUS = "prompt-floor";
const MAX_LINE = 8000;

export function logLine(m: FloorMeasurement, skillCount: number, compacted: number, allPrefixes?: Record<string, PrefixTotal>): string {
	const record = {
		ts: new Date().toISOString(),
		estTokens: m.estTokens, totalBytes: m.totalBytes, promptBytes: m.promptBytes, toolsBytes: m.toolsBytes,
		sections: m.sections, contextFileBytes: m.contextFileBytes,
		skills: skillCount, skillsCompacted: compacted, toolCount: m.tools.length,
		topTools: m.tools.slice(0, 15),
		activePrefixes: topPrefixes(m.prefixes), allPrefixes: allPrefixes ? topPrefixes(allPrefixes) : undefined,
	};
	let line = JSON.stringify(record);
	if (line.length > MAX_LINE) line = JSON.stringify({ ...record, contextFileBytes: undefined, topTools: m.tools.slice(0, 5), activePrefixes: undefined });
	return line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
}

export default function (pi: ExtensionAPI) {
	let last: FloorMeasurement | undefined;
	let lastAll: Record<string, PrefixTotal> | undefined;
	let lastSignature = "";
	let warnTokens = 100_000;

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const config = loadFloorConfig();
			warnTokens = config.warnTokens;
			const options = event.systemPromptOptions;
			const result = compactSkills(options.skills ?? [], config, ctx.cwd);
			if (result.section) {
				options.skills = result.skills;
				options.sections = { ...(options.sections ?? {}), repo_skills: result.section };
			}
			const active = new Set(pi.getActiveTools());
			const all = pi.getAllTools();
			const tools = all.filter((tool) => active.has(tool.name));
			lastAll = groupByPrefix(all);
			const m = measureFloor({ systemPrompt: event.systemPrompt, systemPromptOptions: options, tools });
			last = m;
			if (ctx.hasUI) ctx.ui.setStatus(STATUS, statusText(m, warnTokens));
			const signature = `${m.totalBytes}:${m.tools.length}`;
			if (signature !== lastSignature) {
				lastSignature = signature;
				const file = process.env.PI_FLOOR_LOG || join(homedir(), ".pi", "agent", "logs", "prompt-floor.jsonl");
				mkdirSync(dirname(file), { recursive: true });
				appendFileSync(file, `${logLine(m, (options.skills ?? []).length, result.compacted, lastAll)}\n`);
			}
		} catch { /* the meter must never disturb a turn */ }
	});

	pi.registerCommand("floor", {
		description: "Show the fixed prompt floor: sections, context files and the largest tool schemas",
		handler: async (_args, ctx) => {
			const text = last ? formatFloor(last, warnTokens, lastAll) : "No floor measurement yet; it is taken on the first turn.";
			if (ctx.hasUI) ctx.ui.notify(text, "info");
		},
	});
}
