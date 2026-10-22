import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deepEqual, hasTokens, mergeUserJson, readSettings, render } from "./settings.ts";
import { listFiles } from "./fsx.ts";
import { spliceRouting } from "./profiles.ts";
import type { Overlay } from "./profiles.ts";
import { SetupError } from "./types.ts";
import type { Action, Settings } from "./types.ts";

const TREES = ["agents", "extensions", "early-extensions", "lib", "workflows", "templates", "profiles", "loose-threads", "bin", "pi-phase", "lane-policy"];
const ONLY_IF_ABSENT = ["settings.json", "models.json", "subagents.json", "provider-fallback.json", "mcp-adapter.json", "efficiency.json", "context-budget.json"];
const PACKAGE = "./local-packages/pi-questions";

export interface PlanInput {
  repoDir: string;
  home: string;
  settings: Settings;
  overlay: Overlay;
}

interface Desired {
  content: Buffer;
  mode: number;
  mtimeMs?: number;
}

function fromSource(src: string, settings: Settings): Desired {
  const raw = readFileSync(src);
  const st = statSync(src);
  const mode = st.mode & 0o7777;
  return hasTokens(raw)
    ? { content: render(raw, settings), mode }
    : { content: raw, mode, mtimeMs: st.mtimeMs };
}

function sameBytes(dest: string, content: Buffer): boolean {
  return existsSync(dest) && statSync(dest).isFile() && readFileSync(dest).equals(content);
}

function put(actions: Action[], dest: string, desired: Desired): void {
  if (sameBytes(dest, desired.content)) return;
  actions.push({ op: "install", path: dest, existed: existsSync(dest), ...desired });
}

function putSource(actions: Action[], src: string, dest: string, settings: Settings): void {
  put(actions, dest, fromSource(src, settings));
}

function putTree(actions: Action[], srcDir: string, destDir: string, settings: Settings, overlay?: Map<string, string>, prefix = ""): void {
  const files = new Set(listFiles(srcDir));
  for (const [rel, src] of overlay ?? []) if (rel.startsWith(prefix)) files.add(rel.slice(prefix.length));
  for (const rel of [...files].sort()) {
    const src = overlay?.get(`${prefix}${rel}`) ?? join(srcDir, rel);
    putSource(actions, src, join(destDir, rel), settings);
  }
}

function userJsonAction(actions: Action[], piDir: string, settings: Settings): void {
  const path = join(piDir, "user.json");
  const existing = readSettings(path);
  const merged = mergeUserJson(existing, settings);
  if (existsSync(path) && deepEqual(existing, merged)) return;
  actions.push({
    op: "install", path, existed: existsSync(path), mode: 0o644,
    content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`),
  });
}

function agentsMd(input: PlanInput): Desired {
  const base = fromSource(join(input.repoDir, "agent", "AGENTS.md"), input.settings);
  if (!input.overlay.routing) return base;
  return { content: spliceRouting(base.content, input.overlay.routing), mode: base.mode };
}

function registerAction(actions: Action[], piDir: string): void {
  const path = join(piDir, "settings.json");
  const pending = actions.find((a) => a.op === "install" && a.path === path);
  const content = pending && pending.op === "install" ? pending.content : existsSync(path) ? readFileSync(path) : undefined;
  if (!content) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new SetupError(`${path}: ${(error as Error).message}`);
  }
  const packages = Array.isArray(data.packages) ? (data.packages as unknown[]) : [];
  if (packages.includes(PACKAGE)) return;
  const updated = { ...data, packages: [...packages, PACKAGE] };
  const mode = pending && pending.op === "install" ? pending.mode : statSync(path).mode & 0o7777;
  const next = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`);
  if (pending && pending.op === "install") {
    pending.content = next;
    actions.push({ op: "register", path, content: next, mode, existed: false });
  } else {
    actions.push({ op: "register", path, content: next, mode, existed: true });
  }
}

export function buildPlan(input: PlanInput): Action[] {
  const { repoDir, home, settings, overlay } = input;
  const agent = join(repoDir, "agent");
  const piDir = join(home, ".pi", "agent");
  const actions: Action[] = [];
  userJsonAction(actions, piDir, settings);
  for (const tree of TREES) {
    const useOverlay = tree === "agents" || tree === "workflows";
    putTree(actions, join(agent, tree), join(piDir, tree), settings, useOverlay ? overlay.sources : undefined, useOverlay ? `${tree}/` : "");
  }
  putTree(actions, join(agent, "local-packages/pi-questions"), join(piDir, "local-packages/pi-questions"), settings);
  actions.push({ op: "chmod-x", path: join(piDir, "local-packages/pi-questions/dist/cli.js") });
  put(actions, join(piDir, "AGENTS.md"), agentsMd(input));
  putSource(actions, join(agent, "AGENTS.subagent.md"), join(piDir, "AGENTS.subagent.md"), settings);
  for (const name of ONLY_IF_ABSENT) {
    if (!existsSync(join(piDir, name))) putSource(actions, join(agent, name), join(piDir, name), settings);
  }
  registerAction(actions, piDir);
  const absent: [string, string][] = [
    ["docker-guardian/pinned.example.txt", "docker-guardian/pinned.txt"],
    ["dev-doctor.example.json", "dev-doctor.json"],
    ["npm-package.json", "npm/package.json"],
  ];
  for (const [from, to] of absent) {
    if (!existsSync(join(piDir, to))) putSource(actions, join(agent, from), join(piDir, to), settings);
  }
  for (const skill of listSkills(repoDir)) {
    putTree(actions, join(repoDir, "skills", skill), join(home, ".agents", "skills", skill), settings);
  }
  const link = join(piDir, "skills", "ai-work-lifecycle");
  if (!lstatExists(link)) actions.push({ op: "symlink", path: link, target: join(home, ".agents", "skills", "ai-work-lifecycle") });
  putTree(actions, join(repoDir, "tools/ai-work-lifecycle"), join(home, ".local/share/ai-work-lifecycle"), settings);
  const bin = join(repoDir, "tools/bin/ai-work-lifecycle");
  putSource(actions, bin, join(home, ".local/bin/ai-work-lifecycle"), settings);
  return actions;
}

function listSkills(repoDir: string): string[] {
  const dir = join(repoDir, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function writtenPaths(actions: Action[]): string[] {
  return actions.filter((a) => a.op === "install" || a.op === "register").map((a) => a.path);
}
