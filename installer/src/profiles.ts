import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "./settings.ts";
import { listFiles } from "./fsx.ts";
import { PROVIDER_LABELS, SetupError } from "./types.ts";
import type { ProfileMeta, Settings } from "./types.ts";

export const START = "<!-- pi-profile:routing:start";
export const END = "<!-- pi-profile:routing:end -->";
const FALLBACK_PROFILE = "balanced";

export function profilesDir(repoDir: string): string {
  return join(repoDir, "agent", "profiles");
}

export function profileNames(repoDir: string): string[] {
  const dir = profilesDir(repoDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function loadProfiles(repoDir: string): ProfileMeta[] {
  const metas: ProfileMeta[] = [];
  for (const name of profileNames(repoDir)) {
    const file = join(profilesDir(repoDir), name, "profile.json");
    if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    metas.push({
      name,
      summary: typeof data.summary === "string" ? data.summary : "",
      requires: stringList(data.requires),
      uses: stringList(data.uses),
      rank: typeof data.rank === "number" ? data.rank : 0,
    });
  }
  return metas;
}

export interface Choice {
  name: string;
  reason: string;
  provisional: boolean;
  source: "flag" | "active" | "chooser" | "prompt";
}

export function chooseProfile(ready: Set<string>, profiles: ProfileMeta[]): Choice {
  const fit = profiles
    .filter((p) => p.requires.every((r) => ready.has(r)))
    .sort((a, b) => b.rank - a.rank)[0];
  const name = fit?.name ?? FALLBACK_PROFILE;
  return { name, reason: reasonFor(ready, name), provisional: !fit, source: "chooser" };
}

export function reasonFor(ready: Set<string>, name: string): string {
  const claude = ready.has("anthropic");
  const gpt = ready.has("openai-codex");
  const kimi = ready.has("kimi-coding");
  if (claude && gpt && kimi) return "you have Claude, ChatGPT and Kimi: each role goes where it is strongest";
  if (claude && gpt) return "you have Claude and ChatGPT; Kimi roles (ops, scout) fall back to GPT via provider-fallback";
  if (gpt && !claude) return `only ChatGPT is logged in: ${name} keeps every role on GPT`;
  if (claude) return `only Claude is logged in: ${name} keeps every role on Claude`;
  return "log in with /login in pi, then rerun ./install.sh --profile auto";
}

/** One line for the summary when the chosen profile uses Kimi but Kimi is not logged in. */
export function kimiNote(profile: ProfileMeta | undefined, ready: Set<string>): string | undefined {
  if (!profile?.uses.includes("kimi-coding") || ready.has("kimi-coding")) return undefined;
  return "Kimi is not logged in: the Kimi roles fall back to GPT.";
}

export function missingLogins(profile: ProfileMeta | undefined, ready: Set<string>): string[] {
  return (profile?.requires ?? []).filter((r) => !ready.has(r)).map((r) => PROVIDER_LABELS[r] ?? r);
}

export function pinnedModels(profileDir: string): string[] {
  const pins = new Set<string>();
  for (const file of listFiles(join(profileDir, "agents")).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(profileDir, "agents", file), "utf8");
    const match = /^model:\s*(\S+)/m.exec(text);
    if (match) pins.add(match[1]);
  }
  return [...pins].sort();
}

export function pinWarnings(pins: string[], ready: Set<string>, catalog: Set<string> | null): string[] {
  if (!catalog || catalog.size === 0) return [];
  return pins
    .filter((pin) => ready.has(pin.split("/")[0]) && !catalog.has(pin))
    .map((pin) => `Pinned model ${pin} is not in this pi's model catalog.`);
}

export interface Overlay {
  /** Profile files that replace repo files, by path relative to ~/.pi/agent (agents/, workflows/). */
  sources: Map<string, string>;
  /** The routing.md of the profile, rendered; spliced into AGENTS.md by the plan. */
  routing?: Buffer;
}

/** What pi-profile would put live for a profile, computed in memory. */
export function overlayFor(repoDir: string, name: string, settings: Settings): Overlay {
  const base = join(profilesDir(repoDir), name);
  if (!existsSync(base)) throw new SetupError(`unknown profile '${name}'. available: ${profileNames(repoDir).join(", ")}`);
  const sources = new Map<string, string>();
  // The same filter as pi-profile's managed_files(): only *.md under agents/ and *.js under workflows/.
  for (const [sub, ext] of [["agents", ".md"], ["workflows", ".js"]]) {
    for (const file of listFiles(join(base, sub))) {
      if (!file.includes("/") && file.endsWith(ext)) sources.set(`${sub}/${file}`, join(base, sub, file));
    }
  }
  const routingPath = join(base, "routing.md");
  return { sources, routing: existsSync(routingPath) ? render(readFileSync(routingPath), settings) : undefined };
}

function markerLines(text: string): { start: number; bodyStart: number; end: number; endLineEnd: number } | undefined {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) return undefined;
  const bodyStart = text.indexOf("\n", start) + 1;
  if (bodyStart === 0 || bodyStart > end) return undefined;
  const nl = text.indexOf("\n", end);
  return { start, bodyStart, end, endLineEnd: nl < 0 ? text.length : nl };
}

export function hasRoutingMarkers(content: Buffer): boolean {
  return markerLines(content.toString("utf8")) !== undefined;
}

/**
 * Replace only the body between the routing markers, like pi-profile. When the live file has the markers,
 * its start and end marker lines are kept exactly (the start line carries "(managed by …)" text).
 */
export function spliceRouting(agentsMd: Buffer, routing: Buffer, live?: Buffer): Buffer {
  const text = agentsMd.toString("utf8");
  const m = markerLines(text);
  if (!m) throw new SetupError("routing markers not found in AGENTS.md");
  const l = live ? markerLines(live.toString("utf8")) : undefined;
  const liveText = live?.toString("utf8") ?? "";
  const startLine = l ? liveText.slice(l.start, l.bodyStart) : text.slice(m.start, m.bodyStart);
  const endLine = l ? liveText.slice(l.end, l.endLineEnd) : text.slice(m.end, m.endLineEnd);
  return Buffer.from(text.slice(0, m.start) + startLine + routing.toString("utf8") + endLine + text.slice(m.endLineEnd), "utf8");
}
