import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { deepEqual, hasTokens, mergeUserJson, readSettings, render } from "./settings.ts";
import { listFiles } from "./fsx.ts";
import { hasRoutingMarkers, spliceRouting } from "./profiles.ts";
import type { Overlay } from "./profiles.ts";
import { dropGuardExtension, isCratisFile, stripSections, WEB_PACKAGES } from "./components.ts";
import { preapprovalDefault } from "./lanes/config.ts";
import { SetupError } from "./types.ts";
import type { Action, JsonOp, Settings } from "./types.ts";

const TREES = ["agents", "extensions", "early-extensions", "lib", "workflows", "templates", "profiles", "loose-threads", "bin", "pi-phase", "lane-policy"];
const ONLY_IF_ABSENT = ["settings.json", "models.json", "subagents.json", "provider-fallback.json", "mcp-adapter.json", "efficiency.json", "context-budget.json"];
const PACKAGE = "./local-packages/pi-questions";

export interface PlanInput {
  repoDir: string;
  home: string;
  settings: Settings;
  overlay: Overlay;
  /** Which optional components are on; undefined means all of them. */
  components?: Record<string, boolean>;
  /** Components being turned on by this run; only these are added to a settings file that already exists. */
  activate?: string[];
  /** Explicit trust opt-in for newly created lanes folders; saved true is preserved. */
  preapproveMcp?: boolean;
  /** Packages pi-setup added earlier for a component that is being turned off; they are dropped from the content planned for settings.json, which is read before the component is retired. */
  drop?: string[];
  /** Looks a tool up on PATH (the cs-mcp command). */
  which?: (name: string) => string | undefined;
  /** Receives notes for the summary (for example missing AGENTS.md markers). */
  notes?: string[];
}

interface Filter {
  skip: (rel: string) => boolean;
  transform: (rel: string, content: Buffer) => Buffer;
}
const NO_FILTER: Filter = { skip: () => false, transform: (_rel, content) => content };

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
  if (sameBytes(dest, desired.content)) {
    actions.push({ op: "adopt", path: dest });
    return;
  }
  actions.push({ op: "install", path: dest, existed: existsSync(dest), ...desired });
}

function putSource(actions: Action[], src: string, dest: string, settings: Settings): void {
  put(actions, dest, fromSource(src, settings));
}

function putTree(
  actions: Action[], srcDir: string, destDir: string, settings: Settings, overlay?: Map<string, string>, prefix = "",
  filter = NO_FILTER, treeRel = "",
): void {
  const files = new Set(listFiles(srcDir));
  for (const [rel, src] of overlay ?? []) if (rel.startsWith(prefix)) files.add(rel.slice(prefix.length));
  for (const rel of [...files].sort()) {
    const full = `${treeRel}${rel}`;
    if (filter.skip(full)) continue;
    const src = overlay?.get(`${prefix}${rel}`) ?? join(srcDir, rel);
    const desired = fromSource(src, settings);
    const content = filter.transform(full, desired.content);
    put(actions, join(destDir, rel), content === desired.content ? desired : { content, mode: desired.mode });
  }
}

