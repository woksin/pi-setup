#!/usr/bin/env node
// pi-setup-source-sha256: d420c3fe3cc62796fa948abc055004fc946d587c104eca8ee47b4df881186d42

// src/lanes/cli.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { realpathSync as realpathSync3 } from "node:fs";

// src/lanes/ctx.ts
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as join2, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/context.ts
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
var MAX_BUFFER = 16 * 1024 * 1024;
function inherited(cmd, args, options) {
  return new Promise((resolve10) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (error) => resolve10({ code: null, stdout: "", stderr: error.message, timedOut: false }));
    child.on("close", (code) => resolve10({ code, stdout: "", stderr: "", timedOut: false }));
  });
}
var realRun = (cmd, args, options = {}) => {
  if (options.inherit) return inherited(cmd, args, options);
  return new Promise((resolve10) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error;
        const code = failure ? typeof failure.code === "number" ? failure.code : null : 0;
        resolve10({
          code,
          stdout: String(stdout ?? ""),
          stderr: failure && code === null && !stderr ? failure.message : String(stderr ?? ""),
          timedOut: Boolean(failure?.killed)
        });
      }
    );
    child.stdin?.end();
  });
};
function realWhich(env) {
  return (name) => {
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
      }
    }
    return void 0;
  };
}

// src/lanes/ctx.ts
function realLanesCtx() {
  const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const home = homedir();
  return {
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    env: process.env,
    platform: process.platform,
    home,
    cwd: process.cwd(),
    now: () => /* @__PURE__ */ new Date(),
    run: realRun,
    which: realWhich(process.env),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    stdinTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => {
      let text = "";
      for await (const chunk2 of process.stdin) text += chunk2;
      return text;
    },
    templatesDir: [process.env.LANES_TEMPLATES, join2(dir, "templates"), join2(dir, "../lanes/templates")].find((p) => p && existsSync(p)) || join2(dir, "templates"),
    piAgentDir: process.env.PI_CODING_AGENT_DIR || join2(home, ".pi/agent"),
    loadModule: (p) => import(pathToFileURL(resolve(p)).href),
    realpath: realpathSync
  };
}

// src/lanes/commands/handoff.ts
import { join as join13, relative as relative3 } from "node:path";

// src/lanes/config.ts
import { existsSync as existsSync2, readFileSync, realpathSync as realpathSync2, renameSync, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, isAbsolute, join as join4, relative, resolve as resolve3, sep } from "node:path";
import { homedir as homedir2 } from "node:os";
import { randomUUID } from "node:crypto";

// src/lanes/names.ts
import { join as join3, resolve as resolve2 } from "node:path";
var ID = "[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*";
var validId = (s) => s.length <= 16 && new RegExp(`^${ID}$`).test(s);
var validTopic = (s) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);
var slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "") || "task";
function messageName(from, to, topic, at, collision = 1) {
  const hhmm = `${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
  return `${from}-to-${to}-${topic}-${hhmm}${collision > 1 ? `-${collision}` : ""}.md`;
}
function parseMessageName(name) {
  const hasTimestamp = /^\d{8}-\d{6}-/.test(name);
  name = name.replace(/^\d{8}-\d{6}-/, "");
  const timestamped = new RegExp(`^(${ID})-to-(${ID})-([a-z0-9][a-z0-9-]*)\\.md$`).exec(name);
  const match = new RegExp(`^(${ID})-to-(${ID})-([a-z0-9][a-z0-9-]*?)-[0-9]{4}(?:-[0-9]+)?\\.md$`).exec(name);
  if (match) return { from: match[1], to: [match[2]], topic: match[3] };
  if (hasTimestamp && timestamped) return { from: timestamped[1], to: [timestamped[2]], topic: timestamped[3] };
  const legacy = new RegExp(`^(${ID})-from-(${ID})-([a-z0-9].*)\\.md$`).exec(name);
  if (legacy) return { from: legacy[2], to: [legacy[1]], topic: legacy[3] };
  const prefix = new RegExp(`^(${ID})-([a-z0-9].*)\\.md$`).exec(name);
  if (prefix) return { from: "", to: [prefix[1]], topic: prefix[2] };
  return void 0;
}
function sessionDirFor(cwd, piAgentDir) {
  return join3(piAgentDir, "sessions", `--${resolve2(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

// src/lanes/config.ts
var BACKENDS = ["auto", "terminal-app", "iterm", "tmux", "print"];
var UsageError = class extends Error {
};
function defaults(root, home, reposRoot) {
  if (!reposRoot) {
    try {
      reposRoot = JSON.parse(readFileSync(join4(home, ".pi/agent/user.json"), "utf8")).reposRoot;
    } catch {
    }
  }
  return {
    idle: { minutes: 75 },
    github: { repos: [], author: "@me", excludeLabels: [] },
    version: 1,
    reposRoot: reposRoot || dirname2(root),
    worktreesDir: "${reposRoot}/.worktrees",
    baseBranch: "origin/main",
    repos: {},
    coordinator: { id: "L0", cwd: "${root}", prompt: "prompts/coordinator.md", maxRunning: 8 },
    messages: { dir: "messages", broadcast: "ALL", retention: { mode: "archive", maxAgeDays: 14, archiveDir: "archive", archiveMaxAgeDays: null, keepUnread: true, auto: true } },
    terminal: { backend: "auto" },
    launch: { wrapper: "pi-session", preapproveMcp: false, unsetEnv: ["PI_MCP_CONFIG_MODE"] },
    lanes: []
  };
}
function preapprovalDefault(templatesDir) {
  const path = join4(dirname2(templatesDir), "defaults.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  try {
    const value = JSON.parse(text);
    if (typeof value?.launch?.preapproveMcp !== "boolean") throw new Error("invalid launch.preapproveMcp");
    return value.launch.preapproveMcp;
  } catch (e) {
    throw new UsageError(`invalid lanes defaults: ${e.message}`);
  }
}
function validate(value, root = process.cwd(), home = homedir2()) {
  const c = value;
  const require2 = (ok, key) => {
    if (!ok) throw new UsageError(`invalid ${key}`);
  };
  const text = (v) => typeof v === "string" && v.length > 0;
  require2(c && typeof c === "object", "config");
  require2(c.version === 1, "version (expected 1)");
  for (const key of ["reposRoot", "worktreesDir", "baseBranch"]) require2(text(c[key]), key);
  require2(c.repos && typeof c.repos === "object" && !Array.isArray(c.repos) && Object.values(c.repos).every(text), "repos");
  require2(c.messages && text(c.messages.dir), "messages.dir");
  require2(c.messages && typeof c.messages.broadcast === "string" && validId(c.messages.broadcast), "messages.broadcast");
  if (c.messages.retention !== void 0) {
    const r = c.messages.retention;
    require2(r && typeof r === "object" && !Array.isArray(r), "messages.retention");
    require2(["keep", "archive", "delete"].includes(r.mode), "messages.retention.mode");
    require2(Number.isInteger(r.maxAgeDays) && r.maxAgeDays >= 1, "messages.retention.maxAgeDays");
    require2(r.archiveDir === void 0 || text(r.archiveDir), "messages.retention.archiveDir");
    require2(r.archiveMaxAgeDays === null || Number.isInteger(r.archiveMaxAgeDays) && r.archiveMaxAgeDays >= 1, "messages.retention.archiveMaxAgeDays");
    require2(typeof r.keepUnread === "boolean", "messages.retention.keepUnread");
    require2(typeof r.auto === "boolean", "messages.retention.auto");
    archiveDir(c, root, home);
  }
  require2(c.coordinator && typeof c.coordinator.id === "string" && validId(c.coordinator.id) && !["ALL", c.messages.broadcast].includes(c.coordinator.id), "coordinator.id");
  require2(text(c.coordinator.cwd), "coordinator.cwd");
  require2(text(c.coordinator.prompt), "coordinator.prompt");
  require2(Number.isInteger(c.coordinator.maxRunning) && c.coordinator.maxRunning > 0, "coordinator.maxRunning");
  require2(c.terminal && BACKENDS.includes(c.terminal.backend), "terminal.backend");
  require2(c.launch && text(c.launch.wrapper), "launch.wrapper");
  require2(typeof c.launch.preapproveMcp === "boolean", "launch.preapproveMcp");
  require2(Array.isArray(c.launch.unsetEnv) && c.launch.unsetEnv.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)), "launch.unsetEnv");
  if (c.idle !== void 0) require2(c.idle && Number.isInteger(c.idle.minutes) && c.idle.minutes > 0, "idle.minutes");
  if (c.github !== void 0) {
    require2(c.github && Array.isArray(c.github.repos) && c.github.repos.every((r) => typeof r === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)), "github.repos");
    require2(typeof c.github.author === "string" && /^@?[A-Za-z0-9-]+$/.test(c.github.author), "github.author");
    require2(Array.isArray(c.github.excludeLabels) && c.github.excludeLabels.every(text), "github.excludeLabels");
  }
  require2(Array.isArray(c.lanes), "lanes");
  const ids = /* @__PURE__ */ new Set([c.coordinator.id, "ALL", c.messages.broadcast]);
  for (const [i, lane] of c.lanes.entries()) {
    const key = `lanes.${i}`;
    require2(lane && typeof lane.id === "string" && validId(lane.id) && !ids.has(lane.id), `${key}.id`);
    ids.add(lane.id);
    require2(typeof lane.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lane.repo), `${key}.repo`);
    for (const k of ["branch", "prompt"]) require2(text(lane[k]), `${key}.${k}`);
    require2(text(lane.worktree) && !/[\\/]/.test(lane.worktree) && ![".", ".."].includes(lane.worktree), `${key}.worktree`);
    require2(lane.group === null || typeof lane.group === "string" && validId(lane.group) && !["ALL", c.messages.broadcast].includes(lane.group), `${key}.group`);
    require2(lane.issue === void 0 || Number.isInteger(lane.issue) && lane.issue > 0, `${key}.issue`);
    require2(lane.goal === void 0 || text(lane.goal), `${key}.goal`);
    validateHierarchyFields(lane, c, key);
  }
  validateHierarchy(c);
}
function requireField(ok, key) {
  if (!ok) throw new UsageError(`invalid ${key}`);
}
function validParent(lane, c) {
  if (lane.parent === void 0 || lane.parent === c.coordinator.id) return true;
  return c.lanes.some((parent) => parent.id === lane.parent && (lane.retired || !parent.retired));
}
function validOrchestratorParent(lane, c) {
  if (lane.role !== "repo-orch") return true;
  return lane.parent === void 0 || lane.parent === c.coordinator.id;
}
function validateHierarchyFields(lane, c, key) {
  requireField(lane.role === void 0 || ["lane", "repo-orch", "sub-orch"].includes(lane.role), `${key}.role`);
  requireField(lane.retired === void 0 || typeof lane.retired === "boolean", `${key}.retired`);
  requireField(validStateFile(lane.stateFile), `${key}.stateFile`);
  requireField(validParent(lane, c), `${key}.parent`);
  requireField(validOrchestratorParent(lane, c), `${key}.parent`);
}
function validStateFile(value) {
  return value === void 0 || typeof value === "string" && value.length > 0;
}
function validateHierarchy(c) {
  const active = c.lanes.filter((l) => !l.retired);
  requireField(new Set(active.map((l) => l.worktree)).size === active.length, "duplicate worktree");
  const orchs = active.filter((l) => l.role === "repo-orch");
  requireField(new Set(orchs.map((l) => l.repo)).size === orchs.length, "duplicate repo-orch");
  for (const lane of active) validateParentChain(lane, c);
}
function validateParentChain(lane, c) {
  const seen = /* @__PURE__ */ new Set([lane.id]);
  let parent = effectiveParent(lane, c);
  while (parent !== c.coordinator.id) {
    requireField(!seen.has(parent), "parent cycle");
    seen.add(parent);
    const next = c.lanes.find((l) => l.id === parent);
    requireField(next, "parent");
    parent = effectiveParent(next, c);
  }
}
function expand(value, c, root, home, base = root) {
  let out = value;
  for (let n = 0; n < 8; n++) {
    const next = out.replace(/\$\{(root|reposRoot|worktreesDir)\}/g, (_, key) => key === "root" ? root : c[key]);
    if (next === out) break;
    out = next;
  }
  if (/\$\{/.test(out)) throw new UsageError(`invalid path expansion: ${value}`);
  if (out === "~" || out.startsWith("~/")) out = join4(home, out.slice(2));
  return isAbsolute(out) ? resolve3(out) : resolve3(base, out);
}
function physicalPath(path) {
  if (existsSync2(path)) return realpathSync2(path);
  const parent = dirname2(path);
  return parent === path ? path : join4(physicalPath(parent), basename(path));
}
function archiveBelow(dir, destination) {
  const path = relative(dir, destination);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) && path.split(sep)[0] !== "status";
}
function archiveDir(c, root, home) {
  try {
    const value = c.messages.retention?.archiveDir ?? "archive";
    const dir = expand(c.messages.dir, c, root, home);
    const destination = expand(value, c, root, home, dir);
    if (value.split(/[\\/]/).includes("..") || !archiveBelow(dir, destination) || !archiveBelow(physicalPath(dir), physicalPath(destination))) {
      throw new Error("must be below messages.dir and outside status/");
    }
    return destination;
  } catch (e) {
    throw new UsageError(`invalid messages.retention.archiveDir: ${e.message}`);
  }
}
function findRoot(dir, env, cwd) {
  if (dir || env.LANES_DIR) return resolve3(cwd, dir || env.LANES_DIR);
  let at = resolve3(cwd);
  while (!existsSync2(join4(at, "lanes.json"))) {
    const parent = dirname2(at);
    if (parent === at) throw new UsageError("lanes.json not found; run lanes init or set --dir");
    at = parent;
  }
  return at;
}
function loadConfig(root) {
  let c;
  try {
    c = JSON.parse(readFileSync(join4(root, "lanes.json"), "utf8"));
  } catch (e) {
    throw new UsageError(`invalid lanes.json: ${e.message}`);
  }
  validate(c, root);
  return c;
}
function saveConfig(root, c) {
  validate(c, root);
  const tmp = join4(root, `.lanes-${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}
`, { flag: "wx" });
  renameSync(tmp, join4(root, "lanes.json"));
}
function effectiveParent(lane, c) {
  return lane.parent ?? (lane.role === "repo-orch" ? c.coordinator.id : c.lanes.find((l) => !l.retired && l.role === "repo-orch" && l.repo === lane.repo)?.id ?? c.coordinator.id);
}
function laneTree(c, all = false) {
  const lanes = c.lanes.filter((l) => all || !l.retired);
  const rows = [];
  const visit = (parent, depth) => {
    for (const lane of lanes.filter((l) => effectiveParent(l, c) === parent)) {
      rows.push({ lane, depth });
      visit(lane.id, depth + 1);
    }
  };
  visit(c.coordinator.id, 0);
  return rows;
}

