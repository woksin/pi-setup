import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { validId } from "./names.ts";

export const BACKENDS = ["auto", "terminal-app", "iterm", "tmux", "print"];
export interface Lane {
  id: string; repo: string; issue?: number; goal?: string; group: string | null;
  role?: "lane" | "repo-orch" | "sub-orch"; parent?: string; retired?: boolean; stateFile?: string;
  worktree: string; branch: string; prompt: string; [key: string]: unknown;
}
export interface Retention {
  mode: "keep" | "archive" | "delete"; maxAgeDays: number; archiveDir?: string;
  archiveMaxAgeDays: number | null; keepUnread: boolean; auto: boolean;
}
export interface Config {
  version: number; reposRoot: string; worktreesDir: string; baseBranch: string; repos: Record<string, string>;
  coordinator: { id: string; cwd: string; prompt: string; maxRunning: number; [key: string]: unknown };
  messages: { dir: string; broadcast: string; retention?: Retention; [key: string]: unknown };
  terminal: { backend: string; [key: string]: unknown };
  launch: { wrapper: string; preapproveMcp: boolean; unsetEnv: string[]; [key: string]: unknown };
  idle?: { minutes: number };
  github?: { repos: string[]; author: string; excludeLabels: string[] };
  lanes: Lane[]; [key: string]: unknown;
}
export class UsageError extends Error {}
export function defaults(root: string, home: string, reposRoot?: string): Config {
  if (!reposRoot) {
    try { reposRoot = JSON.parse(readFileSync(join(home, ".pi/agent/user.json"), "utf8")).reposRoot; } catch { /* optional */ }
  }
  return {
    idle: { minutes: 75 }, github: { repos: [], author: "@me", excludeLabels: [] },
    version: 1, reposRoot: reposRoot || dirname(root), worktreesDir: "${reposRoot}/.worktrees", baseBranch: "origin/main", repos: {},
    coordinator: { id: "L0", cwd: "${root}", prompt: "prompts/coordinator.md", maxRunning: 8 },
    messages: { dir: "messages", broadcast: "ALL", retention: { mode: "archive", maxAgeDays: 14, archiveDir: "archive", archiveMaxAgeDays: null, keepUnread: true, auto: true } }, terminal: { backend: "auto" },
    launch: { wrapper: "pi-session", preapproveMcp: false, unsetEnv: ["PI_MCP_CONFIG_MODE"] }, lanes: [],
  };
}
/** Installed defaults apply only when creating a new coordination folder. */
export function preapprovalDefault(templatesDir: string): boolean {
  const path = join(dirname(templatesDir), "defaults.json");
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  try {
    const value = JSON.parse(text);
    if (typeof value?.launch?.preapproveMcp !== "boolean") throw new Error("invalid launch.preapproveMcp");
    return value.launch.preapproveMcp;
  } catch (e) { throw new UsageError(`invalid lanes defaults: ${(e as Error).message}`); }
}

