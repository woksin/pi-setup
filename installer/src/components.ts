import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, Detection } from "./types.ts";

export const COMPONENT_IDS = ["docker-guardian", "cleanup", "secret-sweep", "codescene", "cratis", "web"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export interface ComponentDef {
  id: ComponentId;
  label: string;
  explain: string;
  service: boolean;
}

export const COMPONENTS: ComponentDef[] = [
  { id: "docker-guardian", label: "docker-guardian", explain: "restarts a hung Docker Desktop every 2 minutes (macOS launchd)", service: true },
  { id: "cleanup", label: "cleanup schedule", explain: "daily disk cleanup of pi's caches (launchd or systemd timer)", service: true },
  { id: "secret-sweep", label: "secret-sweep", explain: "daily scan of pi sessions for leaked secrets (macOS launchd; needs gitleaks)", service: true },
  { id: "codescene", label: "CodeScene", explain: "Code Health MCP server and policy in AGENTS.md (needs cs-mcp and a token)", service: false },
  { id: "cratis", label: "Cratis conventions", explain: "Cratis rules, cratis-cli guard and agent, and the Cratis sections of AGENTS.md", service: false },
  { id: "web", label: "browser and web tools", explain: "pi-web-access and pi-browser-use (the browser may download on first use)", service: false },
];

export const isComponentId = (id: string): id is ComponentId => (COMPONENT_IDS as readonly string[]).includes(id);

/** true when usable here, otherwise the reason it is not. */
export function available(id: ComponentId, ctx: Pick<Ctx, "platform" | "which">): true | string {
  if (id === "docker-guardian") return ctx.platform === "darwin" ? true : "needs Docker Desktop on macOS";
  if (id === "secret-sweep") return ctx.platform === "darwin" ? true : "its schedule is a macOS launchd job";
  if (id === "cleanup") return ctx.platform === "darwin" || ctx.which("systemctl") ? true : "needs launchd (macOS) or systemd";
  return true;
}

export type ComponentSource = "flag" | "prompt" | "saved" | "installed" | "detected" | "default";
export type ComponentChoice = Record<string, { on: boolean; source: ComponentSource }>;

export interface ResolveInput {
  /** `--with` / `--without`. */
  flags?: Record<string, boolean>;
  /** Answers from this run's wizard. */
  answers?: Record<string, boolean>;
  /** manifest.components. */
  saved?: Record<string, { on: boolean }>;
  /** State of an install from before choices were recorded (non-services only). */
  current?: Record<string, boolean>;
  detected: Record<string, boolean>;
  interactive: boolean;
}

/**
 * Precedence: flag > wizard answer > saved > installed state > detection.
 * Services never come from the installed state, and detection only sets an interactive run's initial value:
 * a service loads only on an explicit choice.
 */
export function resolveComponents(input: ResolveInput): ComponentChoice {
  const out: ComponentChoice = {};
  for (const def of COMPONENTS) {
    const { id } = def;
    if (input.flags && id in input.flags) out[id] = { on: input.flags[id], source: "flag" };
    else if (input.answers && id in input.answers) out[id] = { on: input.answers[id], source: "prompt" };
    else if (input.saved?.[id]) out[id] = { on: input.saved[id].on === true, source: "saved" };
    else if (!def.service && input.current?.[id]) out[id] = { on: true, source: "installed" };
    else if (def.service && !input.interactive) out[id] = { on: false, source: "default" };
    else out[id] = { on: Boolean(input.detected[id]), source: "detected" };
  }
  return out;
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export const WEB_PACKAGES = ["npm:pi-web-access", "npm:pi-browser-use"];

/** What an install from before choices were recorded already has (non-services). */
export function currentState(ctx: Pick<Ctx, "home">): Record<string, boolean> {
  const piDir = join(ctx.home, ".pi", "agent");
  const mcp = readJson(join(piDir, "mcp-adapter.json"));
  const servers = mcp?.mcpServers;
  const packages = readJson(join(piDir, "settings.json"))?.packages;
  return {
    cratis: existsSync(join(piDir, "extensions", "cratis-cli-guard.ts")),
    codescene: typeof servers === "object" && servers !== null && "codescene" in servers,
    web: Array.isArray(packages) && packages.some((p) => WEB_PACKAGES.includes(p as string)),
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const LIMIT = 200;

function hasCratisDir(root: string): boolean {
  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir).slice(0, LIMIT);
    } catch {
      return [];
    }
  };
  for (const a of entries(root)) {
    if (a === ".cratis") return true;
    const one = join(root, a);
    if (!isDir(one)) continue;
    if (entries(one).some((b) => b === ".cratis" && isDir(join(one, b)))) return true;
  }
  return false;
}

export function detectDefaults(
  ctx: Pick<Ctx, "platform" | "which" | "env">, detection: Pick<Detection, "github">, reposRoot: string,
): Record<string, boolean> {
  const cratis =
    detection.github.orgs.some((o) => o.toLowerCase() === "cratis") ||
    isDir(join(reposRoot, "cratis")) || isDir(join(reposRoot, "Cratis")) || hasCratisDir(reposRoot);
  return {
    "docker-guardian": ctx.platform === "darwin" && Boolean(ctx.which("docker")),
    cleanup: ctx.platform === "darwin" || Boolean(ctx.which("systemctl")),
    "secret-sweep": ctx.platform === "darwin" && Boolean(ctx.which("gitleaks")),
    codescene: Boolean(ctx.which("cs-mcp")) || Boolean(ctx.env.CS_ACCESS_TOKEN),
    cratis,
    web: true,
  };
}

/** One line explaining the initial value, e.g. `docker found; restarts …` or `off: no Cratis repos found`. */
export function hintFor(def: ComponentDef, on: boolean): string {
  const why: Record<string, [string, string]> = {
    "docker-guardian": ["docker found", "no docker found"],
    cleanup: ["a scheduler is available", "no scheduler found"],
    "secret-sweep": ["gitleaks found", "gitleaks not found"],
    codescene: ["cs-mcp or a token found", "no cs-mcp or token found"],
    cratis: ["Cratis repos found", "no Cratis repos found"],
    web: ["on by default", "off"],
  };
  const [yes, no] = why[def.id];
  return on ? `${yes}; ${def.explain}` : `off: ${no}; ${def.explain}`;
}

// ---------------------------------------------------------------- Cratis

/** Paths below ~/.pi/agent that exist only for Cratis conventions. */
export function isCratisFile(rel: string): boolean {
  return rel === "extensions/cratis-cli-guard.ts" || rel === "lib/cratis-cli-guard.test.ts" || rel === "agents/cratis-cli.md" ||
    rel === "bin/cratis-local-run" || /^profiles\/[^/]+\/agents\/cratis-cli\.md$/.test(rel);
}

/** Drop `cratis-cli-guard` from the `extensions:` frontmatter list of an agent definition. */
export function dropGuardExtension(content: Buffer): Buffer {
  const text = content.toString("utf8");
  const fm = /^---\n[\s\S]*?\n---/.exec(text);
  if (!fm) return content;
  const head = fm[0].replace(/^(extensions:\s*\[)([^\]\n]*)(\])/m, (_m, a: string, list: string, b: string) =>
    `${a}${list.split(",").map((s) => s.trim()).filter((s) => s && s !== "cratis-cli-guard").join(", ")}${b}`);
  return head === fm[0] ? content : Buffer.from(head + text.slice(fm[0].length), "utf8");
}