// src/lanes/reap/files.ts
import { mkdirSync, readFileSync as readFileSync2, readdirSync, renameSync as renameSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import { dirname as dirname3, join as join5 } from "node:path";
function optionalText(path) {
  try {
    return readFileSync2(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw new Error(`cannot read ${path}`);
  }
}
function jsonFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error(`cannot read ${dir}`);
  }
  return names.filter((n) => n.endsWith(".json")).map((n) => {
    try {
      const value = JSON.parse(readFileSync2(join5(dir, n), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error(`cannot read ${join5(dir, n)}`);
    }
  });
}
function mtime(path) {
  return statSync2(path).mtimeMs;
}
function atomicJson(path, value) {
  mkdirSync(dirname3(path), { recursive: true });
  const tmp = `${path}.${randomUUID2()}.tmp`;
  writeFileSync2(tmp, `${JSON.stringify(value, null, 2)}
`, { flag: "wx" });
  renameSync2(tmp, path);
}

// src/lanes/reap/signals.ts
import { join as join10 } from "node:path";

// src/lanes/reap/tree.ts
import { createHash } from "node:crypto";
import { lstatSync, readFileSync as readFileSync3, readlinkSync } from "node:fs";
import { isAbsolute as isAbsolute2, relative as relative2, resolve as resolve4 } from "node:path";
function changedPaths(status2) {
  const records = status2.split("\0");
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (!/^[ MADRCU?!]{2} /.test(record)) throw new Error("git status paths unknown");
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) paths.push(renameSource(records[++i]));
  }
  return [...new Set(paths)].sort();
}
function renameSource(path) {
  if (!path) throw new Error("git rename source unknown");
  return path;
}
function below(cwd, path) {
  const full = resolve4(cwd, path);
  const rel = relative2(cwd, full);
  if (!rel) throw new Error("git path outside worktree");
  if (rel.startsWith("..") || isAbsolute2(rel)) throw new Error("git path outside worktree");
  return full;
}
function contents(path) {
  let stat2;
  try {
    stat2 = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT") return "<missing>";
    throw e;
  }
  if (stat2.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
  if (!stat2.isFile()) throw new Error("dirty directory/submodule contents unknown");
  return Buffer.concat([Buffer.from(`mode:${stat2.mode}:`), readFileSync3(path)]);
}
function treeDigest(input) {
  const hash = createHash("sha256").update(input.status).update(input.diff);
  for (const path of input.paths) hash.update(JSON.stringify(path)).update(contents(below(input.cwd, path)));
  return hash.digest("hex");
}
function commitList(text) {
  const commits = text.trim().split(/\s+/).filter(Boolean);
  if (!commits.every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error("unpushed commits unknown");
  return commits;
}

// src/lanes/reap/git.ts
function succeeded(probe) {
  return !probe.code && !probe.timedOut;
}
function validHead(head) {
  return succeeded(head) && /^[a-f0-9]{40,64}$/.test(head.stdout.trim());
}
function mergedAtHead(prs, head) {
  if (!succeeded(prs)) return void 0;
  try {
    const rows = JSON.parse(prs.stdout);
    if (Array.isArray(rows)) return rows.some((p) => p.headRefOid === head);
  } catch {
  }
  return void 0;
}
async function gitEvidence(ctx, lane, cwd) {
  const run = (args) => ctx.run("git", ["--no-optional-locks", "-C", cwd, ...args], { timeoutMs: 4e3 });
  const head = await run(["rev-parse", "HEAD"]);
  const status2 = await run(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (!validHead(head) || !succeeded(status2)) return { error: "git HEAD/status unknown" };
  const ahead = await run(["rev-list", "HEAD", "--not", "--remotes"]);
  const diff = await run(["diff", "--binary", "HEAD"]);
  if (!succeeded(ahead) || !succeeded(diff)) return { error: "git unpushed/tree evidence unknown" };
  const unpushed = commitList(ahead.stdout);
  const paths = changedPaths(status2.stdout);
  const digest = treeDigest({ cwd, paths, status: status2.stdout, diff: diff.stdout });
  const prs = await ctx.run("gh", [
    "pr",
    "list",
    "--repo",
    lane.repo,
    "--head",
    lane.branch,
    "--state",
    "merged",
    "--json",
    "headRefOid"
  ], { cwd, timeoutMs: 5e3 });
  return {
    head: head.stdout.trim(),
    dirty: Boolean(status2.stdout.trim()),
    merged: mergedAtHead(prs, head.stdout.trim()),
    ahead: unpushed.length,
    status: status2.stdout,
    paths,
    unpushed,
    digest
  };
}

// src/lanes/reap/process.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join6, normalize } from "node:path";
function absolute(ctx, path) {
  return normalize(ctx.realpath(path));
}
function requireProbe(result, message) {
  if (result.code !== 0 || result.timedOut) throw new Error(message);
}
async function processCwd(ctx, pid) {
  if (ctx.readCwd) return canonicalCwd(ctx, await ctx.readCwd(pid));
  const token = String(pid);
  const probe = ctx.platform === "darwin" ? await ctx.run("lsof", ["-a", "-p", token, "-d", "cwd", "-Fn"], { timeoutMs: 4e3 }) : await ctx.run("readlink", [`/proc/${token}/cwd`], { timeoutMs: 4e3 });
  requireProbe(probe, "pi cwd unknown");
  const cwd = ctx.platform === "darwin" ? probe.stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1) : probe.stdout.trim();
  return canonicalCwd(ctx, cwd);
}
async function processIds(ctx, cwd) {
  const probe = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 4e3 });
  if (probe.timedOut || ![0, 1].includes(probe.code)) throw new Error("pi process list unknown");
  const tokens = probe.stdout.trim().split(/\s+/).filter(Boolean);
  const ids = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) throw new Error("pi process list malformed");
    const pid = Number(token);
    if (await processCwd(ctx, pid) === cwd) ids.push(pid);
  }
  return ids;
}
async function busyChildren(s, ctx) {
  const ps = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 4e3 });
  requireProbe(ps, "process descendants unknown");
  const rows = ps.stdout.split("\n").map((line) => /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())).filter(Boolean);
  const owned = /* @__PURE__ */ new Set([s.pid]);
  const addChild = (row) => {
    if (!owned.has(Number(row[2])) || owned.has(Number(row[1]))) return false;
    owned.add(Number(row[1]));
    return true;
  };
  let changed = true;
  while (changed) {
    changed = rows.map(addChild).some(Boolean);
  }
  if (owned.size > 1) s.keeps.push("busy child process");
}
async function openJobs(s, ctx) {
  const files = await ctx.run("lsof", ["-p", String(s.pid), "-Fn"], { timeoutMs: 4e3 });
  requireProbe(files, "open files unknown");
  const jobs = files.stdout.split("\n").filter((l) => l.startsWith("n" + join6(ctx.piAgentDir, "jobs") + "/"));
  for (const path of jobs) {
    readFileSync4(path.slice(1), "utf8");
    s.keeps.push("job/watch running (log open)");
  }
}
async function foreground(s, ctx) {
  const tty = await ctx.run("ps", ["-o", "tty=", "-p", String(s.pid)], { timeoutMs: 4e3 });
  requireProbe(tty, "TTY unknown");
  s.tty = tty.stdout.trim();
  if (!/^[A-Za-z0-9/]+$/.test(s.tty)) throw new Error("foreground not the expected pi (no TTY)");
  const fg = await ctx.run("ps", ["-t", s.tty, "-o", "pid=,stat=,command="], { timeoutMs: 4e3 });
  requireProbe(fg, "foreground unknown");
  const rows = fg.stdout.split("\n").filter((l) => /^\s*\d+\s+\S*\+/.test(l));
  const expected = new RegExp(`^\\s*${s.pid}\\s+\\S*\\+\\s+(?:\\S*/)?pi(?:\\s|$)`);
  if (rows.length !== 1 || !expected.test(rows[0])) throw new Error("foreground not the expected pi");
}
async function processEvidence(s, ctx) {
  await busyChildren(s, ctx);
  await openJobs(s, ctx);
  const start2 = await ctx.run("ps", ["-p", String(s.pid), "-o", "lstart="], { timeoutMs: 4e3 });
  requireProbe(start2, "process start unknown");
  s.procStart = start2.stdout.trim();
  if (!s.procStart) throw new Error("process start unknown");
  await foreground(s, ctx);
}
function canonicalCwd(ctx, cwd) {
  if (!cwd) throw new Error("pi cwd unknown");
  return absolute(ctx, cwd);
}

// src/lanes/reap/session.ts
import { readdirSync as readdirSync2 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join7 } from "node:path";
function sameProcess(value, s, ctx) {
  if (value.pid !== s.pid) return false;
  return !value.cwd || absolute(ctx, value.cwd) === s.cwd;
}
function leaseFor(s, ctx) {
  const leases = jsonFiles(join7(ctx.piAgentDir, "issue-work/sessions")).filter((l) => l.cwd && sameProcess(l, s, ctx));
  if (!leases.length) return void 0;
  const good = leases.filter((l) => l.procStart === s.procStart);
  if (good.length !== 1) throw new Error("lease/process start mismatch");
  return good[0];
}
function heartbeatFor(s, ctx) {
  const beats = jsonFiles(join7(ctx.home, ".pi/orch/heartbeats")).filter((h) => sameProcess(h, s, ctx));
  if (beats.length > 1) throw new Error("signals disagree: session identity");
  return beats[0];
}
function checkHeartbeat(beat, s, ctx) {
  if (!beat) return;
  const stamp = Date.parse(beat.at ?? beat.updatedAt);
  if (!Number.isFinite(stamp) || ctx.now().getTime() - stamp > 6e5) throw new Error("signals disagree: heartbeat stale");
  if (beat.state !== "working") return;
  if (ctx.now().getTime() - s.lastWrite >= 6e5) throw new Error("signals disagree: heartbeat working versus session write");
  s.keeps.push("heartbeat working");
}
function fileFor(identity, dir) {
  if (identity?.sessionFile) return identity.sessionFile;
  if (!identity?.sessionId) return void 0;
  const names = readdirSync2(dir).filter((n) => n.endsWith(".jsonl") && n.includes(identity.sessionId));
  return names.length === 1 ? join7(dir, names[0]) : void 0;
}
function checkFile(s, dir, ctx) {
  if (!s.sessionId || !s.sessionFile) throw new Error("session file unknown");
  if (!isAbsolute3(s.sessionFile)) throw new Error("session file unknown");
  if (!absolute(ctx, s.sessionFile).startsWith(absolute(ctx, dir) + "/")) throw new Error("session file unknown");
  s.lastWrite = mtime(s.sessionFile);
}
function resolveSession(s, ctx) {
  const dir = sessionDirFor(s.cwd, ctx.piAgentDir);
  try {
    readdirSync2(dir);
  } catch {
    throw new Error("sessions directory unreadable or missing");
  }
  const lease = leaseFor(s, ctx);
  const beat = heartbeatFor(s, ctx);
  checkIdentity(lease, beat);
  const identity = lease || beat;
  s.sessionId = identity?.sessionId;
  s.sessionFile = fileFor(identity, dir);
  checkFile(s, dir, ctx);
  checkHeartbeat(beat, s, ctx);
}
function checkIdentity(lease, beat) {
  if (!lease || !beat?.sessionId) return;
  if (beat.sessionId !== lease.sessionId) throw new Error("signals disagree: session identity");
}

// src/lanes/reap/inbox.ts
import { readdirSync as readdirSync3 } from "node:fs";
import { join as join8 } from "node:path";

// src/lanes/status-line.ts
function parseStatus(line = "") {
  const match = /^(waiting-on|barred-by) "(.*)" until (\S+)$/.exec(line);
  if (match) return { kind: match[1], until: Date.parse(match[3]) };
  if (/^closed\b/.test(line)) return { kind: "closed" };
  return { kind: /^working\b/.test(line) ? "working" : "other" };
}
function suppressed(line, now) {
  const status2 = parseStatus(line);
  return (status2.kind === "waiting-on" || status2.kind === "barred-by") && (status2.until ?? 0) > now.getTime();
}
var clean = (text) => text.replace(/"/g, "'").replace(/\s+/g, " ").trim();
function closedLine(to, reason, now) {
  return `closed${to ? ` reassigned-to ${to}` : ""} at ${now.toISOString()}${reason ? ` reason "${clean(reason)}"` : ""}`;
}

// src/lanes/reap/inbox.ts
function isAddressed(to, ids) {
  return ids.filter(Boolean).some((id) => to.some((recipient2) => recipient2 === id || `-${recipient2}-`.includes(`-${id}-`)));
}
function checkMessage(name, s, options) {
  if (!name.endsWith(".md")) return;
  const message = parseMessageName(name);
  if (!message) {
    s.asks.push(`unparseable message ${name}`);
    return;
  }
  if (message.from === s.id || !isAddressed(message.to, options.ids)) return;
  if (mtime(join8(options.dir, name)) > options.since) s.unread.push(name);
}
function inboxAndStatus(s, env) {
  const { c, root, ctx, lane } = env;
  const dir = expand(c.messages.dir, c, root, ctx.home);
  let since;
  try {
    since = mtime(join8(dir, `${s.id}-inbox.marker`));
  } catch {
    s.asks.push("inbox watch never ran (marker missing/unreadable)");
    return;
  }
  const ids = [s.id, c.messages.broadcast, "ALL", lane.group];
  for (const name of readdirSync3(dir)) checkMessage(name, s, { dir, ids, since });
  if (s.unread.length) s.keeps.push("unread inbox");
  s.status = optionalText(join8(dir, "status", `${s.id}.status`));
  if (suppressed(s.status?.trim(), ctx.now())) s.keeps.push("declared wait until future");
}

// src/lanes/reap/ownership.ts
import { join as join9 } from "node:path";
function registry(text) {
  const folded = /* @__PURE__ */ new Map();
  for (const line of text.split("\n").filter((l) => l.trim())) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      throw new Error("cannot read issue-work registry");
    }
    if (!validEvent(ev)) throw new Error("cannot read issue-work registry");
    const key = `${ev.repo.toLowerCase()}#${ev.issue}`;
    folded.set(key, { ...folded.get(key), ...ev });
  }
  return [...folded.values()];
}
function validEvent(ev) {
  return Boolean(ev?.repo && Number.isInteger(ev.issue) && ev.sessionId && ev.source);
}
function classifyClaim(claim, s) {
  if (claim.sessionId !== s.sessionId || claim.source !== "tool") {
    s.asks.push("claim from another tool or unmapped session");
    return;
  }
  s.claims.push(claim);
  if (activeUnnoted(claim)) {
    s.keeps.push("in-progress claim");
    return;
  }
  if (readyClaim(claim)) return;
  s.asks.push("claim needs named ready/blocked note or completion evidence");
}
function namedNotes(s, env) {
  const pattern = new RegExp(`(^|[^A-Z0-9-])${s.id}([^A-Z0-9-]|$)`);
  for (const name of ["NOW.md", "WATCHES.md"]) if (pattern.test(optionalText(join9(env.root, "coordinator", name)) || "")) s.asks.push(`named in ${name}`);
}
function assigned(task, s) {
  return [s.sessionId, s.id].includes(task.assignee) || task.assignee?.sessionId === s.sessionId;
}
function openTask(task) {
  return ["claimed", "blocked", "ready"].includes(task.state || task.status);
}
function subagentRunning(status2) {
  return status2.role === "subagent" && !["done", "failed", "cancelled", "stopped"].includes(status2.phase || status2.state);
}
function subagentOwned(status2, s) {
  return [status2.pid, status2.parentPid].includes(s.pid) || [status2.sessionId, status2.parentSessionId].includes(s.sessionId);
}
function orchestration(s, env) {
  const { ctx } = env;
  for (const task of jsonFiles(join9(ctx.home, ".pi/orch/tasks"))) if (assigned(task, s) && openTask(task)) s.asks.push("assigned pi-orch task requires handoff");
  const statuses = jsonFiles(join9(ctx.piAgentDir, "context-budget/status")).filter(subagentRunning);
  for (const status2 of statuses) {
    if (subagentOwned(status2, s)) s.keeps.push("subagent running");
    else s.asks.push("subagent ownership unknown");
  }
}
function claimsAndOwnership(s, env) {
  const text = optionalText(join9(env.ctx.piAgentDir, "issue-work/registry.jsonl"));
  const claims = registry(text || "").filter((claim) => claim.repo.toLowerCase() === env.lane.repo.toLowerCase());
  for (const claim of claims) classifyClaim(claim, s);
  namedNotes(s, env);
  orchestration(s, env);
}
function readyClaim(claim) {
  if (["done", "in-review"].includes(claim.state || "")) return true;
  return ["blocked", "planned", "paused", "in-progress"].includes(claim.state || "") && Boolean(claim.note?.trim());
}
function activeUnnoted(claim) {
  return claim.state === "in-progress" && !claim.note?.trim();
}