export function validate(value: unknown, root = process.cwd(), home = homedir()): asserts value is Config {
  const c = value as Config;
  const require = (ok: unknown, key: string) => { if (!ok) throw new UsageError(`invalid ${key}`); };
  const text = (v: unknown) => typeof v === "string" && v.length > 0;
  require(c && typeof c === "object", "config");
  require(c.version === 1, "version (expected 1)");
  for (const key of ["reposRoot", "worktreesDir", "baseBranch"] as const) require(text(c[key]), key);
  require(c.repos && typeof c.repos === "object" && !Array.isArray(c.repos) && Object.values(c.repos).every(text), "repos");
  require(c.messages && text(c.messages.dir), "messages.dir");
  require(c.messages && typeof c.messages.broadcast === "string" && validId(c.messages.broadcast), "messages.broadcast");
  if (c.messages.retention !== undefined) {
    const r = c.messages.retention;
    require(r && typeof r === "object" && !Array.isArray(r), "messages.retention");
    require(["keep", "archive", "delete"].includes(r.mode), "messages.retention.mode");
    require(Number.isInteger(r.maxAgeDays) && r.maxAgeDays >= 1, "messages.retention.maxAgeDays");
    require(r.archiveDir === undefined || text(r.archiveDir), "messages.retention.archiveDir");
    require(r.archiveMaxAgeDays === null || (Number.isInteger(r.archiveMaxAgeDays) && r.archiveMaxAgeDays >= 1), "messages.retention.archiveMaxAgeDays");
    require(typeof r.keepUnread === "boolean", "messages.retention.keepUnread");
    require(typeof r.auto === "boolean", "messages.retention.auto");
    archiveDir(c, root, home);
  }
  require(c.coordinator && typeof c.coordinator.id === "string" && validId(c.coordinator.id) && !["ALL", c.messages.broadcast].includes(c.coordinator.id), "coordinator.id");
  require(text(c.coordinator.cwd), "coordinator.cwd"); require(text(c.coordinator.prompt), "coordinator.prompt");
  require(Number.isInteger(c.coordinator.maxRunning) && c.coordinator.maxRunning > 0, "coordinator.maxRunning");
  require(c.terminal && BACKENDS.includes(c.terminal.backend), "terminal.backend");
  require(c.launch && text(c.launch.wrapper), "launch.wrapper");
  require(typeof c.launch.preapproveMcp === "boolean", "launch.preapproveMcp");
  require(Array.isArray(c.launch.unsetEnv) && c.launch.unsetEnv.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)), "launch.unsetEnv");
  if (c.idle !== undefined) require(c.idle && Number.isInteger(c.idle.minutes) && c.idle.minutes > 0, "idle.minutes");
  if (c.github !== undefined) {
    require(c.github && Array.isArray(c.github.repos) && c.github.repos.every((r) => typeof r === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)), "github.repos");
    require(typeof c.github.author === "string" && /^@?[A-Za-z0-9-]+$/.test(c.github.author), "github.author");
    require(Array.isArray(c.github.excludeLabels) && c.github.excludeLabels.every(text), "github.excludeLabels");
  }
  require(Array.isArray(c.lanes), "lanes");
  const ids = new Set([c.coordinator.id, "ALL", c.messages.broadcast]);
  for (const [i, lane] of c.lanes.entries()) {
    const key = `lanes.${i}`;
    require(lane && typeof lane.id === "string" && validId(lane.id) && !ids.has(lane.id), `${key}.id`); ids.add(lane.id);
    require(typeof lane.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lane.repo), `${key}.repo`);
    for (const k of ["branch", "prompt"] as const) require(text(lane[k]), `${key}.${k}`);
    require(text(lane.worktree) && !/[\\/]/.test(lane.worktree) && ![".", ".."].includes(lane.worktree), `${key}.worktree`);
    require(lane.group === null || (typeof lane.group === "string" && validId(lane.group) && !["ALL", c.messages.broadcast].includes(lane.group)), `${key}.group`);
    require(lane.issue === undefined || (Number.isInteger(lane.issue) && lane.issue > 0), `${key}.issue`);
    require(lane.goal === undefined || text(lane.goal), `${key}.goal`);
    require(lane.role === undefined || ["lane", "repo-orch", "sub-orch"].includes(lane.role), `${key}.role`);
    require(lane.retired === undefined || typeof lane.retired === "boolean", `${key}.retired`);
    require(lane.stateFile === undefined || text(lane.stateFile), `${key}.stateFile`);
    require(lane.parent === undefined || lane.parent === c.coordinator.id || c.lanes.some(l => l.id === lane.parent && !l.retired), `${key}.parent`);
    require(lane.role !== "repo-orch" || lane.parent === undefined || lane.parent === c.coordinator.id, `${key}.parent`);
  }
  const active = c.lanes.filter(l => !l.retired);
  require(new Set(active.map(l => l.worktree)).size === active.length, "duplicate worktree");
  const orchs = active.filter(l => l.role === "repo-orch");
  require(new Set(orchs.map(l => l.repo)).size === orchs.length, "duplicate repo-orch");
  for (const lane of active) {
    const seen = new Set([lane.id]); let parent = effectiveParent(lane, c);
    while (parent !== c.coordinator.id) {
      require(!seen.has(parent), "parent cycle"); seen.add(parent);
      const next = c.lanes.find(l => l.id === parent);
      require(next, "parent"); parent = effectiveParent(next!, c);
    }
  }
}
export function expand(value: string, c: Config, root: string, home: string, base = root): string {
  let out = value;
  for (let n = 0; n < 8; n++) {
    const next = out.replace(/\$\{(root|reposRoot|worktreesDir)\}/g, (_, key) => key === "root" ? root : c[key]);
    if (next === out) break;
    out = next;
  }
  if (/\$\{/.test(out)) throw new UsageError(`invalid path expansion: ${value}`);
  if (out === "~" || out.startsWith("~/")) out = join(home, out.slice(2));
  return isAbsolute(out) ? resolve(out) : resolve(base, out);
}
function physicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(physicalPath(parent), basename(path));
}
function archiveBelow(dir: string, destination: string): boolean {
  const path = relative(dir, destination);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) && path.split(sep)[0] !== "status";
}
export function archiveDir(c: Config, root: string, home: string): string {
  try {
    const value = c.messages.retention?.archiveDir ?? "archive";
    const dir = expand(c.messages.dir, c, root, home);
    const destination = expand(value, c, root, home, dir);
    if (value.split(/[\\/]/).includes("..") || !archiveBelow(dir, destination) || !archiveBelow(physicalPath(dir), physicalPath(destination))) {
      throw new Error("must be below messages.dir and outside status/");
    }
    return destination;
  } catch (e) { throw new UsageError(`invalid messages.retention.archiveDir: ${(e as Error).message}`); }
}
export function findRoot(dir: string | undefined, env: Record<string, string | undefined>, cwd: string): string {
  if (dir || env.LANES_DIR) return resolve(cwd, dir || env.LANES_DIR!);
  let at = resolve(cwd);
  while (!existsSync(join(at, "lanes.json"))) {
    const parent = dirname(at);
    if (parent === at) throw new UsageError("lanes.json not found; run lanes init or set --dir");
    at = parent;
  }
  return at;
}
export function loadConfig(root: string): Config {
  let c: unknown;
  try { c = JSON.parse(readFileSync(join(root, "lanes.json"), "utf8")); }
  catch (e) { throw new UsageError(`invalid lanes.json: ${(e as Error).message}`); }
  validate(c, root); return c;
}
export function saveConfig(root: string, c: Config): void {
  validate(c, root);
  const tmp = join(root, `.lanes-${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { flag: "wx" });
  renameSync(tmp, join(root, "lanes.json"));
}

export function effectiveParent(lane: Lane, c: Config): string {
  return lane.parent ?? (lane.role === "repo-orch" ? c.coordinator.id : c.lanes.find(l => !l.retired && l.role === "repo-orch" && l.repo === lane.repo)?.id ?? c.coordinator.id);
}
export function laneTree(c: Config, all = false): { lane: Lane; depth: number }[] {
  const lanes = c.lanes.filter(l => all || !l.retired); const rows: { lane: Lane; depth: number }[] = [];
  const visit = (parent: string, depth: number) => { for (const lane of lanes.filter(l => effectiveParent(l, c) === parent)) { rows.push({ lane, depth }); visit(lane.id, depth + 1); } };
  visit(c.coordinator.id, 0); return rows;
}
