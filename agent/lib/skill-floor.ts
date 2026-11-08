/**
 * skill-floor — compacts the project-scope skill listing of the system prompt.
 *
 * Pi lists every skill with its full description and absolute path (~550 B of XML each). A repository that
 * links a large skill corpus (Cratis worktrees: ~150 skills) pays 55–93 KB on every session. Project skills
 * are instead listed once as `name | hint | path` lines in a `repo_skills` section; the path is relative to
 * the cwd when that resolves to the same file, otherwise absolute, so every skill stays readable with the
 * read tool. Global, agent and package skills are never touched. Input skill objects are never mutated.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { byteLength, DEFAULT_CONFIG, type FloorConfig } from "./prompt-floor.ts";

export interface FloorSkill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
	sourceInfo?: { scope?: string };
	[key: string]: unknown;
}
export interface CompactResult<T extends FloorSkill = FloorSkill> {
	/** Skills for `systemPromptOptions.skills`: untouched ones plus hidden copies of the compacted ones. */
	skills: T[];
	/** Text for `systemPromptOptions.sections.repo_skills`; undefined when nothing was compacted. */
	section: string | undefined;
	compacted: number;
}

const isProject = (skill: FloorSkill): boolean => skill.sourceInfo?.scope === "project";

function globToRegExp(glob: string): RegExp {
	const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${source}$`);
}

/** First sentence of a description, whitespace collapsed, angle brackets removed, cut at `max` characters. */
export function skillHint(description: string, max: number): string {
	if (max <= 0) return "";
	const flat = (description ?? "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
	const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? "";
	return sentence.length <= max ? sentence : `${sentence.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Path the model can pass to `read`: relative to cwd when that resolves back to the same file, else absolute. */
export function readablePath(filePath: string, cwd: string): string {
	if (!cwd || !isAbsolute(filePath)) return filePath;
	const rel = relative(cwd, filePath);
	return rel && !isAbsolute(rel) && resolve(cwd, rel) === filePath ? rel : filePath;
}

function render(entries: { name: string; description: string; path: string }[], descChars: number): string {
	const header = `${entries.length} repository skills (not listed in full). When the task matches one, read its file with the read tool (paths are relative to the cwd unless absolute). Format: name | hint | path.`;
	const lines = entries.map((entry) => {
		const hint = skillHint(entry.description, descChars);
		return hint ? `${entry.name} | ${hint} | ${entry.path}` : `${entry.name} | | ${entry.path}`;
	});
	return [header, ...lines].join("\n");
}

export function compactSkills<T extends FloorSkill>(skills: T[], cfg: FloorConfig = DEFAULT_CONFIG, cwd = process.cwd()): CompactResult<T> {
	const input = skills ?? [];
	if (cfg.skills.projectMode !== "compact") return { skills: input, section: undefined, compacted: 0 };
	const keep = cfg.skills.keepFull.map(globToRegExp);
	const kept = (skill: T) => keep.some((re) => re.test(skill.name));
	const candidates = input.filter((skill) => isProject(skill) && !skill.disableModelInvocation && !kept(skill));
	if (!candidates.length) return { skills: input, section: undefined, compacted: 0 };
	const hide = new Set<T>(candidates);
	const out: T[] = input.map((skill) => (hide.has(skill) ? { ...skill, disableModelInvocation: true } : skill));
	const entries = [...candidates]
		.sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath))
		.map((skill) => ({ name: skill.name, description: skill.description, path: readablePath(skill.filePath, cwd) }));
	// Shrink the hints step by step until the cap holds; names and paths are never dropped.
	let section = render(entries, cfg.skills.descChars);
	for (const chars of [60, 40, 20, 0]) {
		if (byteLength(section) <= cfg.skills.maxBytes || chars >= cfg.skills.descChars) continue;
		section = render(entries, chars);
	}
	return { skills: out, section, compacted: entries.length };
}