// src/lanes/reap/signals.ts
function snooze(s, env) {
  const text = optionalText(join10(env.root, ".state/snooze", s.id));
  if (text === void 0) return;
  const until2 = Date.parse(text.trim());
  if (!Number.isFinite(until2)) throw new Error("cannot read snooze");
  if (until2 > env.ctx.now().getTime()) s.keeps.push("snoozed");
}
function idle(s, env) {
  if (env.ctx.now().getTime() - s.lastWrite < env.minutes * 6e4) {
    s.keeps.push(`recent write (< ${env.minutes} minutes)`);
  }
}
async function collect(env) {
  const { c, lane, root, ctx } = env;
  const s = {
    id: lane.id,
    cwd: "",
    asks: [],
    keeps: [],
    finished: false,
    takeover: false,
    pids: [],
    claims: [],
    git: {},
    unread: []
  };
  const protectedReason = callerProtection(env);
  if (protectedReason) {
    s.keeps.push(protectedReason);
    return s;
  }
  try {
    s.cwd = absolute(ctx, join10(expand(c.worktreesDir, c, root, ctx.home), lane.worktree));
    s.pids = await processIds(ctx, s.cwd);
    if (!s.pids.length) {
      s.keeps.push("not running");
      return s;
    }
    if (s.pids.length !== 1) {
      s.asks.push("shared cwd");
      return s;
    }
    s.pid = s.pids[0];
    await processEvidence(s, ctx);
    resolveSession(s, ctx);
    idle(s, env);
    snooze(s, env);
    inboxAndStatus(s, env);
    claimsAndOwnership(s, env);
    s.git = await gitEvidence(ctx, lane, s.cwd);
    if (s.git.error) s.asks.push(s.git.error);
  } catch (e) {
    s.asks.push(e.message);
  }
  return s;
}
function callerProtection({ ctx, lane, c }) {
  const id = ctx.env.PI_ORCH_ID;
  if (lane.id === id) return "caller";
  const caller = c.lanes.find((l) => l.id === id);
  if (caller && effectiveParent(caller, c) === lane.id) return "caller's parent";
  return void 0;
}

// src/lanes/reap/handoff.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join12 } from "node:path";