function userJsonAction(actions: Action[], piDir: string, settings: Settings): void {
  const path = join(piDir, "user.json");
  const existing = readSettings(path);
  const merged = mergeUserJson(existing, settings);
  if (existsSync(path) && deepEqual(existing, merged)) return;
  const jsonOps: JsonOp[] = [];
  for (const key of ["githubUser", "reposRoot"]) {
    if (key in existing && deepEqual(existing[key], merged[key])) continue;
    jsonOps.push({ op: "set", key, before: key in existing ? { present: true, value: existing[key] } : { present: false }, after: merged[key] });
  }
  actions.push({
    op: "install", path, existed: existsSync(path), mode: 0o644, merge: "user-json", jsonOps,
    content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`),
  });
}

function agentsMd(input: PlanInput, live: string): Desired & { noMarkers: boolean } {
  const base = fromSource(join(input.repoDir, "agent", "AGENTS.md"), input.settings);
  const off = ["cratis", "codescene"].filter((id) => input.components?.[id] === false);
  if (off.length) {
    const stripped = stripSections(base.content, off);
    base.content = stripped.content;
    delete base.mtimeMs;
    input.notes?.push(...stripped.warnings);
  }
  const existing = existsSync(live) && statSync(live).isFile() ? readFileSync(live) : undefined;
  const noMarkers = existing !== undefined && !hasRoutingMarkers(existing);
  if (!input.overlay.routing) return { ...base, noMarkers };
  return { content: spliceRouting(base.content, input.overlay.routing, noMarkers ? undefined : existing), mode: base.mode, noMarkers };
}

/**
 * Edit a JSON file pi-setup merges into. `edit` changes a copy of the parsed file and returns the recorded ops;
 * `fresh` means the file is about to be created from the template, so the template itself may be trimmed.
 */
function registerJson(
  actions: Action[], path: string, edit: (data: Record<string, unknown>, fresh: boolean) => JsonOp[],
): void {
  const pending = actions.find((a) => a.op === "install" && a.path === path);
  const content = pending && pending.op === "install" ? pending.content : existsSync(path) ? readFileSync(path) : undefined;
  if (!content) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new SetupError(`${path}: ${(error as Error).message}`);
  }
  const before = structuredClone(data);
  const jsonOps = edit(data, Boolean(pending));
  if (jsonOps.length === 0 && deepEqual(before, data)) return;
  const mode = pending && pending.op === "install" ? pending.mode : statSync(path).mode & 0o7777;
  const next = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  if (pending && pending.op === "install") {
    pending.content = next;
    if (jsonOps.length) actions.push({ op: "register", path, content: next, mode, existed: false, jsonOps });
  } else {
    actions.push({ op: "register", path, content: next, mode, existed: true, jsonOps });
  }
}

/** Add `value` to a list; a template-provided value is still recorded so it can be undone. */
function addPackage(data: Record<string, unknown>, value: string, fresh: boolean, ops: JsonOp[], allow: boolean): void {
  const list = Array.isArray(data.packages) ? (data.packages as unknown[]) : undefined;
  const has = list?.includes(value) ?? false;
  if ((has && !fresh) || (!has && !allow)) return;
  if (!has) data.packages = [...(list ?? []), value];
  ops.push({ op: "array-add", key: "packages", value, keyCreated: !list });
}

function settingsEdit(web: boolean | undefined, activate: boolean, drop: string[]): (data: Record<string, unknown>, fresh: boolean) => JsonOp[] {
  return (data, fresh) => {
    const ops: JsonOp[] = [];
    if (fresh && web !== true && Array.isArray(data.packages)) {
      if (web === false) data.packages = (data.packages as unknown[]).filter((p) => !WEB_PACKAGES.includes(p as string));
    }
    if (web === false && drop.length && Array.isArray(data.packages)) data.packages = (data.packages as unknown[]).filter((p) => !drop.includes(p as string));
    // the first package pi-setup adds to a fresh template is not template-provided, the rest are
    addPackage(data, PACKAGE, false, ops, true);
    if (web === true) for (const p of WEB_PACKAGES) addPackage(data, p, fresh, ops, fresh || activate);
    return ops;
  };
}

function mcpEdit(codescene: boolean | undefined, activate: boolean, which: (name: string) => string | undefined): (data: Record<string, unknown>, fresh: boolean) => JsonOp[] {
  return (data, fresh) => {
    const servers = (typeof data.mcpServers === "object" && data.mcpServers !== null && !Array.isArray(data.mcpServers) ? data.mcpServers : undefined) as Record<string, unknown> | undefined;
    const has = Boolean(servers && "codescene" in servers);
    if (codescene !== true) {
      if (fresh && codescene === false && servers) delete servers.codescene;
      return [];
    }
    if ((has && !fresh) || (!has && !fresh && !activate)) return [];
    const stripped = { ...servers };
    delete stripped.codescene;
    const entry = { command: which("cs-mcp") ?? "cs-mcp", args: [], lifecycle: "lazy-keep-alive" };
    data.mcpServers = { ...stripped, codescene: entry };
    return [{ op: "set", key: "mcpServers", before: servers ? { present: true, value: stripped } : { present: false }, after: data.mcpServers }];
  };
}

function linkIfFree(actions: Action[], notes: string[] | undefined, path: string, target: string, home: string): void {
  if (!lstatExists(path)) { actions.push({ op: "symlink", path, target }); return; }
  const link = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  if (link === target) return;
  const shown = (p: string) => p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
  notes?.push(`left ${shown(path)}: ${link === undefined ? "a file" : `a link to ${shown(link)}`}; pi-setup does not replace it`);
}

export function buildPlan(input: PlanInput): Action[] {
  const { repoDir, home, settings, overlay } = input;
  const cratis = input.components?.cratis !== false;
  const filter: Filter = cratis ? NO_FILTER : {
    skip: isCratisFile,
    transform: (rel, content) => (/(^|\/)agents\/[^/]+\.md$/.test(rel) ? dropGuardExtension(content) : content),
  };
  const agent = join(repoDir, "agent");
  const piDir = join(home, ".pi", "agent");
  const actions: Action[] = [];
  userJsonAction(actions, piDir, settings);
  for (const tree of TREES) {
    const useOverlay = tree === "agents" || tree === "workflows";
    putTree(actions, join(agent, tree), join(piDir, tree), settings, useOverlay ? overlay.sources : undefined, useOverlay ? `${tree}/` : "", filter, `${tree}/`);
  }
  putTree(actions, join(agent, "local-packages/pi-questions"), join(piDir, "local-packages/pi-questions"), settings);
  actions.push({ op: "chmod-x", path: join(piDir, "local-packages/pi-questions/dist/cli.js") });
  const agentsPath = join(piDir, "AGENTS.md");
  const { noMarkers, ...agentsDesired } = agentsMd(input, agentsPath);
  put(actions, agentsPath, agentsDesired);
  const last = actions[actions.length - 1];
  if (noMarkers && last.op === "install") last.noMarkers = true;
  putSource(actions, join(agent, "AGENTS.subagent.md"), join(piDir, "AGENTS.subagent.md"), settings);
  for (const name of ONLY_IF_ABSENT) {
    if (!existsSync(join(piDir, name))) putSource(actions, join(agent, name), join(piDir, name), settings);
  }
  registerJson(actions, join(piDir, "settings.json"), settingsEdit(input.components?.web, Boolean(input.activate?.includes("web")), input.drop ?? []));
  registerJson(actions, join(piDir, "mcp-adapter.json"), mcpEdit(input.components?.codescene, Boolean(input.activate?.includes("codescene")), input.which ?? (() => undefined)));
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
  if (input.components?.lanes === true) {
    const lanesDir = join(home, ".local/share/pi-setup/lanes");
    const preapproveMcp = preapprovalDefault(join(lanesDir, "templates")) || input.preapproveMcp === true;
    put(actions, join(lanesDir, "defaults.json"), { content: Buffer.from(`${JSON.stringify({ launch: { preapproveMcp } }, null, 2)}\n`), mode: 0o644 });
    putSource(actions, join(repoDir, "installer/dist/lanes.mjs"), join(lanesDir, "lanes.mjs"), settings);
    putTree(actions, join(repoDir, "installer/lanes/templates"), join(lanesDir, "templates"), settings);
    linkIfFree(actions, input.notes, join(home, ".local/bin/lanes"), join(lanesDir, "lanes.mjs"), home);
  }
  for (const [pkg, cmd] of [["pi-context-budget", "pi-session"], ["pi-orch", "orch"]]) {
    const target = join(piDir, "npm/node_modules/@woksin", pkg, "bin", cmd);
    if (existsSync(target)) linkIfFree(actions, input.notes, join(home, ".local/bin", cmd), target, home);
  }
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