const markerRe = (id: string, which: "start" | "end") => new RegExp(`^<!-- pi-setup:${id}:${which}\\b[^\\n]*-->[ \\t]*$`, "m");

/** Remove each `pi-setup:<id>:start … end` block, inclusive, with one trailing blank line. */
export function stripSections(buf: Buffer, offIds: string[]): { content: Buffer; warnings: string[] } {
  let text = buf.toString("utf8");
  const warnings: string[] = [];
  for (const id of offIds) {
    const s = markerRe(id, "start").exec(text);
    const e = markerRe(id, "end").exec(text);
    if (!s || !e || e.index < s.index) {
      warnings.push(`AGENTS.md has no pi-setup:${id} markers; its ${id} section stays`);
      continue;
    }
    let end = text.indexOf("\n", e.index);
    end = end < 0 ? text.length : end + 1;
    if (text[end] === "\n") end += 1;
    text = text.slice(0, s.index) + text.slice(end);
  }
  return { content: Buffer.from(text, "utf8"), warnings };
}

const CS_REPO = "https://github.com/codescene-oss/codescene-mcp-server";
export const CS_SKILLS = [
  "explaining-code-health", "guiding-refactoring-with-code-health", "making-the-business-case-for-code-health",
  "prioritizing-technical-debt", "risk-based-testing-with-code-health", "routing-work-with-code-ownership", "safeguarding-ai-generated-code",
];

/** Summary lines for CodeScene when it is on. Nothing here reads or stores the token. */
export function codesceneNotes(ctx: Pick<Ctx, "which" | "env">): string[] {
  return [
    ...(ctx.env.CS_ACCESS_TOKEN ? [] : ["CodeScene: set CS_ACCESS_TOKEN in your shell profile (pi-setup never stores it)"]),
    ...(ctx.which("cs-mcp") ? [] : [`install cs-mcp: ${CS_REPO}#readme`]),
    `CodeScene skills are not bundled: copy ${CS_SKILLS.join(", ")} from ${CS_REPO}/tree/main/skills to ~/.agents/skills/`,
  ];
}