// src/lanes/backend.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync4, readFileSync as readFileSync5, renameSync as renameSync3, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
import { join as join11 } from "node:path";
function addressed(m, id) {
  return m.to.some((to) => to === id || `-${to}-`.includes(`-${id}-`));
}
var FileBackend = class {
  name = "file";
  dir;
  now;
  broadcast;
  constructor(dir, now, broadcast = "ALL") {
    this.dir = dir;
    this.now = now;
    this.broadcast = broadcast;
  }
  async send(m) {
    if (!validId(m.from) || !validId(m.to) || !validTopic(m.topic)) throw new Error("invalid message name");
    mkdirSync2(this.dir, { recursive: true });
    const at = this.now();
    for (let i = 1; ; i++) {
      const name = messageName(m.from, m.to, m.topic, at, i);
      const path = join11(this.dir, name);
      try {
        writeFileSync3(path, m.body, { flag: "wx" });
        return { name, from: m.from, to: [m.to], topic: m.topic, at, path };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }
  async list(filter = {}) {
    let names;
    try {
      names = readdirSync4(this.dir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const messages2 = [];
    for (const name of names) {
      const parsed = parseMessageName(name);
      if (!parsed) continue;
      const stat2 = statSync3(join11(this.dir, name));
      if (!stat2.isFile()) continue;
      const ref = { name, ...parsed, at: stat2.mtime };
      if (filter.from !== void 0 && ref.from !== filter.from) continue;
      if (filter.to !== void 0 && !addressed(ref, filter.to)) continue;
      messages2.push(ref);
    }
    return messages2.sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name)).slice(0, filter.limit);
  }
  async inbox(lane, opts = {}) {
    const recipients = [lane, "ALL", this.broadcast, ...opts.groups || [], ...opts.aliases || []];
    return (await this.list()).filter((m) => ![lane, ...opts.aliases || []].includes(m.from) && recipients.some((id) => addressed(m, id)));
  }
  async setStatus(lane, line) {
    if (!validId(lane)) throw new Error("invalid lane id");
    const dir = join11(this.dir, "status");
    mkdirSync2(dir, { recursive: true });
    const tmp = join11(dir, `.${lane}-${randomUUID3()}.tmp`);
    writeFileSync3(tmp, `${line}
`, { flag: "wx" });
    renameSync3(tmp, join11(dir, `${lane}.status`));
  }
  async unread(lane, opts = {}) {
    if (!validId(lane)) throw new Error("invalid lane id");
    let since;
    try {
      since = statSync3(join11(this.dir, `${lane}-inbox.marker`)).mtimeMs;
    } catch (e) {
      if (e.code === "ENOENT") return void 0;
      throw e;
    }
    return (await this.inbox(lane, opts)).filter((m) => m.at.getTime() > since);
  }
  async status(lane) {
    if (!validId(lane)) throw new Error("invalid lane id");
    try {
      return readFileSync5(join11(this.dir, "status", `${lane}.status`), "utf8").split(/\r?\n/)[0];
    } catch (e) {
      if (e.code === "ENOENT") return void 0;
      throw e;
    }
  }
};
function backendFor(config, ctx, root) {
  return new FileBackend(expand(config.messages.dir, config, root, ctx.home), ctx.now, config.messages.broadcast);
}

// src/lanes/reap/handoff.ts
function fingerprint(s) {
  return createHash2("sha256").update(JSON.stringify(s)).digest("hex");
}
function packPath(env) {
  return join12(env.root, ".state/handoffs", env.lane.id);
}
function readPack(env) {
  const text = optionalText(join12(packPath(env), "handoff.json"));
  if (text === void 0) return void 0;
  const value = JSON.parse(text);
  if (!validPack(value, env.lane.id)) throw new Error("invalid handoff pack");
  return value;
}
async function recipient(env, to) {
  const { c, lane, root, ctx } = env;
  const target = c.lanes.find((l) => l.id === to && !l.retired);
  validateRecipient({ to, target }, env);
  const cwd = recipientCwd(env, target);
  if ((await processIds(ctx, absolute(ctx, cwd))).length !== 1) {
    throw new UsageError("handoff recipient is not live or has shared cwd");
  }
}
async function prepare(env, to, s) {
  const { c, lane, root, ctx } = env;
  await recipient(env, to);
  if (s.asks.length || s.keeps.length) throw new Error(`handoff blocked: ${[...s.asks, ...s.keeps].join("; ")}`);
  const hash = fingerprint(s);
  const old = readPack(env);
  if (reusable(old, hash, to)) return old;
  const dir = packPath(env);
  mkdirSync3(dir, { recursive: true });
  const pack = {
    version: 1,
    id: `${lane.id}-${hash.slice(0, 12)}`,
    from: lane.id,
    to,
    at: ctx.now().toISOString(),
    fingerprint: hash,
    signals: s
  };
  const notes = ["NOW.md", "WATCHES.md", "STATE.md"].map((n) => `## ${n}
${optionalText(join12(root, "coordinator", n)) || "unknown/not present"}`).join("\n\n");
  writeFileSync4(join12(dir, "HANDOFF.md"), [
    `# Handoff ${pack.id}`,
    `Recipient: ${to}`,
    `Branch: ${lane.branch}`,
    `SHA: ${s.git.head || "unknown"}`,
    `Dirty: ${s.git.dirty}`,
    `Ahead: ${s.git.ahead ?? "unknown"}`,
    `Uncommitted paths: ${JSON.stringify(s.git.paths)}`,
    `Unpushed commits: ${JSON.stringify(s.git.unpushed)}`,
    `Tree digest: ${s.git.digest}`,
    `PR merged at HEAD: ${s.git.merged ?? "unknown"}`,
    ``,
    `## Claims`,
    `${JSON.stringify(s.claims, null, 2)}`,
    ``,
    `## Deliveries / pending acknowledgements / candidate ownership`,
    `Unknown: file messages are not machine-readable acknowledgements. Recipient must take these over explicitly.`,
    ``,
    `## Next action`,
    `Review claims, branch, preserved worktree and pending acknowledgements. Accept using lanes handoff ${lane.id} --accept --from ${to}. Never mark claims done just to retire.`,
    ``,
    `${notes}`,
    ``
  ].join("\n"));
  atomicJson(join12(dir, "handoff.json"), pack);
  const message = await backendFor(c, ctx, root).send({
    from: c.coordinator.id,
    to,
    topic: "handoff-request",
    body: `Review ${join12(dir, "HANDOFF.md")} and ${join12(dir, "handoff.json")}. Explicitly accept with: lanes handoff ${lane.id} --accept --from ${to}. This transfers next-action and pending acknowledgement ownership; it does not complete claims.`
  });
  pack.requestMessage = message.name;
  atomicJson(join12(dir, "handoff.json"), pack);
  return pack;
}
async function accept(env, from) {
  const { lane, ctx } = env;
  validateAcceptanceIdentity(env, from);
  const pack = readPack(env);
  if (!pack || pack.to !== from) throw new UsageError("acceptance must come from the named handoff recipient");
  await recipient(env, from);
  const current = await collect(env);
  if (fingerprint(current) !== pack.fingerprint) {
    throw new Error("handoff evidence changed; prepare a new pack before accepting");
  }
  pack.acceptance = { from, at: ctx.now().toISOString(), fingerprint: pack.fingerprint };
  atomicJson(join12(packPath(env), "handoff.json"), pack);
  return pack;
}
function handoffRecipient(lane, c, override) {
  return override || effectiveParent(lane, c);
}
function recipientCwd(env, target) {
  const { c, root, ctx } = env;
  return target ? join12(expand(c.worktreesDir, c, root, ctx.home), target.worktree) : expand(c.coordinator.cwd, c, root, ctx.home);
}
function validPack(value, id) {
  return value.version === 1 && value.from === id && typeof value.fingerprint === "string";
}
function reusable(pack, hash, to) {
  if (!pack?.requestMessage) return false;
  return pack.fingerprint === hash && pack.to === to;
}
function validateRecipient(input, env) {
  const error = "handoff recipient must be another active lane or coordinator";
  if (input.to === env.lane.id) throw new UsageError(error);
  if (!input.target && input.to !== env.c.coordinator.id) throw new UsageError(error);
}
function validateAcceptanceIdentity(env, from) {
  const caller = env.ctx.env.PI_ORCH_ID;
  if (caller && caller !== from) throw new UsageError("--from must match PI_ORCH_ID");
}

// src/lanes/commands/handoff.ts
async function handoff(args, opts, env) {
  const { c, root, ctx } = env;
  const lane = activeLane(args, c);
  const minutes = c.idle?.minutes ?? 75;
  if (opts.accept) {
    validateAcceptance(opts);
    await accept({ c, lane, root, ctx, minutes }, opts.from);
    ctx.out(`accepted handoff ${lane.id} by ${opts.from}`);
    return 0;
  }
  if (opts.from) throw new UsageError("--from requires --accept");
  const s = await collect({ c, lane, root, ctx, minutes });
  const pack = await prepare({ c, lane, root, ctx, minutes }, handoffRecipient(lane, c, opts.to), s);
  atomicJson(join13(root, ".state/reap-plan.json"), { at: ctx.now().toISOString(), rows: [{
    id: lane.id,
    verdict: "handoff",
    pack: relative3(root, packPath({ root, lane })),
    signals: s
  }] });
  ctx.out(`handoff ${pack.id}: ${packPath({ root, lane })}`);
  return 0;
}
function activeLane(args, c) {
  const lane = c.lanes.find((l) => l.id === args[0] && !l.retired);
  if (args.length !== 1 || !lane) throw new UsageError("handoff requires an active lane ID");
  return lane;
}
function validateAcceptance(opts) {
  if (!opts.from || opts.to) throw new UsageError("handoff --accept requires --from ID and no --to");
}

// src/lanes/commands/reap.ts
import { join as join18, relative as relative5 } from "node:path";

// src/lanes/reap/own-context.ts
import { join as join15 } from "node:path";
import { createHash as createHash4 } from "node:crypto";

// src/lanes/terminal.ts
import { join as join14 } from "node:path";
var shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
var appleScriptString = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
function detectBackend(configured, ctx) {
  if (!BACKENDS.includes(configured)) throw new UsageError("invalid terminal.backend");
  if (configured !== "auto") return configured;
  if (ctx.env.TMUX) return "tmux";
  if (ctx.platform === "darwin" && ctx.env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (ctx.platform === "darwin" && ctx.env.TERM_PROGRAM === "Apple_Terminal") return "terminal-app";
  return "print";
}
function launchCommand(c, root, cwd, id, prompt, wrapper, messages2) {
  const unset = c.launch.unsetEnv.map((name) => `-u ${name}`).join(" ");
  const exe = /^[A-Za-z0-9_/-]+$/.test(wrapper) ? wrapper : shellQuote(wrapper);
  return `cd ${shellQuote(cwd)} && env ${unset ? `${unset} ` : ""}PI_ORCH_ID=${id} LANES_DIR=${shellQuote(root)} INBOX_DIR=${shellQuote(messages2)} LANE_STATUS_DIR=${shellQuote(join14(messages2, "status"))} ${exe} ${shellQuote(`@${prompt}`)}`;
}
function terminalBackend(name) {
  if (!BACKENDS.includes(name) || name === "auto") throw new UsageError("invalid terminal.backend");
  return { quit: (ctx, tty, guard) => nudgeTerminal(name, ctx, { tty, text: "/quit" }, guard), nudge: (ctx, input, guard) => nudgeTerminal(name, ctx, input, guard), async start(ctx, { id, cwd, command }) {
    if (name === "print") {
      ctx.out(command);
      return 0;
    }
    let cmd;
    let args;
    if (name === "terminal-app") {
      cmd = "osascript";
      args = ["-e", `tell application "Terminal" to do script "${appleScriptString(command)}"`, "-e", 'tell application "Terminal" to activate'];
    } else if (name === "iterm") {
      cmd = "osascript";
      args = ["-e", `tell application "iTerm2"
create window with default profile
tell current session of current window to write text "${appleScriptString(command)}"
activate
end tell`];
    } else {
      cmd = "tmux";
      if (ctx.env.TMUX) args = ["new-window", "-n", id, "-c", cwd];
      else {
        const exists = (await ctx.run("tmux", ["has-session", "-t", "lanes"], { timeoutMs: 1e4 })).code === 0;
        args = exists ? ["new-window", "-t", "lanes", "-n", id, "-c", cwd] : ["new-session", "-d", "-s", "lanes", "-n", id, "-c", cwd];
      }
      args.push(`sh -c ${shellQuote(command)}`);
    }
    const result = await ctx.run(cmd, args, { timeoutMs: 3e4 });
    if (result.code !== 0) {
      ctx.err(`${cmd} failed: ${result.stderr.trim()}`);
      ctx.out(command);
      return 1;
    }
    if (name === "tmux" && !ctx.env.TMUX) ctx.out("attach with: tmux attach -t lanes");
    return 0;
  } };
}
async function nudgeTerminal(name, ctx, { tty, text }, beforeSend) {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) throw new UsageError("invalid tty");
  if (name === "print") return "not-found";
  if (name === "tmux") {
    const panes = await ctx.run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"], { timeoutMs: 1e4 });
    if (panes.code !== 0) throw new Error("tmux list-panes failed");
    const pane = panes.stdout.split("\n").map((s) => s.trim().split(/\s+/)).find(([t]) => t === `/dev/${tty}`)?.[1];
    if (!pane) return "not-found";
    await guardQuit(beforeSend);
    for (const args of [["send-keys", "-t", pane, "-l", "--", text], ["send-keys", "-t", pane, "Enter"]]) {
      if ((await ctx.run("tmux", args, { timeoutMs: 1e4 })).code !== 0) throw new Error("tmux send-keys failed");
    }
    return "sent";
  }
  const escaped = appleScriptString(text);
  const script = name === "terminal-app" ? `tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is "/dev/${tty}" then
do script "${escaped}" in t
return "sent"
end if
end repeat
end repeat
return "not-found"
end tell` : `tell application "iTerm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
if tty of s is "/dev/${tty}" then
tell s to write text "${escaped}"
return "sent"
end if
end repeat
end repeat
end repeat
return "not-found"
end tell`;
  await guardQuit(beforeSend);
  const result = await ctx.run("osascript", ["-e", script], { timeoutMs: 1e4 });
  if (result.code !== 0) throw new Error(`osascript failed: ${result.stderr.trim()}`);
  return result.stdout.trim() === "sent" ? "sent" : "not-found";
}
async function guardQuit(guard) {
  if (guard) await guard();
}

// src/lanes/reap/context-format.ts
import { createHash as createHash3 } from "node:crypto";
import { lstatSync as lstatSync2, readFileSync as readFileSync6 } from "node:fs";
var HEADINGS = [
  "Goal",
  "Repository",
  "Worktree",
  "Branch",
  "HEAD",
  "Dirty files",
  "Issue claims",
  "Open PRs or candidates",
  "External work",
  "Next step",
  "User constraints",
  "Open items",
  "Launch prompt"
];
function sections(text) {
  const matches = [...text.matchAll(/^##\s+([^\r\n]+)\r?$/gm)];
  const result = /* @__PURE__ */ new Map();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const end = matches[i + 1]?.index ?? text.length;
    result.set(match[1].trim().toLowerCase(), text.slice(match.index + match[0].length, end).trim());
  }
  return result;
}
function snapshotSection(section) {
  const json = section?.match(/^```json\s*\n([\s\S]*?)\n```\s*$/)?.[1];
  if (!json) throw new Error("lane handoff requires a JSON Snapshot section");
  const snapshot = JSON.parse(json);
  if (!validSnapshot(snapshot)) throw new Error("lane handoff Snapshot invalid");
  return snapshot;
}
function strings(value) {
  return Array.isArray(value) && value.every((s) => typeof s === "string");
}
function validSnapshot(s) {
  if (!s || !/^[a-f0-9]{40,64}$/.test(s.head)) return false;
  if (!strings(s.paths) || !strings(s.unpushed)) return false;
  return [s.repo, s.worktree, s.branch].every((value) => typeof value === "string" && Boolean(value));
}
function readContext(path) {
  const stat2 = lstatSync2(path);
  if (!stat2.isFile()) throw new Error("lane handoff must be a regular file");
  const text = readFileSync6(path, "utf8");
  const parts = sections(text);
  for (const heading of HEADINGS) {
    if (!parts.get(heading.toLowerCase())) throw new Error(`lane handoff missing ${heading}`);
  }
  return {
    text,
    snapshot: snapshotSection(parts.get("snapshot")),
    mtime: stat2.mtimeMs,
    digest: createHash3("sha256").update(text).digest("hex")
  };
}
function expectedSnapshot(env, s) {
  return {
    head: s.git.head,
    paths: s.git.paths,
    unpushed: s.git.unpushed,
    repo: env.lane.repo,
    worktree: s.cwd,
    branch: env.lane.branch
  };
}
function validateContext(file, expected) {
  const actual = file.snapshot;
  if (actual.head !== expected.head) throw new Error("lane handoff HEAD differs from worktree");
  if (!samePaths(actual.paths, expected.paths)) throw new Error("lane handoff has unaccounted dirty files");
  if (!samePaths(actual.unpushed, expected.unpushed)) throw new Error("lane handoff unpushed commits differ");
  validateLocation(actual, expected);
}
function validateLocation(actual, expected) {
  for (const key of ["repo", "worktree", "branch"]) {
    if (actual[key] !== expected[key]) throw new Error(`lane handoff ${key} differs`);
  }
}
function samePaths(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

// src/lanes/reap/own-context.ts
function contextPath(env) {
  return join15(env.root, ".state/handoffs", `${env.lane.id}.md`);
}
function receiptPath(env) {
  return join15(env.root, ".state/handoffs", `${env.lane.id}.request.json`);
}
function version(s) {
  const state = {
    pid: s.pid,
    procStart: s.procStart,
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    lastWrite: s.lastWrite,
    git: s.git,
    claims: s.claims
  };
  return createHash4("sha256").update(JSON.stringify(state)).digest("hex");
}
function cached(env, s) {
  const text = optionalText(receiptPath(env));
  if (text === void 0) return false;
  const receipt = JSON.parse(text);
  if (receipt.version !== version(s)) return false;
  const file = readContext(contextPath(env));
  validateContext(file, expectedSnapshot(env, s));
  if (file.digest !== receipt.digest || file.mtime !== receipt.mtime) throw new Error("lane handoff changed after validation");
  return true;
}
async function request(env, s) {
  if (!s.tty) throw new Error("lane handoff TTY unknown");
  const backend = terminalBackend(detectBackend("auto", env.ctx));
  let at = env.ctx.now().getTime();
  const text = `Write your own context handoff to ${contextPath(env)}. Use nonempty ## sections: ${HEADINGS.join(", ")}. Preserve user constraints verbatim. Add ## Snapshot with a fenced json object matching ${JSON.stringify(expectedSnapshot(env, s))}. Account for every dirty path, outstanding acknowledgement, candidate and CI run. Do not quit.`;
  const result = await backend.nudge(env.ctx, { tty: s.tty, text }, async () => {
    await unchanged(env, s);
    at = env.ctx.now().getTime();
  });
  if (result !== "sent") throw new Error("could not request lane's own handoff through its terminal");
  return at;
}
async function unchanged(env, s) {
  const current = await collect(env);
  if (current.asks.length || current.keeps.length) throw new Error("handoff request safety evidence changed");
  if (version(current) !== version(s)) throw new Error("handoff request safety evidence changed");
}
async function waitForContext(env, s, at) {
  const sleep = env.ctx.sleep || ((ms) => new Promise((resolve10) => setTimeout(resolve10, ms)));
  let reason = "lane handoff absent or stale";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const file = readContext(contextPath(env));
      if (file.mtime > at) {
        validateContext(file, expectedSnapshot(env, s));
        return file;
      }
    } catch (e) {
      reason = e.message;
    }
    await sleep(1e3);
  }
  throw new Error(`lane handoff timed out: ${reason}`);
}
async function ownContext(env, s) {
  if (cached(env, s)) return contextPath(env);
  const at = await request(env, s);
  const file = await waitForContext(env, s, at);
  const current = await collect(env);
  if (JSON.stringify(current.git) !== JSON.stringify(s.git)) throw new Error("tree changed while writing lane handoff");
  atomicJson(receiptPath(env), { version: version(current), digest: file.digest, mtime: file.mtime });
  if (JSON.stringify(current) !== JSON.stringify(s)) throw new Error("lane wrote handoff; wait until idle and review again");
  return contextPath(env);
}
function verifyOwnContext(env, s) {
  if (!cached(env, s)) throw new Error("lane handoff no longer matches session/tree evidence");
}

// src/lanes/reap/safe-quit.ts
function ready(s, env) {
  if (env.ctx.now().getTime() - (s.lastWrite || 0) < 18e4) throw new Error("quit refused: session wrote less than 180s ago");
  if (!s.pid || !s.tty) throw new Error("quit identity missing");
}
async function revalidate(env, s, to) {
  await recipient(env, to);
  const fresh = await collect(env);
  if (fresh.asks.length || fresh.keeps.length) throw new Error("quit refused: safety evidence changed");
  if (fingerprint(fresh) !== fingerprint(s)) throw new Error("quit refused: safety evidence changed");
  verifyOwnContext(env, fresh);
}
async function exited(env, pid) {
  const probe = await env.ctx.run("ps", ["-p", String(pid)], { timeoutMs: 2e3 });
  if (probe.timedOut) throw new Error("quit exit could not be confirmed");
  if (probe.code === 1) return true;
  if (probe.code !== 0) throw new Error("quit exit could not be confirmed");
  return false;
}
async function awaitExit(env, pid) {
  const sleep = env.ctx.sleep || ((ms) => new Promise((resolve10) => setTimeout(resolve10, ms)));
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await exited(env, pid)) return;
    await sleep(200);
  }
  throw new Error("pi did not exit after /quit; active metadata unchanged");
}
async function safeQuit(env, s, to) {
  ready(s, env);
  const backend = terminalBackend(detectBackend("auto", env.ctx));
  const outcome = await backend.quit(env.ctx, s.tty, () => revalidate(env, s, to));
  if (outcome !== "sent") throw new Error(`quit refused: ${outcome}`);
  await awaitExit(env, s.pid);
}

// src/lanes/reap/archive.ts
import { copyFileSync, existsSync as existsSync3, lstatSync as lstatSync3, mkdirSync as mkdirSync5, readFileSync as readFileSync7, readdirSync as readdirSync5, unlinkSync } from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute4, join as join17, relative as relative4, resolve as resolve5 } from "node:path";

// src/lanes/reap/closure.ts
import { appendFileSync, mkdirSync as mkdirSync4 } from "node:fs";
import { join as join16 } from "node:path";
function pauseClaims(env, s, record) {
  const path = join16(env.ctx.piAgentDir, "issue-work/registry.jsonl");
  const latest = registry(optionalText(path) || "");
  for (const claim of s.claims.filter((claim2) => claim2.state !== "done")) {
    const current = latest.find((value) => value.repo.toLowerCase() === claim.repo.toLowerCase() && value.issue === claim.issue);
    if (JSON.stringify(current) !== JSON.stringify(claim)) throw new Error("claim changed before pause; inspect closure");
    const event = {
      ...claim,
      ts: record.ts,
      state: "paused",
      sessionFile: s.sessionFile,
      note: `Paused by lanes reap; takeover by ${record.to}; handoff: ${record.handoff}`
    };
    appendFileSync(path, `
${JSON.stringify(event)}
`);
  }
}
async function recordClosure(env, s, target) {
  const { root, lane, c, ctx } = env;
  const record = {
    id: lane.id,
    ground: "takeover",
    verdict: "retire",
    ts: ctx.now().toISOString(),
    sha: s.git.head,
    sessionFile: s.sessionFile,
    handoff: contextPath(env),
    archive: target.archive,
    to: target.to,
    evidence: `Accepted takeover; clean foreground /quit and exit confirmed; tree=${s.git.digest}`
  };
  pauseClaims(env, s, record);
  mkdirSync4(join16(root, "coordinator"), { recursive: true });
  appendFileSync(
    join16(root, "coordinator/STATE.md"),
    `
- ${record.ts} ${lane.id}: takeover by ${target.to}; handoff ${record.handoff}; SHA ${record.sha}.
`
  );
  appendFileSync(join16(root, ".state/reaped.log"), `${JSON.stringify(record)}
`);
  await backendFor(c, ctx, root).send({
    from: lane.id,
    to: effectiveParent(lane, c),
    topic: "lane-closed",
    body: `${lane.id} closed (takeover by ${target.to}). Handoff: ${record.handoff}. Archive: ${target.archive}.`
  });
}

// src/lanes/reap/archive.ts
function checkRetirement(lane, c, root) {
  if (c.lanes.some((l) => !l.retired && effectiveParent(l, c) === lane.id)) throw new Error("retirement would orphan active children; reparent first");
  const prompt = relative4(root, resolve5(root, lane.prompt));
  if (prompt.startsWith("..") || isAbsolute4(prompt)) throw new Error("prompt outside coordination root cannot be archived");
}
async function archive(env, s, to) {
  const { c, lane, root, ctx } = env;
  checkRetirement(lane, c, root);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, "-");
  const dest = join17(root, ".state/retired", stamp, lane.id);
  if (existsSync3(join17(dest, "closure.json"))) throw new Error("retirement archive already exists; inspect before retrying");
  const dir = expand(c.messages.dir, c, root, ctx.home);
  const sources = [];
  const add2 = (path, target) => {
    if (existsSync3(path)) sources.push({ path, dest: join17(dest, target) });
  };
  add2(resolve5(root, lane.prompt), `prompts/${lane.id}.md`);
  add2(join17(dir, "status", `${lane.id}.status`), `messages/status/${lane.id}.status`);
  add2(join17(dir, `${lane.id}-inbox.marker`), `messages/${lane.id}-inbox.marker`);
  for (const name of readdirSync5(dir)) {
    const parsed = parseMessageName(name);
    if (laneAddressed(parsed, lane)) add2(join17(dir, name), `messages/${name}`);
  }
  const handoff2 = packPath({ root, lane });
  if (existsSync3(handoff2)) for (const name of readdirSync5(handoff2)) add2(join17(handoff2, name), `handoff/${name}`);
  mkdirSync5(dest, { recursive: true });
  atomicJson(join17(dest, "lane.json"), lane);
  sources.forEach(copySource);
  copySource({ path: contextPath(env), dest: join17(dest, "handoff", `${lane.id}.md`) });
  const closure = { id: lane.id, at: ctx.now().toISOString(), ground: "takeover", to, signals: s, worktreePreserved: s.cwd, branchPreserved: lane.branch };
  atomicJson(join17(dest, "closure.json"), closure);
  await recordClosure(env, s, { to, archive: dest });
  lane.retired = true;
  lane.stateFile = relative4(root, join17(dest, "closure.json"));
  saveConfig(root, c);
  sources.forEach(removeUnchanged);
  return dest;
}
function copySource(source) {
  if (!lstatSync3(source.path).isFile()) throw new Error(`archive source is not a regular file: ${source.path}`);
  source.body = readFileSync7(source.path);
  mkdirSync5(dirname4(source.dest), { recursive: true });
  copyFileSync(source.path, source.dest);
}
function removeUnchanged(source) {
  if (source.body && readFileSync7(source.path).equals(source.body)) unlinkSync(source.path);
}
function laneAddressed(parsed, lane) {
  if (!parsed) return false;
  return parsed.to.length === 1 && parsed.to[0] === lane.id;
}

// src/lanes/reap/verdict.ts
function verdict(s) {
  if (s.asks.length) return { verdict: "ask", reason: s.asks.join("; ") };
  if (s.keeps.length) return { verdict: "keep", reason: s.keeps.join("; ") };
  if (s.finished) return { verdict: "retire", ground: "finished", reason: "finished: all machine evidence proves completion" };
  if (s.takeover) return { verdict: "retire", ground: "takeover", reason: "takeover validated" };
  return { verdict: "handoff", reason: "idle; delivery acknowledgements and candidate ownership unknown; takeover required" };
}

// src/lanes/commands/reap.ts
function validateArgs(args, opts, c) {
  if (args.length > 1) throw new UsageError("reap accepts one active lane ID");
  validateId(args[0], c);
  if (opts.apply && opts["dry-run"]) throw new UsageError("choose --apply or --dry-run");
  return idleMinutes(opts, c);
}
async function applyRow(row, env, opts) {
  const { lane, c, root, ctx } = env;
  checkRetirement(lane, c, root);
  const to = opts["handoff-to"] || readPack({ root, lane })?.to || handoffRecipient(lane, c);
  await recipient(env, to);
  await ownContext(env, row.signals);
  const pack = await prepare(env, to, row.signals);
  row.pack = relative5(root, packPath({ root, lane }));
  if (pack.acceptance?.from !== to || pack.acceptance?.fingerprint !== fingerprint(row.signals)) {
    row.reason = `takeover request sent to ${to}; explicit acceptance required`;
    return;
  }
  await recipient(env, to);
  await safeQuit(env, row.signals, to);
  row.pack = relative5(root, await archive(env, row.signals, to));
  row.verdict = "retire";
  row.ground = "takeover";
  row.reason = `takeover accepted by ${to}; /quit exit confirmed; archived`;
}
async function planRow(env, opts) {
  const signals = await collect(env);
  const row = { id: env.lane.id, ...verdict(signals), signals };
  if (!opts.apply || row.verdict !== "handoff") return row;
  try {
    await applyRow(row, env, opts);
  } catch (e) {
    row.verdict = "ask";
    row.reason = e.message;
    row.failed = true;
  }
  return row;
}
function display(rows, json, ctx) {
  if (json) {
    ctx.out(JSON.stringify(rows));
    return;
  }
  ctx.out("LANE	VERDICT	REASON");
  for (const row of rows) {
    ctx.out(`${row.id}	${row.verdict}${row.ground ? ` (${row.ground})` : ""}	${row.reason}`);
  }
}
async function reap(args, opts, env) {
  const { c, root, ctx } = env;
  const minutes = validateArgs(args, opts, c);
  const rows = [];
  const active = laneTree(c).reverse().map((row) => row.lane).filter((l) => !args[0] || l.id === args[0]);
  for (const lane of active) rows.push(await planRow({ c, lane, root, ctx, minutes }, opts));
  atomicJson(join18(root, ".state/reap-plan.json"), { at: ctx.now().toISOString(), minutes, rows });
  display(rows, Boolean(opts.json), ctx);
  return rows.some((row) => row.failed) ? 2 : 0;
}
function validateId(id, c) {
  if (!id) return;
  if (!c.lanes.some((l) => l.id === id && !l.retired)) throw new UsageError("reap accepts one active lane ID");
}
function idleMinutes(opts, c) {
  const minutes = Number(opts.minutes ?? c.idle?.minutes ?? 75);
  if (!Number.isFinite(minutes) || minutes < 1) throw new UsageError("--minutes must be positive");
  return minutes;
}

// src/lanes/commands/snooze.ts
import { mkdirSync as mkdirSync6, unlinkSync as unlinkSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join19 } from "node:path";
async function snooze2(args, opts, env) {
  const { c, root, ctx } = env;
  const lane = c.lanes.find((l) => l.id === args[0] && !l.retired);
  if (invalidRequest(args, lane, opts)) throw new UsageError("snooze requires ID and --until ISO|+90m or --clear");
  const dir = join19(root, ".state/snooze");
  const path = join19(dir, lane.id);
  if (opts.clear) {
    clear(path);
    ctx.out(`snooze cleared ${lane.id}`);
    return 0;
  }
  const date = until(opts.until, ctx);
  if (!Number.isFinite(date) || date <= ctx.now().getTime()) {
    throw new UsageError("--until must be a future ISO timestamp or +90m");
  }
  mkdirSync6(dir, { recursive: true });
  writeFileSync5(path, new Date(date).toISOString() + "\n");
  ctx.out(`snoozed ${lane.id} until ${new Date(date).toISOString()}`);
  return 0;
}
function invalidRequest(args, lane, opts) {
  if (args.length !== 1 || !lane) return true;
  return Boolean(opts.clear) === Boolean(opts.until);
}
function until(value, ctx) {
  const relative6 = /^\+(\d+)m$/.exec(value);
  return relative6 ? ctx.now().getTime() + Number(relative6[1]) * 6e4 : Date.parse(value);
}
function clear(path) {
  try {
    unlinkSync2(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

// src/lanes/commands/init.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync7, readFileSync as readFileSync9, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname5, join as join21, resolve as resolve6 } from "node:path";

// src/lanes/templates.ts
import { readFileSync as readFileSync8 } from "node:fs";
import { join as join20 } from "node:path";
function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (token, name) => Object.hasOwn(vars, name) ? String(vars[name]) : token);
}
function readTemplate(ctx, name) {
  return readFileSync8(join20(ctx.templatesDir, name), "utf8");
}
function templateVars(c, ctx, root) {
  const messages2 = expand(c.messages.dir, c, root, ctx.home);
  return {
    root,
    root_sh: shellQuote(root),
    messages_sh: shellQuote(messages2),
    coordinator_sh: shellQuote(c.coordinator.id),
    coordinator: c.coordinator.id,
    maxRunning: c.coordinator.maxRunning,
    rules: join20(root, "rules.md"),
    messages: messages2,
    watches: join20(root, "coordinator/WATCHES.md"),
    handoff: join20(root, "coordinator/handoff-protocol.md")
  };
}

// src/lanes/commands/init.ts
async function init(args, opts, ctx) {
  const root = resolve6(ctx.cwd, args[0] || ".");
  const configPath = join21(root, "lanes.json");
  const c = existsSync4(configPath) ? loadConfig(root) : defaults(root, ctx.home, opts["repos-root"]);
  if (!existsSync4(configPath)) {
    c.coordinator.id = opts.coordinator || c.coordinator.id;
    c.terminal.backend = opts.terminal || c.terminal.backend;
    c.launch.preapproveMcp = opts["preapprove-mcp"] === "true" || preapprovalDefault(ctx.templatesDir);
  }
  validate(c);
  const vars = templateVars(c, ctx, root);
  const put = (rel, content) => {
    const path = join21(root, rel);
    mkdirSync7(dirname5(path), { recursive: true });
    if (existsSync4(path)) ctx.out(`kept ${path}`);
    else {
      writeFileSync6(path, content, { flag: "wx" });
      ctx.out(`created ${path}`);
    }
  };
  put("lanes.json", `${JSON.stringify(c, null, 2)}
`);
  for (const [source, dest] of [["rules.md", "rules.md"], ["coordinator.md", "prompts/coordinator.md"], ...["WATCHES.md", "handoff-protocol.md", "NOW.md", "STATE.md"].map((n) => [n, `coordinator/${n}`])]) {
    put(dest, renderTemplate(readTemplate(ctx, source), vars));
  }
  const status2 = join21(root, "messages/status");
  const hadStatus = existsSync4(status2);
  mkdirSync7(status2, { recursive: true });
  ctx.out(`${hadStatus ? "kept" : "created"} ${status2}`);
  const ignore = join21(root, ".gitignore");
  const text = existsSync4(ignore) ? readFileSync9(ignore, "utf8") : "";
  const missing = [".state/", "messages/"].filter((s) => !text.split(/\r?\n/).includes(s));
  if (missing.length) {
    writeFileSync6(ignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}
`);
    ctx.out(`created ${ignore}`);
  } else ctx.out(`kept ${ignore}`);
  return 0;
}

// src/lanes/commands/add.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync8, writeFileSync as writeFileSync7 } from "node:fs";
import { dirname as dirname6, join as join23, resolve as resolve7 } from "node:path";

// src/lanes/preapprove.ts
import { existsSync as existsSync5, readFileSync as readFileSync10 } from "node:fs";
import { join as join22 } from "node:path";
var SUPPORTED_MAJORS = [5];
async function preapprove(ctx, cwd, enabled) {
  if (!enabled) {
    ctx.out("MCP preapproval is off; enable with lanes init --preapprove-mcp for a new folder, or set launch.preapproveMcp to true in lanes.json.");
    return;
  }
  const files = [".mcp.json", ".pi/mcp.json"].filter((f) => existsSync5(join22(cwd, f)));
  if (!files.length) return;
  const skip = (reason2) => ctx.err(`MCP preapproval skipped: ${reason2}; pi will ask once per server when the lane starts.`);
  let reason = "adapter not found";
  try {
    const adapter = join22(ctx.piAgentDir, "npm/node_modules/pi-mcp-adapter");
    const pkg = JSON.parse(readFileSync10(join22(adapter, "package.json"), "utf8"));
    if (!SUPPORTED_MAJORS.includes(Number(String(pkg.version).split(".")[0]))) {
      reason = `adapter ${pkg.version} not supported (supports ${SUPPORTED_MAJORS.join(", ")}.x)`;
      throw new Error(reason);
    }
    reason = "adapter API changed";
    const mod = await ctx.loadModule(join22(adapter, "dist/project-server-trust.js"));
    if (typeof mod.approveProjectServer !== "function" || typeof mod.hashProjectServerDefinition !== "function") throw new Error(reason);
    for (const file of files) {
      let servers;
      try {
        servers = JSON.parse(readFileSync10(join22(cwd, file), "utf8")).mcpServers ?? {};
      } catch {
        skip(`invalid ${file} (${join22(cwd, file)})`);
        continue;
      }
      for (const [name, def] of Object.entries(servers)) {
        const hash = await mod.hashProjectServerDefinition(def);
        await mod.approveProjectServer(cwd, name, def);
        ctx.out(`approved ${file} ${name} ${String(hash).slice(0, 12)}`);
      }
    }
  } catch {
    skip(reason);
  }
}

// src/lanes/commands/add.ts
async function add(id, opts, c, root, ctx) {
  validateInput(id, opts, c);
  const lane = newLane(id, opts);
  validate({ ...c, lanes: [...c.lanes, lane] });
  const orchestration2 = planOrchestration(lane, opts, c);
  const { orchestrator, candidate, siblings } = orchestration2;
  if (orchestrator) lane.parent = orchestrator.id;
  const env = { c, root, ctx };
  const code = await createWorktree(lane, opts, env);
  if (code !== 0) return code;
  if (candidate && await createWorktree(candidate, opts, env) !== 0) return 1;
  if (orchestrator) await assignOrchestrator(orchestration2, env);
  else if (siblings.length) ctx.err(`warning: ${siblings.length + 1} lanes, no repo-orch`);
  saveConfig(root, c);
  ctx.out(`next: lanes start ${id}`);
  return 0;
}
function validateInput(id, opts, c) {
  if (!validId(id) || ["ALL", c.messages.broadcast, c.coordinator.id].includes(id)) {
    throw new UsageError("invalid lane id");
  }
  if (c.lanes.some((l) => l.id === id)) throw new Error(`lane ${id} already exists`);
  validateRepo(opts.repo);
  validateIssueAndGoal(opts);
}
function validateRepo(repo) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new UsageError("invalid repo (expected owner/name)");
  }
  if (repo.split("/").some((s) => [".", ".."].includes(s))) {
    throw new UsageError("invalid repo (expected owner/name)");
  }
}
function validateIssueAndGoal(opts) {
  if (invalidIssue(opts.issue)) {
    throw new UsageError("invalid issue");
  }
  if (opts.goal !== void 0 && !opts.goal.trim()) throw new UsageError("invalid goal");
}
function newLane(id, opts) {
  const repo = opts.repo;
  const name = repo.split("/")[1];
  const lower = id.toLowerCase();
  const worktree = `${lower}-${name.toLowerCase()}`;
  const branch = opts.branch || defaultBranch(lower, worktree, opts);
  return {
    id,
    repo,
    ...opts.issue ? { issue: Number(opts.issue) } : {},
    ...opts.goal ? { goal: opts.goal } : {},
    group: opts.group || null,
    worktree,
    branch,
    prompt: `prompts/${id}.md`
  };
}
function defaultBranch(lower, worktree, opts) {
  if (opts.issue) return `${lower}-issue-${Number(opts.issue)}`;
  return opts.goal ? `${lower}-${slug(opts.goal)}` : worktree;
}
function planOrchestration(lane, opts, c) {
  const siblings = c.lanes.filter((l) => !l.retired && l.repo === lane.repo);
  const current = siblings.find((l) => l.role === "repo-orch");
  if (opts.orchestrator && opts["no-orchestrator"]) {
    throw new UsageError("choose --orchestrator or --no-orchestrator");
  }
  if (opts.orchestrator) return { siblings, orchestrator: promotedOrchestrator(siblings, opts.orchestrator) };
  if (!needsOrchestrator({ current, siblings }, opts)) return { siblings, orchestrator: current };
  const candidate = newOrchestrator(lane, opts, c);
  return { siblings, orchestrator: candidate, candidate };
}
function promotedOrchestrator(siblings, id) {
  const orchestrator = siblings.find((l) => l.id === id);
  if (!orchestrator) throw new UsageError("--orchestrator must name an existing lane in the repository");
  if (siblings.some((l) => l.role === "repo-orch" && l.id !== orchestrator.id)) {
    throw new UsageError("repository already has a repo-orch");
  }
  return orchestrator;
}
function newOrchestrator(lane, opts, c) {
  const name = lane.repo.split("/")[1];
  const id = opts["orchestrator-id"] || `R-${name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14)}`;
  const reserved = [lane.id, c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.map((l) => l.id)];
  if (!validId(id) || reserved.includes(id)) {
    throw new Error("repo-orch ID collision or invalid ID; choose --orchestrator-id");
  }
  const lower = id.toLowerCase();
  return {
    id,
    repo: lane.repo,
    group: null,
    role: "repo-orch",
    parent: c.coordinator.id,
    worktree: lower,
    branch: `${lower}-candidate`,
    prompt: `prompts/${id}.md`
  };
}
async function assignOrchestrator(plan, { c, root, ctx }) {
  const orchestrator = plan.orchestrator;
  orchestrator.role = "repo-orch";
  orchestrator.parent = c.coordinator.id;
  const active = c.lanes.filter((l) => !l.retired && l.repo === orchestrator.repo);
  for (const sibling of active.filter((l) => l.id !== orchestrator.id)) sibling.parent = orchestrator.id;
  saveConfig(root, c);
  for (const sibling of plan.siblings.filter((l) => l.id !== orchestrator.id)) {
    await backendFor(c, ctx, root).send({
      from: c.coordinator.id,
      to: sibling.id,
      topic: "repo-orch-assigned",
      body: `Report to ${orchestrator.id} from now on.`
    });
  }
  ctx.out(`next: lanes start ${orchestrator.id}`);
}
async function createWorktree(lane, opts, env) {
  const { c, root, ctx } = env;
  const git = (clone2, args, timeoutMs = 1e4) => ctx.run("git", ["-C", clone2, ...args], { timeoutMs });
  const clone = await findClone(lane, opts, env, git);
  const base = await prepareBase({ clone, lane, opts, env }, git);
  const wt = join23(expand(c.worktreesDir, c, root, ctx.home), lane.worktree);
  await addWorktree({ clone, lane, wt, base }, git);
  try {
    const lock = await git(clone, ["worktree", "lock", "--reason", `lanes ${lane.id}`, wt]);
    if (lock.code !== 0) throw new Error(`git worktree lock failed: ${lock.stderr.trim()}`);
    writePrompt({ lane, wt, base }, env);
    c.lanes.push(lane);
    await preapprove(ctx, wt, c.launch.preapproveMcp);
  } catch (e) {
    ctx.err(e.message);
    ctx.err(`undo: git -C ${shellQuote(clone)} worktree unlock ${shellQuote(wt)} && git -C ${shellQuote(clone)} worktree remove ${shellQuote(wt)} && git -C ${shellQuote(clone)} branch -D ${shellQuote(lane.branch)}`);
    return 1;
  }
  return 0;
}
async function findClone(lane, opts, { c, root, ctx }, git) {
  const [owner, name] = lane.repo.split("/");
  const repos = expand(c.reposRoot, c, root, ctx.home);
  const candidates = [
    opts.path ? resolve7(ctx.cwd, opts.path) : void 0,
    c.repos[lane.repo] ? expand(c.repos[lane.repo], c, root, ctx.home) : void 0,
    join23(repos, name),
    join23(repos, owner, name)
  ].filter((p) => Boolean(p));
  for (const path of candidates) if ((await git(path, ["rev-parse", "--git-dir"])).code === 0) return path;
  throw new Error(`clone it first: gh repo clone ${lane.repo} ${join23(repos, name)}`);
}
async function prepareBase(input, git) {
  const { clone, lane, opts, env: { c, ctx } } = input;
  const remote = await git(clone, ["remote", "get-url", "origin"]);
  if (!remote.stdout.trim().endsWith(lane.repo) && !remote.stdout.trim().endsWith(`${lane.repo}.git`)) {
    ctx.err(`warning: origin does not match ${lane.repo}`);
  }
  const base = opts.base || c.baseBranch;
  const fetch = await git(clone, ["fetch", "origin"], 12e4);
  const ref = await git(clone, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (ref.code !== 0) throw new Error(`base ${base} does not resolve`);
  if (fetch.code !== 0) ctx.err(`warning: fetch origin failed; using local ${base}`);
  return base;
}
async function addWorktree(input, git) {
  const { clone, lane, wt, base } = input;
  if (existsSync6(wt)) throw new Error(`worktree already exists: ${wt}`);
  if ((await git(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`])).code === 0) {
    throw new Error(`branch already exists: ${lane.branch}`);
  }
  const created = await git(clone, ["worktree", "add", "-b", lane.branch, wt, base], 12e4);
  if (created.code !== 0) throw new Error(`git worktree add failed: ${created.stderr.trim()}`);
}
function writePrompt(input, { c, root, ctx }) {
  const { lane, wt, base } = input;
  const { id, repo, branch } = lane;
  const prompt = expand(lane.prompt, c, root, ctx.home);
  mkdirSync8(dirname6(prompt), { recursive: true });
  const template = readTemplate(ctx, lane.role === "repo-orch" ? "repo-orchestrator.md" : "lane.md");
  const vars = {
    ...templateVars(c, ctx, root),
    id,
    repo,
    parent: effectiveParent(lane, c),
    parent_sh: shellQuote(effectiveParent(lane, c)),
    lanes: c.lanes.filter((l) => l.repo === repo).map((l) => l.id).join(", "),
    issue: lane.issue ?? "none",
    goal: lane.goal || "none",
    group: lane.group || "none",
    worktree: wt,
    branch,
    base
  };
  writeFileSync7(prompt, renderTemplate(template, vars), { flag: "wx" });
}
function invalidIssue(issue) {
  if (issue === void 0) return false;
  return !/^\d+$/.test(issue) || Number(issue) < 1;
}
function needsOrchestrator(plan, opts) {
  if (plan.current || !plan.siblings.length) return false;
  return !opts["no-orchestrator"];
}

// src/lanes/commands/resume.ts
import { join as join26, resolve as resolve8 } from "node:path";
import { existsSync as existsSync8, statSync as statSync6 } from "node:fs";

// src/lanes/commands/start.ts
import { existsSync as existsSync7, statSync as statSync5 } from "node:fs";

// src/lanes/sessions.ts
import { readdirSync as readdirSync6, statSync as statSync4 } from "node:fs";
import { join as join24 } from "node:path";

// src/lanes/processes.ts
async function runningPi(ctx) {
  const result = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 1e4 });
  if (result.code !== 0) return [];
  const found = [];
  for (const token of result.stdout.trim().split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number(token);
    const cwd = await processCwd2(ctx, pid);
    if (cwd) {
      try {
        found.push({ pid, cwd: ctx.realpath(cwd) });
      } catch {
      }
    }
  }
  return found;
}
async function ttyOf(ctx, pid) {
  const r = await ctx.run("ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: 1e4 });
  const tty = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9/]+$/.test(tty) ? tty : void 0;
}
async function processCwd2(ctx, pid) {
  if (ctx.readCwd) return ctx.readCwd(pid);
  const r = ctx.platform === "darwin" ? await ctx.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 1e4 }) : await ctx.run("readlink", [`/proc/${pid}/cwd`], { timeoutMs: 1e4 });
  if (r.code !== 0 || r.timedOut) return void 0;
  return ctx.platform === "darwin" ? r.stdout.split("\n").find((s) => s.startsWith("n"))?.slice(1) : r.stdout.trim();
}
async function foregroundPi(ctx, tty, pid, cwd) {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) return false;
  const r = await ctx.run("ps", ["-t", tty, "-o", "pid=,stat=,comm="], { timeoutMs: 1e4 });
  const matches = r.code === 0 && !r.timedOut && r.stdout.split("\n").some((line) => {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return m && Number(m[1]) === pid && m[2].includes("+") && m[3].split("/").at(-1) === "pi";
  });
  if (!matches) return false;
  try {
    const current = await processCwd2(ctx, pid);
    return Boolean(current && ctx.realpath(current) === ctx.realpath(cwd));
  } catch {
    return false;
  }
}
async function descendants(ctx, rootPid) {
  const r = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 1e4 });
  if (r.code !== 0) throw new Error("cannot inspect process descendants");
  const rows = r.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3] }] : [];
  });
  const ids = /* @__PURE__ */ new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) {
      ids.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((r2) => r2.pid !== rootPid && ids.has(r2.pid)).map((r2) => r2.command);
}
async function alive(ctx, pid) {
  return (await ctx.run("ps", ["-p", String(pid)], { timeoutMs: 1e4 })).code === 0;
}

// src/lanes/sessions.ts
function laneTarget(id, c, root, ctx) {
  const coordinator = id === "coordinator" || id === c.coordinator.id;
  const lane = c.lanes.find((l) => l.id === id);
  if (!coordinator && !lane) throw new Error(`lane not found: ${id}`);
  const cwd = coordinator ? expand(c.coordinator.cwd, c, root, ctx.home) : join24(expand(c.worktreesDir, c, root, ctx.home), lane.worktree);
  return { id: coordinator ? c.coordinator.id : id, cwd, coordinator, lane };
}
function idleMinutes2(cwd, ctx) {
  try {
    const dir = sessionDirFor(cwd, ctx.piAgentDir);
    const times = readdirSync6(dir).map((n) => statSync4(join24(dir, n))).filter((s) => s.isFile()).map((s) => s.mtimeMs);
    return times.length ? Math.max(0, Math.floor((ctx.now().getTime() - Math.max(...times)) / 6e4)) : void 0;
  } catch {
    return void 0;
  }
}
async function piIn(cwd, ctx) {
  const processes = await runningPi(ctx);
  try {
    return processes.find((p) => p.cwd === ctx.realpath(cwd))?.pid;
  } catch {
    return void 0;
  }
}

// src/lanes/retention.ts
import { closeSync, copyFileSync as copyFileSync2, lstatSync as lstatSync4, mkdirSync as mkdirSync9, openSync, readdirSync as readdirSync7, renameSync as renameSync4, unlinkSync as unlinkSync3, utimesSync } from "node:fs";
import { join as join25 } from "node:path";
var DAY = 864e5;
function stat(path) {
  try {
    return lstatSync4(path);
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
}
function messages(dir) {
  const info = stat(dir);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`not a regular directory: ${dir}`);
  return readdirSync7(dir).flatMap((name) => {
    const parsed = parseMessageName(name);
    if (!parsed || name.startsWith(".")) return [];
    const path = join25(dir, name);
    const info2 = stat(path);
    return info2?.isFile() ? [{ name, path, info: info2, ...parsed, at: info2.mtime }] : [];
  });
}
function unread(m, c, dir) {
  const broadcast = addressed(m, "ALL") || addressed(m, c.messages.broadcast);
  return [{ id: c.coordinator.id, group: null }, ...c.lanes].some(({ id, group }) => {
    if (!broadcast && ![id, ...group ? [group] : []].some((recipient2) => addressed(m, recipient2))) return false;
    const marker = stat(join25(dir, `${id}-inbox.marker`));
    return marker?.isFile() === true && marker.mtimeMs < m.info.mtimeMs;
  });
}
function archive2(m, dir) {
  mkdirSync9(dir, { recursive: true });
  const target = join25(dir, m.name);
  try {
    closeSync(openSync(target, "wx"));
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    try {
      renameSync4(m.path, target);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      copyFileSync2(m.path, target);
      utimesSync(target, m.info.atime, m.info.mtime);
      unlinkSync3(m.path);
    }
  } catch (e) {
    unlinkSync3(target);
    throw e;
  }
  return true;
}
function prune(c, root, ctx, dryRun = false) {
  const counts = { archived: 0, deleted: 0, skippedUnread: 0, skippedCollision: 0, kept: 0, archiveExpired: 0 };
  const dir = expand(c.messages.dir, c, root, ctx.home);
  const r = c.messages.retention;
  if (!r || r.mode === "keep" && r.archiveMaxAgeDays === null) {
    counts.kept = messages(dir).length;
    return counts;
  }
  const destination = archiveDir(c, root, ctx.home);
  const destinationInfo = stat(destination);
  if (destinationInfo && (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink())) throw new Error(`not a regular directory: ${destination}`);
  const now = ctx.now().getTime();
  if (r.archiveMaxAgeDays !== null) {
    for (const m of messages(destination)) {
      if (m.info.mtimeMs >= now - r.archiveMaxAgeDays * DAY) continue;
      if (!dryRun) unlinkSync3(m.path);
      counts.archiveExpired++;
    }
  }
  for (const m of messages(dir)) {
    if (r.mode === "keep" || m.info.mtimeMs >= now - r.maxAgeDays * DAY) {
      counts.kept++;
      continue;
    }
    if (r.keepUnread && unread(m, c, dir)) {
      counts.skippedUnread++;
      continue;
    }
    if (r.mode === "delete") {
      if (!dryRun) unlinkSync3(m.path);
      counts.deleted++;
      continue;
    }
    const target = stat(join25(destination, m.name));
    const expired = target?.isFile() && r.archiveMaxAgeDays !== null && target.mtimeMs < now - r.archiveMaxAgeDays * DAY;
    if (target && !(dryRun && expired) || !dryRun && !archive2(m, destination)) {
      counts.skippedCollision++;
      continue;
    }
    counts.archived++;
  }
  return counts;
}
function messagesPrune(opts, c, root, ctx) {
  const counts = prune(c, root, ctx, opts["dry-run"] === "true");
  ctx.out(opts.json === "true" ? JSON.stringify(counts) : `archived: ${counts.archived}, deleted: ${counts.deleted}, skipped (unread): ${counts.skippedUnread}, skipped (collision): ${counts.skippedCollision}, kept: ${counts.kept}, archive-expired: ${counts.archiveExpired}`);
  return 0;
}

// src/lanes/commands/start.ts
async function start(id, opts, c, root, ctx) {
  rejectRetired(id, c);
  const { coordinator, lane, cwd } = laneTarget(id, c, root, ctx);
  const prompt = expand(coordinator ? c.coordinator.prompt : lane.prompt, c, root, ctx.home);
  if (!existsSync7(cwd) || !statSync5(cwd).isDirectory()) throw new Error(`cwd not found: ${cwd}`);
  if (!existsSync7(prompt) || !statSync5(prompt).isFile()) throw new Error(`prompt not found: ${prompt}`);
  const duplicate = (await runningPi(ctx)).find((p) => p.cwd === ctx.realpath(cwd));
  if (duplicate) throw new Error(`already running in ${cwd} (pid ${duplicate.pid}); not starting a second session`);
  if (!coordinator || !c.launch.preapproveMcp) await preapprove(ctx, cwd, c.launch.preapproveMcp);
  const backend = detectBackend(opts.terminal || c.terminal.backend, ctx);
  let wrapper = ctx.which(c.launch.wrapper);
  if (!wrapper) {
    wrapper = ctx.which("pi");
    if (wrapper) ctx.err("pi-session not found; starting pi directly (no relaunch after a context handoff)");
    else if (backend === "print") {
      wrapper = c.launch.wrapper;
      ctx.err(`${c.launch.wrapper} and pi not found; printing the command only`);
    } else throw new Error("pi not found");
  }
  if (c.messages.retention?.auto) {
    try {
      prune(c, root, ctx);
    } catch (e) {
      ctx.err(`warning: message prune failed: ${e.message.replace(/\s+/g, " ")}`);
    }
  }
  const command = launchCommand(c, root, cwd, coordinator ? c.coordinator.id : id, prompt, wrapper, expand(c.messages.dir, c, root, ctx.home));
  return terminalBackend(backend).start(ctx, { id: coordinator ? c.coordinator.id : id, cwd, command });
}
function rejectRetired(id, c) {
  if (c.lanes.find((l) => l.id === id)?.retired) throw new Error(`lane ${id} is retired; add a fresh lane instead`);
}

// src/lanes/commands/resume.ts
async function startCommand(id, opts, env) {
  if (opts["from-handoff"]) return fromHandoff({ id, opts }, env);
  return start(id, opts, env.c, env.root, env.ctx);
}
async function resume(args, opts, env) {
  return fromHandoff({ id: args[0], opts: { ...opts, "from-handoff": args[0] } }, env);
}
function filePath(value, env) {
  return env.c.lanes.some((lane) => lane.id === value) ? join26(env.root, ".state/handoffs", `${value}.md`) : resolve8(env.ctx.cwd, value);
}
function sourceLane(snapshot, env) {
  const { c, ctx, root } = env;
  const lanes = c.lanes.filter((lane) => lane.repo === snapshot.repo && lane.branch === snapshot.branch);
  const source = lanes.find((lane) => ctx.realpath(join26(expand(c.worktreesDir, c, root, ctx.home), lane.worktree)) === ctx.realpath(snapshot.worktree));
  if (!source) throw new UsageError("handoff does not match a configured lane worktree");
  return source;
}
function restoreLane(input, env) {
  const { c } = env;
  const { id, path, source } = input;
  validateTarget({ id, source }, env);
  return { ...source, id, prompt: path, retired: false, parent: activeParent(source, env) };
}
function validateTarget({ id, source }, { c }) {
  if (!validId(id) || [c.coordinator.id, "ALL", c.messages.broadcast].includes(id)) {
    throw new UsageError("invalid lane id");
  }
  if (id !== source.id && c.lanes.some((lane) => lane.id === id)) throw new UsageError("resume target lane already exists");
}
function activeParent(source, { c }) {
  const parent = effectiveParent(source, c);
  if (parent === c.coordinator.id) return parent;
  if (c.lanes.some((lane) => lane.id === parent && !lane.retired)) return parent;
  return c.coordinator.id;
}
async function verifyWorktree(snapshot, env) {
  requireWorktree(snapshot.worktree);
  const head = await env.ctx.run(
    "git",
    ["--no-optional-locks", "-C", snapshot.worktree, "rev-parse", "HEAD"],
    { timeoutMs: 4e3 }
  );
  if (head.code || head.timedOut) throw new Error("handoff HEAD changed");
  if (head.stdout.trim() !== snapshot.head) throw new Error("handoff HEAD changed");
}
async function fromHandoff(input, env) {
  const { c, root, ctx } = env;
  const path = filePath(input.opts["from-handoff"], env);
  const file = readContext(path);
  const source = sourceLane(file.snapshot, env);
  await verifyWorktree(file.snapshot, env);
  const restored = restoreLane({ id: input.id, path, source }, env);
  const lanes = c.lanes.filter((lane) => lane.id !== input.id).concat(restored);
  const next = { ...c, lanes };
  validate(next, root, ctx.home);
  const opts = { ...input.opts };
  delete opts["from-handoff"];
  const code = await start(input.id, opts, next, root, ctx);
  if (code === 0) {
    saveConfig(root, next);
    c.lanes = lanes;
  }
  return code;
}
function requireWorktree(path) {
  if (!existsSync8(path) || !statSync6(path).isDirectory()) throw new Error("handoff worktree missing");
}

// src/lanes/commands/send.ts
import { readFileSync as readFileSync11 } from "node:fs";
import { resolve as resolve9 } from "node:path";
async function send(args, opts, c, root, ctx) {
  let [to, topic, file] = args;
  const from = opts.from || ctx.env.PI_ORCH_ID;
  if (!from) throw new UsageError("set --from or PI_ORCH_ID");
  if (!validId(from)) throw new UsageError("invalid from");
  if (!validId(to)) throw new UsageError("invalid to");
  if (!validTopic(topic)) throw new UsageError("invalid topic");
  if (opts.m !== void 0 && file !== void 0) throw new UsageError("choose a file or -m, not both");
  const known = [c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.flatMap((l) => [l.id, l.group])];
  if (!known.includes(to)) ctx.err(`warning: unknown recipient ${to}; sending anyway`);
  const body = opts.m !== void 0 ? opts.m : file && file !== "-" ? readFileSync11(resolve9(ctx.cwd, file), "utf8") : file === "-" || !ctx.stdinTTY ? await ctx.readStdin() : "";
  if (!body.trim()) throw new UsageError("empty message body");
  to = route({ to, from, direct: opts.direct }, c, ctx);
  ctx.out((await backendFor(c, ctx, root).send({ from, to, topic, body })).path);
  return 0;
}
function route(input, c, ctx) {
  const sender = c.lanes.find((l) => l.id === input.from && !l.retired);
  if (!routeToParent(input, sender, c)) return input.to;
  const parent = effectiveParent(sender, c);
  if (parent !== input.to) {
    ctx.err(`routed to ${parent} (repo orchestrator of ${sender.repo}); --direct to bypass`);
    return parent;
  }
  return input.to;
}
function routeToParent(input, sender, c) {
  if (input.direct || input.to !== c.coordinator.id) return false;
  return Boolean(sender && sender.role !== "repo-orch");
}

// src/lanes/commands/idle-check.ts
async function idleCheck(opts, c, root, ctx) {
  const backend = backendFor(c, ctx, root);
  const silent = [];
  for (const lane of c.lanes) {
    const line = await backend.status(lane.id);
    if (parseStatus(line).kind === "closed" || suppressed(line, ctx.now())) continue;
    const { cwd } = laneTarget(lane.id, c, root, ctx);
    const pid = await piIn(cwd, ctx);
    if (!pid || (await descendants(ctx, pid)).some((s) => /\bpi-phase run\b/.test(s))) continue;
    const minutes = idleMinutes2(cwd, ctx);
    if (minutes !== void 0 && minutes > Number(opts.minutes ?? c.idle?.minutes ?? 75)) silent.push(`${lane.id}:${minutes}m`);
  }
  if (!silent.length) return 1;
  ctx.out(`silent: ${silent.join(" ")}`);
  return 0;
}

// src/lanes/commands/nudge.ts
async function nudge(id, text, opts, c, root, ctx) {
  text = text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (!text || text.length > 2e3) throw new UsageError("nudge text must be between 1 and 2000 characters");
  const target = laneTarget(id, c, root, ctx);
  const refuse = (why) => {
    ctx.err(`NOT SENT: ${why}`);
    return 3;
  };
  if (parseStatus(await backendFor(c, ctx, root).status(target.id)).kind === "closed") return refuse(`${target.id} is closed`);
  const pid = await piIn(target.cwd, ctx);
  if (!pid) return refuse(`no pi running in ${target.cwd}`);
  const tty = await ttyOf(ctx, pid);
  if (!tty) return refuse(`${target.id} has no tty`);
  if (!await foregroundPi(ctx, tty, pid, target.cwd)) return refuse(`no foreground pi on ${tty} (lane stopped or busy in a subshell)`);
  const backend = detectBackend(opts.terminal || c.terminal.backend, ctx);
  if (backend === "print") {
    ctx.out(`nudge ${target.id} (tty ${tty}): type this into its pi session: ${text}`);
    return 4;
  }
  if (await terminalBackend(backend).nudge(ctx, { tty, text }) !== "sent") return 4;
  ctx.out(`nudged ${target.id}`);
  return 0;
}

// src/lanes/commands/resume-check.ts
import { existsSync as existsSync9, readFileSync as readFileSync12, statSync as statSync8 } from "node:fs";
import { join as join28 } from "node:path";

// src/lanes/joblogs.ts
import { closeSync as closeSync2, openSync as openSync2, readSync, readdirSync as readdirSync8, statSync as statSync7 } from "node:fs";
import { join as join27 } from "node:path";
function parseWatches(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const [tag, label, until2, interval, ...check] = line.split("|");
    if (tag !== "WATCH") return [];
    if (!label || !until2 || !/^\d+$/.test(interval) || Number(interval) <= 0 || !check.join("|")) throw new Error("invalid WATCH line");
    return [{ label, until: until2, interval: Number(interval), check: check.join("|") }];
  });
}
function chunk(path, length, position) {
  const fd = openSync2(path, "r");
  try {
    const b = Buffer.alloc(length);
    return b.subarray(0, readSync(fd, b, 0, length, position)).toString("utf8");
  } finally {
    closeSync2(fd);
  }
}
function day(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function liveWatch(jobs, watch, now) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const date of [now, yesterday]) {
    const dir = join27(jobs, day(date));
    let names;
    try {
      names = readdirSync8(dir);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const name of names.filter((n) => n.endsWith(".log"))) {
      const path = join27(dir, name);
      const stat2 = statSync7(path);
      if (!stat2.isFile() || !chunk(path, Math.min(4096, stat2.size), 0).split("\n")[0].includes(watch.check)) continue;
      const tail = chunk(path, Math.min(65536, stat2.size), Math.max(0, stat2.size - 65536));
      const last = tail.split("\n").filter((s) => /^--- check .* exit \d+ ---$/.test(s)).at(-1);
      if (watch.until === "success" && /exit 0 ---$/.test(last || "")) continue;
      if (now.getTime() - stat2.mtimeMs <= (watch.interval + 90) * 1e3) return true;
    }
  }
  return false;
}

// src/lanes/commands/resume-check.ts
async function livePrs(text, ctx) {
  if (!ctx.which("gh")) return;
  const refs = new Set(text.match(/\bPR [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g));
  for (const ref of refs) {
    const [repo, n] = ref.slice(3).split("#");
    let state = "unknown";
    const r = await ctx.run("gh", ["pr", "view", n, "--repo", repo, "--json", "state,mergeStateStatus,headRefOid"], { timeoutMs: 3e4 });
    if (r.code === 0) {
      try {
        const p = JSON.parse(r.stdout);
        state = `${p.state} ${p.mergeStateStatus} ${String(p.headRefOid).slice(0, 9)}`;
      } catch {
      }
    }
    ctx.out(`LIVE    ${ref.slice(3)}: ${state}`);
  }
}
async function resumeCheck(c, root, ctx) {
  const now = ctx.now();
  let bad = false;
  ctx.out(`date: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const watches = join28(root, "coordinator/WATCHES.md");
  if (!existsSync9(watches)) {
    ctx.out("MISSING coordinator/WATCHES.md");
    bad = true;
  } else for (const w of parseWatches(readFileSync12(watches, "utf8"))) {
    if (liveWatch(join28(ctx.piAgentDir, "jobs"), w, now)) ctx.out(`OK      watch: ${w.label}`);
    else {
      ctx.out(`MISSING watch: ${w.label} -> job_watch until=${w.until} interval=${w.interval} check from coordinator/WATCHES.md`);
      bad = true;
    }
  }
  const unread2 = await backendFor(c, ctx, root).unread(c.coordinator.id);
  if (unread2 === void 0) {
    ctx.out("MISSING inbox marker: the coordinator inbox watch has not run");
    bad = true;
  } else {
    const old = unread2.filter((m) => now.getTime() - m.at.getTime() > 3e5);
    for (const m of old) ctx.out(`UNREAD  inbox: ${m.name}`);
    if (old.length) bad = true;
    else ctx.out("OK      inbox: no unread backlog");
  }
  const path = join28(root, "coordinator/NOW.md");
  if (!existsSync9(path)) {
    ctx.out("MISSING coordinator/NOW.md");
    bad = true;
  } else {
    await livePrs(readFileSync12(path, "utf8"), ctx);
    const age = Math.floor((now.getTime() - statSync8(path).mtimeMs) / 6e4);
    if (age > 90) {
      ctx.out(`STALE   NOW.md not updated for ${age} min`);
      bad = true;
    }
  }
  const questions = join28(ctx.piAgentDir, "local-packages/pi-questions/dist/cli.js");
  if (existsSync9(questions)) {
    const r = await ctx.run(process.execPath, [questions, "list", "--all"], { timeoutMs: 15e3 });
    for (const line of r.stdout.split("\n").filter((s) => /^Q-\d+/.test(s))) ctx.out(`OPEN    ${line}`);
  }
  return bad ? 1 : 0;
}

// src/lanes/commands/green-prs.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync10, readFileSync as readFileSync13, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join29 } from "node:path";
function green(pr, excluded) {
  return !pr.isDraft && !pr.labels.some((l) => excluded.includes(l.name)) && pr.statusCheckRollup.length > 0 && pr.statusCheckRollup.every((s) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(s.conclusion ?? s.state ?? ""));
}
async function greenPrs(opts, c, root, ctx) {
  if (opts.new && opts.ack) throw new UsageError("--new and --ack are mutually exclusive");
  const repos = c.github?.repos.length ? c.github.repos : [.../* @__PURE__ */ new Set([...c.lanes.map((l) => l.repo), ...Object.keys(c.repos)])];
  if (!repos.length) {
    ctx.err("no repositories configured (lanes.json github.repos)");
    return 1;
  }
  if (!ctx.which("gh")) {
    ctx.err("gh not found");
    return 2;
  }
  const refs = [];
  for (const repo of repos) {
    const r = await ctx.run("gh", ["pr", "list", "--repo", repo, "--author", c.github?.author || "@me", "--state", "open", "--limit", "100", "--json", "number,isDraft,labels,statusCheckRollup"], { timeoutMs: 3e4 });
    if (r.code !== 0 || r.timedOut) {
      ctx.err(`gh pr list failed for ${repo}: ${r.stderr.trim()}`);
      return 2;
    }
    try {
      const prs = JSON.parse(r.stdout);
      refs.push(...prs.filter((p) => green(p, c.github?.excludeLabels || [])).map((p) => `${repo}#${p.number}`));
    } catch {
      ctx.err(`invalid gh pr list response for ${repo}`);
      return 2;
    }
  }
  refs.sort();
  const ack = join29(root, ".state/green-ack");
  if (opts.ack) {
    mkdirSync10(join29(root, ".state"), { recursive: true });
    writeFileSync8(ack, refs.length ? `${refs.join("\n")}
` : "");
    ctx.out(`acked ${refs.length}`);
    return 0;
  }
  const previous = opts.new && existsSync10(ack) ? readFileSync13(ack, "utf8").split(/\r?\n/) : [];
  const output = opts.new ? refs.filter((r) => !previous.includes(r)) : refs;
  if (output.length) ctx.out(output.join("\n"));
  return opts.new && !output.length ? 1 : 0;
}

// src/lanes/commands/close.ts
import { basename as basename2, dirname as dirname7 } from "node:path";
function closeBody(id, to, reason, unread2) {
  const body = [
    `Lane ${id} is closed.${to ? ` Reassigned to ${to}.` : ""}${reason ? ` Reason: ${clean(reason)}` : ""}`,
    "",
    `${to ? `${to}: pick up` : "Pick up"} the work and any unread messages of ${id}. No message file was moved or edited.`,
    ""
  ];
  if (unread2 === void 0) body.push(`Unread inbox of ${id}: none known (${id}-inbox.marker does not exist).`);
  else if (unread2.length) body.push(`Unread inbox files of ${id} (newer than ${id}-inbox.marker):`, ...unread2.map((m) => `- ${m.name}`));
  else body.push(`Unread inbox files of ${id}: none.`);
  return `${body.join("\n")}
`;
}
async function quit(id, pid, cwd, c, root, ctx) {
  const busy = (await descendants(ctx, pid)).filter((cmd) => /\bpi-phase run\b/.test(cmd) || /^(dotnet|vstest.*|testhost.*|npm|yarn|pnpm|pi-phase|git|docker|make)$/i.test(basename2(cmd.split(/\s+/)[0])));
  if (busy.length) {
    ctx.err(`REFUSED: busy children: ${busy.join(" ")}`);
    return false;
  }
  const age = idleMinutes2(cwd, ctx);
  if (age !== void 0 && age < 3) {
    ctx.err("REFUSED: session wrote less than 180s ago");
    return false;
  }
  if (await nudge(id, "/quit", {}, c, root, ctx) !== 0) return false;
  for (let i = 0; i < 10; i++) {
    await (ctx.sleep ? ctx.sleep(1e3) : new Promise((done) => setTimeout(done, 1e3)));
    if (!await alive(ctx, pid)) return true;
  }
  ctx.err(`REFUSED: pi ${pid} did not quit`);
  return false;
}
async function close(id, opts, c, root, ctx) {
  if (!c.lanes.some((l) => l.id === id)) throw new UsageError(`not a lane: ${id}`);
  const to = opts["reassign-to"];
  const from = opts.from || ctx.env.PI_ORCH_ID || c.coordinator.id;
  if (to && (!validId(to) || to === id)) throw new UsageError("--reassign-to must be a valid id different from the closed lane");
  if (!validId(from)) throw new UsageError("invalid sender id");
  if (to && to !== c.coordinator.id && !c.lanes.some((l) => l.id === to)) ctx.err(`unknown reassignment target: ${to}`);
  const target = laneTarget(id, c, root, ctx);
  const common = await ctx.run("git", ["-C", target.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 1e4 });
  if (common.code !== 0 || common.timedOut || !common.stdout.trim()) throw new Error("cannot find clone for worktree removal hint");
  const clone = shellQuote(dirname7(common.stdout.trim()));
  const wt = shellQuote(target.cwd);
  const backend = backendFor(c, ctx, root);
  const unread2 = await backend.unread(id, { groups: target.lane?.group ? [target.lane.group] : [] });
  const pid = await piIn(target.cwd, ctx);
  if (pid && opts.quit && !await quit(id, pid, target.cwd, c, root, ctx)) return 1;
  if (pid && !opts.quit) ctx.err(`${id} is still running; type /quit in its session or use --quit`);
  const line = closedLine(to, opts.reason, ctx.now());
  await backend.setStatus(id, line);
  const message = await backend.send({ from, to: c.messages.broadcast, topic: `lane-closed-${id.toLowerCase()}`, body: closeBody(id, to, opts.reason, unread2) });
  ctx.out(`${id}: ${line}`);
  ctx.out(message.path);
  ctx.out(`when merged, remove the worktree: git -C ${clone} worktree unlock ${wt} && git -C ${clone} worktree remove ${wt}`);
  return 0;
}

// src/lanes/commands/status.ts
import { existsSync as existsSync11 } from "node:fs";
import { join as join30 } from "node:path";
async function status(c, root, ctx, all = false) {
  const backend = backendFor(c, ctx, root);
  const processes = await runningPi(ctx);
  const rows = [["LANE", "ROLE", "PARENT", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  for (const lane of statusLanes({ c, root, ctx }, all)) {
    const pid = findPid(lane.cwd, processes, ctx);
    const messages2 = [
      ...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }),
      ...await backend.list({ from: lane.id, limit: 1 })
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    rows.push([
      lane.label,
      lane.role,
      lane.parent,
      lane.repo,
      lane.branch,
      pid,
      String(idleMinutes2(lane.cwd, ctx) ?? "-"),
      await backend.status(lane.id) || "-",
      lastMessage(messages2[0], ctx)
    ]);
  }
  warnMissingOrchestrators(c, ctx);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  ctx.out(rows.map((r) => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  return 0;
}
function statusLanes(env, all) {
  const { c, root, ctx } = env;
  return [
    {
      id: c.coordinator.id,
      repo: "-",
      branch: "-",
      group: null,
      role: "coord",
      parent: "-",
      label: c.coordinator.id,
      cwd: expand(c.coordinator.cwd, c, root, ctx.home)
    },
    ...laneTree(c, all).map(({ lane, depth }) => ({
      ...lane,
      role: lane.role || "lane",
      parent: effectiveParent(lane, c),
      label: "  ".repeat(depth) + lane.id,
      cwd: join30(expand(c.worktreesDir, c, root, ctx.home), lane.worktree)
    }))
  ];
}
function findPid(cwd, processes, ctx) {
  let pid = "missing";
  if (existsSync11(cwd)) {
    try {
      pid = String(processes.find((p) => p.cwd === ctx.realpath(cwd))?.pid || "-");
    } catch {
    }
  }
  return pid;
}
function lastMessage(last, ctx) {
  return last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 6e4))}m)` : "-";
}
function warnMissingOrchestrators(c, ctx) {
  for (const repo of new Set(c.lanes.filter((l) => !l.retired).map((l) => l.repo))) {
    const lanes = c.lanes.filter((l) => !l.retired && l.repo === repo);
    if (lanes.length > 1 && !lanes.some((l) => l.role === "repo-orch")) {
      ctx.err(`warning: ${repo}: ${lanes.length} lanes, no repo-orch`);
    }
  }
}

// src/lanes/main.ts
var HELP = `Usage: lanes [--dir root] <command> [options]
  init [dir] [--repos-root p] [--coordinator ID] [--terminal backend] [--preapprove-mcp]
  add <ID> --repo owner/name [--issue n] [--goal text] [--group G] [--branch b] [--base ref] [--path clone]
    [--orchestrator ID | --orchestrator-id ID | --no-orchestrator]
  start <ID>|coordinator [--terminal backend] [--from-handoff ID|file]
  resume <ID> [--terminal backend]
  send <TO> <topic> [file|-] [-m text] [--from ID] [--direct]
  status [--all]
  messages prune [--dry-run] [--json]
  idle-check [--minutes n]
  nudge <ID|coordinator> <text> [--terminal backend]
  resume-check
  green-prs [--new | --ack]
  reap [ID] [--minutes n] [--dry-run | --apply] [--handoff-to ID] [--json]
  handoff <ID> --to ID | --accept --from ID
  snooze <ID> --until ISO|+90m | --clear
  close <ID> [--reassign-to ID2] [--reason text] [--from ID] [--quit]
Ops exits: 0 fire/OK, 1 nothing/missing, 2 usage/I/O/gh failure.
Nudge: 0 sent, 3 not sent, 4 tab/pane not found or print.
Terminal backends: auto, terminal-app, iterm, tmux, print. Auto falls back to print.
--preapprove-mcp trusts project MCP server definitions in explicitly added repositories.`;
var OPTIONS = {
  init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"],
  add: [
    "repo",
    "issue",
    "goal",
    "group",
    "branch",
    "base",
    "path",
    "orchestrator",
    "orchestrator-id",
    "no-orchestrator"
  ],
  start: ["terminal", "from-handoff"],
  resume: ["terminal"],
  send: ["m", "from", "direct"],
  status: ["all"],
  messages: ["dry-run", "json"],
  "idle-check": ["minutes"],
  nudge: ["terminal"],
  "resume-check": [],
  "green-prs": ["new", "ack"],
  handoff: ["to", "accept", "from"],
  reap: ["minutes", "dry-run", "json", "apply", "handoff-to"],
  snooze: ["until", "clear"],
  close: ["reassign-to", "reason", "from", "quit", "inactive", "json", "minutes", "dry-run", "apply", "handoff-to"]
};
var FLAGS = [
  "preapprove-mcp",
  "new",
  "ack",
  "quit",
  "dry-run",
  "json",
  "direct",
  "all",
  "no-orchestrator",
  "inactive",
  "clear",
  "apply",
  "accept"
];
function parseOption(argv, i, opts) {
  const token = argv[i];
  const { equals, key } = optionName({ argv, index: i });
  if (FLAGS.includes(key)) {
    if (equals >= 0) throw new UsageError(`unknown option ${token}`);
    opts[key] = "true";
    return i;
  }
  if (equals < 0) requireValue({ argv, index: i });
  if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
  opts[key] = equals < 0 ? argv[++i] : token.slice(equals + 1);
  return i;
}
function requireValue({ argv, index }) {
  const value = argv[index + 1];
  if (value === void 0 || value.startsWith("--")) throw new UsageError(`missing value for ${argv[index]}`);
}
function parse(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--") || token === "-m") i = parseOption(argv, i, opts);
    else appendPositional({ argv, index: i }, positional);
  }
  return { positional, opts };
}
function validateInvocation({ command, positional, opts }) {
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(HELP);
  validateOptions({ command, opts });
  const bounds = {
    init: [0, 1],
    add: [1, 1],
    start: [1, 1],
    resume: [1, 1],
    send: [2, 3],
    status: [0, 0],
    messages: [1, 1],
    "idle-check": [0, 0],
    nudge: [2, 2],
    "resume-check": [0, 0],
    "green-prs": [0, 0],
    handoff: [1, 1],
    reap: [0, 1],
    snooze: [1, 1],
    close: [opts.inactive ? 0 : 1, 1]
  };
  validateBounds(positional, bounds[command]);
  if (command === "messages" && positional[0] !== "prune") throw new UsageError(HELP);
  validateMinutes(opts.minutes);
}
function validateMinutes(minutes) {
  if (minutes === void 0) return;
  if (invalidMinutes(minutes)) {
    throw new UsageError("--minutes must be a positive integer");
  }
}
async function dispatch(input, env) {
  const { command, positional: args, opts } = input;
  const { c, root, ctx } = env;
  const handlers = {
    add: () => add(args[0], opts, c, root, ctx),
    start: () => startCommand(args[0], opts, env),
    resume: () => resume(args, opts, env),
    messages: () => messagesPrune(opts, c, root, ctx),
    send: () => send(args, opts, c, root, ctx),
    "idle-check": () => idleCheck(opts, c, root, ctx),
    nudge: () => nudge(args[0], args[1], opts, c, root, ctx),
    "resume-check": () => resumeCheck(c, root, ctx),
    "green-prs": () => greenPrs(opts, c, root, ctx),
    handoff: () => handoff(args, opts, env),
    snooze: () => snooze2(args, opts, env),
    reap: () => reap(args, opts, env),
    close: () => closeCommand(input, env),
    status: () => status(c, root, ctx, Boolean(opts.all))
  };
  return await handlers[command]();
}
function closeCommand({ positional, opts }, env) {
  if (opts.inactive) return reap(positional, opts, env);
  return close(positional[0], opts, env.c, env.root, env.ctx);
}
function errorCode({ e, command }) {
  return e instanceof UsageError || [
    "idle-check",
    "nudge",
    "resume-check",
    "green-prs",
    "close",
    "reap",
    "snooze",
    "handoff"
  ].includes(command) ? 2 : 1;
}
async function main(argv, ctx) {
  let command = "";
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      ctx.out(HELP);
      return 0;
    }
    const { positional, opts } = parse(argv);
    command = positional.shift() || "";
    const input = { command, positional, opts };
    validateInvocation(input);
    if (command === "init") return await init(positional, opts, ctx);
    const root = findRoot(opts.dir, ctx.env, ctx.cwd);
    const c = loadConfig(root);
    return await dispatch(input, { c, root, ctx });
  } catch (e) {
    ctx.err(e.message);
    return errorCode({ e, command });
  }
}
function optionName({ argv, index }) {
  const token = argv[index];
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  const key = token === "-m" ? "m" : token.slice(2, equals < 0 ? void 0 : equals);
  return { equals, key };
}
function validateOptions({ command, opts }) {
  for (const key of Object.keys(opts)) {
    if (key !== "dir" && !OPTIONS[command].includes(key)) throw new UsageError(`unknown option --${key}`);
  }
}
function invalidMinutes(minutes) {
  if (!/^\d+$/.test(minutes)) return true;
  return !Number.isSafeInteger(Number(minutes)) || Number(minutes) <= 0;
}
function validateBounds(args, bounds) {
  if (args.length < bounds[0] || args.length > bounds[1]) throw new UsageError(HELP);
}
function appendPositional({ argv, index }, positional) {
  const token = argv[index];
  if (token.startsWith("-") && token !== "-") throw new UsageError(`unknown option ${token}`);
  positional.push(token);
}

// src/lanes/cli.ts
if (process.argv[1] && realpathSync3(process.argv[1]) === fileURLToPath2(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realLanesCtx());
}
export {
  main
};
