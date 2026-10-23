#!/usr/bin/env node
// pi-setup-source-sha256: 47a5ed41f84322cd948c95d36f9c42df7cda2b08b36028af8be2994d2bfe16dd
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/context.ts
var context_exports = {};
__export(context_exports, {
  realContext: () => realContext,
  realRun: () => realRun,
  realWhich: () => realWhich
});
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
function inherited(cmd, args, options) {
  return new Promise((resolve8) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (error) => resolve8({ code: null, stdout: "", stderr: error.message, timedOut: false }));
    child.on("close", (code) => resolve8({ code, stdout: "", stderr: "", timedOut: false }));
  });
}
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
function realContext(repoDir2) {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    repoDir: repoDir2,
    nodePath: process.execPath,
    now: () => /* @__PURE__ */ new Date(),
    run: realRun,
    which: realWhich(process.env),
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    nodeVersion: process.version,
    out: (line) => process.stdout.write(`${line}
`),
    err: (line) => process.stderr.write(`${line}
`)
  };
}
var MAX_BUFFER, realRun;
var init_context = __esm({
  "src/context.ts"() {
    MAX_BUFFER = 16 * 1024 * 1024;
    realRun = (cmd, args, options = {}) => {
      if (options.inherit) return inherited(cmd, args, options);
      return new Promise((resolve8) => {
        const child = execFile(
          cmd,
          args,
          { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
          (error, stdout2, stderr) => {
            const failure = error;
            const code = failure ? typeof failure.code === "number" ? failure.code : null : 0;
            resolve8({
              code,
              stdout: String(stdout2 ?? ""),
              stderr: failure && code === null && !stderr ? failure.message : String(stderr ?? ""),
              timedOut: Boolean(failure?.killed)
            });
          }
        );
        child.stdin?.end();
      });
    };
  }
});

// src/types.ts
var SetupError, PROVIDER_IDS, PROVIDER_LABELS, CANCEL;
var init_types = __esm({
  "src/types.ts"() {
    SetupError = class extends Error {
    };
    PROVIDER_IDS = ["anthropic", "openai-codex", "kimi-coding"];
    PROVIDER_LABELS = {
      anthropic: "Claude",
      "openai-codex": "ChatGPT",
      "kimi-coding": "Kimi"
    };
    CANCEL = /* @__PURE__ */ Symbol("pi-setup-cancel");
  }
});

// src/settings.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { resolve } from "node:path";
function readSettings(path2) {
  if (!existsSync(path2)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(path2, "utf8"));
  } catch (error) {
    throw new SetupError(`${path2}: ${error.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SetupError(`${path2}: expected a JSON object`);
  }
  const record = data;
  for (const key of ["githubUser", "reposRoot"]) {
    const value = record[key];
    if (key in record && (typeof value !== "string" || !value.trim())) {
      throw new SetupError(`${path2}: ${key} must be a nonempty string`);
    }
  }
  return record;
}
function validLogin(login) {
  return LOGIN.test(login);
}
function expandHome(value, home = homedir2()) {
  if (value === "~") return home;
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}
function normalizeRoot(value, home, base) {
  const root = resolve(base, expandHome(value, home));
  if (FORBIDDEN_ROOT.test(root)) {
    throw new SetupError("Repositories root must be a single-line path without quotes, $, backticks or backslashes.");
  }
  return root;
}
function resolveSettings(input) {
  const savedUser = typeof input.saved.githubUser === "string" ? input.saved.githubUser : "";
  const savedRoot = typeof input.saved.reposRoot === "string" ? input.saved.reposRoot : "";
  const [githubUser, userSource] = pick([
    [input.flagUser, "flag"],
    [savedUser, "saved"],
    [input.detectedUser ?? "", "detected"]
  ]);
  if (!githubUser) throw new SetupError("Cannot determine GitHub login; pass --user <login> (or authenticate gh).");
  if (!validLogin(githubUser)) throw new SetupError("Invalid GitHub login; pass --user <login>.");
  const [rawRoot, rootSource] = pick([
    [input.flagRoot, "flag"],
    [savedRoot, "saved"],
    [input.scanRoot ?? "", "scan"],
    [`${input.home}/repos`, "default"]
  ]);
  const reposRoot = normalizeRoot(rawRoot, input.home, input.repoDir);
  const warnings = /\s/.test(reposRoot) ? [`Repositories root contains a space (${reposRoot}); shell scripts in bin/ may not quote it.`] : [];
  return { githubUser, reposRoot, userSource, rootSource, warnings };
}
function pick(choices) {
  return choices.find(([value]) => value) ?? ["", choices[choices.length - 1][1]];
}
function render(buf, settings2) {
  const text3 = buf.toString("utf8").split("{{GITHUB_USER}}").join(settings2.githubUser).split("{{REPOS_ROOT}}").join(settings2.reposRoot);
  return Buffer.from(text3, "utf8");
}
function hasTokens(buf) {
  return buf.includes("{{GITHUB_USER}}") || buf.includes("{{REPOS_ROOT}}");
}
function mergeUserJson(existing, settings2) {
  return { ...existing, githubUser: settings2.githubUser, reposRoot: settings2.reposRoot };
}
function deepEqual(a2, b) {
  return JSON.stringify(canonical(a2)) === JSON.stringify(canonical(b));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([x], [y2]) => x < y2 ? -1 : 1).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
var LOGIN, FORBIDDEN_ROOT;
var init_settings = __esm({
  "src/settings.ts"() {
    init_types();
    LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
    FORBIDDEN_ROOT = /[\n\r\0"'$`\\]/;
  }
});

// src/lanes-wizard.ts
import { existsSync as existsSync2 } from "node:fs";
import { isAbsolute, join as join2 } from "node:path";
async function collectLanes(p, input) {
  let dir = input.dir;
  if (!dir) {
    const initial = join2(input.reposRoot, ".lanes");
    const answer = await p.select({ message: "Workspace folder", initial, options: [
      { value: initial, label: initial, hint: existsSync2(join2(initial, "lanes.json")) ? "existing" : "new" },
      { value: "other", label: "Other\u2026" }
    ] });
    if (p.isCancel(answer)) return CANCEL;
    if (answer === "other") {
      const path2 = await p.text({ message: "Workspace folder (absolute or ~/)", validate: (v) => isAbsolute(expandHome(v, input.home)) ? void 0 : "Use an absolute path or ~/" });
      if (p.isCancel(path2)) return CANCEL;
      dir = expandHome(path2, input.home);
    } else dir = answer;
  }
  const repos = await p.multiselect({ message: "Repositories for lanes", initial: [], options: input.checkouts.map((c2) => ({ value: c2.path, label: c2.repo, hint: c2.path })) });
  if (p.isCancel(repos)) return CANCEL;
  if (!repos.length) {
    p.note("No repositories selected.");
    return CANCEL;
  }
  const ids = new Set(input.existingIdsFor?.(dir) ?? input.existingIds);
  const lanes = [];
  for (const path2 of repos) {
    const checkout = input.checkouts.find((c2) => c2.path === path2);
    const issues = await input.issues(checkout.repo);
    let issue;
    if (issues?.length) {
      const answer = await p.select({ message: `Work for ${checkout.repo}`, initial: "goal", options: [
        ...[...issues].sort((a2, b) => Number(b.mine) - Number(a2.mine)).slice(0, 15).map((i2) => ({ value: String(i2.number), label: `#${i2.number} ${i2.title}`.slice(0, 60) })),
        { value: "goal", label: "Type a goal\u2026" },
        { value: "skip", label: "Skip this repository" }
      ] });
      if (p.isCancel(answer)) return CANCEL;
      if (answer === "skip") continue;
      if (answer !== "goal") issue = Number(answer);
    } else p.note(`No issues available for ${checkout.repo}; type a goal instead.`);
    let goal;
    if (!issue) {
      const answer = await p.text({ message: `Goal for ${checkout.repo}`, validate: (v) => v.trim() ? void 0 : "Required" });
      if (p.isCancel(answer)) return CANCEL;
      goal = answer.trim();
    }
    let n3 = 1;
    while (ids.has(`L${n3}`)) n3++;
    const id = `L${n3}`;
    ids.add(id);
    lanes.push({ ...checkout, id, ...issue ? { issue } : { goal } });
  }
  if (!lanes.length) {
    p.note("No lanes selected.");
    return CANCEL;
  }
  p.note([`Folder: ${dir}`, ...lanes.map((l2) => `${l2.id}  ${l2.repo}  ${l2.issue ? `issue #${l2.issue}` : `goal: ${l2.goal}`}`), `Worktrees: ${join2(input.reposRoot, ".worktrees")}`].join("\n"), "Preview");
  const confirmed = await p.confirm({ message: "Create these lanes?", initial: true });
  return !p.isCancel(confirmed) && confirmed === true ? { dir, lanes } : CANCEL;
}
var init_lanes_wizard = __esm({
  "src/lanes-wizard.ts"() {
    init_settings();
    init_types();
  }
});

// src/repos-scan.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { dirname, join as join3 } from "node:path";
function originUrl(gitDir) {
  try {
    const config = readFileSync2(join3(gitDir, "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isCheckout(dir) {
  return existsSync3(join3(dir, ".git"));
}
function scoreCandidate(path2, owners, options) {
  const names = owners.filter(Boolean).map(escapeRegExp);
  const owned = names.length ? new RegExp(`[:/](${names.join("|")})/`, "i") : void 0;
  const list = (dir) => {
    try {
      return readdirSync(dir).filter((name) => !SKIP.has(name)).slice(0, options.maxChildren);
    } catch {
      return [];
    }
  };
  const points = (dir) => {
    const git2 = join3(dir, ".git");
    return 1 + (owned && statSync2(git2).isDirectory() && owned.test(originUrl(git2)) ? 1 : 0);
  };
  let score = 0;
  let budget = options.maxChildren * 4;
  for (const name of list(path2)) {
    if (options.expired()) break;
    const child = join3(path2, name);
    if (isCheckout(child)) {
      score += points(child);
      continue;
    }
    for (const grand of list(child)) {
      if (options.expired() || budget-- <= 0) break;
      if (isCheckout(join3(child, grand))) score += points(join3(child, grand));
    }
  }
  return score;
}
function scanRoots(candidates, owners, options) {
  const deadline = options.now() + (options.deadlineMs ?? 1500);
  const expired = () => options.now() > deadline;
  const seen = /* @__PURE__ */ new Set();
  const scored = [];
  for (const path2 of candidates) {
    if (seen.has(path2) || expired()) continue;
    seen.add(path2);
    scored.push({ path: path2, score: scoreCandidate(path2, owners, { maxChildren: options.maxChildren ?? 500, expired }) });
  }
  return scored.filter((c2) => c2.score > 0).sort((a2, b) => b.score - a2.score).slice(0, 3);
}
async function candidateRoots(ctx) {
  const list = [];
  const common = await ctx.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ctx.repoDir,
    timeoutMs: 3e3
  });
  if (common.code === 0 && common.stdout.trim()) list.push(dirname(dirname(dirname(common.stdout.trim()))));
  list.push(...NAMES.map((n3) => join3(ctx.home, n3)));
  if (ctx.platform === "darwin") {
    let volumes = [];
    try {
      volumes = readdirSync("/Volumes");
    } catch {
      volumes = [];
    }
    for (const volume of volumes) list.push(...NAMES.map((n3) => join3("/Volumes", volume, n3)));
  }
  return list;
}
function listCheckouts(root, max = 60) {
  const list = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const found = [];
  const add2 = (path2) => {
    const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(originUrl(join3(path2, ".git")));
    const repo = match ? `${match[1]}/${match[2]}` : "";
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) found.push({ repo, path: path2 });
  };
  for (const name of list(root)) {
    if (found.length >= max) break;
    const path2 = join3(root, name);
    if (isCheckout(path2)) add2(path2);
    else for (const child of list(path2)) {
      if (found.length >= max) break;
      if (isCheckout(join3(path2, child))) add2(join3(path2, child));
    }
  }
  return found;
}
var NAMES, SKIP;
var init_repos_scan = __esm({
  "src/repos-scan.ts"() {
    NAMES = ["repos", "src", "code", "dev", "projects", "git", "work", "source"];
    SKIP = /* @__PURE__ */ new Set(["Library", "node_modules", ".Trash"]);
  }
});

// src/lanes/names.ts
import { join as join4, resolve as resolve2 } from "node:path";
function messageName(from, to, topic, at, collision = 1) {
  const hhmm = `${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
  return `${from}-to-${to}-${topic}-${hhmm}${collision > 1 ? `-${collision}` : ""}.md`;
}
function parseMessageName(name) {
  const match = new RegExp(`^(${ID})-to-(${ID})-([a-z0-9][a-z0-9-]*?)-[0-9]{4}(?:-[0-9]+)?\\.md$`).exec(name);
  if (match) return { from: match[1], to: [match[2]], topic: match[3] };
  const legacy = new RegExp(`^(${ID})-from-(${ID})-([a-z0-9].*)\\.md$`).exec(name);
  if (legacy) return { from: legacy[2], to: [legacy[1]], topic: legacy[3] };
  const prefix = new RegExp(`^(${ID})-([a-z0-9].*)\\.md$`).exec(name);
  if (prefix) return { from: "", to: [prefix[1]], topic: prefix[2] };
  return void 0;
}
function sessionDirFor(cwd, piAgentDir) {
  return join4(piAgentDir, "sessions", `--${resolve2(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
var ID, validId, validTopic, slug;
var init_names = __esm({
  "src/lanes/names.ts"() {
    ID = "[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*";
    validId = (s) => s.length <= 16 && new RegExp(`^${ID}$`).test(s);
    validTopic = (s) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);
    slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "") || "task";
  }
});

// src/lanes/config.ts
import { existsSync as existsSync4, readFileSync as readFileSync3, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join5, resolve as resolve3 } from "node:path";
import { randomUUID } from "node:crypto";
function defaults(root, home, reposRoot) {
  if (!reposRoot) {
    try {
      reposRoot = JSON.parse(readFileSync3(join5(home, ".pi/agent/user.json"), "utf8")).reposRoot;
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
    messages: { dir: "messages", broadcast: "ALL" },
    terminal: { backend: "auto" },
    launch: { wrapper: "pi-session", preapproveMcp: false, unsetEnv: ["PI_MCP_CONFIG_MODE"] },
    lanes: []
  };
}
function preapprovalDefault(templatesDir) {
  const path2 = join5(dirname2(templatesDir), "defaults.json");
  let text3;
  try {
    text3 = readFileSync3(path2, "utf8");
  } catch {
    return false;
  }
  try {
    const value = JSON.parse(text3);
    if (typeof value?.launch?.preapproveMcp !== "boolean") throw new Error("invalid launch.preapproveMcp");
    return value.launch.preapproveMcp;
  } catch (e) {
    throw new UsageError(`invalid lanes defaults: ${e.message}`);
  }
}
function validate(value) {
  const c2 = value;
  const require2 = (ok, key) => {
    if (!ok) throw new UsageError(`invalid ${key}`);
  };
  const text3 = (v) => typeof v === "string" && v.length > 0;
  require2(c2 && typeof c2 === "object", "config");
  require2(c2.version === 1, "version (expected 1)");
  for (const key of ["reposRoot", "worktreesDir", "baseBranch"]) require2(text3(c2[key]), key);
  require2(c2.repos && typeof c2.repos === "object" && !Array.isArray(c2.repos) && Object.values(c2.repos).every(text3), "repos");
  require2(c2.messages && text3(c2.messages.dir), "messages.dir");
  require2(c2.messages && typeof c2.messages.broadcast === "string" && validId(c2.messages.broadcast), "messages.broadcast");
  require2(c2.coordinator && typeof c2.coordinator.id === "string" && validId(c2.coordinator.id) && !["ALL", c2.messages.broadcast].includes(c2.coordinator.id), "coordinator.id");
  require2(text3(c2.coordinator.cwd), "coordinator.cwd");
  require2(text3(c2.coordinator.prompt), "coordinator.prompt");
  require2(Number.isInteger(c2.coordinator.maxRunning) && c2.coordinator.maxRunning > 0, "coordinator.maxRunning");
  require2(c2.terminal && BACKENDS.includes(c2.terminal.backend), "terminal.backend");
  require2(c2.launch && text3(c2.launch.wrapper), "launch.wrapper");
  require2(typeof c2.launch.preapproveMcp === "boolean", "launch.preapproveMcp");
  require2(Array.isArray(c2.launch.unsetEnv) && c2.launch.unsetEnv.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)), "launch.unsetEnv");
  if (c2.idle !== void 0) require2(c2.idle && Number.isInteger(c2.idle.minutes) && c2.idle.minutes > 0, "idle.minutes");
  if (c2.github !== void 0) {
    require2(c2.github && Array.isArray(c2.github.repos) && c2.github.repos.every((r2) => typeof r2 === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r2)), "github.repos");
    require2(typeof c2.github.author === "string" && /^@?[A-Za-z0-9-]+$/.test(c2.github.author), "github.author");
    require2(Array.isArray(c2.github.excludeLabels) && c2.github.excludeLabels.every(text3), "github.excludeLabels");
  }
  require2(Array.isArray(c2.lanes), "lanes");
  const ids = /* @__PURE__ */ new Set([c2.coordinator.id, "ALL", c2.messages.broadcast]);
  for (const [i2, lane] of c2.lanes.entries()) {
    const key = `lanes.${i2}`;
    require2(lane && typeof lane.id === "string" && validId(lane.id) && !ids.has(lane.id), `${key}.id`);
    ids.add(lane.id);
    require2(typeof lane.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lane.repo), `${key}.repo`);
    for (const k of ["branch", "prompt"]) require2(text3(lane[k]), `${key}.${k}`);
    require2(text3(lane.worktree) && !/[\\/]/.test(lane.worktree) && ![".", ".."].includes(lane.worktree), `${key}.worktree`);
    require2(lane.group === null || typeof lane.group === "string" && validId(lane.group) && !["ALL", c2.messages.broadcast].includes(lane.group), `${key}.group`);
    require2(lane.issue === void 0 || Number.isInteger(lane.issue) && lane.issue > 0, `${key}.issue`);
    require2(lane.goal === void 0 || text3(lane.goal), `${key}.goal`);
  }
}
function expand(value, c2, root, home) {
  let out = value;
  for (let n3 = 0; n3 < 8; n3++) {
    const next = out.replace(/\$\{(root|reposRoot|worktreesDir)\}/g, (_, key) => key === "root" ? root : c2[key]);
    if (next === out) break;
    out = next;
  }
  if (/\$\{/.test(out)) throw new UsageError(`invalid path expansion: ${value}`);
  if (out === "~" || out.startsWith("~/")) out = join5(home, out.slice(2));
  return isAbsolute2(out) ? resolve3(out) : resolve3(root, out);
}
function findRoot(dir, env, cwd) {
  if (dir || env.LANES_DIR) return resolve3(cwd, dir || env.LANES_DIR);
  let at = resolve3(cwd);
  while (!existsSync4(join5(at, "lanes.json"))) {
    const parent = dirname2(at);
    if (parent === at) throw new UsageError("lanes.json not found; run lanes init or set --dir");
    at = parent;
  }
  return at;
}
function loadConfig(root) {
  let c2;
  try {
    c2 = JSON.parse(readFileSync3(join5(root, "lanes.json"), "utf8"));
  } catch (e) {
    throw new UsageError(`invalid lanes.json: ${e.message}`);
  }
  validate(c2);
  return c2;
}
function saveConfig(root, c2) {
  validate(c2);
  const tmp = join5(root, `.lanes-${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(c2, null, 2)}
`, { flag: "wx" });
  renameSync(tmp, join5(root, "lanes.json"));
}
var BACKENDS, UsageError;
var init_config = __esm({
  "src/lanes/config.ts"() {
    init_names();
    BACKENDS = ["auto", "terminal-app", "iterm", "tmux", "print"];
    UsageError = class extends Error {
    };
  }
});

// src/lanes/terminal.ts
import { join as join6 } from "node:path";
function detectBackend(configured, ctx) {
  if (!BACKENDS.includes(configured)) throw new UsageError("invalid terminal.backend");
  if (configured !== "auto") return configured;
  if (ctx.env.TMUX) return "tmux";
  if (ctx.platform === "darwin" && ctx.env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (ctx.platform === "darwin" && ctx.env.TERM_PROGRAM === "Apple_Terminal") return "terminal-app";
  return "print";
}
function launchCommand(c2, root, cwd, id, prompt, wrapper, messages) {
  const unset = c2.launch.unsetEnv.map((name) => `-u ${name}`).join(" ");
  const exe = /^[A-Za-z0-9_/-]+$/.test(wrapper) ? wrapper : shellQuote(wrapper);
  return `cd ${shellQuote(cwd)} && env ${unset ? `${unset} ` : ""}PI_ORCH_ID=${id} LANES_DIR=${shellQuote(root)} INBOX_DIR=${shellQuote(messages)} LANE_STATUS_DIR=${shellQuote(join6(messages, "status"))} ${exe} ${shellQuote(`@${prompt}`)}`;
}
function terminalBackend(name) {
  if (!BACKENDS.includes(name) || name === "auto") throw new UsageError("invalid terminal.backend");
  return { nudge: (ctx, input) => nudgeTerminal(name, ctx, input), async start(ctx, { id, cwd, command }) {
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
    const result2 = await ctx.run(cmd, args, { timeoutMs: 3e4 });
    if (result2.code !== 0) {
      ctx.err(`${cmd} failed: ${result2.stderr.trim()}`);
      ctx.out(command);
      return 1;
    }
    if (name === "tmux" && !ctx.env.TMUX) ctx.out("attach with: tmux attach -t lanes");
    return 0;
  } };
}
async function nudgeTerminal(name, ctx, { tty, text: text3 }) {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) throw new UsageError("invalid tty");
  if (name === "print") return "not-found";
  if (name === "tmux") {
    const panes = await ctx.run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"], { timeoutMs: 1e4 });
    if (panes.code !== 0) throw new Error("tmux list-panes failed");
    const pane = panes.stdout.split("\n").map((s) => s.trim().split(/\s+/)).find(([t2]) => t2 === `/dev/${tty}`)?.[1];
    if (!pane) return "not-found";
    for (const args of [["send-keys", "-t", pane, "-l", "--", text3], ["send-keys", "-t", pane, "Enter"]]) {
      if ((await ctx.run("tmux", args, { timeoutMs: 1e4 })).code !== 0) throw new Error("tmux send-keys failed");
    }
    return "sent";
  }
  const escaped = appleScriptString(text3);
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
  const result2 = await ctx.run("osascript", ["-e", script], { timeoutMs: 1e4 });
  if (result2.code !== 0) throw new Error(`osascript failed: ${result2.stderr.trim()}`);
  return result2.stdout.trim() === "sent" ? "sent" : "not-found";
}
var shellQuote, appleScriptString;
var init_terminal = __esm({
  "src/lanes/terminal.ts"() {
    init_config();
    shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    appleScriptString = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  }
});

// src/lanes/templates.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join7 } from "node:path";
function renderTemplate(text3, vars) {
  return text3.replace(/\{\{(\w+)\}\}/g, (token, name) => Object.hasOwn(vars, name) ? String(vars[name]) : token);
}
function readTemplate(ctx, name) {
  return readFileSync4(join7(ctx.templatesDir, name), "utf8");
}
function templateVars(c2, ctx, root) {
  const messages = expand(c2.messages.dir, c2, root, ctx.home);
  return {
    root,
    root_sh: shellQuote(root),
    messages_sh: shellQuote(messages),
    coordinator_sh: shellQuote(c2.coordinator.id),
    coordinator: c2.coordinator.id,
    maxRunning: c2.coordinator.maxRunning,
    rules: join7(root, "rules.md"),
    messages,
    watches: join7(root, "coordinator/WATCHES.md"),
    handoff: join7(root, "coordinator/handoff-protocol.md")
  };
}
var init_templates = __esm({
  "src/lanes/templates.ts"() {
    init_terminal();
    init_config();
  }
});

// src/lanes/commands/init.ts
import { existsSync as existsSync5, mkdirSync, readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3, join as join8, resolve as resolve4 } from "node:path";
async function init(args, opts, ctx) {
  const root = resolve4(ctx.cwd, args[0] || ".");
  const configPath = join8(root, "lanes.json");
  const c2 = existsSync5(configPath) ? loadConfig(root) : defaults(root, ctx.home, opts["repos-root"]);
  if (!existsSync5(configPath)) {
    c2.coordinator.id = opts.coordinator || c2.coordinator.id;
    c2.terminal.backend = opts.terminal || c2.terminal.backend;
    c2.launch.preapproveMcp = opts["preapprove-mcp"] === "true" || preapprovalDefault(ctx.templatesDir);
  }
  validate(c2);
  const vars = templateVars(c2, ctx, root);
  const put2 = (rel, content) => {
    const path2 = join8(root, rel);
    mkdirSync(dirname3(path2), { recursive: true });
    if (existsSync5(path2)) ctx.out(`kept ${path2}`);
    else {
      writeFileSync2(path2, content, { flag: "wx" });
      ctx.out(`created ${path2}`);
    }
  };
  put2("lanes.json", `${JSON.stringify(c2, null, 2)}
`);
  for (const [source, dest] of [["rules.md", "rules.md"], ["coordinator.md", "prompts/coordinator.md"], ...["WATCHES.md", "handoff-protocol.md", "NOW.md", "STATE.md"].map((n3) => [n3, `coordinator/${n3}`])]) {
    put2(dest, renderTemplate(readTemplate(ctx, source), vars));
  }
  const status2 = join8(root, "messages/status");
  const hadStatus = existsSync5(status2);
  mkdirSync(status2, { recursive: true });
  ctx.out(`${hadStatus ? "kept" : "created"} ${status2}`);
  const ignore = join8(root, ".gitignore");
  const text3 = existsSync5(ignore) ? readFileSync5(ignore, "utf8") : "";
  const missing = [".state/", "messages/"].filter((s) => !text3.split(/\r?\n/).includes(s));
  if (missing.length) {
    writeFileSync2(ignore, `${text3}${text3 && !text3.endsWith("\n") ? "\n" : ""}${missing.join("\n")}
`);
    ctx.out(`created ${ignore}`);
  } else ctx.out(`kept ${ignore}`);
  return 0;
}
var init_init = __esm({
  "src/lanes/commands/init.ts"() {
    init_config();
    init_templates();
  }
});

// src/lanes/preapprove.ts
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "node:fs";
import { join as join9 } from "node:path";
async function preapprove(ctx, cwd, enabled) {
  if (!enabled) {
    ctx.out("MCP preapproval is off; enable with lanes init --preapprove-mcp for a new folder, or set launch.preapproveMcp to true in lanes.json.");
    return;
  }
  const files2 = [".mcp.json", ".pi/mcp.json"].filter((f) => existsSync6(join9(cwd, f)));
  if (!files2.length) return;
  const skip = (reason2) => ctx.err(`MCP preapproval skipped: ${reason2}; pi will ask once per server when the lane starts.`);
  let reason = "adapter not found";
  try {
    const adapter = join9(ctx.piAgentDir, "npm/node_modules/pi-mcp-adapter");
    const pkg = JSON.parse(readFileSync6(join9(adapter, "package.json"), "utf8"));
    if (!SUPPORTED_MAJORS.includes(Number(String(pkg.version).split(".")[0]))) {
      reason = `adapter ${pkg.version} not supported (supports ${SUPPORTED_MAJORS.join(", ")}.x)`;
      throw new Error(reason);
    }
    reason = "adapter API changed";
    const mod = await ctx.loadModule(join9(adapter, "dist/project-server-trust.js"));
    if (typeof mod.approveProjectServer !== "function" || typeof mod.hashProjectServerDefinition !== "function") throw new Error(reason);
    for (const file of files2) {
      let servers;
      try {
        servers = JSON.parse(readFileSync6(join9(cwd, file), "utf8")).mcpServers ?? {};
      } catch {
        skip(`invalid ${file} (${join9(cwd, file)})`);
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
var SUPPORTED_MAJORS;
var init_preapprove = __esm({
  "src/lanes/preapprove.ts"() {
    SUPPORTED_MAJORS = [5];
  }
});

// src/lanes/commands/add.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname4, join as join10, resolve as resolve5 } from "node:path";
async function add(id, opts, c2, root, ctx) {
  if (!validId(id) || ["ALL", c2.messages.broadcast, c2.coordinator.id].includes(id)) throw new UsageError("invalid lane id");
  if (c2.lanes.some((l2) => l2.id === id)) throw new Error(`lane ${id} already exists`);
  const repo = opts.repo;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((s) => [".", ".."].includes(s))) throw new UsageError("invalid repo (expected owner/name)");
  if (opts.issue !== void 0 && (!/^\d+$/.test(opts.issue) || Number(opts.issue) < 1)) throw new UsageError("invalid issue");
  if (opts.goal !== void 0 && !opts.goal.trim()) throw new UsageError("invalid goal");
  const [owner, name] = repo.split("/");
  const lower = id.toLowerCase();
  const worktree = `${lower}-${name.toLowerCase()}`;
  const branch = opts.branch || (opts.issue ? `${lower}-issue-${Number(opts.issue)}` : opts.goal ? `${lower}-${slug(opts.goal)}` : worktree);
  const lane = { id, repo, ...opts.issue ? { issue: Number(opts.issue) } : {}, ...opts.goal ? { goal: opts.goal } : {}, group: opts.group || null, worktree, branch, prompt: `prompts/${id}.md` };
  validate({ ...c2, lanes: [...c2.lanes, lane] });
  const repos = expand(c2.reposRoot, c2, root, ctx.home);
  const candidates = [opts.path ? resolve5(ctx.cwd, opts.path) : void 0, c2.repos[repo] ? expand(c2.repos[repo], c2, root, ctx.home) : void 0, join10(repos, name), join10(repos, owner, name)].filter((p) => Boolean(p));
  const git2 = (clone2, args, timeoutMs = 1e4) => ctx.run("git", ["-C", clone2, ...args], { timeoutMs });
  let clone;
  for (const p of candidates) if ((await git2(p, ["rev-parse", "--git-dir"])).code === 0) {
    clone = p;
    break;
  }
  if (!clone) throw new Error(`clone it first: gh repo clone ${repo} ${join10(repos, name)}`);
  const remote = await git2(clone, ["remote", "get-url", "origin"]);
  if (!remote.stdout.trim().endsWith(repo) && !remote.stdout.trim().endsWith(`${repo}.git`)) ctx.err(`warning: origin does not match ${repo}`);
  const base = opts.base || c2.baseBranch;
  const fetch = await git2(clone, ["fetch", "origin"], 12e4);
  const ref = await git2(clone, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (ref.code !== 0) throw new Error(`base ${base} does not resolve`);
  if (fetch.code !== 0) ctx.err(`warning: fetch origin failed; using local ${base}`);
  const wt = join10(expand(c2.worktreesDir, c2, root, ctx.home), worktree);
  if (existsSync7(wt)) throw new Error(`worktree already exists: ${wt}`);
  if ((await git2(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) throw new Error(`branch already exists: ${branch}`);
  const created = await git2(clone, ["worktree", "add", "-b", branch, wt, base], 12e4);
  if (created.code !== 0) throw new Error(`git worktree add failed: ${created.stderr.trim()}`);
  try {
    const lock = await git2(clone, ["worktree", "lock", "--reason", `lanes ${id}`, wt]);
    if (lock.code !== 0) throw new Error(`git worktree lock failed: ${lock.stderr.trim()}`);
    const prompt = expand(lane.prompt, c2, root, ctx.home);
    mkdirSync2(dirname4(prompt), { recursive: true });
    writeFileSync3(prompt, renderTemplate(readTemplate(ctx, "lane.md"), { ...templateVars(c2, ctx, root), id, repo, issue: lane.issue ?? "none", goal: lane.goal || "none", group: lane.group || "none", worktree: wt, branch, base }), { flag: "wx" });
    c2.lanes.push(lane);
    saveConfig(root, c2);
    await preapprove(ctx, wt, c2.launch.preapproveMcp);
  } catch (e) {
    ctx.err(e.message);
    ctx.err(`undo: git -C ${shellQuote(clone)} worktree unlock ${shellQuote(wt)} && git -C ${shellQuote(clone)} worktree remove ${shellQuote(wt)} && git -C ${shellQuote(clone)} branch -D ${shellQuote(branch)}`);
    return 1;
  }
  ctx.out(`next: lanes start ${id}`);
  return 0;
}
var init_add = __esm({
  "src/lanes/commands/add.ts"() {
    init_config();
    init_names();
    init_preapprove();
    init_terminal();
    init_templates();
  }
});

// src/lanes/processes.ts
async function runningPi(ctx) {
  const result2 = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 1e4 });
  if (result2.code !== 0) return [];
  const found = [];
  for (const token of result2.stdout.trim().split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number(token);
    let cwd = await ctx.readCwd?.(pid);
    if (!ctx.readCwd) {
      const r2 = ctx.platform === "darwin" ? await ctx.run("lsof", ["-a", "-p", token, "-d", "cwd", "-Fn"], { timeoutMs: 1e4 }) : await ctx.run("readlink", [`/proc/${pid}/cwd`], { timeoutMs: 1e4 });
      if (r2.code !== 0) continue;
      cwd = ctx.platform === "darwin" ? r2.stdout.split("\n").find((s) => s.startsWith("n"))?.slice(1) : r2.stdout.trim();
    }
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
  const r2 = await ctx.run("ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: 1e4 });
  const tty = r2.stdout.trim();
  return r2.code === 0 && /^[A-Za-z0-9/]+$/.test(tty) ? tty : void 0;
}
async function foregroundPi(ctx, tty) {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) return false;
  const r2 = await ctx.run("ps", ["-t", tty, "-o", "stat=,comm="], { timeoutMs: 1e4 });
  return r2.code === 0 && r2.stdout.split("\n").some((line) => {
    const m2 = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
    return m2?.[1].includes("+") && m2[2].split("/").at(-1) === "pi";
  });
}
async function descendants(ctx, rootPid) {
  const r2 = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,command="], { timeoutMs: 1e4 });
  if (r2.code !== 0) throw new Error("cannot inspect process descendants");
  const rows = r2.stdout.split("\n").flatMap((line) => {
    const m2 = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m2 ? [{ pid: Number(m2[1]), parent: Number(m2[2]), command: m2[3] }] : [];
  });
  const ids = /* @__PURE__ */ new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) {
      ids.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((r3) => r3.pid !== rootPid && ids.has(r3.pid)).map((r3) => r3.command);
}
async function alive(ctx, pid) {
  return (await ctx.run("ps", ["-p", String(pid)], { timeoutMs: 1e4 })).code === 0;
}
var init_processes = __esm({
  "src/lanes/processes.ts"() {
  }
});

// src/lanes/sessions.ts
import { readdirSync as readdirSync2, statSync as statSync3 } from "node:fs";
import { join as join11 } from "node:path";
function laneTarget(id, c2, root, ctx) {
  const coordinator = id === "coordinator" || id === c2.coordinator.id;
  const lane = c2.lanes.find((l2) => l2.id === id);
  if (!coordinator && !lane) throw new Error(`lane not found: ${id}`);
  const cwd = coordinator ? expand(c2.coordinator.cwd, c2, root, ctx.home) : join11(expand(c2.worktreesDir, c2, root, ctx.home), lane.worktree);
  return { id: coordinator ? c2.coordinator.id : id, cwd, coordinator, lane };
}
function idleMinutes(cwd, ctx) {
  try {
    const dir = sessionDirFor(cwd, ctx.piAgentDir);
    const times = readdirSync2(dir).map((n3) => statSync3(join11(dir, n3))).filter((s) => s.isFile()).map((s) => s.mtimeMs);
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
var init_sessions = __esm({
  "src/lanes/sessions.ts"() {
    init_config();
    init_names();
    init_processes();
  }
});

// src/lanes/commands/start.ts
import { existsSync as existsSync8, statSync as statSync4 } from "node:fs";
async function start(id, opts, c2, root, ctx) {
  const { coordinator, lane, cwd } = laneTarget(id, c2, root, ctx);
  const prompt = expand(coordinator ? c2.coordinator.prompt : lane.prompt, c2, root, ctx.home);
  if (!existsSync8(cwd) || !statSync4(cwd).isDirectory()) throw new Error(`cwd not found: ${cwd}`);
  if (!existsSync8(prompt) || !statSync4(prompt).isFile()) throw new Error(`prompt not found: ${prompt}`);
  const duplicate = (await runningPi(ctx)).find((p) => p.cwd === ctx.realpath(cwd));
  if (duplicate) throw new Error(`already running in ${cwd} (pid ${duplicate.pid}); not starting a second session`);
  if (!coordinator || !c2.launch.preapproveMcp) await preapprove(ctx, cwd, c2.launch.preapproveMcp);
  const backend = detectBackend(opts.terminal || c2.terminal.backend, ctx);
  let wrapper = ctx.which(c2.launch.wrapper);
  if (!wrapper) {
    wrapper = ctx.which("pi");
    if (wrapper) ctx.err("pi-session not found; starting pi directly (no relaunch after a context handoff)");
    else if (backend === "print") {
      wrapper = c2.launch.wrapper;
      ctx.err(`${c2.launch.wrapper} and pi not found; printing the command only`);
    } else throw new Error("pi not found");
  }
  const command = launchCommand(c2, root, cwd, coordinator ? c2.coordinator.id : id, prompt, wrapper, expand(c2.messages.dir, c2, root, ctx.home));
  return terminalBackend(backend).start(ctx, { id: coordinator ? c2.coordinator.id : id, cwd, command });
}
var init_start = __esm({
  "src/lanes/commands/start.ts"() {
    init_config();
    init_sessions();
    init_processes();
    init_preapprove();
    init_terminal();
  }
});

// src/lanes/backend.ts
import { mkdirSync as mkdirSync3, readdirSync as readdirSync3, readFileSync as readFileSync7, renameSync as renameSync2, statSync as statSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import { join as join12 } from "node:path";
function addressed(m2, id) {
  return m2.to.some((to) => to === id || `-${to}-`.includes(`-${id}-`));
}
function backendFor(config, ctx, root) {
  return new FileBackend(expand(config.messages.dir, config, root, ctx.home), ctx.now, config.messages.broadcast);
}
var FileBackend;
var init_backend = __esm({
  "src/lanes/backend.ts"() {
    init_config();
    init_names();
    FileBackend = class {
      name = "file";
      dir;
      now;
      broadcast;
      constructor(dir, now, broadcast = "ALL") {
        this.dir = dir;
        this.now = now;
        this.broadcast = broadcast;
      }
      async send(m2) {
        if (!validId(m2.from) || !validId(m2.to) || !validTopic(m2.topic)) throw new Error("invalid message name");
        mkdirSync3(this.dir, { recursive: true });
        const at = this.now();
        for (let i2 = 1; ; i2++) {
          const name = messageName(m2.from, m2.to, m2.topic, at, i2);
          const path2 = join12(this.dir, name);
          try {
            writeFileSync4(path2, m2.body, { flag: "wx" });
            return { name, from: m2.from, to: [m2.to], topic: m2.topic, at, path: path2 };
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
          }
        }
      }
      async list(filter = {}) {
        let names;
        try {
          names = readdirSync3(this.dir);
        } catch (e) {
          if (e.code === "ENOENT") return [];
          throw e;
        }
        const messages = [];
        for (const name of names) {
          const parsed = parseMessageName(name);
          if (!parsed) continue;
          const stat = statSync5(join12(this.dir, name));
          if (!stat.isFile()) continue;
          const ref = { name, ...parsed, at: stat.mtime };
          if (filter.from !== void 0 && ref.from !== filter.from) continue;
          if (filter.to !== void 0 && !addressed(ref, filter.to)) continue;
          messages.push(ref);
        }
        return messages.sort((a2, b) => b.at.getTime() - a2.at.getTime() || b.name.localeCompare(a2.name)).slice(0, filter.limit);
      }
      async inbox(lane, opts = {}) {
        const recipients = [lane, "ALL", this.broadcast, ...opts.groups || [], ...opts.aliases || []];
        return (await this.list()).filter((m2) => ![lane, ...opts.aliases || []].includes(m2.from) && recipients.some((id) => addressed(m2, id)));
      }
      async setStatus(lane, line) {
        if (!validId(lane)) throw new Error("invalid lane id");
        const dir = join12(this.dir, "status");
        mkdirSync3(dir, { recursive: true });
        const tmp = join12(dir, `.${lane}-${randomUUID2()}.tmp`);
        writeFileSync4(tmp, `${line}
`, { flag: "wx" });
        renameSync2(tmp, join12(dir, `${lane}.status`));
      }
      async unread(lane, opts = {}) {
        if (!validId(lane)) throw new Error("invalid lane id");
        let since;
        try {
          since = statSync5(join12(this.dir, `${lane}-inbox.marker`)).mtimeMs;
        } catch (e) {
          if (e.code === "ENOENT") return void 0;
          throw e;
        }
        return (await this.inbox(lane, opts)).filter((m2) => m2.at.getTime() > since);
      }
      async status(lane) {
        if (!validId(lane)) throw new Error("invalid lane id");
        try {
          return readFileSync7(join12(this.dir, "status", `${lane}.status`), "utf8").split(/\r?\n/)[0];
        } catch (e) {
          if (e.code === "ENOENT") return void 0;
          throw e;
        }
      }
    };
  }
});

// src/lanes/commands/send.ts
import { readFileSync as readFileSync8 } from "node:fs";
import { resolve as resolve6 } from "node:path";
async function send(args, opts, c2, root, ctx) {
  const [to, topic, file] = args;
  const from = opts.from || ctx.env.PI_ORCH_ID;
  if (!from) throw new UsageError("set --from or PI_ORCH_ID");
  if (!validId(from)) throw new UsageError("invalid from");
  if (!validId(to)) throw new UsageError("invalid to");
  if (!validTopic(topic)) throw new UsageError("invalid topic");
  if (opts.m !== void 0 && file !== void 0) throw new UsageError("choose a file or -m, not both");
  const known = [c2.coordinator.id, "ALL", c2.messages.broadcast, ...c2.lanes.flatMap((l2) => [l2.id, l2.group])];
  if (!known.includes(to)) ctx.err(`warning: unknown recipient ${to}; sending anyway`);
  const body = opts.m !== void 0 ? opts.m : file && file !== "-" ? readFileSync8(resolve6(ctx.cwd, file), "utf8") : file === "-" || !ctx.stdinTTY ? await ctx.readStdin() : "";
  if (!body.trim()) throw new UsageError("empty message body");
  ctx.out((await backendFor(c2, ctx, root).send({ from, to, topic, body })).path);
  return 0;
}
var init_send = __esm({
  "src/lanes/commands/send.ts"() {
    init_backend();
    init_config();
    init_names();
  }
});

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
function closedLine(to, reason, now) {
  return `closed${to ? ` reassigned-to ${to}` : ""} at ${now.toISOString()}${reason ? ` reason "${clean(reason)}"` : ""}`;
}
var clean;
var init_status_line = __esm({
  "src/lanes/status-line.ts"() {
    clean = (text3) => text3.replace(/"/g, "'").replace(/\s+/g, " ").trim();
  }
});

// src/lanes/commands/idle-check.ts
async function idleCheck(opts, c2, root, ctx) {
  const backend = backendFor(c2, ctx, root);
  const silent = [];
  for (const lane of c2.lanes) {
    const line = await backend.status(lane.id);
    if (parseStatus(line).kind === "closed" || suppressed(line, ctx.now())) continue;
    const { cwd } = laneTarget(lane.id, c2, root, ctx);
    const pid = await piIn(cwd, ctx);
    if (!pid || (await descendants(ctx, pid)).some((s) => /\bpi-phase run\b/.test(s))) continue;
    const minutes = idleMinutes(cwd, ctx);
    if (minutes !== void 0 && minutes > Number(opts.minutes ?? c2.idle?.minutes ?? 75)) silent.push(`${lane.id}:${minutes}m`);
  }
  if (!silent.length) return 1;
  ctx.out(`silent: ${silent.join(" ")}`);
  return 0;
}
var init_idle_check = __esm({
  "src/lanes/commands/idle-check.ts"() {
    init_backend();
    init_processes();
    init_sessions();
    init_status_line();
  }
});

// src/lanes/commands/nudge.ts
async function nudge(id, text3, opts, c2, root, ctx) {
  text3 = text3.trim().replace(/[\r\n]/g, " ");
  if (!text3 || text3.length > 2e3) throw new UsageError("nudge text must be between 1 and 2000 characters");
  const target = laneTarget(id, c2, root, ctx);
  const refuse = (why) => {
    ctx.err(`NOT SENT: ${why}`);
    return 3;
  };
  if (parseStatus(await backendFor(c2, ctx, root).status(target.id)).kind === "closed") return refuse(`${target.id} is closed`);
  const pid = await piIn(target.cwd, ctx);
  if (!pid) return refuse(`no pi running in ${target.cwd}`);
  const tty = await ttyOf(ctx, pid);
  if (!tty) return refuse(`${target.id} has no tty`);
  if (!await foregroundPi(ctx, tty)) return refuse(`no foreground pi on ${tty} (lane stopped or busy in a subshell)`);
  const backend = detectBackend(opts.terminal || c2.terminal.backend, ctx);
  if (backend === "print") {
    ctx.out(`nudge ${target.id} (tty ${tty}): type this into its pi session: ${text3}`);
    return 4;
  }
  if (await terminalBackend(backend).nudge(ctx, { tty, text: text3 }) !== "sent") return 4;
  ctx.out(`nudged ${target.id}`);
  return 0;
}
var init_nudge = __esm({
  "src/lanes/commands/nudge.ts"() {
    init_backend();
    init_config();
    init_processes();
    init_sessions();
    init_status_line();
    init_terminal();
  }
});

// src/lanes/joblogs.ts
import { closeSync, openSync, readSync, readdirSync as readdirSync4, statSync as statSync6 } from "node:fs";
import { join as join13 } from "node:path";
function parseWatches(text3) {
  return text3.split(/\r?\n/).flatMap((line) => {
    const [tag, label, until, interval, ...check3] = line.split("|");
    if (tag !== "WATCH") return [];
    if (!label || !until || !/^\d+$/.test(interval) || Number(interval) <= 0 || !check3.join("|")) throw new Error("invalid WATCH line");
    return [{ label, until, interval: Number(interval), check: check3.join("|") }];
  });
}
function chunk(path2, length, position) {
  const fd = openSync(path2, "r");
  try {
    const b = Buffer.alloc(length);
    return b.subarray(0, readSync(fd, b, 0, length, position)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function day(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function liveWatch(jobs, watch, now) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const date of [now, yesterday]) {
    const dir = join13(jobs, day(date));
    let names;
    try {
      names = readdirSync4(dir);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const name of names.filter((n3) => n3.endsWith(".log"))) {
      const path2 = join13(dir, name);
      const stat = statSync6(path2);
      if (!stat.isFile() || !chunk(path2, Math.min(4096, stat.size), 0).split("\n")[0].includes(watch.check)) continue;
      const tail = chunk(path2, Math.min(65536, stat.size), Math.max(0, stat.size - 65536));
      const last = tail.split("\n").filter((s) => /^--- check .* exit \d+ ---$/.test(s)).at(-1);
      if (watch.until === "success" && /exit 0 ---$/.test(last || "")) continue;
      if (now.getTime() - stat.mtimeMs <= (watch.interval + 90) * 1e3) return true;
    }
  }
  return false;
}
var init_joblogs = __esm({
  "src/lanes/joblogs.ts"() {
  }
});

// src/lanes/commands/resume-check.ts
import { existsSync as existsSync9, readFileSync as readFileSync9, statSync as statSync7 } from "node:fs";
import { join as join14 } from "node:path";
async function livePrs(text3, ctx) {
  if (!ctx.which("gh")) return;
  const refs = new Set(text3.match(/\bPR [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g));
  for (const ref of refs) {
    const [repo, n3] = ref.slice(3).split("#");
    let state2 = "unknown";
    const r2 = await ctx.run("gh", ["pr", "view", n3, "--repo", repo, "--json", "state,mergeStateStatus,headRefOid"], { timeoutMs: 3e4 });
    if (r2.code === 0) {
      try {
        const p = JSON.parse(r2.stdout);
        state2 = `${p.state} ${p.mergeStateStatus} ${String(p.headRefOid).slice(0, 9)}`;
      } catch {
      }
    }
    ctx.out(`LIVE    ${ref.slice(3)}: ${state2}`);
  }
}
async function resumeCheck(c2, root, ctx) {
  const now = ctx.now();
  let bad = false;
  ctx.out(`date: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const watches = join14(root, "coordinator/WATCHES.md");
  if (!existsSync9(watches)) {
    ctx.out("MISSING coordinator/WATCHES.md");
    bad = true;
  } else for (const w of parseWatches(readFileSync9(watches, "utf8"))) {
    if (liveWatch(join14(ctx.piAgentDir, "jobs"), w, now)) ctx.out(`OK      watch: ${w.label}`);
    else {
      ctx.out(`MISSING watch: ${w.label} -> job_watch until=${w.until} interval=${w.interval} check from coordinator/WATCHES.md`);
      bad = true;
    }
  }
  const unread = await backendFor(c2, ctx, root).unread(c2.coordinator.id);
  if (unread === void 0) {
    ctx.out("MISSING inbox marker: the coordinator inbox watch has not run");
    bad = true;
  } else {
    const old = unread.filter((m2) => now.getTime() - m2.at.getTime() > 3e5);
    for (const m2 of old) ctx.out(`UNREAD  inbox: ${m2.name}`);
    if (old.length) bad = true;
    else ctx.out("OK      inbox: no unread backlog");
  }
  const path2 = join14(root, "coordinator/NOW.md");
  if (!existsSync9(path2)) {
    ctx.out("MISSING coordinator/NOW.md");
    bad = true;
  } else {
    await livePrs(readFileSync9(path2, "utf8"), ctx);
    const age = Math.floor((now.getTime() - statSync7(path2).mtimeMs) / 6e4);
    if (age > 90) {
      ctx.out(`STALE   NOW.md not updated for ${age} min`);
      bad = true;
    }
  }
  const questions = join14(ctx.piAgentDir, "local-packages/pi-questions/dist/cli.js");
  if (existsSync9(questions)) {
    const r2 = await ctx.run(process.execPath, [questions, "list", "--all"], { timeoutMs: 15e3 });
    for (const line of r2.stdout.split("\n").filter((s) => /^Q-\d+/.test(s))) ctx.out(`OPEN    ${line}`);
  }
  return bad ? 1 : 0;
}
var init_resume_check = __esm({
  "src/lanes/commands/resume-check.ts"() {
    init_backend();
    init_joblogs();
  }
});

// src/lanes/commands/green-prs.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync4, readFileSync as readFileSync10, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join15 } from "node:path";
function green(pr, excluded) {
  return !pr.isDraft && !pr.labels.some((l2) => excluded.includes(l2.name)) && pr.statusCheckRollup.length > 0 && pr.statusCheckRollup.every((s) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(s.conclusion ?? s.state ?? ""));
}
async function greenPrs(opts, c2, root, ctx) {
  if (opts.new && opts.ack) throw new UsageError("--new and --ack are mutually exclusive");
  const repos = c2.github?.repos.length ? c2.github.repos : [.../* @__PURE__ */ new Set([...c2.lanes.map((l2) => l2.repo), ...Object.keys(c2.repos)])];
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
    const r2 = await ctx.run("gh", ["pr", "list", "--repo", repo, "--author", c2.github?.author || "@me", "--state", "open", "--limit", "100", "--json", "number,isDraft,labels,statusCheckRollup"], { timeoutMs: 3e4 });
    if (r2.code !== 0 || r2.timedOut) {
      ctx.err(`gh pr list failed for ${repo}: ${r2.stderr.trim()}`);
      return 2;
    }
    try {
      const prs = JSON.parse(r2.stdout);
      refs.push(...prs.filter((p) => green(p, c2.github?.excludeLabels || [])).map((p) => `${repo}#${p.number}`));
    } catch {
      ctx.err(`invalid gh pr list response for ${repo}`);
      return 2;
    }
  }
  refs.sort();
  const ack = join15(root, ".state/green-ack");
  if (opts.ack) {
    mkdirSync4(join15(root, ".state"), { recursive: true });
    writeFileSync5(ack, refs.length ? `${refs.join("\n")}
` : "");
    ctx.out(`acked ${refs.length}`);
    return 0;
  }
  const previous = opts.new && existsSync10(ack) ? readFileSync10(ack, "utf8").split(/\r?\n/) : [];
  const output = opts.new ? refs.filter((r2) => !previous.includes(r2)) : refs;
  if (output.length) ctx.out(output.join("\n"));
  return opts.new && !output.length ? 1 : 0;
}
var init_green_prs = __esm({
  "src/lanes/commands/green-prs.ts"() {
    init_config();
  }
});

// src/lanes/commands/close.ts
import { basename, dirname as dirname5 } from "node:path";
function closeBody(id, to, reason, unread) {
  const body = [
    `Lane ${id} is closed.${to ? ` Reassigned to ${to}.` : ""}${reason ? ` Reason: ${clean(reason)}` : ""}`,
    "",
    `${to ? `${to}: pick up` : "Pick up"} the work and any unread messages of ${id}. No message file was moved or edited.`,
    ""
  ];
  if (unread === void 0) body.push(`Unread inbox of ${id}: none known (${id}-inbox.marker does not exist).`);
  else if (unread.length) body.push(`Unread inbox files of ${id} (newer than ${id}-inbox.marker):`, ...unread.map((m2) => `- ${m2.name}`));
  else body.push(`Unread inbox files of ${id}: none.`);
  return `${body.join("\n")}
`;
}
async function quit(id, pid, cwd, c2, root, ctx) {
  const busy = (await descendants(ctx, pid)).filter((cmd) => /\bpi-phase run\b/.test(cmd) || /^(dotnet|vstest.*|testhost.*|npm|yarn|pnpm|pi-phase|git|docker|make)$/i.test(basename(cmd.split(/\s+/)[0])));
  if (busy.length) {
    ctx.err(`REFUSED: busy children: ${busy.join(" ")}`);
    return false;
  }
  const age = idleMinutes(cwd, ctx);
  if (age !== void 0 && age < 3) {
    ctx.err("REFUSED: session wrote less than 180s ago");
    return false;
  }
  if (await nudge(id, "/quit", {}, c2, root, ctx) !== 0) return false;
  for (let i2 = 0; i2 < 10; i2++) {
    await (ctx.sleep ? ctx.sleep(1e3) : new Promise((done) => setTimeout(done, 1e3)));
    if (!await alive(ctx, pid)) return true;
  }
  ctx.err(`REFUSED: pi ${pid} did not quit`);
  return false;
}
async function close(id, opts, c2, root, ctx) {
  if (!c2.lanes.some((l2) => l2.id === id)) throw new UsageError(`not a lane: ${id}`);
  const to = opts["reassign-to"];
  const from = opts.from || ctx.env.PI_ORCH_ID || c2.coordinator.id;
  if (to && (!validId(to) || to === id)) throw new UsageError("--reassign-to must be a valid id different from the closed lane");
  if (!validId(from)) throw new UsageError("invalid sender id");
  if (to && to !== c2.coordinator.id && !c2.lanes.some((l2) => l2.id === to)) ctx.err(`unknown reassignment target: ${to}`);
  const target = laneTarget(id, c2, root, ctx);
  const pid = await piIn(target.cwd, ctx);
  if (pid && opts.quit && !await quit(id, pid, target.cwd, c2, root, ctx)) return 1;
  if (pid && !opts.quit) ctx.err(`${id} is still running; type /quit in its session or use --quit`);
  const backend = backendFor(c2, ctx, root);
  const unread = await backend.unread(id, { groups: target.lane?.group ? [target.lane.group] : [] });
  const line = closedLine(to, opts.reason, ctx.now());
  await backend.setStatus(id, line);
  const message = await backend.send({ from, to: c2.messages.broadcast, topic: `lane-closed-${id.toLowerCase()}`, body: closeBody(id, to, opts.reason, unread) });
  ctx.out(`${id}: ${line}`);
  ctx.out(message.path);
  const common = await ctx.run("git", ["-C", target.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 1e4 });
  if (common.code !== 0 || !common.stdout.trim()) throw new Error("cannot find clone for worktree removal hint");
  const clone = shellQuote(dirname5(common.stdout.trim()));
  const wt = shellQuote(target.cwd);
  ctx.out(`when merged, remove the worktree: git -C ${clone} worktree unlock ${wt} && git -C ${clone} worktree remove ${wt}`);
  return 0;
}
var init_close = __esm({
  "src/lanes/commands/close.ts"() {
    init_backend();
    init_config();
    init_names();
    init_processes();
    init_sessions();
    init_status_line();
    init_terminal();
    init_nudge();
  }
});

// src/lanes/commands/status.ts
import { existsSync as existsSync11 } from "node:fs";
import { join as join16 } from "node:path";
async function status(c2, root, ctx) {
  const backend = backendFor(c2, ctx, root);
  const processes = await runningPi(ctx);
  const rows = [["LANE", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  const lanes = [{ id: c2.coordinator.id, repo: "-", branch: "-", group: null, cwd: expand(c2.coordinator.cwd, c2, root, ctx.home) }, ...c2.lanes.map((l2) => ({ ...l2, cwd: join16(expand(c2.worktreesDir, c2, root, ctx.home), l2.worktree) }))];
  for (const lane of lanes) {
    let pid = "missing";
    if (existsSync11(lane.cwd)) {
      try {
        pid = String(processes.find((p) => p.cwd === ctx.realpath(lane.cwd))?.pid || "-");
      } catch {
      }
    }
    const messages = [...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }), ...await backend.list({ from: lane.id, limit: 1 })].sort((a2, b) => b.at.getTime() - a2.at.getTime());
    const last = messages[0];
    rows.push([lane.id, lane.repo, lane.branch, pid, String(idleMinutes(lane.cwd, ctx) ?? "-"), await backend.status(lane.id) || "-", last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 6e4))}m)` : "-"]);
  }
  const widths = rows[0].map((_, i2) => Math.max(...rows.map((r2) => r2[i2].length)));
  ctx.out(rows.map((r2) => r2.map((s, i2) => i2 === r2.length - 1 ? s : s.padEnd(widths[i2])).join("  ")).join("\n"));
  return 0;
}
var init_status = __esm({
  "src/lanes/commands/status.ts"() {
    init_backend();
    init_config();
    init_sessions();
    init_processes();
  }
});

// src/lanes/main.ts
async function main(argv, ctx) {
  let command = "";
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      ctx.out(HELP);
      return 0;
    }
    const positional = [];
    const opts = {};
    for (let i2 = 0; i2 < argv.length; i2++) {
      const token = argv[i2];
      if (token === "--") {
        positional.push(...argv.slice(i2 + 1));
        break;
      }
      if (token.startsWith("--") || token === "-m") {
        const key = token === "-m" ? "m" : token.slice(2);
        if (["preapprove-mcp", "new", "ack", "quit"].includes(key)) {
          opts[key] = "true";
          continue;
        }
        if (argv[i2 + 1] === void 0 || argv[i2 + 1].startsWith("--")) throw new UsageError(`missing value for ${token}`);
        if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
        opts[key] = argv[++i2];
      } else if (token.startsWith("-") && token !== "-") throw new UsageError(`unknown option ${token}`);
      else positional.push(token);
    }
    command = positional.shift() || "";
    if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(HELP);
    for (const key of Object.keys(opts)) if (key !== "dir" && !OPTIONS[command].includes(key)) throw new UsageError(`unknown option --${key}`);
    const bounds = { init: [0, 1], add: [1, 1], start: [1, 1], send: [2, 3], status: [0, 0], "idle-check": [0, 0], nudge: [2, 2], "resume-check": [0, 0], "green-prs": [0, 0], close: [1, 1] };
    if (positional.length < bounds[command][0] || positional.length > bounds[command][1]) throw new UsageError(HELP);
    if (opts.minutes !== void 0 && (!/^\d+$/.test(opts.minutes) || !Number.isSafeInteger(Number(opts.minutes)) || Number(opts.minutes) <= 0)) throw new UsageError("--minutes must be a positive integer");
    if (command === "init") return await init(positional, opts, ctx);
    const root = findRoot(opts.dir, ctx.env, ctx.cwd);
    const c2 = loadConfig(root);
    if (command === "add") return await add(positional[0], opts, c2, root, ctx);
    if (command === "start") return await start(positional[0], opts, c2, root, ctx);
    if (command === "send") return await send(positional, opts, c2, root, ctx);
    if (command === "idle-check") return await idleCheck(opts, c2, root, ctx);
    if (command === "nudge") return await nudge(positional[0], positional[1], opts, c2, root, ctx);
    if (command === "resume-check") return await resumeCheck(c2, root, ctx);
    if (command === "green-prs") return await greenPrs(opts, c2, root, ctx);
    if (command === "close") return await close(positional[0], opts, c2, root, ctx);
    return await status(c2, root, ctx);
  } catch (e) {
    ctx.err(e.message);
    return e instanceof UsageError || ["idle-check", "nudge", "resume-check", "green-prs", "close"].includes(command) ? 2 : 1;
  }
}
var HELP, OPTIONS;
var init_main = __esm({
  "src/lanes/main.ts"() {
    init_config();
    init_init();
    init_add();
    init_start();
    init_send();
    init_idle_check();
    init_nudge();
    init_resume_check();
    init_green_prs();
    init_close();
    init_status();
    HELP = `Usage: lanes [--dir root] <command> [options]
  init [dir] [--repos-root p] [--coordinator ID] [--terminal backend] [--preapprove-mcp]
  add <ID> --repo owner/name [--issue n] [--goal text] [--group G] [--branch b] [--base ref] [--path clone]
  start <ID>|coordinator [--terminal backend]
  send <TO> <topic> [file|-] [-m text] [--from ID]
  status
  idle-check [--minutes n]
  nudge <ID|coordinator> <text> [--terminal backend]
  resume-check
  green-prs [--new | --ack]
  close <ID> [--reassign-to ID2] [--reason text] [--from ID] [--quit]
Ops exits: 0 fire/OK, 1 nothing/missing, 2 usage/I/O/gh failure.
Nudge: 0 sent, 3 not sent, 4 tab/pane not found or print.
Terminal backends: auto, terminal-app, iterm, tmux, print. Auto falls back to print.
--preapprove-mcp trusts project MCP server definitions in explicitly added repositories.`;
    OPTIONS = { init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"], add: ["repo", "issue", "goal", "group", "branch", "base", "path"], start: ["terminal"], send: ["m", "from"], status: [], "idle-check": ["minutes"], nudge: ["terminal"], "resume-check": [], "green-prs": ["new", "ack"], close: ["reassign-to", "reason", "from", "quit"] };
  }
});

// src/lanes-flow.ts
import { existsSync as existsSync12, realpathSync } from "node:fs";
import { join as join17 } from "node:path";
import { pathToFileURL } from "node:url";
function lanesCtxFrom(ctx) {
  return {
    home: ctx.home,
    cwd: ctx.cwd,
    env: ctx.env,
    platform: ctx.platform,
    now: ctx.now,
    run: ctx.run,
    which: ctx.which,
    out: ctx.out,
    err: ctx.err,
    stdinTTY: ctx.stdinTTY,
    readStdin: async () => "",
    templatesDir: join17(ctx.home, ".local/share/pi-setup/lanes/templates"),
    piAgentDir: ctx.env.PI_CODING_AGENT_DIR || join17(ctx.home, ".pi/agent"),
    loadModule: (path2) => import(pathToFileURL(path2).href),
    realpath: realpathSync
  };
}
async function recentFirst(ctx, checkouts) {
  const scored = [];
  for (let i2 = 0; i2 < checkouts.length; i2 += 8) {
    scored.push(...await Promise.all(checkouts.slice(i2, i2 + 8).map(async (checkout) => {
      const r2 = await ctx.run("git", ["-C", checkout.path, "log", "-1", "--format=%ct"], { timeoutMs: 5e3 });
      return { checkout, time: r2.code === 0 ? Number(r2.stdout.trim()) || 0 : 0 };
    })));
  }
  return scored.sort((a2, b) => b.time - a2.time).map((s) => s.checkout);
}
async function issuesFor(ctx, repo, user) {
  if (!ctx.which("gh")) return void 0;
  const r2 = await ctx.run("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", "number,title,assignees"], { timeoutMs: 15e3 });
  if (r2.code !== 0 || r2.timedOut) return void 0;
  try {
    const issues = JSON.parse(r2.stdout);
    return issues.length ? issues.map((i2) => ({ number: i2.number, title: i2.title, mine: i2.assignees.some((a2) => a2.login === user) })) : void 0;
  } catch {
    return void 0;
  }
}
async function runLanesFlow(ctx, options, p, nested = false) {
  if (!p) {
    ctx.out("pi-setup lanes is interactive; in scripts use lanes init <dir>, lanes --dir <dir> add <ID> --repo owner/name and lanes --dir <dir> start coordinator");
    return 1;
  }
  if (!existsSync12(join17(ctx.home, ".local/share/pi-setup/lanes/lanes.mjs"))) throw new SetupError("lanes is not installed; run ./install.sh --with lanes");
  if (!nested) p.intro("pi-setup lanes");
  const settings2 = readSettings(join17(ctx.home, ".pi/agent/user.json"));
  const reposRoot = typeof settings2.reposRoot === "string" ? settings2.reposRoot : join17(ctx.home, "repos");
  const requestedDir = options.dir ? expandHome(options.dir, ctx.home) : "";
  const dir = requestedDir || join17(reposRoot, ".lanes");
  const c2 = existsSync12(join17(dir, "lanes.json")) ? loadConfig(dir) : void 0;
  const choice = await collectLanes(p, {
    dir: requestedDir || void 0,
    reposRoot,
    home: ctx.home,
    existingIds: c2 ? [c2.coordinator.id, ...c2.lanes.map((l2) => l2.id)] : ["L0"],
    existingIdsFor: (selected) => {
      if (!existsSync12(join17(selected, "lanes.json"))) return ["L0"];
      const existing = loadConfig(selected);
      return ["L0", existing.coordinator.id, ...existing.lanes.map((l2) => l2.id)];
    },
    checkouts: await recentFirst(ctx, listCheckouts(reposRoot)),
    issues: (repo) => issuesFor(ctx, repo, settings2.githubUser)
  });
  if (choice === CANCEL) {
    if (!nested) p.outro("Cancelled.");
    return 1;
  }
  const laneCtx = lanesCtxFrom(ctx);
  const created = [];
  if (!existsSync12(join17(choice.dir, "lanes.json")) && await main(["init", choice.dir, "--repos-root", reposRoot], laneCtx) !== 0) return 1;
  for (const lane of choice.lanes) {
    const argv = ["--dir", choice.dir, "add", lane.id, "--repo", lane.repo, "--path", lane.path, ...lane.issue ? ["--issue", String(lane.issue)] : ["--goal", lane.goal]];
    if (await main(argv, laneCtx) !== 0) {
      ctx.err(`Could not create ${lane.id}; created lanes: ${created.join(", ") || "none"}`);
      return 1;
    }
    created.push(lane.id);
  }
  const open = await p.confirm({ message: "Open the coordinator now?", initial: true });
  if (p.isCancel(open)) return 1;
  if (open === true && await main(["--dir", choice.dir, "start", "coordinator"], laneCtx) !== 0) return 1;
  p.note(`The coordinator starts lanes with: lanes --dir ${shellQuote(choice.dir)} start ${created[0]}`);
  if (!nested) p.outro("Lanes ready.");
  return 0;
}
var init_lanes_flow = __esm({
  "src/lanes-flow.ts"() {
    init_lanes_wizard();
    init_repos_scan();
    init_settings();
    init_types();
    init_config();
    init_main();
    init_terminal();
  }
});

// src/fsx.ts
import {
  chmodSync,
  closeSync as closeSync2,
  copyFileSync,
  existsSync as existsSync13,
  fsyncSync,
  mkdirSync as mkdirSync5,
  openSync as openSync2,
  readdirSync as readdirSync5,
  realpathSync as realpathSync2,
  renameSync as renameSync3,
  statSync as statSync8,
  utimesSync,
  writeSync
} from "node:fs";
import { dirname as dirname6, join as join18 } from "node:path";
function timestamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function listFiles(dir, base = "") {
  if (!existsSync13(dir)) return [];
  const out = [];
  for (const entry of readdirSync5(join18(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      if (!entry.name.endsWith(".pi-setup-new")) out.push(rel);
    } else if (entry.isDirectory()) out.push(...listFiles(dir, rel));
  }
  return out.sort();
}
function backupCopy(from, to) {
  copyFileSync(from, to);
  const st = statSync8(from);
  chmodSync(to, st.mode & 4095);
  utimesSync(to, st.atime, st.mtime);
}
function atomicWrite(link, data, mode, pid = process.pid) {
  const path2 = existsSync13(link) ? realpathSync2(link) : link;
  mkdirSync5(dirname6(path2), { recursive: true });
  const tmp = `${path2}.tmp-${pid}`;
  const fd = openSync2(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync2(fd);
  }
  chmodSync(tmp, mode);
  renameSync3(tmp, path2);
}
var pad;
var init_fsx = __esm({
  "src/fsx.ts"() {
    pad = (n3) => String(n3).padStart(2, "0");
  }
});

// src/manifest.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync14, lstatSync, readFileSync as readFileSync11 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join19, relative } from "node:path";
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function fileSha(path2) {
  try {
    return lstatSync(path2).isFile() ? sha256(readFileSync11(path2)) : void 0;
  } catch {
    return void 0;
  }
}
function emptyManifest(now) {
  const stamp = now.toISOString();
  return { version: 1, installedAt: stamp, updatedAt: stamp, source: noSource(), files: {}, symlinks: {}, dirs: [], json: {} };
}
function problemWith(rel, allowProtected = false) {
  if (typeof rel !== "string" || rel === "") return "empty path";
  if (rel.includes("\0") || rel.includes("\\")) return "invalid character";
  if (isAbsolute3(rel)) return "absolute path";
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) return "path escapes its directory";
  const prefix = ".pi/agent/";
  if (!allowProtected && rel.startsWith(prefix)) {
    const sub = rel.slice(prefix.length);
    if (DENY_FILES.includes(sub) || DENY_DIRS.some((d) => sub === d || sub.startsWith(`${d}/`))) return "protected path";
  }
  return void 0;
}
function fromHomeRel(home, rel) {
  const problem = problemWith(rel);
  if (problem) throw new SetupError(`manifest path rejected (${problem}): ${String(rel)}`);
  return join19(home, rel);
}
function symlinkTarget(home, rel) {
  const problem = problemWith(rel, true);
  if (problem) throw new SetupError(`manifest target rejected (${problem}): ${String(rel)}`);
  return join19(home, rel);
}
function homeRel(home, abs) {
  const rel = relative(home, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute3(rel)) throw new SetupError(`${abs} is outside ${home}`);
  return rel.split("\\").join("/");
}
function checkBackupRel(rel) {
  if (typeof rel !== "string" || rel === "" || isAbsolute3(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new SetupError(`manifest backup path rejected: ${String(rel)}`);
  }
  return rel;
}
function validateManifest(home, m2) {
  for (const [rel, e] of Object.entries(m2.files)) {
    fromHomeRel(home, rel);
    if (e.pending) fromHomeRel(home, e.pending.path);
    if (e.backup !== void 0) checkBackupRel(e.backup);
  }
  for (const [rel, l2] of Object.entries(m2.symlinks)) {
    fromHomeRel(home, rel);
    symlinkTarget(home, l2.target);
  }
  for (const rel of m2.dirs) fromHomeRel(home, rel);
  for (const rel of Object.keys(m2.pendingNew ?? {})) fromHomeRel(home, rel);
  for (const [rel, j] of Object.entries(m2.json)) {
    fromHomeRel(home, rel);
    if (j.backup !== void 0) checkBackupRel(j.backup);
  }
  for (const c2 of Object.values(m2.components ?? {})) {
    if (!c2.service) continue;
    if (typeof c2.service.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(c2.service.label)) {
      throw new SetupError(`manifest service label rejected: ${String(c2.service.label)}`);
    }
    for (const rel of c2.service.files) fromHomeRel(home, rel);
  }
}
function readManifest(piDir) {
  const path2 = manifestPath(piDir);
  if (!existsSync14(path2)) return void 0;
  const bad = (why) => new SetupError(`${path2}: ${why}; move it aside to re-adopt your files with ./install.sh`);
  let data;
  try {
    data = JSON.parse(readFileSync11(path2, "utf8"));
  } catch (error) {
    throw bad(error.message);
  }
  const m2 = data;
  const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(m2) || m2.version !== 1 || !isObject(m2.files) || !isObject(m2.symlinks) || !isObject(m2.json) || !Array.isArray(m2.dirs)) {
    throw bad("not a version 1 manifest");
  }
  return m2;
}
function saveIfChanged(piDir, old, next, now) {
  const strip = (m2) => JSON.stringify({ ...m2, updatedAt: "" });
  if (old && strip(old) === strip(next)) return false;
  next.updatedAt = now.toISOString();
  atomicWrite(manifestPath(piDir), `${JSON.stringify(next, null, 2)}
`, 420);
  return true;
}
function pinnedBackups(m2) {
  const pinned = /* @__PURE__ */ new Set();
  for (const e of Object.values(m2?.files ?? {})) if (e.backup) pinned.add(e.backup);
  for (const e of Object.values(m2?.json ?? {})) if (e.backup) pinned.add(e.backup);
  return pinned;
}
function recordSet(entry, op) {
  const i2 = entry.ops.findIndex((o) => o.op === "set" && o.key === op.key);
  const prior = entry.ops[i2];
  if (prior?.op === "set") entry.ops[i2] = { ...op, before: prior.before };
  else entry.ops.push(op);
}
function recordArrayAdd(entry, op) {
  const known = entry.ops.some((o) => o.op === "array-add" && o.key === op.key && deepEqual(o.value, op.value));
  if (!known) entry.ops.push(op);
}
var noSource, dataDir, manifestPath, backupsDir, DENY_FILES, DENY_DIRS;
var init_manifest = __esm({
  "src/manifest.ts"() {
    init_fsx();
    init_settings();
    init_types();
    noSource = () => ({ release: null, commit: null });
    dataDir = (piDir) => join19(piDir, ".pi-setup");
    manifestPath = (piDir) => join19(dataDir(piDir), "manifest.json");
    backupsDir = (piDir) => join19(dataDir(piDir), "backups");
    DENY_FILES = ["auth.json", "auth.json.lock", "models-store.json", "guards.json", "lane-policy/policy.json"];
    DENY_DIRS = ["accounts", "sessions", "jobs", "relaunch", "context-budget", "pi-phase/state", "npm/node_modules", ".pi-setup"];
  }
});

// src/backups.ts
import { existsSync as existsSync15, mkdirSync as mkdirSync6, readdirSync as readdirSync6, rmdirSync, rmSync, statSync as statSync9, unlinkSync } from "node:fs";
import { dirname as dirname7, join as join20, relative as relative2 } from "node:path";
function filesBelow(dir, base = "") {
  const out = [];
  for (const e of readdirSync6(join20(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesBelow(dir, rel));
    else out.push(rel);
  }
  return out;
}
function order(name) {
  const m2 = RUN_DIR.exec(name);
  return [m2[1], m2[2] ? Number(m2[2]) : 1];
}
function listBackups(piDir, pinned) {
  const base = backupsDir(piDir);
  if (!existsSync15(base)) return [];
  return readdirSync6(base, { withFileTypes: true }).filter((e) => e.isDirectory() && RUN_DIR.test(e.name)).map((e) => e.name).sort((a2, b) => {
    const [x, y2] = [order(a2), order(b)];
    return x[0] === y2[0] ? y2[1] - x[1] : x[0] < y2[0] ? 1 : -1;
  }).map((name) => {
    const files2 = filesBelow(join20(base, name));
    return { name, path: join20(base, name), files: files2, pinned: files2.some((f) => pinned.has(`${name}/${f}`)) };
  });
}
function pruneEmptyDirs(dir) {
  for (const e of readdirSync6(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(join20(dir, e.name));
  if (readdirSync6(dir).length === 0) rmdirSync(dir);
}
function prune(piDir, keep, pinned, dryRun) {
  const removed = [];
  for (const info of listBackups(piDir, pinned).slice(keep)) {
    if (!info.pinned) {
      removed.push(info.path);
      if (!dryRun) rmSync(info.path, { recursive: true, force: true });
      continue;
    }
    for (const file of info.files) {
      if (pinned.has(`${info.name}/${file}`)) continue;
      removed.push(join20(info.path, file));
      if (!dryRun) unlinkSync(join20(info.path, file));
    }
    if (!dryRun) {
      for (const e of readdirSync6(info.path, { withFileTypes: true })) if (e.isDirectory()) pruneEmptyDirs(join20(info.path, e.name));
    }
  }
  return removed;
}
function tidy(piDir) {
  const base = backupsDir(piDir);
  if (existsSync15(base) && statSync9(base).isDirectory()) pruneEmptyDirs(base);
  const data = dirname7(base);
  if (existsSync15(data) && readdirSync6(data).length === 0) rmdirSync(data);
}
function backupsCommand(ctx, sub, keep, dryRun) {
  const piDir = join20(ctx.home, ".pi", "agent");
  const pinned = pinnedBackups(readManifest(piDir));
  if (sub === "list") {
    const all = listBackups(piDir, pinned);
    if (all.length === 0) ctx.out("No backups.");
    for (const b of all) ctx.out(`${b.name}  ${b.files.length} file(s)${b.pinned ? "  (pinned: uninstall restores from it)" : ""}`);
    return 0;
  }
  const removed = prune(piDir, keep, pinned, dryRun);
  for (const path2 of removed) ctx.out(`${dryRun ? "would remove" : "remove"} ${path2}`);
  ctx.out(removed.length === 0 ? "Nothing to prune." : dryRun ? "Nothing was removed." : `Removed ${removed.length} item(s).`);
  return 0;
}
var RUN_DIR, BackupRun;
var init_backups = __esm({
  "src/backups.ts"() {
    init_fsx();
    init_manifest();
    RUN_DIR = /^(\d{8}-\d{6})(?:-(\d+))?$/;
    BackupRun = class {
      dir;
      piDir;
      home;
      now;
      constructor(piDir, home, now) {
        this.piDir = piDir;
        this.home = home;
        this.now = now;
      }
      /** Copy abs into this run's folder; returns the path relative to .pi-setup/backups/. */
      backup(abs) {
        const run = this.runDir();
        const inside = abs.startsWith(`${this.piDir}/`);
        const rel = inside ? relative2(this.piDir, abs) : `_home/${relative2(this.home, abs)}`;
        const target = join20(run, rel);
        if (!existsSync15(target)) {
          mkdirSync6(dirname7(target), { recursive: true });
          backupCopy(abs, target);
        }
        return `${relative2(backupsDir(this.piDir), run)}/${rel}`;
      }
      runDir() {
        if (this.dir) return this.dir;
        const base = backupsDir(this.piDir);
        mkdirSync6(base, { recursive: true });
        const stamp = timestamp(this.now);
        for (let n3 = 1; ; n3++) {
          const candidate = join20(base, n3 === 1 ? stamp : `${stamp}-${n3}`);
          try {
            mkdirSync6(candidate);
            this.dir = candidate;
            return candidate;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
      }
    };
  }
});

// src/apply.ts
import {
  chmodSync as chmodSync2,
  existsSync as existsSync16,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync7,
  readFileSync as readFileSync12,
  statSync as statSync10,
  symlinkSync,
  utimesSync as utimesSync2,
  writeFileSync as writeFileSync6
} from "node:fs";
import { dirname as dirname8, join as join21 } from "node:path";
function describe(action) {
  if (action.op === "install") return `install ${action.path}`;
  if (action.op === "keep") return `keep ${action.path} (changed since install; new version in ${action.newPath})`;
  if (action.op === "register") {
    const what = (action.jsonOps ?? []).map((o) => o.op === "array-add" ? String(o.value) : o.key).join(", ");
    return `register ${what || "changes"} in ${action.path}`;
  }
  return void 0;
}
async function sourceOf(ctx) {
  const git2 = async (args) => {
    const r2 = await ctx.run("git", ["-C", ctx.repoDir, ...args], { timeoutMs: 5e3 });
    return r2.code === 0 && r2.stdout.trim() ? r2.stdout.trim() : null;
  };
  return { release: await git2(["describe", "--tags", "--exact-match", "HEAD"]), commit: await git2(["rev-parse", "HEAD"]) };
}
function npmInputs(piDir) {
  const pkg = join21(piDir, "npm", "package.json");
  if (!existsSync16(pkg)) return void 0;
  const lock = join21(piDir, "npm", "package-lock.json");
  return { packageJson: fileSha(pkg) ?? "", ...fileSha(lock) ? { lock: fileSha(lock) } : {} };
}
function needsNpm(actions, piDir, manifest, force = false) {
  const npmDir = join21(piDir, "npm");
  const pkg = join21(npmDir, "package.json");
  const lock = join21(npmDir, "node_modules", ".package-lock.json");
  if (actions.some((a2) => a2.op === "install" && a2.path === pkg)) return true;
  if (!existsSync16(pkg)) return false;
  if (force || !existsSync16(join21(npmDir, "node_modules"))) return true;
  const known = manifest?.npm;
  if (known) {
    const now = npmInputs(piDir);
    return now?.packageJson !== known.packageJson || now?.lock !== known.lock;
  }
  if (!existsSync16(lock)) return true;
  return statSync10(pkg).mtimeMs > statSync10(lock).mtimeMs;
}
async function apply(ctx, actions, options, manifest) {
  const piDir = join21(ctx.home, ".pi", "agent");
  for (const action of actions) {
    const line = describe(action);
    if (line) ctx.out(line);
  }
  if (options.dryRun) return { code: 0, wrote: false, written: /* @__PURE__ */ new Set() };
  const run = new Run(ctx, piDir, manifest, noSource());
  let code = 0;
  try {
    run.source = await sourceOf(ctx);
    for (const action of actions) run.execute(action);
    applyProfile(options, piDir, run);
    if (options.components) run.next.components = options.components;
    if (code === 0) {
      const npm2 = await runNpm(ctx, actions, options, piDir, manifest);
      code = npm2.code;
      if (npm2.ran) run.wrote = true;
      if (npm2.ran && npm2.code === 0) run.next.npm = npmInputs(piDir);
    }
  } finally {
    run.finish();
  }
  return { code, wrote: run.wrote, written: run.written };
}
function applyProfile(options, piDir, run) {
  if (options.activeBefore === options.profile) return;
  const path2 = join21(piDir, "profiles", "ACTIVE");
  run.execute({ op: "install", path: path2, content: Buffer.from(`${options.profile}
`), mode: 420, existed: options.activeBefore !== void 0 });
}
async function runNpm(ctx, actions, options, piDir, manifest) {
  if (options.skipNpm) return { code: 0, ran: false };
  if (!needsNpm(actions, piDir, manifest, options.reinstallNpm)) {
    ctx.out("npm packages up to date");
    return { code: 0, ran: false };
  }
  const args = ["install", "--legacy-peer-deps"];
  const cwd = join21(piDir, "npm");
  options.spinner?.start("Installing npm packages");
  const result2 = await ctx.run("npm", args, { cwd, inherit: options.inheritNpm });
  options.spinner?.stop(result2.code === 0 ? "npm packages installed" : "npm install failed");
  if (result2.code === 0) return { code: 0, ran: true };
  if (!options.inheritNpm) ctx.err((result2.stdout + result2.stderr).trim().split("\n").slice(-15).join("\n"));
  ctx.err("Files installed; npm install failed: (cd ~/.pi/agent/npm && npm install --legacy-peer-deps)");
  return { code: 1, ran: true };
}
function readActive(piDir) {
  const file = join21(piDir, "profiles", "ACTIVE");
  return existsSync16(file) ? readFileSync12(file, "utf8").trim() : void 0;
}
var KEEP_RUNS, modeOf, Run;
var init_apply = __esm({
  "src/apply.ts"() {
    init_fsx();
    init_backups();
    init_manifest();
    KEEP_RUNS = 10;
    modeOf = (path2) => statSync10(path2).mode & 4095;
    Run = class {
      backups;
      next;
      /** Files this run wrote or adopted; only these may be chmodded or recorded. */
      written = /* @__PURE__ */ new Set();
      wrote = false;
      source;
      dirs = /* @__PURE__ */ new Set();
      ctx;
      piDir;
      old;
      constructor(ctx, piDir, old, source) {
        this.ctx = ctx;
        this.piDir = piDir;
        this.old = old;
        this.source = source;
        this.backups = new BackupRun(piDir, ctx.home, ctx.now());
        this.next = old ? structuredClone(old) : emptyManifest(ctx.now());
      }
      ensureDir(dir) {
        const missing = [];
        for (let d = dir; d.startsWith(`${this.ctx.home}/`) && !existsSync16(d); d = dirname8(d)) missing.push(d);
        mkdirSync7(dir, { recursive: true });
        for (const m2 of missing) this.dirs.add(homeRel(this.ctx.home, m2));
      }
      backupIfThere(path2) {
        return existsSync16(path2) && statSync10(path2).isFile() ? this.backups.backup(path2) : void 0;
      }
      rel(path2) {
        return homeRel(this.ctx.home, path2);
      }
      /** Write one action, then record it. */
      execute(action) {
        if (action.op === "install") this.install(action);
        else if (action.op === "register") this.register(action);
        else if (action.op === "keep") this.keep(action);
        else if (action.op === "adopt") this.adopt(action.path);
        else if (action.op === "symlink") this.symlink(action);
        else this.chmodX(action.path);
      }
      install(a2) {
        const backup = a2.existed ? this.backupIfThere(a2.path) : void 0;
        const priorSha = fileSha(a2.path);
        this.ensureDir(dirname8(a2.path));
        if (/\/(user\.json|settings\.json|ACTIVE)$/.test(a2.path)) {
          atomicWrite(a2.path, a2.content, a2.mode);
        } else {
          writeFileSync6(a2.path, a2.content);
          chmodSync2(a2.path, a2.mode);
        }
        if (a2.mtimeMs !== void 0) utimesSync2(a2.path, a2.mtimeMs / 1e3, a2.mtimeMs / 1e3);
        this.wrote = true;
        if (a2.merge === "user-json") this.recordJson(a2.path, a2.content, priorSha, !a2.existed, backup, a2.jsonOps ?? []);
        else this.recordFile(a2.path, a2.content, backup);
      }
      /** Record a file this run wrote, with the hash of the bytes it wrote. */
      recordFile(path2, content, backup) {
        const rel = this.rel(path2);
        const entry = this.next.files[rel] ?? { sha256: "", mode: 0, source: this.source, origin: backup ? "replaced" : "new", ...backup ? { backup } : {} };
        entry.sha256 = sha256(content);
        entry.mode = modeOf(path2);
        entry.source = this.source;
        delete entry.pending;
        this.next.files[rel] = entry;
        this.written.add(path2);
      }
      /** priorSha is the hash on disk just before this run wrote; a mismatch with the recorded one means the user edited the file. */
      recordJson(path2, content, priorSha, created, backup, ops) {
        const rel = this.rel(path2);
        const entry = this.next.json[rel] ?? { created, sha256After: "", ops: [] };
        if (this.next.json[rel] && priorSha !== entry.sha256After) entry.edited = true;
        if (backup && !entry.created && !entry.backup) entry.backup = backup;
        for (const op of ops) {
          if (op.op === "set") recordSet(entry, op);
          else recordArrayAdd(entry, op);
        }
        entry.sha256After = sha256(content);
        this.next.json[rel] = entry;
      }
      register(a2) {
        const file = this.next.files[this.rel(a2.path)];
        const priorSha = fileSha(a2.path);
        const unmodified = Boolean(file) && priorSha === file.sha256;
        const backup = a2.existed ? this.backupIfThere(a2.path) : void 0;
        this.ensureDir(dirname8(a2.path));
        atomicWrite(a2.path, a2.content, a2.mode);
        this.wrote = true;
        if (file && (unmodified || !a2.existed)) {
          this.recordFile(a2.path, a2.content, void 0);
          this.recordJson(a2.path, a2.content, priorSha, true, void 0, a2.jsonOps ?? []);
        } else {
          this.recordJson(a2.path, a2.content, priorSha, false, backup, a2.jsonOps ?? []);
        }
      }
      keep(a2) {
        if (a2.write) {
          this.ensureDir(dirname8(a2.newPath));
          atomicWrite(a2.newPath, a2.content, a2.mode);
          this.wrote = true;
        }
        const entry = this.next.files[this.rel(a2.path)];
        const pending2 = { path: this.rel(a2.newPath), sha256: sha256(a2.content) };
        if (entry) entry.pending = pending2;
        else if (existsSync16(a2.newPath)) this.next.pendingNew = { ...this.next.pendingNew, [pending2.path]: pending2.sha256 };
      }
      adopt(path2) {
        const rel = this.rel(path2);
        const entry = this.next.files[rel];
        if (!entry) {
          this.next.files[rel] = { sha256: fileSha(path2) ?? "", mode: modeOf(path2), source: this.source, origin: "adopted" };
        } else {
          const sha = fileSha(path2) ?? "";
          if (sha !== entry.sha256) {
            entry.sha256 = sha;
            entry.source = this.source;
          }
          entry.mode = modeOf(path2);
          delete entry.pending;
        }
        this.written.add(path2);
      }
      symlink(a2) {
        try {
          lstatSync2(a2.path);
          return;
        } catch {
        }
        this.ensureDir(dirname8(a2.path));
        symlinkSync(a2.target, a2.path);
        this.wrote = true;
        this.next.symlinks[this.rel(a2.path)] = { target: this.rel(a2.target) };
      }
      /** Only for a file this run wrote or adopted; a kept (user-modified) file is never touched. */
      chmodX(path2) {
        if (!this.written.has(path2) || !existsSync16(path2)) return;
        const mode = statSync10(path2).mode;
        if ((mode & 73) === 0) {
          chmodSync2(path2, mode | 73);
          this.wrote = true;
        }
        const entry = this.next.files[this.rel(path2)];
        if (entry) entry.mode = modeOf(path2);
      }
      /** Save the manifest and prune old backups. */
      finish() {
        for (const rel of [...this.dirs].sort()) if (!this.next.dirs.includes(rel)) this.next.dirs.push(rel);
        if (this.wrote) this.next.source = this.source;
        const hasEntries = Object.keys(this.next.files).length + Object.keys(this.next.json).length + Object.keys(this.next.symlinks).length > 0;
        if (this.old || hasEntries) saveIfChanged(this.piDir, this.old, this.next, this.ctx.now());
        try {
          prune(this.piDir, KEEP_RUNS, pinnedBackups(this.next), false);
        } catch (error) {
          this.ctx.err(`warning: could not prune old backups: ${error.message}`);
        }
      }
    };
  }
});

// src/components.ts
import { existsSync as existsSync17, readdirSync as readdirSync7, readFileSync as readFileSync13, statSync as statSync11 } from "node:fs";
import { join as join22 } from "node:path";
function available(id, ctx) {
  if (id === "docker-guardian") return ctx.platform === "darwin" ? true : "needs Docker Desktop on macOS";
  if (id === "secret-sweep") return ctx.platform === "darwin" ? true : "its schedule is a macOS launchd job";
  if (id === "lanes") return ctx.which("git") ? true : "needs git";
  if (id === "cleanup") return ctx.platform === "darwin" || ctx.which("systemctl") ? true : "needs launchd (macOS) or systemd";
  return true;
}
function resolveComponents(input) {
  const out = {};
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
function currentState(ctx) {
  const piDir = join22(ctx.home, ".pi", "agent");
  const mcp = readJson(join22(piDir, "mcp-adapter.json"));
  const servers = mcp?.mcpServers;
  const packages2 = readJson(join22(piDir, "settings.json"))?.packages;
  return {
    cratis: existsSync17(join22(piDir, "extensions", "cratis-cli-guard.ts")),
    codescene: typeof servers === "object" && servers !== null && "codescene" in servers,
    web: Array.isArray(packages2) && packages2.some((p) => WEB_PACKAGES.includes(p))
  };
}
function isDir(path2) {
  try {
    return statSync11(path2).isDirectory();
  } catch {
    return false;
  }
}
function hasCratisDir(root) {
  const entries = (dir) => {
    try {
      return readdirSync7(dir).slice(0, LIMIT);
    } catch {
      return [];
    }
  };
  for (const a2 of entries(root)) {
    if (a2 === ".cratis") return true;
    const one = join22(root, a2);
    if (!isDir(one)) continue;
    if (entries(one).some((b) => b === ".cratis" && isDir(join22(one, b)))) return true;
  }
  return false;
}
function detectDefaults(ctx, detection, reposRoot) {
  const cratis = detection.github.orgs.some((o) => o.toLowerCase() === "cratis") || isDir(join22(reposRoot, "cratis")) || isDir(join22(reposRoot, "Cratis")) || hasCratisDir(reposRoot);
  return {
    "docker-guardian": ctx.platform === "darwin" && Boolean(ctx.which("docker")),
    cleanup: ctx.platform === "darwin" || Boolean(ctx.which("systemctl")),
    "secret-sweep": ctx.platform === "darwin" && Boolean(ctx.which("gitleaks")),
    codescene: Boolean(ctx.which("cs-mcp")) || Boolean(ctx.env.CS_ACCESS_TOKEN),
    cratis,
    web: true,
    lanes: false
  };
}
function hintFor(def, on) {
  const why = {
    "docker-guardian": ["docker found", "no docker found"],
    cleanup: ["a scheduler is available", "no scheduler found"],
    "secret-sweep": ["gitleaks found", "gitleaks not found"],
    codescene: ["cs-mcp or a token found", "no cs-mcp or token found"],
    cratis: ["Cratis repos found", "no Cratis repos found"],
    web: ["on by default", "off"],
    lanes: ["explicitly selected", "opt-in"]
  };
  const [yes, no] = why[def.id];
  return on ? `${yes}; ${def.explain}` : `off: ${no}; ${def.explain}`;
}
function isCratisFile(rel) {
  return rel === "extensions/cratis-cli-guard.ts" || rel === "lib/cratis-cli-guard.test.ts" || rel === "agents/cratis-cli.md" || rel === "bin/cratis-local-run" || /^profiles\/[^/]+\/agents\/cratis-cli\.md$/.test(rel);
}
function dropGuardExtension(content) {
  const text3 = content.toString("utf8");
  const fm = /^---\n[\s\S]*?\n---/.exec(text3);
  if (!fm) return content;
  const head = fm[0].replace(/^(extensions:\s*\[)([^\]\n]*)(\])/m, (_m, a2, list, b) => `${a2}${list.split(",").map((s) => s.trim()).filter((s) => s && s !== "cratis-cli-guard").join(", ")}${b}`);
  return head === fm[0] ? content : Buffer.from(head + text3.slice(fm[0].length), "utf8");
}
function stripSections(buf, offIds) {
  let text3 = buf.toString("utf8");
  const warnings = [];
  for (const id of offIds) {
    const s = markerRe(id, "start").exec(text3);
    const e = markerRe(id, "end").exec(text3);
    if (!s || !e || e.index < s.index) {
      warnings.push(`AGENTS.md has no pi-setup:${id} markers; its ${id} section stays`);
      continue;
    }
    let end = text3.indexOf("\n", e.index);
    end = end < 0 ? text3.length : end + 1;
    if (text3[end] === "\n") end += 1;
    text3 = text3.slice(0, s.index) + text3.slice(end);
  }
  return { content: Buffer.from(text3, "utf8"), warnings };
}
function codesceneNotes(ctx) {
  return [
    ...ctx.env.CS_ACCESS_TOKEN ? [] : ["CodeScene: set CS_ACCESS_TOKEN in your shell profile (pi-setup never stores it)"],
    ...ctx.which("cs-mcp") ? [] : [`install cs-mcp: ${CS_REPO}#readme`],
    `CodeScene skills are not bundled: copy ${CS_SKILLS.join(", ")} from ${CS_REPO}/tree/main/skills to ~/.agents/skills/`
  ];
}
var COMPONENT_IDS, COMPONENTS, isComponentId, readJson, WEB_PACKAGES, LIMIT, markerRe, CS_REPO, CS_SKILLS;
var init_components = __esm({
  "src/components.ts"() {
    COMPONENT_IDS = ["docker-guardian", "cleanup", "secret-sweep", "codescene", "cratis", "web", "lanes"];
    COMPONENTS = [
      { id: "docker-guardian", label: "docker-guardian", explain: "restarts a hung Docker Desktop every 2 minutes (macOS launchd)", service: true },
      { id: "cleanup", label: "cleanup schedule", explain: "daily disk cleanup of pi's caches (launchd or systemd timer)", service: true },
      { id: "secret-sweep", label: "secret-sweep", explain: "daily scan of pi sessions for leaked secrets (macOS launchd; needs gitleaks)", service: true },
      { id: "codescene", label: "CodeScene", explain: "Code Health MCP server and policy in AGENTS.md (needs cs-mcp and a token)", service: false },
      { id: "cratis", label: "Cratis conventions", explain: "Cratis rules, cratis-cli guard and agent, and the Cratis sections of AGENTS.md", service: false },
      { id: "lanes", label: "lanes", explain: "the lanes command: a coordinator and several pi sessions in git worktrees, talking through message files", service: false },
      { id: "web", label: "browser and web tools", explain: "pi-web-access and pi-browser-use (the browser may download on first use)", service: false }
    ];
    isComponentId = (id) => COMPONENT_IDS.includes(id);
    readJson = (path2) => {
      try {
        const data = JSON.parse(readFileSync13(path2, "utf8"));
        return typeof data === "object" && data !== null && !Array.isArray(data) ? data : void 0;
      } catch {
        return void 0;
      }
    };
    WEB_PACKAGES = ["npm:pi-web-access", "npm:pi-browser-use"];
    LIMIT = 200;
    markerRe = (id, which) => new RegExp(`^<!-- pi-setup:${id}:${which}\\b[^\\n]*-->[ \\t]*$`, "m");
    CS_REPO = "https://github.com/codescene-oss/codescene-mcp-server";
    CS_SKILLS = [
      "explaining-code-health",
      "guiding-refactoring-with-code-health",
      "making-the-business-case-for-code-health",
      "prioritizing-technical-debt",
      "risk-based-testing-with-code-health",
      "routing-work-with-code-ownership",
      "safeguarding-ai-generated-code"
    ];
  }
});

// src/args.ts
function isAbsoluteOrHome(value) {
  return value.startsWith("/") || value.startsWith("~");
}
function parseArgs(argv, cwd) {
  const options = {
    command: "install",
    sub: "list",
    keep: 10,
    ref: "",
    help: false,
    dryRun: false,
    user: "",
    reposRoot: "",
    dir: "",
    profile: "",
    yes: false,
    skipNpm: false,
    reinstallNpm: false,
    preapproveMcp: false,
    plan: false,
    json: false,
    fix: false,
    with: [],
    without: []
  };
  let args = argv[0] === "install" ? argv.slice(1) : argv;
  if (args[0] === "uninstall" || args[0] === "update" || args[0] === "backups" || args[0] === "doctor" || args[0] === "lanes") {
    options.command = args[0];
    args = args.slice(1);
    if (options.command === "backups" && (args[0] === "list" || args[0] === "prune")) {
      options.sub = args[0];
      args = args.slice(1);
    }
  }
  const allowed = ALLOWED[options.command];
  for (let i2 = 0; i2 < args.length; i2++) {
    const arg = args[i2];
    if (arg === "--dir" && options.command !== "lanes") return { ok: false, error: `--dir is not valid for ${options.command}` };
    if (arg === "--fix" && options.command !== "doctor") return { ok: false, error: `--fix is not valid for ${options.command}` };
    if (allowed && (arg in BOOLEAN_FLAGS || VALUE_FLAGS.has(arg)) && !allowed.includes(arg)) {
      return { ok: false, error: `${arg} is not valid for ${options.command}` };
    }
    if (arg in BOOLEAN_FLAGS) {
      options[BOOLEAN_FLAGS[arg]] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[i2 + 1];
      if (value === void 0 || value === "" || value.startsWith("--")) {
        return { ok: false, error: `Missing value for ${arg}` };
      }
      i2++;
      if (arg === "--keep") {
        if (!/^\d+$/.test(value)) return { ok: false, error: "--keep needs a non-negative integer" };
        options.keep = Number(value);
        continue;
      }
      if (arg === "--ref") {
        if (value.startsWith("-")) return { ok: false, error: "--ref must be a tag or commit, not an option" };
        options.ref = value;
        continue;
      }
      if (arg === "--with" || arg === "--without") {
        if (!isComponentId(value)) return { ok: false, error: `unknown component '${value}' for ${arg}; valid ids: ${COMPONENT_IDS.join(", ")}` };
        (arg === "--with" ? options.with : options.without).push(value);
        continue;
      }
      if (arg === "--user") options.user = value;
      else if (arg === "--profile") options.profile = value;
      else if (arg === "--dir") options.dir = isAbsoluteOrHome(value) ? value : `${cwd}/${value}`;
      else options.reposRoot = isAbsoluteOrHome(value) ? value : `${cwd}/${value}`;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  const both = options.with.filter((id) => options.without.includes(id));
  if (both.length) return { ok: false, error: `${both.join(", ")} is in both --with and --without; valid ids: ${COMPONENT_IDS.join(", ")}` };
  return { ok: true, options };
}
function isInteractive(options, env, stdinTTY, stdoutTTY) {
  return stdinTTY && stdoutTTY && !env.CI && !options.yes && !options.json && !options.plan && !options.dryRun;
}
var USAGE, VALUE_FLAGS, COMMON, ALLOWED, BOOLEAN_FLAGS;
var init_args = __esm({
  "src/args.ts"() {
    init_components();
    USAGE = `Usage: ./install.sh [install] [options]
       ./install.sh uninstall [--dry-run] [--yes]
       ./install.sh update [--dry-run] [--ref <tag>] [--yes] [--skip-npm]
       ./install.sh backups [list | prune --keep <n> [--dry-run]]
       ./install.sh doctor [--fix] [--json]
       ./install.sh lanes [--dir <folder>]

  --dry-run             show what would change, write nothing
  --plan                print the full plan (detection, profile, actions), write nothing
  --json                print one JSON object on stdout (combine with --plan or --dry-run)
  --user <login>        GitHub login (default: saved, then gh, then ask)
  --repos-root <dir>    repositories root (default: saved, then ~/repos; interactive runs suggest a detected root)
  --profile <name|auto> profile to apply (default: the active one, else chosen from your logins)
  --with <id> / --without <id>  turn an extra on or off: ${COMPONENT_IDS.join(", ")}
  --preapprove-mcp      trust project MCP server definitions for new lanes folders (default: off)
  --yes                 never prompt
  --skip-npm            do not run npm install in ~/.pi/agent/npm
  --reinstall-npm       run npm install even when package.json and the lock file are unchanged
  --help                this text`;
    VALUE_FLAGS = /* @__PURE__ */ new Set(["--dir", "--user", "--repos-root", "--profile", "--ref", "--keep", "--with", "--without"]);
    COMMON = ["--help", "--dry-run"];
    ALLOWED = {
      install: void 0,
      lanes: ["--help", "--dir"],
      doctor: ["--help", "--json", "--fix"],
      uninstall: [...COMMON, "--yes"],
      update: [...COMMON, "--yes", "--skip-npm", "--ref"],
      backups: [...COMMON, "--keep"]
    };
    BOOLEAN_FLAGS = {
      "--dry-run": "dryRun",
      "--yes": "yes",
      "--skip-npm": "skipNpm",
      "--reinstall-npm": "reinstallNpm",
      "--preapprove-mcp": "preapproveMcp",
      "--plan": "plan",
      "--json": "json",
      "--fix": "fix",
      "--help": "help"
    };
  }
});

// src/detect.ts
import { existsSync as existsSync18 } from "node:fs";
import { join as join23 } from "node:path";
function parseAuthStatus(text3) {
  const match = /Logged in to (\S+) account (\S+)/.exec(text3);
  return match ? { host: match[1], login: match[2] } : {};
}
function parseProviderCheck(stdout2) {
  try {
    const data = JSON.parse(stdout2);
    if (data.status === "ready" || data.status === "not_ready") {
      return {
        status: data.status,
        authType: typeof data.authType === "string" ? data.authType : void 0,
        reason: typeof data.reason === "string" ? data.reason : void 0
      };
    }
  } catch {
  }
  return { status: "unknown" };
}
function parseModelTable(stdout2) {
  const lines2 = stdout2.split("\n");
  const header = lines2.findIndex((l2) => /^\s*provider\s+model\b/i.test(l2));
  if (header < 0) return null;
  const ids = /* @__PURE__ */ new Set();
  for (const line of lines2.slice(header + 1)) {
    const [provider, model] = line.trim().split(/\s+/);
    if (provider && model) ids.add(`${provider}/${model}`);
  }
  return ids.size ? ids : null;
}
async function probeTool(ctx, name) {
  const path2 = ctx.which(name);
  if (!path2) return { name };
  const result2 = await ctx.run(name, ["--version"], { timeoutMs: name === "pi" ? PI_MS : SHORT_MS });
  const first = result2.stdout.trim().split("\n")[0] || result2.stderr.trim().split("\n")[0];
  return { name, path: path2, version: result2.timedOut || !first ? void 0 : first };
}
async function lines(ctx, args) {
  const result2 = await ctx.run("gh", args, { timeoutMs: SHORT_MS });
  if (result2.code !== 0) return void 0;
  return result2.stdout.split("\n").map((l2) => l2.trim()).filter(Boolean);
}
async function probeGithub(ctx, request) {
  const state2 = { orgs: [] };
  if (!ctx.which("gh") || !(request.needLogin || request.wantGithubDetails || request.needScan)) return state2;
  const status2 = request.wantGithubDetails ? ctx.run("gh", ["auth", "status"], { timeoutMs: SHORT_MS }) : Promise.resolve(void 0);
  const user = request.needLogin || request.wantGithubDetails ? lines(ctx, ["api", "user", "--jq", ".login"]) : void 0;
  const orgs = request.needScan && request.needLogin || request.wantGithubDetails ? lines(ctx, ["api", "user/orgs", "--jq", ".[].login"]) : void 0;
  const parsed = parseAuthStatus(`${(await status2)?.stdout ?? ""}
${(await status2)?.stderr ?? ""}`);
  state2.host = parsed.host;
  state2.login = (await user)?.[0] ?? parsed.login;
  state2.orgs = await orgs ?? [];
  return state2;
}
async function probeProvider(ctx, id) {
  const result2 = await ctx.run("pi", ["auth", "check", "--provider", id, "--no-refresh", "--json"], { timeoutMs: PI_MS });
  return result2.timedOut ? { status: "unknown" } : parseProviderCheck(result2.stdout);
}
async function listModels(ctx) {
  const result2 = await ctx.run("pi", ["--offline", "--list-models"], { timeoutMs: PI_MS });
  const text3 = `${result2.stdout}
${result2.stderr}`;
  const catalog = result2.timedOut ? null : /No models available/i.test(text3) ? /* @__PURE__ */ new Set() : parseModelTable(result2.stdout);
  return { catalog, code: result2.code, timedOut: result2.timedOut, stderr: result2.stderr.split("\n").slice(0, 3).join("\n") };
}
async function probeCatalog(ctx) {
  return (await listModels(ctx)).catalog;
}
async function detect(ctx, request) {
  const piPresent = Boolean(ctx.which("pi"));
  const providers2 = {};
  const probePi = request.probePi && piPresent;
  const [tools, github, states, catalog] = await Promise.all([
    Promise.all(TOOLS.map((t2) => t2 === "pi" && !request.probePi ? Promise.resolve({ name: t2, path: ctx.which(t2) }) : probeTool(ctx, t2))),
    probeGithub(ctx, request),
    Promise.all(PROVIDER_IDS.map((id) => probePi ? probeProvider(ctx, id) : Promise.resolve({ status: "unknown" }))),
    probePi ? probeCatalog(ctx) : Promise.resolve(null)
  ]);
  PROVIDER_IDS.forEach((id, i2) => {
    providers2[id] = states[i2];
  });
  const warnings = [];
  if (probePi && catalog?.size === 0) warnings.push("pi reports no models yet; pinned models were not checked.");
  const candidates = request.needScan ? scanRoots(await candidateRoots(ctx), [request.login ?? github.login ?? "", ...github.orgs], {
    now: () => ctx.now().getTime()
  }) : [];
  return {
    os: ctx.platform,
    tools: [...tools, { name: "node", path: process.execPath, version: ctx.nodeVersion }],
    github,
    providers: providers2,
    hints: {
      codexAuthFile: existsSync18(join23(ctx.home, ".codex", "auth.json")),
      claudeDir: existsSync18(join23(ctx.home, ".claude"))
    },
    catalog,
    candidates,
    warnings
  };
}
function readyProviders(detection) {
  return new Set(Object.entries(detection.providers).filter(([, s]) => s.status === "ready").map(([id]) => id));
}
function toolPath(detection, name) {
  return detection.tools.find((t2) => t2.name === name)?.path;
}
function installHint(platform, tool) {
  if (tool === "pi") return "npm i -g @earendil-works/pi-coding-agent";
  const brewName = tool === "python3" ? "python" : tool;
  return platform === "darwin" ? `brew install ${brewName}` : `apt install ${tool === "npm" ? "npm" : tool}`;
}
var TOOLS, SHORT_MS, PI_MS;
var init_detect = __esm({
  "src/detect.ts"() {
    init_repos_scan();
    init_types();
    TOOLS = ["pi", "python3", "jq", "git", "gh", "docker", "dotnet", "rsync", "npm"];
    SHORT_MS = 3e3;
    PI_MS = 8e3;
  }
});

// src/profiles.ts
import { existsSync as existsSync19, readdirSync as readdirSync8, readFileSync as readFileSync14 } from "node:fs";
import { join as join24 } from "node:path";
function profilesDir(repoDir2) {
  return join24(repoDir2, "agent", "profiles");
}
function profileNames(repoDir2) {
  const dir = profilesDir(repoDir2);
  if (!existsSync19(dir)) return [];
  return readdirSync8(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
function loadProfiles(repoDir2) {
  const metas = [];
  for (const name of profileNames(repoDir2)) {
    const file = join24(profilesDir(repoDir2), name, "profile.json");
    if (!existsSync19(file)) continue;
    const data = JSON.parse(readFileSync14(file, "utf8"));
    metas.push({
      name,
      summary: typeof data.summary === "string" ? data.summary : "",
      requires: stringList(data.requires),
      uses: stringList(data.uses),
      rank: typeof data.rank === "number" ? data.rank : 0
    });
  }
  return metas;
}
function chooseProfile(ready2, profiles) {
  const fit = profiles.filter((p) => p.requires.every((r2) => ready2.has(r2))).sort((a2, b) => b.rank - a2.rank)[0];
  const name = fit?.name ?? FALLBACK_PROFILE;
  return { name, reason: reasonFor(ready2, name), provisional: !fit, source: "chooser" };
}
function reasonFor(ready2, name) {
  const claude = ready2.has("anthropic");
  const gpt = ready2.has("openai-codex");
  const kimi = ready2.has("kimi-coding");
  if (claude && gpt && kimi) return "you have Claude, ChatGPT and Kimi: each role goes where it is strongest";
  if (claude && gpt) return "you have Claude and ChatGPT; Kimi roles (ops, scout) fall back to GPT via provider-fallback";
  if (gpt && !claude) return `only ChatGPT is logged in: ${name} keeps every role on GPT`;
  if (claude) return "no Claude-only profile yet; balanced is used and GPT roles need a ChatGPT login";
  return "log in with /login in pi, then rerun ./install.sh --profile auto";
}
function kimiNote(profile2, ready2) {
  if (!profile2?.uses.includes("kimi-coding") || ready2.has("kimi-coding")) return void 0;
  return "Kimi is not logged in: the Kimi roles fall back to GPT.";
}
function pinnedModels(profileDir) {
  const pins = /* @__PURE__ */ new Set();
  for (const file of listFiles(join24(profileDir, "agents")).filter((f) => f.endsWith(".md"))) {
    const text3 = readFileSync14(join24(profileDir, "agents", file), "utf8");
    const match = /^model:\s*(\S+)/m.exec(text3);
    if (match) pins.add(match[1]);
  }
  return [...pins].sort();
}
function pinWarnings(pins, ready2, catalog) {
  if (!catalog || catalog.size === 0) return [];
  return pins.filter((pin) => ready2.has(pin.split("/")[0]) && !catalog.has(pin)).map((pin) => `Pinned model ${pin} is not in this pi's model catalog.`);
}
function overlayFor(repoDir2, name, settings2) {
  const base = join24(profilesDir(repoDir2), name);
  if (!existsSync19(base)) throw new SetupError(`unknown profile '${name}'. available: ${profileNames(repoDir2).join(", ")}`);
  const sources = /* @__PURE__ */ new Map();
  for (const [sub, ext] of [["agents", ".md"], ["workflows", ".js"]]) {
    for (const file of listFiles(join24(base, sub))) {
      if (!file.includes("/") && file.endsWith(ext)) sources.set(`${sub}/${file}`, join24(base, sub, file));
    }
  }
  const routingPath = join24(base, "routing.md");
  return { sources, routing: existsSync19(routingPath) ? render(readFileSync14(routingPath), settings2) : void 0 };
}
function markerLines(text3) {
  const start2 = text3.indexOf(START);
  const end = text3.indexOf(END);
  if (start2 < 0 || end < 0 || end < start2) return void 0;
  const bodyStart = text3.indexOf("\n", start2) + 1;
  if (bodyStart === 0 || bodyStart > end) return void 0;
  const nl = text3.indexOf("\n", end);
  return { start: start2, bodyStart, end, endLineEnd: nl < 0 ? text3.length : nl };
}
function hasRoutingMarkers(content) {
  return markerLines(content.toString("utf8")) !== void 0;
}
function spliceRouting(agentsMd2, routing, live) {
  const text3 = agentsMd2.toString("utf8");
  const m2 = markerLines(text3);
  if (!m2) throw new SetupError("routing markers not found in AGENTS.md");
  const l2 = live ? markerLines(live.toString("utf8")) : void 0;
  const liveText = live?.toString("utf8") ?? "";
  const startLine = l2 ? liveText.slice(l2.start, l2.bodyStart) : text3.slice(m2.start, m2.bodyStart);
  const endLine = l2 ? liveText.slice(l2.end, l2.endLineEnd) : text3.slice(m2.end, m2.endLineEnd);
  return Buffer.from(text3.slice(0, m2.start) + startLine + routing.toString("utf8") + endLine + text3.slice(m2.endLineEnd), "utf8");
}
var START, END, FALLBACK_PROFILE;
var init_profiles = __esm({
  "src/profiles.ts"() {
    init_settings();
    init_fsx();
    init_types();
    START = "<!-- pi-profile:routing:start";
    END = "<!-- pi-profile:routing:end -->";
    FALLBACK_PROFILE = "balanced";
  }
});

// src/plan.ts
import { existsSync as existsSync20, lstatSync as lstatSync3, readdirSync as readdirSync9, readFileSync as readFileSync15, readlinkSync, statSync as statSync12 } from "node:fs";
import { join as join25 } from "node:path";
function fromSource(src, settings2) {
  const raw = readFileSync15(src);
  const st = statSync12(src);
  const mode = st.mode & 4095;
  return hasTokens(raw) ? { content: render(raw, settings2), mode } : { content: raw, mode, mtimeMs: st.mtimeMs };
}
function sameBytes(dest, content) {
  return existsSync20(dest) && statSync12(dest).isFile() && readFileSync15(dest).equals(content);
}
function put(actions, dest, desired) {
  if (sameBytes(dest, desired.content)) {
    actions.push({ op: "adopt", path: dest });
    return;
  }
  actions.push({ op: "install", path: dest, existed: existsSync20(dest), ...desired });
}
function putSource(actions, src, dest, settings2) {
  put(actions, dest, fromSource(src, settings2));
}
function putTree(actions, srcDir, destDir, settings2, overlay, prefix = "", filter = NO_FILTER, treeRel = "") {
  const files2 = new Set(listFiles(srcDir));
  for (const [rel, src] of overlay ?? []) if (rel.startsWith(prefix)) files2.add(rel.slice(prefix.length));
  for (const rel of [...files2].sort()) {
    const full = `${treeRel}${rel}`;
    if (filter.skip(full)) continue;
    const src = overlay?.get(`${prefix}${rel}`) ?? join25(srcDir, rel);
    const desired = fromSource(src, settings2);
    const content = filter.transform(full, desired.content);
    put(actions, join25(destDir, rel), content === desired.content ? desired : { content, mode: desired.mode });
  }
}
function userJsonAction(actions, piDir, settings2) {
  const path2 = join25(piDir, "user.json");
  const existing = readSettings(path2);
  const merged = mergeUserJson(existing, settings2);
  if (existsSync20(path2) && deepEqual(existing, merged)) return;
  const jsonOps = [];
  for (const key of ["githubUser", "reposRoot"]) {
    if (key in existing && deepEqual(existing[key], merged[key])) continue;
    jsonOps.push({ op: "set", key, before: key in existing ? { present: true, value: existing[key] } : { present: false }, after: merged[key] });
  }
  actions.push({
    op: "install",
    path: path2,
    existed: existsSync20(path2),
    mode: 420,
    merge: "user-json",
    jsonOps,
    content: Buffer.from(`${JSON.stringify(merged, null, 2)}
`)
  });
}
function agentsMd(input, live) {
  const base = fromSource(join25(input.repoDir, "agent", "AGENTS.md"), input.settings);
  const off = ["cratis", "codescene"].filter((id) => input.components?.[id] === false);
  if (off.length) {
    const stripped = stripSections(base.content, off);
    base.content = stripped.content;
    delete base.mtimeMs;
    input.notes?.push(...stripped.warnings);
  }
  const existing = existsSync20(live) && statSync12(live).isFile() ? readFileSync15(live) : void 0;
  const noMarkers = existing !== void 0 && !hasRoutingMarkers(existing);
  if (!input.overlay.routing) return { ...base, noMarkers };
  return { content: spliceRouting(base.content, input.overlay.routing, noMarkers ? void 0 : existing), mode: base.mode, noMarkers };
}
function registerJson(actions, path2, edit) {
  const pending2 = actions.find((a2) => a2.op === "install" && a2.path === path2);
  const content = pending2 && pending2.op === "install" ? pending2.content : existsSync20(path2) ? readFileSync15(path2) : void 0;
  if (!content) return;
  let data;
  try {
    data = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new SetupError(`${path2}: ${error.message}`);
  }
  const before = structuredClone(data);
  const jsonOps = edit(data, Boolean(pending2));
  if (jsonOps.length === 0 && deepEqual(before, data)) return;
  const mode = pending2 && pending2.op === "install" ? pending2.mode : statSync12(path2).mode & 4095;
  const next = Buffer.from(`${JSON.stringify(data, null, 2)}
`);
  if (pending2 && pending2.op === "install") {
    pending2.content = next;
    if (jsonOps.length) actions.push({ op: "register", path: path2, content: next, mode, existed: false, jsonOps });
  } else {
    actions.push({ op: "register", path: path2, content: next, mode, existed: true, jsonOps });
  }
}
function addPackage(data, value, fresh, ops, allow) {
  const list = Array.isArray(data.packages) ? data.packages : void 0;
  const has = list?.includes(value) ?? false;
  if (has && !fresh || !has && !allow) return;
  if (!has) data.packages = [...list ?? [], value];
  ops.push({ op: "array-add", key: "packages", value, keyCreated: !list });
}
function settingsEdit(web, activate, drop) {
  return (data, fresh) => {
    const ops = [];
    if (fresh && web !== true && Array.isArray(data.packages)) {
      if (web === false) data.packages = data.packages.filter((p) => !WEB_PACKAGES.includes(p));
    }
    if (web === false && drop.length && Array.isArray(data.packages)) data.packages = data.packages.filter((p) => !drop.includes(p));
    addPackage(data, PACKAGE, false, ops, true);
    if (web === true) for (const p of WEB_PACKAGES) addPackage(data, p, fresh, ops, fresh || activate);
    return ops;
  };
}
function mcpEdit(codescene, activate, which) {
  return (data, fresh) => {
    const servers = typeof data.mcpServers === "object" && data.mcpServers !== null && !Array.isArray(data.mcpServers) ? data.mcpServers : void 0;
    const has = Boolean(servers && "codescene" in servers);
    if (codescene !== true) {
      if (fresh && codescene === false && servers) delete servers.codescene;
      return [];
    }
    if (has && !fresh || !has && !fresh && !activate) return [];
    const stripped = { ...servers };
    delete stripped.codescene;
    const entry = { command: which("cs-mcp") ?? "cs-mcp", args: [], lifecycle: "lazy-keep-alive" };
    data.mcpServers = { ...stripped, codescene: entry };
    return [{ op: "set", key: "mcpServers", before: servers ? { present: true, value: stripped } : { present: false }, after: data.mcpServers }];
  };
}
function linkIfFree(actions, notes, path2, target, home) {
  if (!lstatExists(path2)) {
    actions.push({ op: "symlink", path: path2, target });
    return;
  }
  const link = lstatSync3(path2).isSymbolicLink() ? readlinkSync(path2) : void 0;
  if (link === target) return;
  const shown = (p) => p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
  notes?.push(`left ${shown(path2)}: ${link === void 0 ? "a file" : `a link to ${shown(link)}`}; pi-setup does not replace it`);
}
function buildPlan(input) {
  const { repoDir: repoDir2, home, settings: settings2, overlay } = input;
  const cratis = input.components?.cratis !== false;
  const filter = cratis ? NO_FILTER : {
    skip: isCratisFile,
    transform: (rel, content) => /(^|\/)agents\/[^/]+\.md$/.test(rel) ? dropGuardExtension(content) : content
  };
  const agent = join25(repoDir2, "agent");
  const piDir = join25(home, ".pi", "agent");
  const actions = [];
  userJsonAction(actions, piDir, settings2);
  for (const tree of TREES) {
    const useOverlay = tree === "agents" || tree === "workflows";
    putTree(actions, join25(agent, tree), join25(piDir, tree), settings2, useOverlay ? overlay.sources : void 0, useOverlay ? `${tree}/` : "", filter, `${tree}/`);
  }
  putTree(actions, join25(agent, "local-packages/pi-questions"), join25(piDir, "local-packages/pi-questions"), settings2);
  actions.push({ op: "chmod-x", path: join25(piDir, "local-packages/pi-questions/dist/cli.js") });
  const agentsPath = join25(piDir, "AGENTS.md");
  const { noMarkers, ...agentsDesired } = agentsMd(input, agentsPath);
  put(actions, agentsPath, agentsDesired);
  const last = actions[actions.length - 1];
  if (noMarkers && last.op === "install") last.noMarkers = true;
  putSource(actions, join25(agent, "AGENTS.subagent.md"), join25(piDir, "AGENTS.subagent.md"), settings2);
  for (const name of ONLY_IF_ABSENT) {
    if (!existsSync20(join25(piDir, name))) putSource(actions, join25(agent, name), join25(piDir, name), settings2);
  }
  registerJson(actions, join25(piDir, "settings.json"), settingsEdit(input.components?.web, Boolean(input.activate?.includes("web")), input.drop ?? []));
  registerJson(actions, join25(piDir, "mcp-adapter.json"), mcpEdit(input.components?.codescene, Boolean(input.activate?.includes("codescene")), input.which ?? (() => void 0)));
  const absent = [
    ["docker-guardian/pinned.example.txt", "docker-guardian/pinned.txt"],
    ["dev-doctor.example.json", "dev-doctor.json"],
    ["npm-package.json", "npm/package.json"]
  ];
  for (const [from, to] of absent) {
    if (!existsSync20(join25(piDir, to))) putSource(actions, join25(agent, from), join25(piDir, to), settings2);
  }
  for (const skill of listSkills(repoDir2)) {
    putTree(actions, join25(repoDir2, "skills", skill), join25(home, ".agents", "skills", skill), settings2);
  }
  const link = join25(piDir, "skills", "ai-work-lifecycle");
  if (!lstatExists(link)) actions.push({ op: "symlink", path: link, target: join25(home, ".agents", "skills", "ai-work-lifecycle") });
  putTree(actions, join25(repoDir2, "tools/ai-work-lifecycle"), join25(home, ".local/share/ai-work-lifecycle"), settings2);
  const bin = join25(repoDir2, "tools/bin/ai-work-lifecycle");
  putSource(actions, bin, join25(home, ".local/bin/ai-work-lifecycle"), settings2);
  if (input.components?.lanes === true) {
    const lanesDir = join25(home, ".local/share/pi-setup/lanes");
    const preapproveMcp = preapprovalDefault(join25(lanesDir, "templates")) || input.preapproveMcp === true;
    put(actions, join25(lanesDir, "defaults.json"), { content: Buffer.from(`${JSON.stringify({ launch: { preapproveMcp } }, null, 2)}
`), mode: 420 });
    putSource(actions, join25(repoDir2, "installer/dist/lanes.mjs"), join25(lanesDir, "lanes.mjs"), settings2);
    putTree(actions, join25(repoDir2, "installer/lanes/templates"), join25(lanesDir, "templates"), settings2);
    linkIfFree(actions, input.notes, join25(home, ".local/bin/lanes"), join25(lanesDir, "lanes.mjs"), home);
  }
  for (const [pkg, cmd] of [["pi-context-budget", "pi-session"], ["pi-orch", "orch"]]) {
    const target = join25(piDir, "npm/node_modules/@woksin", pkg, "bin", cmd);
    if (existsSync20(target)) linkIfFree(actions, input.notes, join25(home, ".local/bin", cmd), target, home);
  }
  return actions;
}
function listSkills(repoDir2) {
  const dir = join25(repoDir2, "skills");
  if (!existsSync20(dir)) return [];
  return readdirSync9(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
function lstatExists(path2) {
  try {
    lstatSync3(path2);
    return true;
  } catch {
    return false;
  }
}
var TREES, ONLY_IF_ABSENT, PACKAGE, NO_FILTER;
var init_plan = __esm({
  "src/plan.ts"() {
    init_settings();
    init_fsx();
    init_profiles();
    init_components();
    init_config();
    init_types();
    TREES = ["agents", "extensions", "early-extensions", "lib", "workflows", "templates", "profiles", "loose-threads", "bin", "pi-phase", "lane-policy"];
    ONLY_IF_ABSENT = ["settings.json", "models.json", "subagents.json", "provider-fallback.json", "mcp-adapter.json", "efficiency.json", "context-budget.json"];
    PACKAGE = "./local-packages/pi-questions";
    NO_FILTER = { skip: () => false, transform: (_rel, content) => content };
  }
});

// src/reconcile.ts
import { existsSync as existsSync21, mkdtempSync, readFileSync as readFileSync16, rmSync as rmSync2, writeFileSync as writeFileSync7 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join26 } from "node:path";
function newVersionNeedsWrite(newPath, content) {
  return !(existsSync21(newPath) && readFileSync16(newPath).equals(content));
}
function reconcile(actions, manifest, home) {
  const conflicts = [];
  const out = actions.map((action) => {
    if (action.op !== "install" || action.merge) return action;
    if (!action.existed || !existsSync21(action.path)) return { ...action, decision: "new" };
    const entry = manifest?.files[homeRel(home, action.path)];
    if (!action.noMarkers) {
      if (!entry) return { ...action, decision: "replace" };
      if (fileSha(action.path) === entry.sha256) return { ...action, decision: "update" };
    }
    const newPath = `${action.path}.pi-setup-new`;
    const keep = {
      op: "keep",
      path: action.path,
      newPath,
      content: action.content,
      mode: action.mode,
      mtimeMs: action.mtimeMs,
      write: newVersionNeedsWrite(newPath, action.content),
      ...action.noMarkers ? { noMarkers: true } : {}
    };
    conflicts.push(keep);
    return keep;
  });
  return { actions: out, conflicts };
}
function applyTakes(actions, takes) {
  return actions.map((a2) => a2.op === "keep" && takes.has(a2.path) ? { op: "install", path: a2.path, content: a2.content, mode: a2.mode, mtimeMs: a2.mtimeMs, existed: true, decision: "take" } : a2);
}
async function diffText(ctx, conflict) {
  const dir = mkdtempSync(join26(tmpdir(), "pisetup-diff."));
  try {
    const tmp = join26(dir, "new");
    writeFileSync7(tmp, conflict.content);
    const result2 = await ctx.run("diff", ["-u", conflict.path, tmp], { timeoutMs: 1e4 });
    if (result2.code === null || result2.code > 1) return `(diff is not available; the new version is in ${conflict.newPath})`;
    const lines2 = result2.stdout.split("\n");
    if (lines2.length <= 1) return "(no differences)";
    return lines2.slice(0, DIFF_LINES).join("\n") + (lines2.length > DIFF_LINES ? `
\u2026 ${lines2.length - DIFF_LINES} more lines` : "");
  } finally {
    rmSync2(dir, { recursive: true, force: true });
  }
}
var DIFF_LINES;
var init_reconcile = __esm({
  "src/reconcile.ts"() {
    init_manifest();
    DIFF_LINES = 200;
  }
});

// src/services.ts
import { existsSync as existsSync22, mkdirSync as mkdirSync8, readFileSync as readFileSync17, statSync as statSync13 } from "node:fs";
import { join as join27 } from "node:path";
function serviceUser(env) {
  return (env.USER ?? "").replace(/[^A-Za-z0-9-]/g, "") || "pi-setup";
}
function systemdUnits(home) {
  const dir = join27(home, ".config/systemd/user");
  return [
    {
      path: join27(dir, "pi-cleanup.service"),
      content: Buffer.from(
        "[Unit]\nDescription=pi-setup scheduled cleanup\n\n[Service]\nType=oneshot\nEnvironment=PYTHONDONTWRITEBYTECODE=1\nExecStart=%h/.pi/agent/bin/pi-cleanup --scheduled\n"
      )
    },
    {
      path: join27(dir, TIMER),
      content: Buffer.from("[Unit]\nDescription=pi-setup scheduled cleanup (daily)\n\n[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n")
    }
  ];
}
function launchdUnit(ctx, id) {
  const name = LAUNCHD_NAME[id];
  const src = join27(ctx.repoDir, "agent", "launchd", `com.example.${name}.plist`);
  if (!name || !existsSync22(src)) return void 0;
  const user = serviceUser(ctx.env);
  const text3 = readFileSync17(src, "utf8").split("__HOME__").join(xml(ctx.home)).split("com.example.").join(`com.${user}.`);
  return { unit: { path: join27(ctx.home, "Library/LaunchAgents", `com.${user}.${name}.plist`), content: Buffer.from(text3) }, label: `com.${user}.${name}` };
}
function expectedUnit(ctx, id) {
  if (ctx.platform === "darwin") {
    const name = LAUNCHD_NAME[id];
    const label = `com.${serviceUser(ctx.env)}.${name}`;
    return name ? { kind: "launchd", label, file: join27(ctx.home, "Library/LaunchAgents", `${label}.plist`) } : void 0;
  }
  return id === "cleanup" ? { kind: "systemd", label: TIMER, file: join27(ctx.home, ".config/systemd/user", TIMER) } : void 0;
}
function planServices(ctx, manifest, on) {
  const out = { actions: [], records: {}, notes: [] };
  for (const def of COMPONENTS.filter((c2) => c2.service)) {
    if (!on[def.id] || available(def.id, ctx) !== true) {
      out.records[def.id] = { on: false };
      continue;
    }
    let kind = "launchd";
    let label = "";
    let units = [];
    if (ctx.platform === "darwin") {
      const l2 = launchdUnit(ctx, def.id);
      if (l2) {
        units = [l2.unit];
        label = l2.label;
      }
    } else {
      kind = "systemd";
      label = TIMER;
      units = systemdUnits(ctx.home);
    }
    if (!units.length) {
      out.records[def.id] = { on: false };
      continue;
    }
    let managed = true;
    const actions = [];
    for (const u3 of units) {
      const rel = homeRel(ctx.home, u3.path);
      const there = existsSync22(u3.path) && statSync13(u3.path).isFile();
      if (!there) actions.push({ op: "install", path: u3.path, content: u3.content, mode: 420, existed: false, decision: "new" });
      else if (readFileSync17(u3.path).equals(u3.content)) actions.push({ op: "adopt", path: u3.path });
      else if (manifest?.files[rel] && fileSha(u3.path) === manifest.files[rel].sha256) {
        actions.push({ op: "install", path: u3.path, content: u3.content, mode: 420, existed: true, decision: "update" });
      } else {
        managed = false;
        out.notes.push(`left your ${u3.path.replace(`${ctx.home}/`, "~/")}; pi-setup does not load or remove it`);
      }
    }
    if (managed) out.actions.push(...actions);
    out.records[def.id] = { on: true, service: { kind, label, files: units.map((u3) => homeRel(ctx.home, u3.path)), managed } };
  }
  return out;
}
async function sh(ctx, cmd, args) {
  try {
    const r2 = await ctx.run(cmd, args, { timeoutMs: TIMEOUT });
    return { ok: r2.code === 0 && !r2.timedOut, text: `${r2.stdout}${r2.stderr}`.trim() };
  } catch (error) {
    return { ok: false, text: error.message };
  }
}
async function syncServices(ctx, components, changed, dryRun) {
  for (const [id, c2] of Object.entries(components)) {
    const svc = c2.service;
    if (!c2.on || !svc?.managed) continue;
    const plist = join27(ctx.home, svc.files[0]);
    const domain = `gui/${uid()}`;
    if (svc.kind === "launchd") {
      if (dryRun) {
        ctx.out(`would load ${svc.label} (launchctl bootstrap ${domain} ${plist})`);
        continue;
      }
      mkdirSync8(join27(ctx.home, ".pi/agent/logs"), { recursive: true });
      const loaded = (await sh(ctx, "launchctl", ["print", `${domain}/${svc.label}`])).ok;
      if (loaded && !svc.files.some((f) => changed.has(join27(ctx.home, f)))) continue;
      if (loaded) await sh(ctx, "launchctl", ["bootout", `${domain}/${svc.label}`]);
      const r2 = await sh(ctx, "launchctl", ["bootstrap", domain, plist]);
      if (!r2.ok) ctx.err(`warning: could not load ${id}: launchctl bootstrap ${domain} ${plist}`);
      else ctx.out(`loaded ${svc.label}`);
    } else {
      if (dryRun) {
        ctx.out(`would enable ${svc.label} (systemctl --user enable --now ${svc.label})`);
        continue;
      }
      if (!ctx.which("systemctl")) {
        ctx.out(`note: systemctl not found; start ${id} later with: systemctl --user enable --now ${svc.label}`);
        continue;
      }
      await sh(ctx, "systemctl", ["--user", "daemon-reload"]);
      const r2 = await sh(ctx, "systemctl", ["--user", "enable", "--now", svc.label]);
      if (!r2.ok) ctx.err(`warning: could not enable ${id}: systemctl --user enable --now ${svc.label}`);
      else ctx.out(`enabled ${svc.label}`);
    }
  }
}
function unloadLine(svc) {
  return svc.kind === "launchd" ? `boot out ${svc.label} (launchctl bootout gui/${uid()}/${svc.label})` : `disable ${svc.label} (systemctl --user disable --now ${svc.label})`;
}
async function unloadService(ctx, svc) {
  if (!svc.managed) return;
  const [cmd, args] = svc.kind === "launchd" ? ["launchctl", ["bootout", `gui/${uid()}/${svc.label}`]] : ["systemctl", ["--user", "disable", "--now", svc.label]];
  if (svc.kind === "systemd" && !ctx.which("systemctl")) return;
  let text3;
  try {
    const r2 = await ctx.run(cmd, args, { timeoutMs: TIMEOUT });
    if (r2.code === 0 && !r2.timedOut) return;
    text3 = r2.timedOut ? "timed out" : `${r2.stdout}${r2.stderr}`.trim();
    if (!r2.timedOut && (NOT_LOADED.test(text3) || svc.kind === "launchd" && [3, 113].includes(r2.code))) return;
  } catch (error) {
    text3 = error.message;
  }
  ctx.err(`warning: could not stop ${svc.label} (${text3.split("\n")[0] || "failed"}); remove it by hand: ${cmd} ${args.join(" ")}`);
}
async function reloadSystemd(ctx, svc) {
  if (svc.managed && svc.kind === "systemd" && ctx.which("systemctl")) await sh(ctx, "systemctl", ["--user", "daemon-reload"]);
}
var LAUNCHD_NAME, TIMER, TIMEOUT, xml, isService, uid, NOT_LOADED;
var init_services = __esm({
  "src/services.ts"() {
    init_components();
    init_manifest();
    LAUNCHD_NAME = { "docker-guardian": "docker-guardian", cleanup: "pi-cleanup", "secret-sweep": "secret-sweep" };
    TIMER = "pi-cleanup.timer";
    TIMEOUT = 5e3;
    xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    isService = (id) => COMPONENTS.some((c2) => c2.id === id && c2.service);
    uid = () => typeof process.getuid === "function" ? process.getuid() : 0;
    NOT_LOADED = /no such process|could not find service|not loaded|not found|does not exist|no such file|unit .* not loaded/i;
  }
});

// src/uninstall.ts
import {
  copyFileSync as copyFileSync2,
  existsSync as existsSync23,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync9,
  readFileSync as readFileSync18,
  readlinkSync as readlinkSync2,
  renameSync as renameSync4,
  rmdirSync as rmdirSync2,
  statSync as statSync14,
  unlinkSync as unlinkSync2
} from "node:fs";
import { dirname as dirname9, join as join28 } from "node:path";
function restore(from, to) {
  mkdirSync9(dirname9(to), { recursive: true });
  try {
    renameSync4(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    copyFileSync2(from, to);
    unlinkSync2(from);
  }
}
function undo(data, op) {
  if (op.op === "set") {
    if (!(op.key in data) || !deepEqual(data[op.key], op.after)) return false;
    if (op.before.present) data[op.key] = op.before.value;
    else delete data[op.key];
    return true;
  }
  const list = data[op.key];
  if (!Array.isArray(list)) return true;
  const at = list.findIndex((v) => deepEqual(v, op.value));
  if (at >= 0) list.splice(at, 1);
  if (op.keyCreated && list.length === 0) delete data[op.key];
  return true;
}
function lstatExists2(path2) {
  try {
    lstatSync4(path2);
    return true;
  } catch {
    return false;
  }
}
function rmdirIfEmpty(path2) {
  try {
    if (lstatSync4(path2).isDirectory()) rmdirSync2(path2);
  } catch {
  }
}
function retireFiles(ctx, piDir, m2, rels) {
  const sub = {
    ...structuredClone(m2),
    files: {},
    json: {},
    symlinks: {},
    dirs: [],
    pendingNew: void 0,
    components: void 0
  };
  for (const rel of rels) if (m2.files[rel]) sub.files[rel] = structuredClone(m2.files[rel]);
  const plan = new Plan(ctx, piDir, sub);
  const steps = plan.build();
  for (const rel of rels) {
    if (!(rel in sub.files)) continue;
    if (rel in plan.remaining.files) m2.files[rel] = plan.remaining.files[rel];
    else delete m2.files[rel];
  }
  return steps;
}
function retireSymlinks(ctx, m2, rels) {
  const steps = [];
  for (const rel of rels) {
    const entry = m2.symlinks[rel];
    if (!entry) continue;
    const path2 = fromHomeRel(ctx.home, rel);
    const target = symlinkTarget(ctx.home, entry.target);
    if (sameLink(path2, target) || sameLink(path2, entry.target)) steps.push({ line: `remove ${path2}`, run: () => unlinkSync2(path2) });
    else steps.push({ line: `left ${path2}: no longer points at ${target}`, run: () => {
    } });
    delete m2.symlinks[rel];
  }
  return steps;
}
function revertOps(ctx, m2, rel, match, dryRun) {
  const entry = m2.json[rel];
  const mine = entry?.ops.filter(match) ?? [];
  if (!entry || mine.length === 0) return [];
  const path2 = fromHomeRel(ctx.home, rel);
  const lines2 = [];
  let data;
  try {
    data = JSON.parse(readFileSync18(path2, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
  } catch {
    if (!existsSync23(path2)) {
      entry.ops = entry.ops.filter((o) => !match(o));
      if (!entry.ops.length) delete m2.json[rel];
      return [];
    }
    return [`left (cannot read as JSON): ${path2}`];
  }
  const left = [];
  for (const op of [...mine].reverse()) if (!undo(data, op)) left.push(op);
  for (const op of left) lines2.push(`left (changed by you): ${op.key} in ${path2}`);
  const done = mine.length - left.length;
  if (done > 0) lines2.push(`${dryRun ? "would revert" : "revert"} ${done} change(s) made by pi-setup in ${path2}`);
  if (dryRun) return lines2;
  if (done > 0) {
    const tracked = m2.files[rel];
    const wasTracked = Boolean(tracked) && fileSha(path2) === tracked.sha256;
    atomicWrite(path2, `${JSON.stringify(data, null, 2)}
`, statSync14(path2).mode & 4095);
    const sha = sha256(readFileSync18(path2));
    entry.sha256After = sha;
    if (wasTracked) tracked.sha256 = sha;
  }
  entry.ops = entry.ops.filter((o) => !match(o) || left.includes(o));
  if (!entry.ops.length) delete m2.json[rel];
  return lines2;
}
async function runUninstall(ctx, options, prompter) {
  const piDir = join28(ctx.home, ".pi", "agent");
  const manifest = readManifest(piDir);
  if (!manifest) {
    ctx.out(`No pi-setup manifest at ${manifestPath(piDir)}; nothing is tracked (installs older than this version are adopted by running ./install.sh once).`);
    return 0;
  }
  validateManifest(ctx.home, manifest);
  const plan = new Plan(ctx, piDir, manifest);
  const steps = plan.build();
  for (const step of steps) ctx.out(step.line);
  if (steps.length === 0) ctx.out("Nothing to remove.");
  if (options.dryRun) {
    ctx.out("Nothing was removed (--dry-run).");
    return 0;
  }
  if (prompter) {
    const answer = await prompter.confirm({ message: "Uninstall?", initial: false });
    if (prompter.isCancel(answer) || answer !== true) {
      ctx.err("Cancelled; nothing removed.");
      return 1;
    }
  } else if (!options.yes) {
    throw new SetupError("uninstall changes files; pass --yes to run it without a prompt (or --dry-run to preview)");
  }
  for (const step of steps) await step.run();
  delete plan.remaining.components;
  finalize(ctx, piDir, manifest, plan.remaining);
  return 0;
}
function finalize(ctx, piDir, old, left) {
  const empty = Object.keys(left.files).length + Object.keys(left.json).length + Object.keys(left.symlinks).length === 0;
  if (empty) {
    if (existsSync23(manifestPath(piDir))) unlinkSync2(manifestPath(piDir));
  } else {
    left.dirs = left.dirs.filter((d) => lstatExists2(fromHomeRel(ctx.home, d)));
    saveIfChanged(piDir, old, left, ctx.now());
  }
  const cache = join28(piDir, ".pi-setup/update-check.json");
  if (existsSync23(cache)) unlinkSync2(cache);
  tidy(piDir);
  const rest = listBackups(piDir, pinnedBackups(empty ? void 0 : left));
  for (const rel of [...left.dirs].sort((a2, b) => b.split("/").length - a2.split("/").length || (a2 < b ? 1 : -1))) {
    rmdirIfEmpty(fromHomeRel(ctx.home, rel));
  }
  if (empty && rest.length > 0) ctx.out(`Left in place (may hold your versions): ${backupsDir(piDir)}; remove with: ./install.sh backups prune --keep 0`);
  else if (!empty) ctx.out(`Some files were left; their record stays in ${manifestPath(piDir)}.`);
  ctx.out("Uninstalled.");
}
var sameLink, Plan;
var init_uninstall = __esm({
  "src/uninstall.ts"() {
    init_fsx();
    init_backups();
    init_manifest();
    init_settings();
    init_services();
    init_types();
    sameLink = (path2, target) => {
      try {
        return lstatSync4(path2).isSymbolicLink() && readlinkSync2(path2) === target;
      } catch {
        return false;
      }
    };
    Plan = class {
      steps = [];
      /** What is left in the manifest once the steps ran. */
      remaining;
      backups;
      ctx;
      m;
      constructor(ctx, piDir, m2) {
        this.ctx = ctx;
        this.m = m2;
        this.remaining = structuredClone(m2);
        this.backups = backupsDir(piDir);
      }
      abs(rel) {
        return fromHomeRel(this.ctx.home, rel);
      }
      backupFile(rel) {
        if (!rel) return void 0;
        const path2 = join28(this.backups, rel);
        return existsSync23(path2) ? path2 : void 0;
      }
      add(line, run) {
        this.steps.push({ line, run });
      }
      build() {
        for (const c2 of Object.values(this.m.components ?? {})) {
          const svc = c2.service;
          if (svc?.managed) this.add(unloadLine(svc), () => unloadService(this.ctx, svc));
        }
        const deleted = /* @__PURE__ */ new Set();
        for (const [rel, entry] of Object.entries(this.m.files)) if (this.file(rel, entry)) deleted.add(rel);
        for (const [rel, sha] of Object.entries(this.m.pendingNew ?? {})) {
          const path2 = this.abs(rel);
          if (fileSha(path2) === sha) this.add(`remove ${path2}`, () => unlinkSync2(path2));
          delete this.remaining.pendingNew;
        }
        for (const [rel, link] of Object.entries(this.m.symlinks)) this.symlink(rel, link.target);
        for (const [rel, entry] of Object.entries(this.m.json)) {
          if (deleted.has(rel)) delete this.remaining.json[rel];
          else this.json(rel, entry);
        }
        for (const c2 of Object.values(this.m.components ?? {})) {
          const svc = c2.service;
          if (svc?.managed && svc.kind === "systemd") this.add("reload systemd (systemctl --user daemon-reload)", () => reloadSystemd(this.ctx, svc));
        }
        return this.steps;
      }
      /** Returns whether the file ends up removed or restored. */
      file(rel, entry) {
        const path2 = this.abs(rel);
        this.pending(rel, entry);
        if (!lstatExists2(path2)) {
          delete this.remaining.files[rel];
          return false;
        }
        const backup = this.backupFile(entry.backup);
        if (fileSha(path2) !== entry.sha256) {
          const note2 = backup ? `; your pre-install version: ${backup}` : "";
          this.add(`left (changed by you): ${path2}${note2}`, () => {
          });
          if (!entry.backup) delete this.remaining.files[rel];
          return false;
        }
        if (entry.origin === "replaced" && backup) {
          this.add(`restore ${path2} (from ${backup})`, () => {
            unlinkSync2(path2);
            restore(backup, path2);
          });
        } else if (entry.origin === "replaced") {
          this.add(`left (pre-install backup is missing): ${path2}`, () => {
          });
          delete this.remaining.files[rel];
          return false;
        } else {
          this.add(`remove ${path2}`, () => unlinkSync2(path2));
        }
        delete this.remaining.files[rel];
        return true;
      }
      pending(rel, entry) {
        if (!entry.pending) return;
        const path2 = this.abs(entry.pending.path);
        const expected = entry.pending.sha256;
        if (fileSha(path2) === expected) this.add(`remove ${path2}`, () => unlinkSync2(path2));
        if (this.remaining.files[rel]) delete this.remaining.files[rel].pending;
      }
      symlink(rel, target) {
        const path2 = this.abs(rel);
        const targetPath = symlinkTarget(this.ctx.home, target);
        if (sameLink(path2, targetPath) || sameLink(path2, target)) this.add(`remove ${path2}`, () => unlinkSync2(path2));
        delete this.remaining.symlinks[rel];
      }
      json(rel, entry) {
        const path2 = this.abs(rel);
        if (!lstatExists2(path2)) {
          delete this.remaining.json[rel];
          return;
        }
        const backup = this.backupFile(entry.backup);
        if (!entry.edited && fileSha(path2) === entry.sha256After && (entry.created || backup)) {
          if (entry.created) this.add(`remove ${path2}`, () => unlinkSync2(path2));
          else this.add(`restore ${path2} (from ${backup})`, () => {
            unlinkSync2(path2);
            restore(backup, path2);
          });
          delete this.remaining.json[rel];
          return;
        }
        this.add(`revert ${path2} (${entry.ops.length} change(s) made by pi-setup)`, () => this.revert(rel, path2, entry));
      }
      revert(rel, path2, entry) {
        const left = [];
        let data;
        try {
          data = JSON.parse(readFileSync18(path2, "utf8"));
          if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
        } catch {
          this.ctx.err(`left (cannot read as JSON): ${path2}`);
          return;
        }
        for (const op of [...entry.ops].reverse()) {
          if (!undo(data, op)) left.push(op);
        }
        if (entry.created && Object.keys(data).length === 0 && left.length === 0) {
          unlinkSync2(path2);
          delete this.remaining.json[rel];
          return;
        }
        const mode = statSync14(path2).mode & 4095;
        atomicWrite(path2, `${JSON.stringify(data, null, 2)}
`, mode);
        if (left.length === 0) {
          delete this.remaining.json[rel];
        } else {
          this.remaining.json[rel] = { ...entry, ops: left.reverse(), sha256After: sha256(readFileSync18(path2)) };
          for (const op of left) this.ctx.err(`left (changed by you): ${op.key} in ${path2}`);
        }
      }
    };
  }
});

// src/retire.ts
import { existsSync as existsSync24, readFileSync as readFileSync19 } from "node:fs";
import { join as join29 } from "node:path";
function wasOn(manifest, current, id) {
  const saved = manifest?.components?.[id];
  return saved ? saved.on : current[id] === true;
}
function leftWebPackages(ctx, manifest) {
  const path2 = join29(ctx.home, PI, "settings.json");
  if (!existsSync24(path2)) return [];
  let packages2;
  try {
    packages2 = JSON.parse(readFileSync19(path2, "utf8")).packages;
  } catch {
    return [];
  }
  const added = new Set((manifest.json[`${PI}settings.json`]?.ops ?? []).filter(WEB_PACKAGE_OP).map((o) => o.value));
  return Array.isArray(packages2) ? WEB_PACKAGES.filter((p) => packages2.includes(p) && !added.has(p)) : [];
}
async function retire(ctx, piDir, manifest, off, dryRun) {
  if (!manifest || off.length === 0) return manifest;
  const m2 = structuredClone(manifest);
  const steps = [];
  const lines2 = [];
  const files2 = (rels) => {
    for (const step of retireFiles(ctx, piDir, m2, rels)) steps.push(step);
  };
  for (const id of off) {
    const svc = m2.components?.[id]?.service;
    if (svc) {
      if (svc.managed) steps.push({ line: unloadLine(svc), run: () => unloadService(ctx, svc) });
      files2(svc.files);
      if (svc.managed && svc.kind === "systemd") steps.push({ line: "reload systemd (systemctl --user daemon-reload)", run: () => reloadSystemd(ctx, svc) });
    }
    if (id === "lanes") {
      files2(Object.keys(m2.files).filter((rel) => rel.startsWith(".local/share/pi-setup/lanes/")));
      steps.push(...retireSymlinks(ctx, m2, [".local/bin/lanes"]));
    }
    if (id === "cratis") files2(Object.keys(m2.files).filter((rel) => rel.startsWith(PI) && isCratisFile(rel.slice(PI.length))));
    if (id === "web") {
      lines2.push(...revertOps(ctx, m2, `${PI}settings.json`, WEB_PACKAGE_OP, dryRun));
      for (const p of leftWebPackages(ctx, m2)) lines2.push(`left ${p} in settings.json (not added by pi-setup)`);
    }
    if (id === "codescene") {
      lines2.push(...revertOps(ctx, m2, `${PI}mcp-adapter.json`, (op) => op.op === "set" && op.key === "mcpServers", dryRun));
    }
    if (m2.components?.[id]) m2.components[id] = { on: false };
  }
  for (const step of steps) {
    ctx.out(dryRun ? `would ${step.line}` : step.line);
    if (!dryRun) await step.run();
  }
  for (const line of lines2) (line.startsWith("left") ? ctx.err : ctx.out)(line);
  if (dryRun) return manifest;
  saveIfChanged(piDir, manifest, m2, ctx.now());
  return m2;
}
var PI, WEB_PACKAGE_OP;
var init_retire = __esm({
  "src/retire.ts"() {
    init_components();
    init_manifest();
    init_uninstall();
    init_services();
    PI = ".pi/agent/";
    WEB_PACKAGE_OP = (op) => op.op === "array-add" && op.key === "packages" && WEB_PACKAGES.includes(op.value);
  }
});

// src/doctor-checks.ts
import { existsSync as existsSync25, lstatSync as lstatSync5, readdirSync as readdirSync10, readFileSync as readFileSync20, readlinkSync as readlinkSync3 } from "node:fs";
import { basename as basename2, delimiter as delimiter2, dirname as dirname10, join as join30, resolve as resolve7 } from "node:path";
function setupCmd(ctx) {
  if (ctx.which("pi-setup")) return "pi-setup";
  const path2 = join30(ctx.repoDir, "install.sh");
  return path2.startsWith(`${ctx.home}/`) ? `~/${path2.slice(ctx.home.length + 1)}` : path2;
}
function readJson2(path2) {
  try {
    const value = JSON.parse(readFileSync20(path2, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function livePins(piDir, settings2) {
  const pins = /* @__PURE__ */ new Map();
  const dir = join30(piDir, "agents");
  if (existsSync25(dir)) for (const file of readdirSync10(dir).filter((f) => f.endsWith(".md"))) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text(join30(dir, file)))?.[1] ?? "";
    const model = /^model:\s*(\S+)/m.exec(front)?.[1];
    if (!model) continue;
    const extensions = /^extensions:\s*([^\n]*(?:\n[ \t]+[^\n]*)*)/m.exec(front)?.[1] ?? "";
    const agents = pins.get(model) ?? [];
    agents.push({ name: basename2(file, ".md"), fallback: /\bprovider-fallback\b/.test(extensions) });
    pins.set(model, agents);
  }
  if (typeof settings2.defaultProvider === "string" && typeof settings2.defaultModel === "string") {
    const model = `${settings2.defaultProvider}/${settings2.defaultModel}`;
    pins.set(model, [...pins.get(model) ?? [], { name: "settings.json", fallback: true }]);
  }
  return [...pins].map(([model, agents]) => ({ model, agents }));
}
function state(ctx, facts) {
  const piDir = join30(ctx.home, ".pi", "agent");
  const s = { ctx, facts, piDir, setup: setupCmd(ctx), profile: text(join30(piDir, "profiles/ACTIVE")), settings: readJson2(join30(piDir, "settings.json")) ?? {}, pins: [], missing: [], changed: [], modes: [] };
  try {
    s.manifest = readManifest(piDir);
    if (s.manifest) validateManifest(ctx.home, s.manifest);
  } catch (error) {
    s.manifest = void 0;
    s.manifestError = error.message;
  }
  s.pins = livePins(piDir, s.settings);
  for (const [rel, entry] of Object.entries(s.manifest?.files ?? {})) {
    const path2 = fromHomeRel(ctx.home, rel);
    if (!present(path2)) s.missing.push(rel);
    else if (fileSha(path2) !== entry.sha256) s.changed.push(rel);
    else if ((lstatSync5(path2).mode & 4095) !== entry.mode) s.modes.push(rel);
  }
  for (const [rel, link] of Object.entries(s.manifest?.symlinks ?? {})) {
    const path2 = fromHomeRel(ctx.home, rel);
    try {
      if (!lstatSync5(path2).isSymbolicLink() || resolve7(dirname10(path2), readlinkSync3(path2)) !== symlinkTarget(ctx.home, link.target)) s.missing.push(rel);
    } catch {
      s.missing.push(rel);
    }
  }
  return s;
}
function files(s) {
  if (!existsSync25(s.piDir)) return check("files", "fail", "not installed", s.setup);
  if (s.manifestError) return check("files", "fail", s.manifestError, s.setup);
  if (!s.manifest) return check("files", "warn", "no install manifest", s.setup);
  const moved = s.manifest.source.commit && s.facts.head && s.manifest.source.commit !== s.facts.head;
  let detail = `${s.missing.length} missing, ${s.changed.length} changed by you`;
  if (moved) detail += `; checkout is at ${s.facts.head.slice(0, 7)}, installed ${s.manifest.source.commit.slice(0, 7)}; the checkout moved since the install; this would also update`;
  const restorable = s.missing.length > 0 && s.facts.checkoutClean === true && Boolean(s.facts.head) && s.facts.head === s.manifest.source.commit;
  return { ...check("files", s.missing.length ? "fail" : moved ? "warn" : "ok", detail, s.missing.length && s.facts.checkoutClean === false ? "commit or stash local changes, then rerun" : s.setup, s.missing.length ? s.missing : s.changed), ...restorable ? { fixable: "restore" } : {} };
}
function pending(s) {
  const paths = [.../* @__PURE__ */ new Set([...Object.values(s.manifest?.files ?? {}).flatMap((e) => e.pending ? [e.pending.path] : []), ...Object.keys(s.manifest?.pendingNew ?? {})])].filter((p) => existsSync25(fromHomeRel(s.ctx.home, p)));
  const first = paths[0] && fromHomeRel(s.ctx.home, paths[0]);
  return check("pending", paths.length ? "warn" : "ok", `${paths.length} pending .pi-setup-new files`, first ? `diff ${first.replace(/\.pi-setup-new$/, "")} ${first}` : void 0, paths);
}
function modes(s) {
  return { ...check("modes", s.modes.length ? "warn" : "skip", `${s.modes.length} unchanged files have mode drift`, `${s.setup} doctor --fix`, s.modes), ...s.modes.length ? { fixable: "chmod" } : {} };
}
function npm(s) {
  const pkg = readJson2(join30(s.piDir, "npm/package.json"));
  const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
  const installed = (name) => existsSync25(join30(s.piDir, "npm/node_modules", name, "package.json"));
  const missing = deps.filter((n3) => !installed(n3));
  const result2 = [{ ...check("npm", missing.length ? "fail" : "ok", missing.length ? `${missing.length} missing dependencies` : "dependencies present", "(cd ~/.pi/agent/npm && npm install --legacy-peer-deps)", missing), ...missing.length ? { fixable: "npm" } : {} }];
  for (const spec of packages(s)) {
    if (spec.startsWith("npm:")) {
      const full = spec.slice(4);
      const at = full.indexOf("@", 1);
      const name = at < 0 ? full : full.slice(0, at);
      if (!installed(name)) result2.push(check(`package:${name}`, "warn", `${spec} is missing`, `pi install npm:${name}`));
    } else if (spec.startsWith(".") && !existsSync25(resolve7(s.piDir, spec))) result2.push(check(`package:${spec}`, "warn", "local package is missing", `edit ~/.pi/agent/settings.json`));
  }
  return result2;
}
function profile(s) {
  if (!s.profile) return check("profile", "warn", "no ACTIVE profile", `${s.setup} --profile auto`);
  const meta = loadProfiles(s.ctx.repoDir).find((p) => p.name === s.profile);
  if (!meta) return check("profile", "warn", `unknown profile ${s.profile}`, `${s.setup} --profile auto`);
  const missing = meta.requires.filter((p) => s.facts.providers[p]?.status === "not_ready");
  if (missing.length) return check("profile", "fail", `${s.profile}: ${missing.map((p) => PROVIDER_LABELS[p] ?? p).join(", ")} has no login`, `run \`pi\`, type /login and choose ${PROVIDER_LABELS[missing[0]] ?? missing[0]}`);
  const unknown = meta.requires.filter((p) => s.facts.providers[p]?.status !== "ready");
  if (unknown.length) return check("profile", "warn", `${unknown.map((p) => PROVIDER_LABELS[p] ?? p).join(", ")}: could not check (pi auth check timed out)`, `${s.setup} doctor`);
  return check("profile", "ok", `${s.profile}; ready: ${Object.keys(s.facts.providers).filter((p) => ready(s, `${p}/`)).map((p) => PROVIDER_LABELS[p] ?? p).join(", ")}`);
}
function providers(s) {
  return Object.entries(s.facts.providers).filter(([, provider]) => provider.status === "unknown").map(([id]) => check(`provider:${id}`, "warn", `${PROVIDER_LABELS[id] ?? id}: could not determine`, `${s.setup} doctor`));
}
function models(s) {
  if (!s.facts.catalog?.size) {
    if (s.facts.summary || !Object.values(s.facts.providers).some((p) => p.status === "ready")) return check("models", "skip", "catalog not checked");
    return check("models", "fail", "pi lists no models", "pi update");
  }
  const missing = s.pins.filter((p) => ready(s, p.model) && !s.facts.catalog.has(p.model)).map((p) => p.model);
  return check("models", missing.length ? "fail" : "ok", missing.length ? "pins missing from catalog" : "available pins are in the catalog", "pi update", missing);
}
function fallback(s) {
  const config = readJson2(join30(s.piDir, "provider-fallback.json")) ?? {};
  const pairs = Array.isArray(config.pairs) ? config.pairs.filter((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "string")) : [];
  const chains = config.chains && typeof config.chains === "object" ? config.chains : {};
  const targets = (pin) => Array.isArray(chains[pin]) ? chains[pin].filter((v) => typeof v === "string") : pairs.filter((p) => p.includes(pin)).map((p) => p[0] === pin ? p[1] : p[0]);
  const available2 = (pin) => ready(s, pin) && (!s.facts.catalog?.size || s.facts.catalog.has(pin));
  const result2 = [];
  for (const pin of s.pins.filter((p) => providerStatus(s, p.model) === "not_ready")) {
    const target = targets(pin.model).find(available2);
    const safe = config.enabled === true && target && pin.agents.every((a2) => a2.fallback);
    const label = PROVIDER_LABELS[pin.model.split("/")[0]] ?? pin.model.split("/")[0];
    const choice = chooseProfile(new Set(Object.keys(s.facts.providers).filter((p) => ready(s, `${p}/`))), loadProfiles(s.ctx.repoDir));
    result2.push(check(`fallback:${pin.model}`, safe ? "warn" : "fail", `${pin.agents.map((a2) => a2.name).join(", ")} pin ${pin.model} but ${label} has no login: subagents may run on the parent model or fail before fallback switches${target ? ` to ${target}` : "; no ready target"}${!safe ? " (fallback unavailable)" : ""}`, `run \`pi\`, type /login and choose ${label}; or \`${s.setup} --profile auto\` (would pick ${choice.name})`));
  }
  const sources = /* @__PURE__ */ new Set([...Object.keys(chains), ...pairs.flat()]);
  const unavailable = [...sources].filter((p) => ready(s, p) && !targets(p).some(available2));
  if (config.enabled === true && unavailable.length) result2.push(check("fallback-targets", "warn", "fallback sources have no ready target", "edit ~/.pi/agent/provider-fallback.json", unavailable));
  if (!result2.length) result2.push(check("fallback", "ok", "fallback targets ready"));
  return result2;
}
function guards(s) {
  const path2 = join30(s.piDir, "guards.json");
  const config = readJson2(path2);
  let detail = "all on";
  if (existsSync25(path2)) {
    const off = config?.off;
    if (!off || typeof off !== "object" || Array.isArray(off) || Object.values(off).some((v) => typeof v !== "boolean")) return check("guards", "warn", "invalid guards.json shape", "/guards in pi (guards default to on)");
    const names = Object.entries(off).filter(([, v]) => v).map(([n3]) => n3);
    if (names.length) detail = `on, except ${names.join(", ")} (persisted off)`;
  }
  if (s.ctx.env.PI_GUARDS_OFF) detail += `; PI_GUARDS_OFF=${s.ctx.env.PI_GUARDS_OFF}`;
  return check("guards", "ok", detail);
}
function path(s) {
  const bin = join30(s.ctx.home, ".local/bin");
  const onPath = (s.ctx.env.PATH ?? "").split(delimiter2).some((p) => resolve7(s.ctx.cwd, p) === bin);
  const shell = basename2(s.ctx.env.SHELL ?? "");
  const rc = shell === "zsh" ? "zshrc" : shell === "bash" ? "bashrc" : "profile";
  const result2 = [check("path", onPath ? "ok" : "warn", onPath ? "~/.local/bin is on PATH" : "~/.local/bin is not on PATH", `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.${rc}`)];
  for (const [pkg, cmd] of [["pi-context-budget", "pi-session"], ["pi-orch", "orch"]]) {
    if (!packages(s).some((p) => p.includes(pkg))) continue;
    const target = `~/.pi/agent/npm/node_modules/@woksin/${pkg}/bin/${cmd}`;
    const fix = existsSync25(join30(s.ctx.home, target.slice(2))) ? `ln -s ${target} ~/.local/bin/${cmd}` : `https://github.com/woksin/${pkg}#readme`;
    result2.push(check(`path:${cmd}`, s.ctx.which(cmd) ? "ok" : "warn", s.ctx.which(cmd) ? `${cmd} found` : `${cmd} is missing`, fix));
  }
  return result2;
}
function localChecks(ctx, facts) {
  const s = state(ctx, facts);
  return { checks: [files(s), pending(s), modes(s), ...npm(s), profile(s), ...providers(s), models(s), ...fallback(s), guards(s), ...path(s)], manifest: s.manifest, profile: s.profile, modePaths: s.modes };
}
var text, present, providerStatus, ready, check, packages;
var init_doctor_checks = __esm({
  "src/doctor-checks.ts"() {
    init_manifest();
    init_profiles();
    init_types();
    text = (path2) => {
      try {
        return readFileSync20(path2, "utf8").trim();
      } catch {
        return "";
      }
    };
    present = (path2) => {
      try {
        lstatSync5(path2);
        return true;
      } catch {
        return false;
      }
    };
    providerStatus = (s, model) => s.facts.providers[model.split("/")[0]]?.status;
    ready = (s, model) => providerStatus(s, model) === "ready";
    check = (id, status2, detail, fix, items) => ({ id, title: id, status: status2, detail, ...fix ? { fix } : {}, ...items?.length ? { items } : {} });
    packages = (s) => Array.isArray(s.settings.packages) ? s.settings.packages.filter((p) => typeof p === "string") : [];
  }
});

// src/update.ts
import { existsSync as existsSync26 } from "node:fs";
import { join as join31 } from "node:path";
function compareTags(a2, b) {
  const x = a2.slice(1).split(".").map(Number);
  const y2 = b.slice(1).split(".").map(Number);
  for (let i2 = 0; i2 < Math.max(x.length, y2.length); i2++) {
    const d = (x[i2] ?? 0) - (y2[i2] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
function latestTag(tags) {
  return tags.filter((t2) => TAG.test(t2)).sort(compareTags).at(-1);
}
async function git(ctx, args, timeoutMs = 3e4) {
  const r2 = await ctx.run("git", ["-C", ctx.repoDir, ...args], { timeoutMs });
  return { ok: r2.code === 0, out: r2.stdout.trim(), err: (r2.stderr || r2.stdout).trim() };
}
async function remoteTags(ctx, timeoutMs = 3e4) {
  const r2 = await git(ctx, ["ls-remote", "--tags", "--refs", "origin", "v*"], timeoutMs);
  if (!r2.ok) throw new SetupError(`git ls-remote failed: ${r2.err}`);
  return r2.out.split("\n").map((l2) => l2.split("	refs/tags/")[1]).filter((t2) => Boolean(t2));
}
async function pickTarget(ctx, options) {
  if (options.dryRun) {
    if (options.ref) return options.ref;
    const tag = latestTag(await remoteTags(ctx));
    if (!tag) throw new SetupError("no v* release tags found on origin");
    return tag;
  }
  const fetched = await git(ctx, ["fetch", "--tags", "--quiet", "origin"], 6e4);
  if (!fetched.ok) throw new SetupError(`git fetch failed: ${fetched.err}`);
  let target = options.ref;
  if (!target) {
    const listed = await git(ctx, ["tag", "--list", "v*"]);
    target = latestTag(listed.out.split("\n").filter(Boolean)) ?? "";
    if (!target) throw new SetupError("no v* release tags found");
  }
  if (!(await git(ctx, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`])).ok) {
    throw new SetupError(`unknown ref '${target}'`);
  }
  return target;
}
async function releaseNotes(ctx, tag) {
  if (!TAG.test(tag) || !ctx.which("gh")) return;
  const r2 = await ctx.run("gh", ["release", "view", tag, "--json", "name,body", "--jq", '.name + "\n\n" + .body'], { cwd: ctx.repoDir, timeoutMs: 15e3 });
  if (r2.code === 0 && r2.stdout.trim()) ctx.out(r2.stdout.trim());
}
async function runUpdate(ctx, options, prompter) {
  if (!existsSync26(join31(ctx.repoDir, ".git"))) throw new SetupError("update needs a git checkout of pi-setup");
  const status2 = await git(ctx, ["status", "--porcelain"]);
  if (!status2.ok) throw new SetupError(`git status failed: ${status2.err}`);
  if (status2.out) throw new SetupError("checkout has local changes; commit or stash them first");
  const target = await pickTarget(ctx, options);
  const current = (await git(ctx, ["describe", "--tags", "--always"])).out || "unknown";
  ctx.out(`pi-setup: ${current} \u2192 ${target}`);
  await releaseNotes(ctx, target);
  if (options.dryRun) {
    ctx.out(`would check out ${target} and run install`);
    return 0;
  }
  if (prompter) {
    const answer = await prompter.confirm({ message: `Check out ${target} and install?`, initial: true });
    if (prompter.isCancel(answer) || answer !== true) {
      ctx.err("Cancelled; nothing changed.");
      return 1;
    }
  }
  const checkout = await git(ctx, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", target], 6e4);
  if (!checkout.ok) throw new SetupError(`git checkout ${target} failed: ${checkout.err}`);
  ctx.out(`checkout is detached at ${target}; \`git switch main\` to go back`);
  const args = [join31(ctx.repoDir, "installer", "dist", "pi-setup.mjs"), "install"];
  if (options.yes || !prompter) args.push("--yes");
  if (options.skipNpm) args.push("--skip-npm");
  const result2 = await ctx.run(ctx.nodePath ?? process.execPath, args, { inherit: true });
  return result2.code ?? 1;
}
var TAG;
var init_update = __esm({
  "src/update.ts"() {
    init_types();
    TAG = /^v\d+(\.\d+)*$/;
  }
});

// src/doctor-probes.ts
import { existsSync as existsSync27, readdirSync as readdirSync11, readFileSync as readFileSync21, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join32 } from "node:path";
function plists(ctx) {
  const dir = join32(ctx.home, "Library/LaunchAgents");
  if (ctx.platform !== "darwin" || !existsSync27(dir)) return [];
  return readdirSync11(dir).filter((f) => f.endsWith(".plist")).flatMap((file) => {
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync21(join32(dir, file), "utf8"))?.[1];
    return label && /\.(docker-guardian|pi-cleanup)$/.test(label) ? [{ file, label }] : [];
  });
}
async function disk(ctx) {
  const unknown = () => [result("disk", "warn", "disk not checked", "df -h ~")];
  const script = join32(ctx.home, ".pi/agent/bin/dev-doctor");
  if (!existsSync27(script)) return unknown();
  const r2 = await ctx.run("python3", [script, "--only", "disk", "--json"], { timeoutMs: 6e3, env: { PYTHONDONTWRITEBYTECODE: "1" } });
  if (r2.timedOut || r2.code !== 0) return unknown();
  try {
    const findings = JSON.parse(r2.stdout);
    if (!Array.isArray(findings)) return unknown();
    const checks = findings.filter((f) => f?.id === "disk").map((f) => {
      if (typeof f.evidence !== "string" || f.evidence.startsWith("Skipped:") || !["info", "warn", "high"].includes(f.severity)) return unknown()[0];
      return result("disk", f.severity === "high" ? "fail" : f.severity === "warn" ? "warn" : "ok", f.evidence, typeof f.suggest === "string" ? f.suggest : "df -h ~");
    });
    return checks.length ? checks : unknown();
  } catch {
    return unknown();
  }
}
async function update(ctx, manifest) {
  const skip = (reason) => result("update", "ok", `update check skipped (${reason})`);
  if (!existsSync27(join32(ctx.repoDir, ".git"))) return skip("not a git checkout");
  const path2 = join32(ctx.home, ".pi/agent/.pi-setup/update-check.json");
  const cache = readJson2(path2);
  const age = ctx.now().getTime() - Date.parse(String(cache?.checkedAt));
  let latest;
  if (age >= 0 && age < 864e5 && typeof cache?.latest === "string") latest = latestTag([cache.latest]);
  if (!latest) {
    if (ctx.env.PI_OFFLINE) return skip("offline");
    try {
      latest = latestTag(await remoteTags(ctx, 5e3));
      if (!latest) return skip("no release tags");
      if (existsSync27(join32(ctx.home, ".pi/agent/.pi-setup"))) writeFileSync8(path2, `${JSON.stringify({ checkedAt: ctx.now().toISOString(), latest })}
`);
    } catch {
      return skip("remote unavailable");
    }
  }
  let current = manifest?.source.release;
  if (!current) {
    const r2 = await ctx.run("git", ["-C", ctx.repoDir, "describe", "--tags", "--abbrev=0"], { timeoutMs: 3e3 });
    if (r2.code !== 0 || r2.timedOut) return skip("installed release unknown");
    current = r2.stdout.trim();
  }
  if (!latestTag([current])) return skip("installed release unknown");
  return result("update", compareTags(latest, current) > 0 ? "warn" : "ok", compareTags(latest, current) > 0 ? `${latest} available (installed ${current})` : `up to date (${current})`, `${setupCmd(ctx)} update`);
}
async function gatherFacts(baseCtx, manifest) {
  const ctx = { ...baseCtx, run: (cmd, args, options) => baseCtx.run(cmd, cmd === "git" ? ["--no-optional-locks", ...args] : args, options) };
  const hasPi = Boolean(ctx.which("pi"));
  const recorded = new Set(Object.values(manifest?.components ?? {}).flatMap((c2) => c2.service?.kind === "launchd" ? [c2.service.label] : []));
  const all = plists(ctx);
  const agents = all.filter((p) => !recorded.has(p.label));
  const guardian = all.some((p) => p.label.endsWith(".docker-guardian")) || manifest?.components?.["docker-guardian"]?.on === true;
  const [providers2, models2, version, gh, head, checkout, disks, launchd, docker, updates] = await Promise.all([
    Promise.all(PROVIDER_IDS.map((id) => hasPi ? probeProvider(ctx, id).catch(() => ({ status: "unknown" })) : Promise.resolve({ status: "unknown" }))),
    hasPi ? listModels(ctx) : Promise.resolve({ catalog: null, code: null, stderr: "", timedOut: false }),
    hasPi ? ctx.run("pi", ["--version"], { timeoutMs: 8e3 }) : Promise.resolve(skippedRun),
    ctx.which("gh") ? ctx.run("gh", ["auth", "status"], { timeoutMs: 3e3 }) : Promise.resolve(skippedRun),
    ctx.run("git", ["-C", ctx.repoDir, "rev-parse", "HEAD"], { timeoutMs: 3e3 }),
    ctx.run("git", ["-C", ctx.repoDir, "status", "--porcelain"], { timeoutMs: 3e3 }),
    disk(ctx),
    Promise.all(agents.map(async (p) => {
      const r2 = await ctx.run("launchctl", ["list", p.label], { timeoutMs: 3e3 });
      return result(`launchd:${p.label}`, r2.code === 0 && !r2.timedOut ? "ok" : "warn", `${p.label}: ${r2.code === 0 && !r2.timedOut ? "loaded" : "not loaded"}`, `launchctl load -w ~/Library/LaunchAgents/${p.file}`);
    })),
    guardian ? ctx.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5e3 }) : Promise.resolve(void 0),
    update(ctx, manifest)
  ]);
  let pi;
  if (!hasPi) pi = result("pi", "fail", "not on PATH", installHint(ctx.platform, "pi"));
  else if (models2.timedOut || version.timedOut) pi = result("pi", "warn", "timed out", `${setupCmd(ctx)} doctor`);
  else if (models2.code !== 0 || version.code !== 0) pi = result("pi", "fail", models2.stderr.split("\n")[0] || version.stderr.split("\n")[0] || "pi did not load", "run `pi` and read the startup errors");
  else pi = result("pi", "ok", `pi ${version.stdout.trim().split("\n")[0]}`);
  const github = parseAuthStatus(`${gh.stdout}
${gh.stderr}`);
  const ghCheck = !ctx.which("gh") ? result("gh", "warn", "not on PATH", installHint(ctx.platform, "gh")) : !github.host ? result("gh", "warn", "not logged in", "gh auth login") : result("gh", "ok", `${github.login}@${github.host}`);
  return {
    facts: { providers: Object.fromEntries(PROVIDER_IDS.map((id, i2) => [id, providers2[i2]])), catalog: models2.catalog, head: head.code === 0 && !head.timedOut ? head.stdout.trim() : void 0, checkoutClean: checkout.code === 0 && !checkout.timedOut ? !checkout.stdout.trim() : void 0, github: { ...github, orgs: [] }, summary: false },
    checks: [pi, ghCheck, ...disks, ...launchd.length ? launchd : [result("launchd", "skip", "no managed launch agents")], docker ? result("docker", docker.code === 0 && !docker.timedOut ? "ok" : "warn", docker.code === 0 && !docker.timedOut ? docker.stdout.trim() : "not reachable", ctx.platform === "darwin" ? "open -a Docker" : "systemctl --user start docker") : result("docker", "skip", "no docker guardian"), updates]
  };
}
var result, skippedRun;
var init_doctor_probes = __esm({
  "src/doctor-probes.ts"() {
    init_detect();
    init_doctor_checks();
    init_update();
    init_types();
    result = (id, status2, detail, fix) => ({ id, title: id, status: status2, detail, ...fix ? { fix } : {} });
    skippedRun = { code: null, stdout: "", stderr: "", timedOut: false };
  }
});

// src/doctor-components.ts
import { existsSync as existsSync28, lstatSync as lstatSync6, readlinkSync as readlinkSync4, statSync as statSync15 } from "node:fs";
import { join as join33 } from "node:path";
async function isLoaded(ctx, kind, label) {
  try {
    const r2 = kind === "launchd" ? await ctx.run("launchctl", ["print", `gui/${uid()}/${label}`], { timeoutMs: 5e3 }) : await ctx.run("systemctl", ["--user", "is-active", label], { timeoutMs: 5e3 });
    return r2.code === 0 && !r2.timedOut;
  } catch {
    return false;
  }
}
function lanesChecks(ctx) {
  const bin = join33(ctx.home, ".local/bin/lanes");
  const target = join33(ctx.home, ".local/share/pi-setup/lanes/lanes.mjs");
  let linked = false;
  let present2 = false;
  try {
    const stat = lstatSync6(bin);
    present2 = true;
    linked = stat.isSymbolicLink() && readlinkSync4(bin) === target;
  } catch {
  }
  const good = linked && existsSync28(target);
  const fix = good ? void 0 : present2 && !linked ? "move ~/.local/bin/lanes away, then pi-setup install --with lanes" : "pi-setup install --with lanes";
  let config;
  let configError = "";
  let root;
  try {
    root = findRoot(void 0, ctx.env, ctx.cwd);
  } catch {
  }
  if (root) {
    try {
      config = loadConfig(root);
    } catch (e) {
      configError = e.message;
    }
  }
  let installedPreapproval = false;
  try {
    installedPreapproval = preapprovalDefault(join33(ctx.home, ".local/share/pi-setup/lanes/templates"));
  } catch (e) {
    configError ||= e.message;
  }
  const enabled = config ? config.launch.preapproveMcp : installedPreapproval;
  const backend = detectBackend(config?.terminal.backend || "auto", ctx);
  return [
    check2("lanes", good ? "ok" : "warn", good ? "lanes is installed" : "lanes link or bundle is missing or points elsewhere", fix),
    check2("lanes-git", ctx.which("git") ? "ok" : "warn", ctx.which("git") ? "git is on PATH" : "git is missing", ctx.which("git") ? void 0 : "install git"),
    check2("lanes-terminal", "ok", backend === "print" ? "print (no Terminal.app, iTerm or tmux detected; lanes start will print the command)" : backend),
    check2("lanes-preapprove-mcp", configError ? "warn" : "ok", configError || `MCP preapproval is ${enabled ? "on (trusts project MCP server definitions)" : "off"}${config ? ` in ${join33(root, "lanes.json")}` : " for new folders (no lanes.json found)"}`)
  ];
}
async function componentChecks(ctx, manifest) {
  const comps = manifest?.components;
  if (!comps) return [];
  const checks = [];
  for (const def of COMPONENTS.filter((c2) => c2.service)) {
    const unit = expectedUnit(ctx, def.id);
    if (!unit) continue;
    const id = `service:${def.id}`;
    const rec = comps[def.id];
    const exists = existsSync28(unit.file);
    if (rec?.on && rec.service?.managed) {
      const manual = unit.kind === "launchd" ? `launchctl bootstrap gui/${uid()} ${unit.file}` : `systemctl --user enable --now ${unit.label}`;
      checks.push(await isLoaded(ctx, unit.kind, unit.label) ? check2(id, "ok", `${unit.label} is loaded`) : check2(id, "warn", `${unit.label} is not loaded`, manual));
    } else if (rec?.on && !rec.service?.managed) {
      checks.push(check2(id, "ok", `${unit.file.replace(`${ctx.home}/`, "~/")} is not managed by pi-setup; left alone`));
    } else if (exists) {
      checks.push(check2(id, "ok", `${def.id} is turned off but a unit exists at ${unit.file.replace(`${ctx.home}/`, "~/")}; left alone`));
    }
  }
  if (comps.codescene?.on) {
    const dir = join33(ctx.home, ".agents/skills");
    const missing = CS_SKILLS.filter((n3) => {
      try {
        return !statSync15(join33(dir, n3)).isDirectory();
      } catch {
        return true;
      }
    });
    checks.push(
      ctx.which("cs-mcp") ? check2("codescene-mcp", "ok", "cs-mcp is on PATH") : check2("codescene-mcp", "warn", "cs-mcp not found on PATH", "install cs-mcp: https://github.com/codescene-oss/codescene-mcp-server#readme"),
      ctx.env.CS_ACCESS_TOKEN ? check2("codescene-token", "ok", "CS_ACCESS_TOKEN is set") : check2("codescene-token", "warn", "CS_ACCESS_TOKEN is not set", "export CS_ACCESS_TOKEN=<your token> in your shell profile (pi-setup never stores it)"),
      missing.length === 0 ? check2("codescene-skills", "ok", "CodeScene skills are present") : check2("codescene-skills", "warn", `CodeScene skills missing: ${missing.join(", ")}`, "copy skills/<name> from https://github.com/codescene-oss/codescene-mcp-server/tree/main/skills to ~/.agents/skills/")
    );
  }
  if (comps.lanes?.on) checks.push(...lanesChecks(ctx));
  return checks;
}
var check2;
var init_doctor_components = __esm({
  "src/doctor-components.ts"() {
    init_terminal();
    init_config();
    init_components();
    init_services();
    check2 = (id, status2, detail, fix) => ({ id, title: id, status: status2, detail, ...fix ? { fix } : {} });
  }
});

// src/doctor.ts
import { chmodSync as chmodSync3 } from "node:fs";
import { join as join34 } from "node:path";
function doctorExitCode(checks) {
  return checks.some((c2) => c2.status === "fail") ? 2 : checks.some((c2) => c2.status === "warn") ? 1 : 0;
}
function render2(checks) {
  return checks.filter((c2) => c2.status !== "skip").flatMap((c2) => {
    const items = c2.items?.length ? ` (${c2.items.slice(0, 3).join(", ")}${c2.items.length > 3 ? ` and ${c2.items.length - 3} more` : ""})` : "";
    const line = `${c2.status === "ok" ? "\u2714" : c2.status === "warn" ? "\u26A0" : "\u2716"} ${c2.title}: ${c2.detail}${items}`;
    return c2.status === "ok" ? [line] : [line, `  fix: ${c2.fix}`];
  });
}
async function inspect(ctx) {
  let manifest;
  try {
    manifest = readManifest(join34(ctx.home, ".pi/agent"));
    if (manifest) validateManifest(ctx.home, manifest);
  } catch {
    manifest = void 0;
  }
  const gathered = await gatherFacts(ctx, manifest);
  const local = localChecks(ctx, gathered.facts);
  const extras = await componentChecks(ctx, local.manifest);
  return { ...local, facts: gathered.facts, checks: [...local.checks, ...gathered.checks, ...extras] };
}
async function runDoctor(ctx, options, baseCtx) {
  let report = await inspect(ctx);
  const fixed = [];
  if (options.fix) {
    const fixable = new Set(report.checks.map((c2) => c2.fixable));
    if (fixable.has("npm")) {
      const r2 = await ctx.run("npm", ["install", "--legacy-peer-deps"], { cwd: join34(ctx.home, ".pi/agent/npm"), inherit: !options.json, timeoutMs: 12e4 });
      if (r2.code === 0 && !r2.timedOut) fixed.push("npm");
    }
    if (fixable.has("restore") && report.facts.checkoutClean === true && report.facts.head && report.facts.head === report.manifest?.source.commit) {
      const r2 = await ctx.run(ctx.nodePath ?? process.execPath, [join34(ctx.repoDir, "installer/dist/pi-setup.mjs"), "install", "--yes", "--skip-npm"], { inherit: !options.json, timeoutMs: 12e4 });
      if (r2.code === 0 && !r2.timedOut) fixed.push("restore");
    }
    if (fixable.has("chmod") && report.manifest) {
      let changed = false;
      for (const rel of report.modePaths) {
        const path2 = fromHomeRel(ctx.home, rel);
        const entry = report.manifest.files[rel];
        if (fileSha(path2) !== entry.sha256) continue;
        chmodSync3(path2, entry.mode);
        changed = true;
      }
      if (changed) fixed.push("chmod");
    }
    report = await inspect(ctx);
  }
  const exitCode = doctorExitCode(report.checks);
  if (options.json) baseCtx.out(JSON.stringify({ version: 1, exitCode, checks: report.checks, fixed }));
  else {
    const source = report.manifest?.source;
    ctx.out(`pi-setup doctor \u2014 profile ${report.profile || "none"}, installed ${source?.release || source?.commit?.slice(0, 7) || "unknown"}`);
    if (fixed.length) ctx.out(`Fixed: ${fixed.join(", ")}`);
    for (const line of render2(report.checks)) ctx.out(line);
    const names = [...new Set(report.checks.map((c2) => c2.fixable).filter(Boolean))];
    ctx.out(`${counts(report.checks)}.${!options.fix && names.length ? ` \`${setupCmd(ctx)} doctor --fix\` can fix: ${names.join(", ")}.` : ""}`);
  }
  return exitCode;
}
async function installSummary(ctx, detection, _piDir) {
  const local = localChecks(ctx, { providers: detection.providers, catalog: detection.catalog, github: detection.github.host ? detection.github : void 0, summary: true });
  const checks = local.checks;
  if (!doctorExitCode(checks)) return [`Doctor: all ${checks.filter((c2) => c2.status === "ok").length} checks passed (full check: \`${setupCmd(ctx)} doctor\`).`];
  return [`Doctor: ${counts(checks)}:`, ...render2(checks.filter((c2) => c2.status === "warn" || c2.status === "fail")), `Full check: \`${setupCmd(ctx)} doctor\``];
}
var counts;
var init_doctor = __esm({
  "src/doctor.ts"() {
    init_doctor_checks();
    init_doctor_probes();
    init_manifest();
    init_doctor_components();
    init_doctor_checks();
    counts = (checks) => {
      const count = (status2) => checks.filter((c2) => c2.status === status2).length;
      return `${count("ok")} ok, ${count("warn")} warnings, ${count("fail")} failures`;
    };
  }
});

// src/report.ts
function countActions(actions) {
  const installs = actions.filter((a2) => a2.op === "install");
  return {
    added: installs.filter((a2) => !a2.existed).length,
    changed: installs.filter((a2) => a2.existed).length,
    kept: actions.filter((a2) => a2.op === "keep").length,
    register: actions.filter((a2) => a2.op === "register").length,
    links: actions.filter((a2) => a2.op === "symlink").length
  };
}
function detectionLines(detection, probed = true) {
  const lines2 = [`OS: ${detection.os}`];
  lines2.push(`Tools: ${detection.tools.map((t2) => `${t2.name} ${t2.path ? "\u2713" : "\u2717"}`).join(", ")}`);
  const github = detection.github;
  lines2.push(`GitHub: ${github.login ? `${github.login}${github.host ? ` on ${github.host}` : ""}` : "no login found"}`);
  if (!probed) lines2.push("Providers: not probed in dry-run (pi probes can write state)");
  else lines2.push(
    "Providers: " + PROVIDER_IDS.map((id) => `${PROVIDER_LABELS[id]} ${symbol(detection.providers[id]?.status)}`).join(", ")
  );
  return lines2;
}
function symbol(status2) {
  if (status2 === "ready") return "\u2713";
  return status2 === "not_ready" ? "\u2717" : "?";
}
function summaryLines(args) {
  const { settings: settings2, choice, actions } = args;
  const counts2 = countActions(actions);
  const lines2 = [
    `GitHub login: ${settings2.githubUser} (${USER_SOURCES[settings2.userSource]})`,
    `Repositories root: ${settings2.reposRoot} (${ROOT_SOURCES[settings2.rootSource]})`,
    ...detectionLines(args.detection, args.probed),
    `Profile: ${choice.name} (${choice.reason})${choice.provisional ? " [provisional]" : ""}`
  ];
  if (args.profile?.summary) lines2.push(args.profile.summary);
  if (args.kimi) lines2.push(args.kimi);
  lines2.push(
    `Files: ${counts2.added} new, ${counts2.changed} changed${counts2.kept ? `, ${counts2.kept} kept (changed by you)` : ""}${counts2.register ? ", register pi-questions" : ""}`,
    `npm install: ${args.skipNpm ? "skipped (--skip-npm)" : args.npm ? "yes" : "up to date"}`
  );
  if (args.components) {
    const word = (id) => `${COMPONENTS.find((c2) => c2.id === id)?.label} ${args.components?.[id]?.on ? "on" : "off"}`;
    lines2.push(`Extras: ${COMPONENTS.map((c2) => word(c2.id)).join(", ")}`);
  }
  const kept = actions.filter((a2) => a2.op === "keep");
  if (kept.some((a2) => /\/\.pi\/agent\/(agents\/[^/]+\.md|workflows\/[^/]+\.js)$/.test(a2.path))) {
    lines2.push(KEPT_EDITS);
  }
  if (kept.some((a2) => a2.op === "keep" && a2.noMarkers)) {
    lines2.push("AGENTS.md has no pi-profile routing markers, so it is reconciled as a whole file; the new version is in AGENTS.md.pi-setup-new");
  }
  lines2.push(...args.componentNotes ?? []);
  for (const warning of args.warnings.filter((w) => w !== args.kimi)) lines2.push(`warning: ${warning}`);
  return lines2;
}
var USER_SOURCES, ROOT_SOURCES, KEPT_EDITS;
var init_report = __esm({
  "src/report.ts"() {
    init_types();
    init_components();
    USER_SOURCES = { flag: "from --user", saved: "saved in user.json", detected: "from gh", prompt: "you typed it" };
    ROOT_SOURCES = { flag: "from --repos-root", saved: "saved in user.json", scan: "best match found", default: "default", prompt: "you typed it" };
    KEPT_EDITS = "kept your edits; `pi-profile save` to adopt them into the profile";
  }
});

// src/wizard.ts
async function askLogin(p, input) {
  if (input.options.user) return void 0;
  const known = savedString(input.saved, "githubUser") || input.detection.github.login || "";
  if (known) {
    const keep = await p.confirm({ message: `Use GitHub login ${known}?`, initial: true });
    if (p.isCancel(keep)) return CANCEL;
    if (keep === true) return known;
  }
  const typed = await p.text({
    message: "GitHub login",
    initial: known,
    validate: (value) => validLogin(value.trim()) ? void 0 : "Enter a valid GitHub login"
  });
  return p.isCancel(typed) ? CANCEL : typed.trim();
}
function rootOptions(input) {
  const saved = savedString(input.saved, "reposRoot");
  const list = input.detection.candidates.map((c2) => ({ value: c2.path, label: c2.path, hint: `${c2.score} repositories` }));
  if (saved && !list.some((c2) => c2.value === saved)) list.push({ value: saved, label: saved, hint: "saved" });
  list.push({ value: "", label: "Other\u2026", hint: "type a path" });
  return list;
}
function validateRoot(input) {
  return (value) => {
    try {
      normalizeRoot(value.trim() || "x", input.home, input.repoDir);
      return value.trim() ? void 0 : "Enter a path";
    } catch (error) {
      return error instanceof SetupError ? error.message : String(error);
    }
  };
}
async function askRoot(p, input) {
  if (input.options.reposRoot) return void 0;
  const picked = await p.select({
    message: "Where are your repositories?",
    options: rootOptions(input),
    initial: input.detection.candidates[0]?.path ?? savedString(input.saved, "reposRoot")
  });
  if (p.isCancel(picked)) return CANCEL;
  if (picked) return picked;
  const typed = await p.text({ message: "Repositories root", initial: `${input.home}/repos`, validate: validateRoot(input) });
  return p.isCancel(typed) ? CANCEL : expandHome(typed.trim(), input.home);
}
async function askProfile(p, input) {
  if (input.options.profile && input.options.profile !== "auto") return void 0;
  const { initial } = input;
  const answer = await p.select({
    message: `Profile ${initial.name}: ${initial.reason}`,
    options: [{ value: "keep", label: "Looks right" }, { value: "change", label: "Change\u2026" }],
    initial: "keep"
  });
  if (p.isCancel(answer)) return CANCEL;
  if (answer === "keep") return void 0;
  const chosen = await p.select({
    message: "Pick a profile",
    options: input.profiles.map((m2) => ({ value: m2.name, label: m2.name, hint: m2.summary })),
    initial: initial.name
  });
  return p.isCancel(chosen) ? CANCEL : chosen;
}
async function askComponents(p, input, root) {
  const rows = input.extras?.(root) ?? [];
  const missing = rows.filter((r2) => r2.unavailable && !r2.fixed);
  if (missing.length) p.note(missing.map((r2) => `${r2.label}: not available (${r2.unavailable})`).join("\n"), "Extras not available here");
  const asked = rows.filter((r2) => !r2.unavailable && !r2.fixed);
  if (asked.length === 0) return void 0;
  const picked = await p.multiselect({
    message: "Extras",
    options: asked.map((r2) => ({ value: r2.id, label: r2.label, hint: r2.hint })),
    initial: asked.filter((r2) => r2.initial).map((r2) => r2.id)
  });
  if (p.isCancel(picked)) return CANCEL;
  const chosen = new Set(picked);
  return Object.fromEntries(asked.map((r2) => [r2.id, chosen.has(r2.id)]));
}
async function collectChoices(p, input) {
  p.note(detectionLines(input.detection).join("\n"), "What I found");
  const user = await askLogin(p, input);
  if (p.isCancel(user)) return CANCEL;
  const root = await askRoot(p, input);
  if (p.isCancel(root)) return CANCEL;
  const profile2 = await askProfile(p, input);
  if (p.isCancel(profile2)) return CANCEL;
  const reposRoot = root || input.options.reposRoot || savedString(input.saved, "reposRoot") || input.detection.candidates[0]?.path || `${input.home}/repos`;
  const components = await askComponents(p, input, reposRoot);
  if (p.isCancel(components)) return CANCEL;
  const lanesRow = input.extras?.(reposRoot).find((r2) => r2.id === "lanes");
  const lanes = !lanesRow?.unavailable && (components?.lanes ?? lanesRow?.initial);
  let preapproveMcp = input.options.preapproveMcp || input.preapproveMcp || false;
  if (lanes && !preapproveMcp) {
    const answer = await p.confirm({ message: "Preapprove project MCP servers? This trusts project MCP server definitions in added repositories.", initial: false });
    if (p.isCancel(answer)) return CANCEL;
    preapproveMcp = answer === true;
  }
  return {
    ...lanes ? { preapproveMcp } : {},
    user,
    root,
    profile: profile2,
    ...components ? { components } : {}
  };
}
async function confirmApply(p, summary) {
  p.note(summary.join("\n"), "Plan");
  const answer = await p.confirm({ message: "Apply?", initial: true });
  return !p.isCancel(answer) && answer === true;
}
async function resolveConflicts(p, conflicts, showDiff) {
  const takes = /* @__PURE__ */ new Set();
  let keepRest = false;
  for (const conflict of conflicts) {
    if (keepRest) break;
    let withDiff = true;
    for (; ; ) {
      const options = [
        { value: "keep", label: `Keep mine (new version goes to ${conflict.newPath})` },
        { value: TAKE, label: "Take the new version (yours is backed up)" },
        ...withDiff ? [{ value: "diff", label: "Show the diff" }] : [],
        { value: "keep-all", label: "Keep mine for all remaining" }
      ];
      const answer = await p.select({ message: `${conflict.path} changed since install`, options, initial: "keep" });
      if (p.isCancel(answer)) return CANCEL;
      if (answer === "diff") {
        p.note(await showDiff(conflict), conflict.path);
        withDiff = false;
        continue;
      }
      if (answer === TAKE) takes.add(conflict.path);
      if (answer === "keep-all") keepRest = true;
      break;
    }
  }
  return takes;
}
var savedString, TAKE;
var init_wizard = __esm({
  "src/wizard.ts"() {
    init_report();
    init_settings();
    init_types();
    savedString = (saved, key) => typeof saved[key] === "string" ? saved[key] : "";
    TAKE = "take";
  }
});

// node_modules/fast-string-truncated-width/dist/utils.js
var getCodePointsLength, isFullWidth, isWideNotCJKTNotEmoji;
var init_utils = __esm({
  "node_modules/fast-string-truncated-width/dist/utils.js"() {
    getCodePointsLength = /* @__PURE__ */ (() => {
      const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
      return (input) => {
        let surrogatePairsNr = 0;
        SURROGATE_PAIR_RE.lastIndex = 0;
        while (SURROGATE_PAIR_RE.test(input)) {
          surrogatePairsNr += 1;
        }
        return input.length - surrogatePairsNr;
      };
    })();
    isFullWidth = (x) => {
      return x === 12288 || x >= 65281 && x <= 65376 || x >= 65504 && x <= 65510;
    };
    isWideNotCJKTNotEmoji = (x) => {
      return x === 8987 || x === 9001 || x >= 12272 && x <= 12287 || x >= 12289 && x <= 12350 || x >= 12441 && x <= 12543 || x >= 12549 && x <= 12591 || x >= 12593 && x <= 12686 || x >= 12688 && x <= 12771 || x >= 12783 && x <= 12830 || x >= 12832 && x <= 12871 || x >= 12880 && x <= 19903 || x >= 65040 && x <= 65049 || x >= 65072 && x <= 65106 || x >= 65108 && x <= 65126 || x >= 65128 && x <= 65131 || x >= 127488 && x <= 127490 || x >= 127504 && x <= 127547 || x >= 127552 && x <= 127560 || x >= 131072 && x <= 196605 || x >= 196608 && x <= 262141;
    };
  }
});

// node_modules/fast-string-truncated-width/dist/index.js
var ANSI_RE, CONTROL_RE, CJKT_WIDE_RE, TAB_RE, EMOJI_RE, LATIN_RE, MODIFIER_RE, NO_TRUNCATION, getStringTruncatedWidth, dist_default;
var init_dist = __esm({
  "node_modules/fast-string-truncated-width/dist/index.js"() {
    init_utils();
    ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\]8;[^;]*;.*?(?:\u0007|\u001b\u005c)/y;
    CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
    CJKT_WIDE_RE = /(?:(?![\uFF61-\uFF9F\uFF00-\uFFEF])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tangut}]){1,1000}/yu;
    TAB_RE = /\t{1,1000}/y;
    EMOJI_RE = new RegExp("[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F\\u20E3?))*", "yu");
    LATIN_RE = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
    MODIFIER_RE = new RegExp("\\p{M}+", "gu");
    NO_TRUNCATION = { limit: Infinity, ellipsis: "" };
    getStringTruncatedWidth = (input, truncationOptions = {}, widthOptions = {}) => {
      const LIMIT2 = truncationOptions.limit ?? Infinity;
      const ELLIPSIS = truncationOptions.ellipsis ?? "";
      const ELLIPSIS_WIDTH = truncationOptions?.ellipsisWidth ?? (ELLIPSIS ? getStringTruncatedWidth(ELLIPSIS, NO_TRUNCATION, widthOptions).width : 0);
      const ANSI_WIDTH = 0;
      const CONTROL_WIDTH = widthOptions.controlWidth ?? 0;
      const TAB_WIDTH = widthOptions.tabWidth ?? 8;
      const EMOJI_WIDTH = widthOptions.emojiWidth ?? 2;
      const FULL_WIDTH_WIDTH = 2;
      const REGULAR_WIDTH = widthOptions.regularWidth ?? 1;
      const WIDE_WIDTH = widthOptions.wideWidth ?? FULL_WIDTH_WIDTH;
      const PARSE_BLOCKS = [
        [LATIN_RE, REGULAR_WIDTH],
        [ANSI_RE, ANSI_WIDTH],
        [CONTROL_RE, CONTROL_WIDTH],
        [TAB_RE, TAB_WIDTH],
        [EMOJI_RE, EMOJI_WIDTH],
        [CJKT_WIDE_RE, WIDE_WIDTH]
      ];
      let indexPrev = 0;
      let index = 0;
      let length = input.length;
      let lengthExtra = 0;
      let truncationEnabled = false;
      let truncationIndex = length;
      let truncationLimit = Math.max(0, LIMIT2 - ELLIPSIS_WIDTH);
      let unmatchedStart = 0;
      let unmatchedEnd = 0;
      let width = 0;
      let widthExtra = 0;
      outer: while (true) {
        if (unmatchedEnd > unmatchedStart || index >= length && index > indexPrev) {
          const unmatched = input.slice(unmatchedStart, unmatchedEnd) || input.slice(indexPrev, index);
          lengthExtra = 0;
          for (const char of unmatched.replaceAll(MODIFIER_RE, "")) {
            const codePoint = char.codePointAt(0) || 0;
            if (isFullWidth(codePoint)) {
              widthExtra = FULL_WIDTH_WIDTH;
            } else if (isWideNotCJKTNotEmoji(codePoint)) {
              widthExtra = WIDE_WIDTH;
            } else {
              widthExtra = REGULAR_WIDTH;
            }
            if (width + widthExtra > truncationLimit) {
              truncationIndex = Math.min(truncationIndex, Math.max(unmatchedStart, indexPrev) + lengthExtra);
            }
            if (width + widthExtra > LIMIT2) {
              truncationEnabled = true;
              break outer;
            }
            lengthExtra += char.length;
            width += widthExtra;
          }
          unmatchedStart = unmatchedEnd = 0;
        }
        if (index >= length) {
          break outer;
        }
        for (let i2 = 0, l2 = PARSE_BLOCKS.length; i2 < l2; i2++) {
          const [BLOCK_RE, BLOCK_WIDTH] = PARSE_BLOCKS[i2];
          BLOCK_RE.lastIndex = index;
          if (BLOCK_RE.test(input)) {
            lengthExtra = BLOCK_RE === CJKT_WIDE_RE ? getCodePointsLength(input.slice(index, BLOCK_RE.lastIndex)) : BLOCK_RE === EMOJI_RE ? 1 : BLOCK_RE.lastIndex - index;
            widthExtra = lengthExtra * BLOCK_WIDTH;
            if (width + widthExtra > truncationLimit) {
              truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / BLOCK_WIDTH));
            }
            if (width + widthExtra > LIMIT2) {
              truncationEnabled = true;
              break outer;
            }
            width += widthExtra;
            unmatchedStart = indexPrev;
            unmatchedEnd = index;
            index = indexPrev = BLOCK_RE.lastIndex;
            continue outer;
          }
        }
        index += 1;
      }
      return {
        width: truncationEnabled ? truncationLimit : width,
        index: truncationEnabled ? truncationIndex : length,
        truncated: truncationEnabled,
        ellipsed: truncationEnabled && LIMIT2 >= ELLIPSIS_WIDTH
      };
    };
    dist_default = getStringTruncatedWidth;
  }
});

// node_modules/fast-string-width/dist/index.js
var NO_TRUNCATION2, fastStringWidth, dist_default2;
var init_dist2 = __esm({
  "node_modules/fast-string-width/dist/index.js"() {
    init_dist();
    NO_TRUNCATION2 = {
      limit: Infinity,
      ellipsis: "",
      ellipsisWidth: 0
    };
    fastStringWidth = (input, options = {}) => {
      return dist_default(input, NO_TRUNCATION2, options).width;
    };
    dist_default2 = fastStringWidth;
  }
});

// node_modules/fast-wrap-ansi/lib/main.js
function wrapAnsi(string, columns, options) {
  return String(string).normalize().split(CRLF_OR_LF).map((line) => exec(line, columns, options)).join("\n");
}
var ESC, CSI, END_CODE, ANSI_ESCAPE_BELL, ANSI_CSI, ANSI_OSC, ANSI_SGR_TERMINATOR, ANSI_ESCAPE_LINK, GROUP_REGEX, getClosingCode, wrapAnsiCode, wrapAnsiHyperlink, wrapWord, stringVisibleTrimSpacesRight, exec, CRLF_OR_LF;
var init_main2 = __esm({
  "node_modules/fast-wrap-ansi/lib/main.js"() {
    init_dist2();
    ESC = "\x1B";
    CSI = "\x9B";
    END_CODE = 39;
    ANSI_ESCAPE_BELL = "\x07";
    ANSI_CSI = "[";
    ANSI_OSC = "]";
    ANSI_SGR_TERMINATOR = "m";
    ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;
    GROUP_REGEX = new RegExp(`(?:\\${ANSI_CSI}(?<code>\\d+)m|\\${ANSI_ESCAPE_LINK}(?<uri>.*)${ANSI_ESCAPE_BELL})`, "y");
    getClosingCode = (openingCode) => {
      if (openingCode >= 30 && openingCode <= 37)
        return 39;
      if (openingCode >= 90 && openingCode <= 97)
        return 39;
      if (openingCode >= 40 && openingCode <= 47)
        return 49;
      if (openingCode >= 100 && openingCode <= 107)
        return 49;
      if (openingCode === 1 || openingCode === 2)
        return 22;
      if (openingCode === 3)
        return 23;
      if (openingCode === 4)
        return 24;
      if (openingCode === 7)
        return 27;
      if (openingCode === 8)
        return 28;
      if (openingCode === 9)
        return 29;
      if (openingCode === 0)
        return 0;
      return void 0;
    };
    wrapAnsiCode = (code) => `${ESC}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`;
    wrapAnsiHyperlink = (url) => `${ESC}${ANSI_ESCAPE_LINK}${url}${ANSI_ESCAPE_BELL}`;
    wrapWord = (rows, word, columns) => {
      const characters = word[Symbol.iterator]();
      let isInsideEscape = false;
      let isInsideLinkEscape = false;
      let lastRow = rows.at(-1);
      let visible = lastRow === void 0 ? 0 : dist_default2(lastRow);
      let currentCharacter = characters.next();
      let nextCharacter = characters.next();
      let rawCharacterIndex = 0;
      while (!currentCharacter.done) {
        const character = currentCharacter.value;
        const characterLength = dist_default2(character);
        if (visible + characterLength <= columns) {
          rows[rows.length - 1] += character;
        } else {
          rows.push(character);
          visible = 0;
        }
        if (character === ESC || character === CSI) {
          isInsideEscape = true;
          isInsideLinkEscape = word.startsWith(ANSI_ESCAPE_LINK, rawCharacterIndex + 1);
        }
        if (isInsideEscape) {
          if (isInsideLinkEscape) {
            if (character === ANSI_ESCAPE_BELL) {
              isInsideEscape = false;
              isInsideLinkEscape = false;
            }
          } else if (character === ANSI_SGR_TERMINATOR) {
            isInsideEscape = false;
          }
        } else {
          visible += characterLength;
          if (visible === columns && !nextCharacter.done) {
            rows.push("");
            visible = 0;
          }
        }
        currentCharacter = nextCharacter;
        nextCharacter = characters.next();
        rawCharacterIndex += character.length;
      }
      lastRow = rows.at(-1);
      if (!visible && lastRow !== void 0 && lastRow.length && rows.length > 1) {
        rows[rows.length - 2] += rows.pop();
      }
    };
    stringVisibleTrimSpacesRight = (string) => {
      const words = string.split(" ");
      let last = words.length;
      while (last) {
        if (dist_default2(words[last - 1])) {
          break;
        }
        last--;
      }
      if (last === words.length) {
        return string;
      }
      return words.slice(0, last).join(" ") + words.slice(last).join("");
    };
    exec = (string, columns, options = {}) => {
      if (options.trim !== false && string.trim() === "") {
        return "";
      }
      let returnValue = "";
      let escapeCode;
      let escapeUrl;
      const words = string.split(" ");
      let rows = [""];
      let rowLength = 0;
      for (let index = 0; index < words.length; index++) {
        const word = words[index];
        if (options.trim !== false) {
          const row = rows.at(-1) ?? "";
          const trimmed = row.trimStart();
          if (row.length !== trimmed.length) {
            rows[rows.length - 1] = trimmed;
            rowLength = dist_default2(trimmed);
          }
        }
        if (index !== 0) {
          if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
            rows.push("");
            rowLength = 0;
          }
          if (rowLength || options.trim === false) {
            rows[rows.length - 1] += " ";
            rowLength++;
          }
        }
        const wordLength = dist_default2(word);
        if (options.hard && wordLength > columns) {
          const remainingColumns = columns - rowLength;
          const breaksStartingThisLine = 1 + Math.floor((wordLength - remainingColumns - 1) / columns);
          const breaksStartingNextLine = Math.floor((wordLength - 1) / columns);
          if (breaksStartingNextLine < breaksStartingThisLine) {
            rows.push("");
          }
          wrapWord(rows, word, columns);
          rowLength = dist_default2(rows.at(-1) ?? "");
          continue;
        }
        if (rowLength + wordLength > columns && rowLength && wordLength) {
          if (options.wordWrap === false && rowLength < columns) {
            wrapWord(rows, word, columns);
            rowLength = dist_default2(rows.at(-1) ?? "");
            continue;
          }
          rows.push("");
          rowLength = 0;
        }
        if (rowLength + wordLength > columns && options.wordWrap === false) {
          wrapWord(rows, word, columns);
          rowLength = dist_default2(rows.at(-1) ?? "");
          continue;
        }
        rows[rows.length - 1] += word;
        rowLength += wordLength;
      }
      if (options.trim !== false) {
        rows = rows.map((row) => stringVisibleTrimSpacesRight(row));
      }
      const preString = rows.join("\n");
      let inSurrogate = false;
      for (let i2 = 0; i2 < preString.length; i2++) {
        const character = preString[i2];
        returnValue += character;
        if (!inSurrogate) {
          inSurrogate = character >= "\uD800" && character <= "\uDBFF";
          if (inSurrogate) {
            continue;
          }
        } else {
          inSurrogate = false;
        }
        if (character === ESC || character === CSI) {
          GROUP_REGEX.lastIndex = i2 + 1;
          const groupsResult = GROUP_REGEX.exec(preString);
          const groups = groupsResult?.groups;
          if (groups?.code !== void 0) {
            const code = Number.parseFloat(groups.code);
            escapeCode = code === END_CODE ? void 0 : code;
          } else if (groups?.uri !== void 0) {
            escapeUrl = groups.uri.length === 0 ? void 0 : groups.uri;
          }
        }
        if (preString[i2 + 1] === "\n") {
          if (escapeUrl) {
            returnValue += wrapAnsiHyperlink("");
          }
          const closingCode = escapeCode ? getClosingCode(escapeCode) : void 0;
          if (escapeCode && closingCode) {
            returnValue += wrapAnsiCode(closingCode);
          }
        } else if (character === "\n") {
          if (escapeCode && getClosingCode(escapeCode)) {
            returnValue += wrapAnsiCode(escapeCode);
          }
          if (escapeUrl) {
            returnValue += wrapAnsiHyperlink(escapeUrl);
          }
        }
      }
      return returnValue;
    };
    CRLF_OR_LF = /\r?\n/;
  }
});

// node_modules/sisteransi/src/index.js
var require_src = __commonJS({
  "node_modules/sisteransi/src/index.js"(exports, module) {
    "use strict";
    var ESC2 = "\x1B";
    var CSI2 = `${ESC2}[`;
    var beep = "\x07";
    var cursor3 = {
      to(x, y2) {
        if (!y2) return `${CSI2}${x + 1}G`;
        return `${CSI2}${y2 + 1};${x + 1}H`;
      },
      move(x, y2) {
        let ret = "";
        if (x < 0) ret += `${CSI2}${-x}D`;
        else if (x > 0) ret += `${CSI2}${x}C`;
        if (y2 < 0) ret += `${CSI2}${-y2}A`;
        else if (y2 > 0) ret += `${CSI2}${y2}B`;
        return ret;
      },
      up: (count = 1) => `${CSI2}${count}A`,
      down: (count = 1) => `${CSI2}${count}B`,
      forward: (count = 1) => `${CSI2}${count}C`,
      backward: (count = 1) => `${CSI2}${count}D`,
      nextLine: (count = 1) => `${CSI2}E`.repeat(count),
      prevLine: (count = 1) => `${CSI2}F`.repeat(count),
      left: `${CSI2}G`,
      hide: `${CSI2}?25l`,
      show: `${CSI2}?25h`,
      save: `${ESC2}7`,
      restore: `${ESC2}8`
    };
    var scroll = {
      up: (count = 1) => `${CSI2}S`.repeat(count),
      down: (count = 1) => `${CSI2}T`.repeat(count)
    };
    var erase3 = {
      screen: `${CSI2}2J`,
      up: (count = 1) => `${CSI2}1J`.repeat(count),
      down: (count = 1) => `${CSI2}J`.repeat(count),
      line: `${CSI2}2K`,
      lineEnd: `${CSI2}K`,
      lineStart: `${CSI2}1K`,
      lines(count) {
        let clear = "";
        for (let i2 = 0; i2 < count; i2++)
          clear += this.line + (i2 < count - 1 ? cursor3.up() : "");
        if (count)
          clear += cursor3.left;
        return clear;
      }
    };
    module.exports = { cursor: cursor3, scroll, erase: erase3, beep };
  }
});

// node_modules/@clack/core/dist/index.mjs
import { styleText } from "node:util";
import { stdout, stdin } from "node:process";
import * as l from "node:readline";
import l__default from "node:readline";
import { ReadStream } from "node:tty";
function findCursor(s, o, l2) {
  if (!l2.some((r2) => !r2.disabled))
    return s;
  const t2 = s + o, n3 = Math.max(l2.length - 1, 0), e = t2 < 0 ? n3 : t2 > n3 ? 0 : t2;
  return l2[e]?.disabled ? findCursor(e, o < 0 ? -1 : 1, l2) : e;
}
function isAccessible(n3) {
  if (n3 !== void 0) return n3;
  if (settings.accessible !== void 0) return settings.accessible;
  const e = process.env.ACCESSIBLE;
  return e !== void 0 && e !== "" && e !== "0" && e !== "false";
}
function isActionKey(n3, e) {
  if (typeof n3 == "string")
    return settings.aliases.get(n3) === e;
  for (const s of n3)
    if (s !== void 0 && isActionKey(s, e))
      return true;
  return false;
}
function diffLines(i2, s) {
  if (i2 === s) return;
  const e = i2.split(`
`), t2 = s.split(`
`), r2 = Math.max(e.length, t2.length), f = [];
  for (let n3 = 0; n3 < r2; n3++)
    e[n3] !== t2[n3] && f.push(n3);
  return {
    lines: f,
    numLinesBefore: e.length,
    numLinesAfter: t2.length,
    numLines: r2
  };
}
function isCancel(e) {
  return e === CANCEL_SYMBOL;
}
function setRawMode(e, r2) {
  const o = e;
  o.isTTY && o.setRawMode(r2);
}
function block({
  input: e = stdin,
  output: r2 = stdout,
  overwrite: o = true,
  hideCursor: n3 = true
} = {}) {
  const s = l.createInterface({
    input: e,
    output: r2,
    prompt: "",
    tabSize: 1
  });
  l.emitKeypressEvents(e, s), e instanceof ReadStream && e.isTTY && e.setRawMode(true);
  const t2 = (f, { name: a2, sequence: w }) => {
    const c2 = String(f);
    if (isActionKey([c2, a2, w], "cancel")) {
      n3 && r2.write(import_sisteransi.cursor.show), process.exit(0);
      return;
    }
    if (!o) return;
    const i2 = a2 === "return" ? 0 : -1, m2 = a2 === "return" ? -1 : 0;
    l.moveCursor(r2, i2, m2, () => {
      l.clearLine(r2, 1, () => {
        e.once("keypress", t2);
      });
    });
  };
  return n3 && r2.write(import_sisteransi.cursor.hide), e.once("keypress", t2), () => {
    e.off("keypress", t2), n3 && r2.write(import_sisteransi.cursor.show), e instanceof ReadStream && e.isTTY && !R && e.setRawMode(false), s.terminal = false, s.close();
  };
}
function wrapTextWithPrefix(e, r2, o, n3 = o, s = o, t2) {
  const f = getColumns(e ?? stdout);
  return wrapAnsi(r2, f - o.length, {
    hard: true,
    trim: false
  }).split(`
`).map((c2, i2, m2) => {
    const d = t2 ? t2(c2, i2) : c2;
    return i2 === 0 ? `${n3}${d}` : i2 === m2.length - 1 ? `${s}${d}` : `${o}${d}`;
  }).join(`
`);
}
function runValidation(e, a2) {
  if ("~standard" in e) {
    const n3 = e["~standard"].validate(a2);
    return n3 instanceof Promise ? n3.then((r2) => r2.issues?.at(0)?.message) : n3.issues?.at(0)?.message;
  }
  return e(a2);
}
var import_sisteransi, a$1, t, settings, R, CANCEL_SYMBOL, getColumns, getRows, y, r, a, n$1, n2;
var init_dist3 = __esm({
  "node_modules/@clack/core/dist/index.mjs"() {
    init_main2();
    import_sisteransi = __toESM(require_src(), 1);
    a$1 = ["up", "down", "left", "right", "space", "enter", "cancel"];
    t = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];
    settings = {
      actions: new Set(a$1),
      aliases: /* @__PURE__ */ new Map([
        // vim support
        ["k", "up"],
        ["j", "down"],
        ["h", "left"],
        ["l", "right"],
        ["", "cancel"],
        // opinionated defaults!
        ["escape", "cancel"]
      ]),
      messages: {
        cancel: "Canceled",
        error: "Something went wrong"
      },
      withGuide: true,
      accessible: void 0,
      date: {
        monthNames: [...t],
        messages: {
          required: "Please enter a valid date",
          invalidMonth: "There are only 12 months in a year",
          invalidDay: (n3, e) => `There are only ${n3} days in ${e}`,
          afterMin: (n3) => `Date must be on or after ${n3.toISOString().slice(0, 10)}`,
          beforeMax: (n3) => `Date must be on or before ${n3.toISOString().slice(0, 10)}`
        }
      }
    };
    R = globalThis.process.platform.startsWith("win");
    CANCEL_SYMBOL = /* @__PURE__ */ Symbol("clack:cancel");
    getColumns = (e) => "columns" in e && typeof e.columns == "number" ? e.columns : 80;
    getRows = (e) => "rows" in e && typeof e.rows == "number" ? e.rows : 20;
    y = class {
      input;
      output;
      _abortSignal;
      rl;
      opts;
      _render;
      _track = false;
      _prevFrame = "";
      _subscribers = /* @__PURE__ */ new Map();
      _cursor = 0;
      state = "initial";
      error = "";
      value;
      userInput = "";
      /**
       * Whether accessible (static, screen-reader friendly) output is enabled for
       * this prompt, resolved from the `accessible` option, the global setting,
       * and the `ACCESSIBLE` env var.
       */
      get accessible() {
        return isAccessible(this.opts.accessible);
      }
      constructor(t2, e = true) {
        const { input: i2 = stdin, output: s = stdout, render: r2, signal: n3, ...o } = t2;
        this.opts = o, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = r2.bind(this), this._track = e, this._abortSignal = n3, this.input = i2, this.output = s;
      }
      /**
       * Unsubscribe all listeners
       */
      unsubscribe() {
        this._subscribers.clear();
      }
      /**
       * Set a subscriber with opts
       * @param event - The event name
       */
      setSubscriber(t2, e) {
        const i2 = this._subscribers.get(t2) ?? [];
        i2.push(e), this._subscribers.set(t2, i2);
      }
      /**
       * Subscribe to an event
       * @param event - The event name
       * @param cb - The callback
       */
      on(t2, e) {
        this.setSubscriber(t2, { cb: e });
      }
      /**
       * Subscribe to an event once
       * @param event - The event name
       * @param cb - The callback
       */
      once(t2, e) {
        this.setSubscriber(t2, { cb: e, once: true });
      }
      /**
       * Emit an event with data
       * @param event - The event name
       * @param data - The data to pass to the callback
       */
      emit(t2, ...e) {
        const i2 = this._subscribers.get(t2) ?? [], s = [];
        for (const r2 of i2)
          r2.cb(...e), r2.once && s.push(() => i2.splice(i2.indexOf(r2), 1));
        for (const r2 of s)
          r2();
      }
      prompt() {
        return new Promise((t2) => {
          if (this._abortSignal) {
            if (this._abortSignal.aborted)
              return this.state = "cancel", this.close(), t2(CANCEL_SYMBOL);
            this._abortSignal.addEventListener(
              "abort",
              () => {
                this.state = "cancel", this.close();
              },
              { once: true }
            );
          }
          this.rl = l__default.createInterface({
            input: this.input,
            tabSize: 2,
            prompt: "",
            escapeCodeTimeout: 50,
            terminal: true
          }), this.rl.prompt(), this.opts.initialUserInput !== void 0 && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), setRawMode(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
            this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), setRawMode(this.input, false), t2(this.value);
          }), this.once("cancel", () => {
            this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), setRawMode(this.input, false), t2(CANCEL_SYMBOL);
          });
        });
      }
      _isActionKey(t2, e) {
        return t2 === "	";
      }
      _shouldSubmit(t2, e) {
        return true;
      }
      _setValue(t2) {
        this.value = t2, this.emit("value", this.value);
      }
      _setUserInput(t2, e) {
        this.userInput = t2 ?? "", this.emit("userInput", this.userInput), e && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
      }
      _clearUserInput() {
        this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
      }
      async onKeypress(t2, e) {
        if (this.state !== "validating") {
          if (this._track && e.name !== "return" && (e.name && this._isActionKey(t2, e) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), e?.name && (!this._track && settings.aliases.has(e.name) && this.emit("cursor", settings.aliases.get(e.name)), settings.actions.has(e.name) && this.emit("cursor", e.name)), t2 && (t2.toLowerCase() === "y" || t2.toLowerCase() === "n") && this.emit("confirm", t2.toLowerCase() === "y"), this.emit("key", t2, e), e?.name === "return" && this._shouldSubmit(t2, e)) {
            if (this.opts.validate) {
              const i2 = runValidation(this.opts.validate, this.value);
              let s;
              i2 instanceof Promise ? (this.state = "validating", this.render(), s = await i2) : s = i2, s && (this.error = s instanceof Error ? s.message : s, this.state = "error", this.rl?.write(this.userInput));
            }
            this.state !== "error" && (this.state = "submit");
          }
          isActionKey([t2, e?.name, e?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
        }
      }
      close() {
        this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), setRawMode(this.input, false), this.rl?.close(), this.rl = void 0, this.emit(`${this.state}`, this.value), this.unsubscribe();
      }
      restoreCursor() {
        const t2 = wrapAnsi(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
        this.output.write(import_sisteransi.cursor.move(-999, t2 * -1));
      }
      render() {
        const t2 = wrapAnsi(this._render(this) ?? "", process.stdout.columns, {
          hard: true,
          trim: false
        });
        if (t2 !== this._prevFrame) {
          if (this.state === "initial")
            this.output.write(import_sisteransi.cursor.hide);
          else {
            const e = diffLines(this._prevFrame, t2), i2 = getRows(this.output);
            if (this.restoreCursor(), e) {
              const s = Math.max(0, e.numLinesAfter - i2), r2 = Math.max(0, e.numLinesBefore - i2);
              let n3 = e.lines.find((o) => o >= s);
              if (n3 === void 0) {
                this._prevFrame = t2;
                return;
              }
              if (e.lines.length === 1) {
                this.output.write(import_sisteransi.cursor.move(0, n3 - r2)), this.output.write(import_sisteransi.erase.lines(1));
                const o = t2.split(`
`);
                this.output.write(o[n3]), this._prevFrame = t2, this.output.write(import_sisteransi.cursor.move(0, o.length - n3 - 1));
                return;
              } else if (e.lines.length > 1) {
                if (s < r2)
                  n3 = s;
                else {
                  const h2 = n3 - r2;
                  h2 > 0 && this.output.write(import_sisteransi.cursor.move(0, h2));
                }
                this.output.write(import_sisteransi.erase.down());
                const f = t2.split(`
`).slice(n3);
                this.output.write(f.join(`
`)), this._prevFrame = t2;
                return;
              }
            }
            this.output.write(import_sisteransi.erase.down());
          }
          this.output.write(t2), this.state === "initial" && (this.state = "active"), this._prevFrame = t2;
        }
      }
    };
    r = class extends y {
      get cursor() {
        return this.value ? 0 : 1;
      }
      get _value() {
        return this.cursor === 0;
      }
      constructor(t2) {
        super(t2, false), this.value = !!t2.initialValue, this.on("userInput", () => {
          this.value = this._value;
        }), this.on("confirm", (i2) => {
          this.output.write(import_sisteransi.cursor.move(0, -1)), this.value = i2, this.state = "submit", this.close();
        }), this.on("cursor", () => {
          this.value = !this.value;
        });
      }
    };
    a = class extends y {
      options;
      cursor = 0;
      get _value() {
        return this.options[this.cursor]?.value;
      }
      get _enabledOptions() {
        return this.options.filter((e) => e.disabled !== true);
      }
      toggleAll() {
        const e = this._enabledOptions, i2 = this.value !== void 0 && this.value.length === e.length;
        this.value = i2 ? [] : e.map((t2) => t2.value);
      }
      toggleInvert() {
        const e = this.value;
        if (!e)
          return;
        const i2 = this._enabledOptions.filter((t2) => !e.includes(t2.value));
        this.value = i2.map((t2) => t2.value);
      }
      toggleValue() {
        this.value === void 0 && (this.value = []);
        const e = this.value.includes(this._value);
        this.value = e ? this.value.filter((i2) => i2 !== this._value) : [...this.value, this._value];
      }
      constructor(e) {
        super(e, false), this.options = e.options, this.value = [...e.initialValues ?? []];
        const i2 = Math.max(
          this.options.findIndex(({ value: t2 }) => t2 === e.cursorAt),
          0
        );
        this.cursor = this.options[i2]?.disabled ? findCursor(i2, 1, this.options) : i2, this.on("key", (t2, l2) => {
          l2.name === "a" && this.toggleAll(), l2.name === "i" && this.toggleInvert();
        }), this.on("cursor", (t2) => {
          switch (t2) {
            case "left":
            case "up":
              this.cursor = findCursor(this.cursor, -1, this.options);
              break;
            case "down":
            case "right":
              this.cursor = findCursor(this.cursor, 1, this.options);
              break;
            case "space":
              this.toggleValue();
              break;
          }
        });
      }
    };
    n$1 = class n extends y {
      options;
      cursor = 0;
      get _selectedValue() {
        return this.options[this.cursor];
      }
      changeValue() {
        const e = this._selectedValue;
        this.value = e === void 0 ? void 0 : e.value;
      }
      constructor(e) {
        super(e, false), this.options = e.options;
        const o = this.options.findIndex(({ value: s }) => s === e.initialValue), t2 = o === -1 ? 0 : o;
        this.cursor = this.options[t2]?.disabled ? findCursor(t2, 1, this.options) : t2, this.changeValue(), this.on("cursor", (s) => {
          switch (s) {
            case "left":
            case "up":
              this.cursor = findCursor(this.cursor, -1, this.options);
              break;
            case "down":
            case "right":
              this.cursor = findCursor(this.cursor, 1, this.options);
              break;
          }
          this.changeValue();
        });
      }
    };
    n2 = class extends y {
      get userInputWithCursor() {
        if (this.state === "submit")
          return this.userInput;
        const t2 = this.userInput;
        if (this.cursor >= t2.length)
          return `${this.userInput}\u2588`;
        const r2 = t2.slice(0, this.cursor), s = t2.slice(this.cursor, this.cursor + 1), e = t2.slice(this.cursor + 1);
        return `${r2}${styleText("inverse", s)}${e}`;
      }
      get cursor() {
        return this._cursor;
      }
      constructor(t2) {
        super({
          ...t2,
          initialUserInput: t2.initialUserInput ?? t2.initialValue
        }), this.on("userInput", (r2) => {
          this._setValue(r2);
        }), this.on("finalize", () => {
          this.value || (this.value = t2.defaultValue), this.value === void 0 && (this.value = "");
        });
      }
    };
  }
});

// node_modules/@clack/prompts/dist/index.mjs
import { styleText as styleText2, stripVTControlCharacters } from "node:util";
import process$1 from "node:process";
function isUnicodeSupported() {
  if (process$1.platform !== "win32") {
    return process$1.env.TERM !== "linux";
  }
  return Boolean(process$1.env.CI) || Boolean(process$1.env.WT_SESSION) || Boolean(process$1.env.TERMINUS_SUBLIME) || process$1.env.ConEmuTask === "{cmd::Cmder}" || process$1.env.TERM_PROGRAM === "Terminus-Sublime" || process$1.env.TERM_PROGRAM === "vscode" || process$1.env.TERM === "xterm-256color" || process$1.env.TERM === "alacritty" || process$1.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
function formatInstructionFooter(o, e) {
  const r2 = [`${e ? `${styleText2("cyan", S_BAR)}  ` : ""}${o.join(" \u2022 ")}`];
  return e && r2.push(styleText2("cyan", S_BAR_END)), r2;
}
var import_sisteransi2, unicode, isCI, unicodeOr, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, S_BAR_START, S_BAR, S_BAR_END, S_BAR_START_RIGHT, S_BAR_END_RIGHT, S_RADIO_ACTIVE, S_RADIO_INACTIVE, S_CHECKBOX_ACTIVE, S_CHECKBOX_SELECTED, S_CHECKBOX_INACTIVE, S_PASSWORD_MASK, S_BAR_H, S_CORNER_TOP_RIGHT, S_CONNECT_LEFT, S_CORNER_BOTTOM_RIGHT, S_CORNER_BOTTOM_LEFT, S_CORNER_TOP_LEFT, S_INFO, S_SUCCESS, S_WARN, S_ERROR, symbol2, symbolBar, I, limitOptions, confirm, MULTISELECT_INSTRUCTIONS, m, multiselect, intro, outro, W$1, C, note, W, spinner, u2, SELECT_INSTRUCTIONS, c, select, i, text2;
var init_dist4 = __esm({
  "node_modules/@clack/prompts/dist/index.mjs"() {
    init_dist3();
    init_dist3();
    init_main2();
    init_dist2();
    import_sisteransi2 = __toESM(require_src(), 1);
    unicode = isUnicodeSupported();
    isCI = () => process.env.CI === "true";
    unicodeOr = (o, e) => unicode ? o : e;
    S_STEP_ACTIVE = unicodeOr("\u25C6", "*");
    S_STEP_CANCEL = unicodeOr("\u25A0", "x");
    S_STEP_ERROR = unicodeOr("\u25B2", "x");
    S_STEP_SUBMIT = unicodeOr("\u25C7", "o");
    S_BAR_START = unicodeOr("\u250C", "T");
    S_BAR = unicodeOr("\u2502", "|");
    S_BAR_END = unicodeOr("\u2514", "\u2014");
    S_BAR_START_RIGHT = unicodeOr("\u2510", "T");
    S_BAR_END_RIGHT = unicodeOr("\u2518", "\u2014");
    S_RADIO_ACTIVE = unicodeOr("\u25CF", ">");
    S_RADIO_INACTIVE = unicodeOr("\u25CB", " ");
    S_CHECKBOX_ACTIVE = unicodeOr("\u25FB", "[\u2022]");
    S_CHECKBOX_SELECTED = unicodeOr("\u25FC", "[+]");
    S_CHECKBOX_INACTIVE = unicodeOr("\u25FB", "[ ]");
    S_PASSWORD_MASK = unicodeOr("\u25AA", "\u2022");
    S_BAR_H = unicodeOr("\u2500", "-");
    S_CORNER_TOP_RIGHT = unicodeOr("\u256E", "+");
    S_CONNECT_LEFT = unicodeOr("\u251C", "+");
    S_CORNER_BOTTOM_RIGHT = unicodeOr("\u256F", "+");
    S_CORNER_BOTTOM_LEFT = unicodeOr("\u2570", "+");
    S_CORNER_TOP_LEFT = unicodeOr("\u256D", "+");
    S_INFO = unicodeOr("\u25CF", "\u2022");
    S_SUCCESS = unicodeOr("\u25C6", "*");
    S_WARN = unicodeOr("\u25B2", "!");
    S_ERROR = unicodeOr("\u25A0", "x");
    symbol2 = (o) => {
      switch (o) {
        case "initial":
        case "active":
          return styleText2("cyan", S_STEP_ACTIVE);
        case "cancel":
          return styleText2("red", S_STEP_CANCEL);
        case "error":
          return styleText2("yellow", S_STEP_ERROR);
        case "submit":
          return styleText2("green", S_STEP_SUBMIT);
        case "validating":
          return styleText2("dim", S_STEP_ACTIVE);
      }
    };
    symbolBar = (o) => {
      switch (o) {
        case "initial":
        case "active":
          return styleText2("cyan", S_BAR);
        case "cancel":
          return styleText2("red", S_BAR);
        case "error":
          return styleText2("yellow", S_BAR);
        case "submit":
          return styleText2("green", S_BAR);
      }
    };
    I = (l2, e, w, p, b, C2 = false) => {
      let r2 = e, O = 0;
      if (C2)
        for (let i2 = p - 1; i2 >= w; i2--) {
          const m2 = l2[i2];
          if (m2 && (r2 -= m2.length), O++, r2 <= b) break;
        }
      else
        for (let i2 = w; i2 < p; i2++) {
          const m2 = l2[i2];
          if (m2 && (r2 -= m2.length), O++, r2 <= b) break;
        }
      return { lineCount: r2, removals: O };
    };
    limitOptions = ({
      cursor: l2,
      options: e,
      style: w,
      output: p = process.stdout,
      maxItems: b = Number.POSITIVE_INFINITY,
      columnPadding: C2 = 0,
      rowPadding: r2 = 4
    }) => {
      const i2 = getColumns(p) - C2, m2 = getRows(p), M = styleText2("dim", "..."), v = Math.max(m2 - r2, 0), a2 = Math.max(Math.min(b, v), 5);
      let f = 0;
      l2 >= a2 - 3 && (f = Math.max(
        Math.min(l2 - a2 + 3, e.length - a2),
        0
      ));
      let d = a2 < e.length && f > 0, c2 = a2 < e.length && f + a2 < e.length;
      const W2 = Math.min(
        f + a2,
        e.length
      ), s = [];
      let g = 0;
      d && g++, c2 && g++;
      const T = f + (d ? 1 : 0), y2 = W2 - (c2 ? 1 : 0);
      for (let t2 = T; t2 < y2; t2++) {
        const n3 = e[t2], o = n3 ? w(n3, t2 === l2) : "", h2 = wrapAnsi(o, i2, {
          hard: true,
          trim: false
        }).split(`
`);
        s.push(h2), g += h2.length;
      }
      if (g > v) {
        let t2 = 0, n3 = 0, o = g;
        const h2 = l2 - T;
        let u3 = v;
        const L = () => I(s, o, 0, h2, u3), E = () => I(
          s,
          o,
          h2 + 1,
          s.length,
          u3,
          true
        );
        d ? ({ lineCount: o, removals: t2 } = L(), o > u3 && (c2 || (u3 -= 1), { lineCount: o, removals: n3 } = E())) : (c2 || (u3 -= 1), { lineCount: o, removals: n3 } = E(), o > u3 && (u3 -= 1, { lineCount: o, removals: t2 } = L())), t2 > 0 && (d = true, s.splice(0, t2)), n3 > 0 && (c2 = true, s.splice(s.length - n3, n3));
      }
      const x = [];
      d && x.push(M);
      for (const t2 of s)
        for (const n3 of t2)
          x.push(n3);
      return c2 && x.push(M), x;
    };
    confirm = (e) => {
      const a2 = e.active ?? "Yes", o = e.inactive ?? "No";
      return new r({
        active: a2,
        inactive: o,
        signal: e.signal,
        input: e.input,
        output: e.output,
        initialValue: e.initialValue ?? true,
        render() {
          const i2 = e.withGuide ?? settings.withGuide, u3 = `${symbol2(this.state)}  `, l2 = i2 ? `${styleText2("gray", S_BAR)}  ` : "", f = wrapTextWithPrefix(
            e.output,
            e.message,
            l2,
            u3
          ), s = `${i2 ? `${styleText2("gray", S_BAR)}
` : ""}${f}
`, c2 = this.value ? a2 : o;
          switch (this.state) {
            case "submit": {
              const r2 = i2 ? `${styleText2("gray", S_BAR)}  ` : "";
              return `${s}${r2}${styleText2("dim", c2)}`;
            }
            case "cancel": {
              const r2 = i2 ? `${styleText2("gray", S_BAR)}  ` : "";
              return `${s}${r2}${styleText2(["strikethrough", "dim"], c2)}${i2 ? `
${styleText2("gray", S_BAR)}` : ""}`;
            }
            default: {
              const r2 = i2 ? `${styleText2("cyan", S_BAR)}  ` : "", g = i2 ? styleText2("cyan", S_BAR_END) : "";
              return `${s}${r2}${this.value ? `${styleText2("green", S_RADIO_ACTIVE)} ${a2}` : `${styleText2("dim", S_RADIO_INACTIVE)} ${styleText2("dim", a2)}`}${e.vertical ? i2 ? `
${styleText2("cyan", S_BAR)}  ` : `
` : ` ${styleText2("dim", "/")} `}${this.value ? `${styleText2("dim", S_RADIO_INACTIVE)} ${styleText2("dim", o)}` : `${styleText2("green", S_RADIO_ACTIVE)} ${o}`}
${g}
`;
            }
          }
        }
      }).prompt();
    };
    MULTISELECT_INSTRUCTIONS = [
      `${styleText2("dim", "\u2191/\u2193")} to navigate`,
      `${styleText2("dim", "Space:")} select`,
      `${styleText2("dim", "Enter:")} confirm`
    ];
    m = (i2, u3) => i2.split(`
`).map((d) => u3(d)).join(`
`);
    multiselect = (i2) => {
      const u3 = (t2, a2) => {
        const r2 = t2.label ?? String(t2.value);
        return a2 === "disabled" ? `${styleText2("gray", S_CHECKBOX_INACTIVE)} ${m(r2, (o) => styleText2(["strikethrough", "gray"], o))}${t2.hint ? ` ${styleText2("dim", `(${t2.hint ?? "disabled"})`)}` : ""}` : a2 === "active" ? `${styleText2("cyan", S_CHECKBOX_ACTIVE)} ${r2}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}` : a2 === "selected" ? `${styleText2("green", S_CHECKBOX_SELECTED)} ${m(r2, (o) => styleText2("dim", o))}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}` : a2 === "cancelled" ? `${m(r2, (o) => styleText2(["strikethrough", "dim"], o))}` : a2 === "active-selected" ? `${styleText2("green", S_CHECKBOX_SELECTED)} ${r2}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}` : a2 === "submitted" ? `${m(r2, (o) => styleText2("dim", o))}` : `${styleText2("dim", S_CHECKBOX_INACTIVE)} ${m(r2, (o) => styleText2("dim", o))}`;
      }, d = i2.required ?? true, x = i2.showInstructions ?? true;
      return new a({
        options: i2.options,
        signal: i2.signal,
        input: i2.input,
        output: i2.output,
        initialValues: i2.initialValues,
        required: d,
        cursorAt: i2.cursorAt,
        validate(t2) {
          if (d && (t2 === void 0 || t2.length === 0))
            return `Please select at least one option.
${styleText2(
              "reset",
              styleText2(
                "dim",
                `Press ${styleText2(["gray", "bgWhite", "inverse"], " space ")} to select, ${styleText2(
                  "gray",
                  styleText2("bgWhite", styleText2("inverse", " enter "))
                )} to submit`
              )
            )}`;
        },
        render() {
          const t2 = i2.withGuide ?? settings.withGuide, a2 = wrapTextWithPrefix(
            i2.output,
            i2.message,
            t2 ? `${symbolBar(this.state)}  ` : "",
            `${symbol2(this.state)}  `
          ), r2 = `${t2 ? `${styleText2("gray", S_BAR)}
` : ""}${a2}
`, o = this.value ?? [], g = (n3, l2) => {
            if (n3.disabled)
              return u3(n3, "disabled");
            const s = o.includes(n3.value);
            return l2 && s ? u3(n3, "active-selected") : s ? u3(n3, "selected") : u3(n3, l2 ? "active" : "inactive");
          };
          switch (this.state) {
            case "submit": {
              const n3 = this.options.filter(({ value: s }) => o.includes(s)).map((s) => u3(s, "submitted")).join(styleText2("dim", ", ")) || styleText2("dim", "none"), l2 = wrapTextWithPrefix(
                i2.output,
                n3,
                t2 ? `${styleText2("gray", S_BAR)}  ` : ""
              );
              return `${r2}${l2}`;
            }
            case "cancel": {
              const n3 = this.options.filter(({ value: s }) => o.includes(s)).map((s) => u3(s, "cancelled")).join(styleText2("dim", ", "));
              if (n3.trim() === "")
                return `${r2}${styleText2("gray", S_BAR)}`;
              const l2 = wrapTextWithPrefix(
                i2.output,
                n3,
                t2 ? `${styleText2("gray", S_BAR)}  ` : ""
              );
              return `${r2}${l2}${t2 ? `
${styleText2("gray", S_BAR)}` : ""}`;
            }
            case "error": {
              const n3 = t2 ? `${styleText2("yellow", S_BAR)}  ` : "", l2 = this.error.split(`
`).map(
                ($, v) => v === 0 ? `${t2 ? `${styleText2("yellow", S_BAR_END)}  ` : ""}${styleText2("yellow", $)}` : `   ${$}`
              ).join(`
`), s = r2.split(`
`).length, h2 = l2.split(`
`).length + 1;
              return `${r2}${n3}${limitOptions({
                output: i2.output,
                options: this.options,
                cursor: this.cursor,
                maxItems: i2.maxItems,
                columnPadding: n3.length,
                rowPadding: s + h2,
                style: g
              }).join(`
${n3}`)}
${l2}
`;
            }
            default: {
              const n3 = t2 ? `${styleText2("cyan", S_BAR)}  ` : "", l2 = r2.split(`
`).length, s = x ? formatInstructionFooter(MULTISELECT_INSTRUCTIONS, t2) : t2 ? [styleText2("cyan", S_BAR_END)] : [], h2 = s.join(`
`), $ = s.length + 1;
              return `${r2}${n3}${limitOptions({
                output: i2.output,
                options: this.options,
                cursor: this.cursor,
                maxItems: i2.maxItems,
                columnPadding: n3.length,
                rowPadding: l2 + $,
                style: g
              }).join(`
${n3}`)}
${h2}
`;
            }
          }
        }
      }).prompt();
    };
    intro = (o = "", t2) => {
      const i2 = t2?.output ?? process.stdout, e = t2?.withGuide ?? settings.withGuide ? `${styleText2("gray", S_BAR_START)}  ` : "";
      i2.write(`${e}${o}
`);
    };
    outro = (o = "", t2) => {
      const i2 = t2?.output ?? process.stdout, e = t2?.withGuide ?? settings.withGuide ? `${styleText2("gray", S_BAR)}
${styleText2("gray", S_BAR_END)}  ` : "";
      i2.write(`${e}${o}

`);
    };
    W$1 = (o) => o;
    C = (o, e, s) => {
      const a2 = {
        hard: true,
        trim: false
      }, i2 = wrapAnsi(o, e, a2).split(`
`), c2 = i2.reduce((n3, t2) => Math.max(dist_default2(t2), n3), 0), u3 = i2.map(s).reduce((n3, t2) => Math.max(dist_default2(t2), n3), 0), g = e - (u3 - c2);
      return wrapAnsi(o, g, a2);
    };
    note = (o = "", e = "", s) => {
      const a2 = s?.output ?? process$1.stdout, i2 = s?.withGuide ?? settings.withGuide, c2 = s?.format ?? W$1, g = ["", ...C(o, getColumns(a2) - 6, c2).split(`
`).map(c2), ""], n3 = dist_default2(e), t2 = Math.max(
        g.reduce((m2, F) => {
          const O = dist_default2(F);
          return O > m2 ? O : m2;
        }, 0),
        n3
      ) + 2, h2 = g.map(
        (m2) => `${styleText2("gray", S_BAR)}  ${m2}${" ".repeat(t2 - dist_default2(m2))}${styleText2("gray", S_BAR)}`
      ).join(`
`), T = i2 ? `${styleText2("gray", S_BAR)}
` : "", l$1 = i2 ? S_CONNECT_LEFT : S_CORNER_BOTTOM_LEFT;
      a2.write(
        `${T}${styleText2("green", S_STEP_SUBMIT)}  ${styleText2("reset", e)} ${styleText2(
          "gray",
          S_BAR_H.repeat(Math.max(t2 - n3 - 1, 1)) + S_CORNER_TOP_RIGHT
        )}
${h2}
${styleText2("gray", l$1 + S_BAR_H.repeat(t2 + 2) + S_CORNER_BOTTOM_RIGHT)}
`
      );
    };
    W = (l2) => styleText2("magenta", l2);
    spinner = ({
      indicator: l2 = "dots",
      onCancel: h2,
      output: n3 = process.stdout,
      cancelMessage: G,
      errorMessage: O,
      frames: E = unicode ? ["\u25D2", "\u25D0", "\u25D3", "\u25D1"] : ["\u2022", "o", "O", "0"],
      delay: F = unicode ? 80 : 120,
      signal: m2,
      ...I2
    } = {}) => {
      const u3 = isCI();
      let M, T, d = false, S = false, s = "", p, w = performance.now();
      const x = getColumns(n3), k = I2?.styleFrame ?? W, g = (e) => {
        const r2 = e > 1 ? O ?? settings.messages.error : G ?? settings.messages.cancel;
        S = e === 1, d && (a2(r2, e), S && typeof h2 == "function" && h2());
      }, f = () => g(2), i2 = () => g(1), A = () => {
        process.on("uncaughtExceptionMonitor", f), process.on("unhandledRejection", f), process.on("SIGINT", i2), process.on("SIGTERM", i2), process.on("exit", g), m2 && m2.addEventListener("abort", i2);
      }, H = () => {
        process.removeListener("uncaughtExceptionMonitor", f), process.removeListener("unhandledRejection", f), process.removeListener("SIGINT", i2), process.removeListener("SIGTERM", i2), process.removeListener("exit", g), m2 && m2.removeEventListener("abort", i2);
      }, y2 = () => {
        if (p === void 0) return;
        u3 && n3.write(`
`);
        const r2 = wrapAnsi(p, x, {
          hard: true,
          trim: false
        }).split(`
`);
        r2.length > 1 && n3.write(import_sisteransi2.cursor.up(r2.length - 1)), n3.write(import_sisteransi2.cursor.to(0)), n3.write(import_sisteransi2.erase.down());
      }, C2 = (e) => e.replace(/\.+$/, ""), _ = (e) => {
        const r2 = (performance.now() - e) / 1e3, t2 = Math.floor(r2 / 60), o = Math.floor(r2 % 60);
        return t2 > 0 ? `[${t2}m ${o}s]` : `[${o}s]`;
      }, N = I2.withGuide ?? settings.withGuide, P = (e = "") => {
        d = true, M = block({ output: n3 }), s = C2(e), w = performance.now(), N && n3.write(`${styleText2("gray", S_BAR)}
`);
        let r2 = 0, t2 = 0;
        A(), T = setInterval(() => {
          if (u3 && s === p)
            return;
          y2(), p = s;
          const o = k(E[r2]);
          let v;
          if (u3)
            v = `${o}  ${s}...`;
          else if (l2 === "timer")
            v = `${o}  ${s} ${_(w)}`;
          else {
            const B = ".".repeat(Math.floor(t2)).slice(0, 3);
            v = `${o}  ${s}${B}`;
          }
          const j = wrapAnsi(v, x, {
            hard: true,
            trim: false
          });
          n3.write(j), r2 = r2 + 1 < E.length ? r2 + 1 : 0, t2 = t2 < 4 ? t2 + 0.125 : 0;
        }, F);
      }, a2 = (e = "", r2 = 0, t2 = false) => {
        if (!d) return;
        d = false, clearInterval(T), y2();
        const o = r2 === 0 ? styleText2("green", S_STEP_SUBMIT) : r2 === 1 ? styleText2("red", S_STEP_CANCEL) : styleText2("red", S_STEP_ERROR);
        s = e ?? s, t2 || (l2 === "timer" ? n3.write(`${o}  ${s} ${_(w)}
`) : n3.write(`${o}  ${s}
`)), H(), M();
      };
      return {
        start: P,
        stop: (e = "") => a2(e, 0),
        message: (e = "") => {
          s = C2(e ?? s);
        },
        cancel: (e = "") => a2(e, 1),
        error: (e = "") => a2(e, 2),
        clear: () => a2("", 0, true),
        get isCancelled() {
          return S;
        }
      };
    };
    u2 = {
      light: unicodeOr("\u2500", "-"),
      heavy: unicodeOr("\u2501", "="),
      block: unicodeOr("\u2588", "#")
    };
    SELECT_INSTRUCTIONS = [
      `${styleText2("dim", "\u2191/\u2193")} to navigate`,
      `${styleText2("dim", "Enter:")} confirm`
    ];
    c = (t2, o) => t2.includes(`
`) ? t2.split(`
`).map((d) => o(d)).join(`
`) : o(t2);
    select = (t2) => {
      const o = (n3, m2) => {
        if (n3 === void 0)
          return "";
        const s = n3.label ?? String(n3.value);
        switch (m2) {
          case "disabled":
            return `${styleText2("gray", S_RADIO_INACTIVE)} ${c(s, (i2) => styleText2("gray", i2))}${n3.hint ? ` ${styleText2("dim", `(${n3.hint ?? "disabled"})`)}` : ""}`;
          case "selected":
            return `${c(s, (i2) => styleText2("dim", i2))}`;
          case "active":
            return `${styleText2("green", S_RADIO_ACTIVE)} ${s}${n3.hint ? ` ${styleText2("dim", `(${n3.hint})`)}` : ""}`;
          case "cancelled":
            return `${c(s, (i2) => styleText2(["strikethrough", "dim"], i2))}`;
          default:
            return `${styleText2("dim", S_RADIO_INACTIVE)} ${c(s, (i2) => styleText2("dim", i2))}`;
        }
      }, d = t2.showInstructions ?? true;
      return new n$1({
        options: t2.options,
        signal: t2.signal,
        input: t2.input,
        output: t2.output,
        initialValue: t2.initialValue,
        render() {
          const n3 = t2.withGuide ?? settings.withGuide, m2 = `${symbol2(this.state)}  `, s = `${symbolBar(this.state)}  `, i2 = wrapTextWithPrefix(
            t2.output,
            t2.message,
            s,
            m2
          ), u3 = `${n3 ? `${styleText2("gray", S_BAR)}
` : ""}${i2}
`;
          switch (this.state) {
            case "submit": {
              const r2 = n3 ? `${styleText2("gray", S_BAR)}  ` : "", a2 = wrapTextWithPrefix(
                t2.output,
                o(this.options[this.cursor], "selected"),
                r2
              );
              return `${u3}${a2}`;
            }
            case "cancel": {
              const r2 = n3 ? `${styleText2("gray", S_BAR)}  ` : "", a2 = wrapTextWithPrefix(
                t2.output,
                o(this.options[this.cursor], "cancelled"),
                r2
              );
              return `${u3}${a2}${n3 ? `
${styleText2("gray", S_BAR)}` : ""}`;
            }
            default: {
              const r2 = n3 ? `${styleText2("cyan", S_BAR)}  ` : "", a2 = u3.split(`
`).length, p = d ? formatInstructionFooter(SELECT_INSTRUCTIONS, n3) : n3 ? [styleText2("cyan", S_BAR_END)] : [], f = p.join(`
`), b = p.length + 1;
              return `${u3}${r2}${limitOptions({
                output: t2.output,
                cursor: this.cursor,
                options: this.options,
                maxItems: t2.maxItems,
                columnPadding: r2.length,
                rowPadding: a2 + b,
                style: (g, x) => o(g, g.disabled ? "disabled" : x ? "active" : "inactive")
              }).join(`
${r2}`)}
${f}
`;
            }
          }
        }
      }).prompt();
    };
    i = `${styleText2("gray", S_BAR)}  `;
    text2 = (t2) => new n2({
      validate: t2.validate,
      placeholder: t2.placeholder,
      defaultValue: t2.defaultValue,
      initialValue: t2.initialValue,
      output: t2.output,
      signal: t2.signal,
      input: t2.input,
      render() {
        const r2 = t2?.withGuide ?? settings.withGuide, l2 = `${`${r2 ? `${styleText2("gray", S_BAR)}
` : ""}${symbol2(this.state)}  `}${t2.message}
`, d = t2.placeholder && t2.placeholder.length > 0 ? (
          // biome-ignore lint/style/noNonNullAssertion: guarded by placeholder.length > 0
          styleText2("inverse", t2.placeholder[0]) + styleText2("dim", t2.placeholder.slice(1))
        ) : styleText2(["inverse", "hidden"], "_"), o = this.userInput ? this.userInputWithCursor : d, s = this.value ?? "";
        switch (this.state) {
          case "validating": {
            const n3 = r2 ? `${styleText2("cyan", S_BAR)}  ` : "", i2 = r2 ? styleText2("cyan", S_BAR_END) : "", c2 = styleText2("dim", o), $ = styleText2("dim", "Validating...");
            return `${l2}${n3}${c2}
${i2}  ${$}
`;
          }
          case "error": {
            const n3 = this.error ? `  ${styleText2("yellow", this.error)}` : "", i2 = r2 ? `${styleText2("yellow", S_BAR)}  ` : "", c2 = r2 ? styleText2("yellow", S_BAR_END) : "";
            return `${l2.trim()}
${i2}${o}
${c2}${n3}
`;
          }
          case "submit": {
            const n3 = s ? `${r2 ? "  " : ""}${styleText2("dim", s)}` : "", i2 = r2 ? styleText2("gray", S_BAR) : "";
            return `${l2}${i2}${n3}`;
          }
          case "cancel": {
            const n3 = s ? `  ${styleText2(["strikethrough", "dim"], s)}` : "", i2 = r2 ? styleText2("gray", S_BAR) : "";
            return `${l2}${i2}${n3}${s.trim() ? `
${i2}` : ""}`;
          }
          default: {
            const n3 = r2 ? `${styleText2("cyan", S_BAR)}  ` : "", i2 = r2 ? styleText2("cyan", S_BAR_END) : "";
            return `${l2}${n3}${o}
${i2}
`;
          }
        }
      }
    }).prompt();
  }
});

// src/prompter-clack.ts
var prompter_clack_exports = {};
__export(prompter_clack_exports, {
  clackPrompter: () => clackPrompter
});
function wrap(value) {
  return isCancel(value) ? CANCEL : value;
}
function clackPrompter() {
  return {
    intro: (title) => intro(title),
    outro: (message) => outro(message),
    note: (body, title) => note(body, title),
    spinner: () => spinner(),
    confirm: async (o) => wrap(await confirm({ message: o.message, initialValue: o.initial })),
    select: async (o) => wrap(
      await select({
        message: o.message,
        options: o.options,
        initialValue: o.initial
      })
    ),
    text: async (o) => wrap(await text2({ message: o.message, initialValue: o.initial, validate: o.validate })),
    multiselect: async (o) => wrap(
      await multiselect({
        message: o.message,
        options: o.options,
        initialValues: o.initial,
        required: false
      })
    ),
    isCancel: (value) => value === CANCEL || isCancel(value)
  };
}
var init_prompter_clack = __esm({
  "src/prompter-clack.ts"() {
    init_dist4();
    init_types();
  }
});

// src/run.ts
var run_exports = {};
__export(run_exports, {
  main: () => main2
});
import { join as join35 } from "node:path";
import { existsSync as existsSync29 } from "node:fs";
function pickProfile(options, activeBefore, ready2, profiles, names, readOnly = false) {
  if (options.profile && options.profile !== "auto") {
    if (!names.includes(options.profile)) {
      throw new SetupError(`unknown profile '${options.profile}'. available: ${names.join(", ")}`);
    }
    return { name: options.profile, reason: "requested with --profile", provisional: false, source: "flag" };
  }
  if (options.profile !== "auto" && activeBefore && names.includes(activeBefore)) {
    return { name: activeBefore, reason: "keeping your active profile", provisional: false, source: "active" };
  }
  if (readOnly) {
    return { name: "balanced", reason: "provisional: the real install picks by logged-in providers", provisional: false, source: "chooser" };
  }
  return chooseProfile(ready2, profiles);
}
function requiredToolErrors(ctx, detection, options) {
  const needed = ["python3", ...options.skipNpm ? [] : ["npm"]];
  return needed.filter((tool) => !toolPath(detection, tool)).map((tool) => `${tool} is required but was not found on PATH; install it with: ${installHint(ctx.platform, tool)}`);
}
function extraRows(ctx, options, saved, detection, manifest) {
  const flags = flagMap(options);
  return (root) => {
    const detected = detectDefaults(ctx, detection, root);
    const initial = resolveComponents({ flags, saved: manifest?.components, current: currentState(ctx), detected, interactive: true });
    return COMPONENTS.map((def) => {
      const why = available(def.id, ctx);
      return {
        id: def.id,
        label: def.label,
        hint: hintFor(def, initial[def.id].on),
        initial: initial[def.id].on,
        unavailable: why === true ? void 0 : why,
        fixed: def.id in flags
      };
    });
  };
}
function savedPreapproval(ctx) {
  return preapprovalDefault(join35(ctx.home, ".local/share/pi-setup/lanes/templates"));
}
function resolveAll(ctx, options, detection, saved, answers, manifest) {
  const piDir = join35(ctx.home, ".pi", "agent");
  const settings2 = resolveSettings({
    flagUser: answers.user ?? options.user,
    flagRoot: answers.root ?? options.reposRoot,
    saved,
    detectedUser: detection.github.login,
    home: ctx.home,
    repoDir: ctx.repoDir
  });
  if (answers.user) settings2.userSource = answers.user === savedString2(saved, "githubUser") ? "saved" : "prompt";
  if (answers.root) settings2.rootSource = "prompt";
  const names = profileNames(ctx.repoDir);
  const profiles = loadProfiles(ctx.repoDir);
  const activeBefore = readActive(piDir);
  const ready2 = readyProviders(detection);
  const asked = answers.profile ? { ...options, profile: answers.profile } : options;
  const choice = pickProfile(asked, activeBefore, ready2, profiles, names, options.dryRun || options.plan);
  const profile2 = profiles.find((p) => p.name === choice.name);
  const components = resolveComponents({
    flags: flagMap(options),
    answers: answers.components,
    saved: manifest?.components,
    current: currentState(ctx),
    detected: detectDefaults(ctx, detection, settings2.reposRoot),
    interactive: Boolean(answers.components) || isInteractive(options, ctx.env, ctx.stdinTTY, ctx.stdoutTTY)
  });
  const componentNotes = [];
  const notes = [];
  for (const def of COMPONENTS) {
    const why = available(def.id, ctx);
    if (why === true) continue;
    if (components[def.id].on && components[def.id].source === "flag") notes.push(`warning: ${def.label} is not available here (${why})`);
    components[def.id] = { on: false, source: components[def.id].source };
  }
  const on = Object.fromEntries(Object.entries(components).map(([id, c2]) => [id, c2.on]));
  const built = reconcile(
    buildPlan({
      repoDir: ctx.repoDir,
      home: ctx.home,
      settings: settings2,
      overlay: overlayFor(ctx.repoDir, choice.name, settings2),
      components: on,
      which: ctx.which,
      notes,
      preapproveMcp: savedPreapproval(ctx) || options.preapproveMcp || answers.preapproveMcp === true,
      drop: on.web === false ? (manifest?.json[".pi/agent/settings.json"]?.ops ?? []).flatMap((o) => o.op === "array-add" && o.key === "packages" && WEB_PACKAGES.includes(o.value) ? [o.value] : []) : [],
      activate: COMPONENTS.map((c2) => c2.id).filter((id) => on[id] && !wasOn(manifest, currentState(ctx), id))
    }),
    manifest,
    ctx.home
  );
  const { conflicts } = built;
  const serviceOn = Object.fromEntries(Object.entries(on).filter(([id]) => isService(id)));
  const services = planServices(ctx, manifest, serviceOn);
  const actions = [...built.actions, ...services.actions];
  const records = { ...services.records };
  for (const def of COMPONENTS.filter((c2) => !c2.service)) records[def.id] = { on: on[def.id] };
  componentNotes.push(...notes, ...services.notes);
  if (on.codescene) componentNotes.push(...codesceneNotes(ctx));
  const kimi = options.dryRun || options.plan ? void 0 : kimiNote(profile2, ready2);
  const warnings = [
    ...settings2.warnings,
    ...componentNotes.filter((n3) => n3.startsWith("warning:")).map((n3) => n3.slice(9)),
    ...detection.warnings,
    ...pinWarnings(pinnedModels(join35(profilesDir(ctx.repoDir), choice.name)), ready2, detection.catalog),
    ...kimi ? [kimi] : []
  ];
  return { settings: settings2, choice, actions, warnings, profile: profile2, ready: ready2, activeBefore, piDir, npm: needsNpm(actions, piDir, manifest, options.reinstallNpm), conflicts, components, records, componentNotes: componentNotes.filter((n3) => !n3.startsWith("warning:")) };
}
function jsonReport(r2, detection, exitCode) {
  return JSON.stringify({
    settings: { ...r2.settings },
    detection: { ...detection, catalog: detection.catalog ? [...detection.catalog].sort() : null },
    profile: { name: r2.choice.name, reason: r2.choice.reason, provisional: r2.choice.provisional, source: r2.choice.source },
    actions: r2.actions.filter((a2) => a2.op !== "adopt").map((a2) => ({ op: a2.op, path: a2.path })),
    warnings: r2.warnings,
    exitCode
  });
}
async function main2(argv, baseCtx, injected) {
  const parsed = parseArgs(argv, baseCtx.cwd);
  if (!parsed.ok) {
    baseCtx.err(parsed.error);
    return (argv[0] === "install" ? argv[1] : argv[0]) === "doctor" ? 2 : 1;
  }
  const options = parsed.options;
  if (options.help) {
    baseCtx.out(USAGE);
    return 0;
  }
  const interactive = isInteractive(options, baseCtx.env, baseCtx.stdinTTY, baseCtx.stdoutTTY);
  const ctx = options.json ? { ...baseCtx, out: baseCtx.err } : baseCtx;
  let prompter = injected;
  if (interactive && !prompter) prompter = (await Promise.resolve().then(() => (init_prompter_clack(), prompter_clack_exports))).clackPrompter();
  try {
    if (options.command !== "install") return await runCommand(ctx, options, interactive ? prompter : void 0, baseCtx);
    return await execute(ctx, options, interactive ? prompter : void 0, baseCtx);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    ctx.err(error.message.startsWith("pi-setup:") || error.message.startsWith("Missing value") ? error.message : `pi-setup: ${error.message}`);
    return options.command === "doctor" ? 2 : 1;
  }
}
async function runCommand(ctx, options, prompter, baseCtx) {
  if (options.command === "lanes") return runLanesFlow(ctx, options, prompter);
  if (options.command === "doctor") return runDoctor(ctx, options, baseCtx);
  if (options.command === "uninstall") return runUninstall(ctx, options, prompter);
  if (options.command === "update") return runUpdate(ctx, options, prompter);
  return backupsCommand(ctx, options.sub, options.keep, options.dryRun);
}
async function execute(ctx, options, prompter, baseCtx) {
  const piDir = join35(ctx.home, ".pi", "agent");
  const saved = readSettings(join35(piDir, "user.json"));
  const manifest = readManifest(piDir);
  const readOnly = options.dryRun || options.plan;
  const names = profileNames(ctx.repoDir);
  if (options.profile && options.profile !== "auto" && !names.includes(options.profile)) {
    throw new SetupError(`unknown profile '${options.profile}'. available: ${names.join(", ")}`);
  }
  prompter?.intro("pi-setup");
  const spin = prompter?.spinner();
  spin?.start("Looking around\u2026");
  const known = Boolean(options.user || savedString2(saved, "githubUser"));
  const knownRoot = Boolean(options.reposRoot || savedString2(saved, "reposRoot"));
  const detection = await detect(ctx, {
    needLogin: !known,
    wantGithubDetails: Boolean(prompter),
    needScan: Boolean(prompter) || !knownRoot,
    probePi: !readOnly,
    login: options.user || savedString2(saved, "githubUser") || void 0
  });
  spin?.stop("Looked around");
  const toolErrors = requiredToolErrors(ctx, detection, options);
  if (toolErrors.length && !readOnly) throw new SetupError(toolErrors.join("\n"));
  let answers = {};
  if (prompter) {
    const profiles = loadProfiles(ctx.repoDir);
    const activeBefore = readActive(piDir);
    const initial = pickProfile(options, activeBefore, readyProviders(detection), profiles, names);
    const result3 = await collectChoices(prompter, {
      options,
      saved,
      detection,
      profiles,
      initial,
      home: ctx.home,
      repoDir: ctx.repoDir,
      extras: extraRows(ctx, options, saved, detection, manifest),
      preapproveMcp: savedPreapproval(ctx)
    });
    if (result3 === CANCEL) return cancelled(ctx);
    answers = result3;
  }
  const r2 = resolveAll(ctx, options, detection, saved, answers, manifest);
  if (prompter && r2.conflicts.length) {
    const takes = await resolveConflicts(prompter, r2.conflicts, (c2) => diffText(ctx, c2));
    if (takes === CANCEL) return cancelled(ctx);
    r2.actions = applyTakes(r2.actions, takes);
  }
  const better = detection.candidates[0]?.path;
  if (!prompter && r2.settings.rootSource === "default" && better && better !== r2.settings.reposRoot) {
    ctx.out(`pi-setup: repos root defaulted to ~/repos; detected ${better}; pass --repos-root ${better} to use it`);
  }
  r2.warnings.push(...toolErrors.map((e) => e));
  if (!toolPath(detection, "pi")) r2.warnings.push(`pi was not found on PATH; install it with: ${installHint(ctx.platform, "pi")}`);
  const summary = summaryLines({ ...r2, detection, kimi: readOnly ? void 0 : kimiNote(r2.profile, r2.ready), skipNpm: options.skipNpm, probed: !readOnly, components: r2.components, componentNotes: r2.componentNotes });
  if (options.plan) return finish(ctx, baseCtx, options, r2, detection, summary, 0);
  if (prompter && !await confirmApply(prompter, summary)) return cancelled(ctx);
  const applyOptions = {
    dryRun: options.dryRun,
    skipNpm: options.skipNpm || options.dryRun,
    reinstallNpm: options.reinstallNpm,
    inheritNpm: !prompter && !options.json,
    profile: r2.choice.name,
    activeBefore: r2.activeBefore,
    spinner: prompter?.spinner(),
    components: r2.records
  };
  const off = COMPONENTS.map((c2) => c2.id).filter((id) => !r2.components[id].on && wasOn(manifest, currentState(ctx), id));
  const live = await retire(ctx, piDir, manifest, off, options.dryRun);
  const result2 = await apply(ctx, r2.actions, applyOptions, live);
  if (result2.code === 0) await syncServices(ctx, r2.records, new Set(r2.actions.filter((a2) => a2.op === "install").map((a2) => a2.path)), options.dryRun);
  const shown = prompter || options.json ? [] : summary.filter((l2) => l2.startsWith("Profile:") || l2.startsWith("Kimi") || l2.startsWith("warning:") || l2 === KEPT_EDITS || l2.startsWith("AGENTS.md has no") || r2.componentNotes.includes(l2));
  if (result2.code === 0 && !options.dryRun && !options.plan && !options.json) shown.push(...await installSummary(ctx, detection, piDir));
  if (prompter && result2.code === 0 && !options.dryRun && !options.plan && r2.components.lanes.on && !existsSync29(join35(r2.settings.reposRoot, ".lanes/lanes.json"))) {
    const answer = await prompter.confirm({ message: "Set up a coordinator and lanes now?", initial: false });
    if (!prompter.isCancel(answer) && answer === true) {
      try {
        if (await runLanesFlow(ctx, { ...options, dir: "" }, prompter, true) !== 0) ctx.err("Lanes setup was not completed; run ./install.sh lanes to continue.");
      } catch (error) {
        ctx.err(`Lanes setup was not completed: ${error.message}`);
      }
    }
  }
  return finish(ctx, baseCtx, options, r2, detection, shown, result2.code, prompter, result2.wrote);
}
function cancelled(ctx) {
  ctx.err("Cancelled; nothing written.");
  return 1;
}
function finish(ctx, baseCtx, options, r2, detection, lines2, code, prompter, wrote = true) {
  if (options.json) {
    baseCtx.out(jsonReport(r2, detection, code));
    return code;
  }
  for (const line of lines2) (line.startsWith("warning:") ? ctx.err : ctx.out)(line);
  if (code === 0) {
    const readOnly = options.plan || options.dryRun;
    const kept = r2.actions.filter((a2) => a2.op === "keep").length;
    const upToDate = `Everything up to date.${kept ? ` ${kept} file(s) you changed were kept.` : ""}`;
    const done = readOnly ? "Nothing was written." : wrote ? "Done. Restart pi (or /reload)." : upToDate;
    const hint = r2.choice.provisional && !readOnly && wrote ? ` ${r2.choice.reason}.` : "";
    if (prompter) prompter.outro(`${done}${hint}`);
    else ctx.out(`${done}${hint}`);
  }
  return code;
}
var savedString2, flagMap;
var init_run = __esm({
  "src/run.ts"() {
    init_lanes_flow();
    init_config();
    init_apply();
    init_args();
    init_detect();
    init_plan();
    init_backups();
    init_manifest();
    init_reconcile();
    init_uninstall();
    init_components();
    init_retire();
    init_services();
    init_doctor();
    init_update();
    init_profiles();
    init_report();
    init_settings();
    init_types();
    init_wizard();
    savedString2 = (saved, key) => typeof saved[key] === "string" ? saved[key] : "";
    flagMap = (options) => ({
      ...Object.fromEntries(options.with.map((id) => [id, true])),
      ...Object.fromEntries(options.without.map((id) => [id, false]))
    });
  }
});

// src/cli.ts
import { dirname as dirname11, join as join36 } from "node:path";
import { fileURLToPath } from "node:url";
var MIN = [22, 19, 0];
function nodeTooOld(version) {
  const have = version.replace(/^v/, "").split(".").map(Number);
  for (let i2 = 0; i2 < MIN.length; i2++) {
    if ((have[i2] ?? 0) !== MIN[i2]) return (have[i2] ?? 0) < MIN[i2];
  }
  return false;
}
if (nodeTooOld(process.version)) {
  process.stderr.write(`pi-setup needs Node.js >= 22.19 (found ${process.version}); install it from https://nodejs.org, with brew install node, or with nvm.
`);
  process.exit(1);
}
var repoDir = join36(dirname11(fileURLToPath(import.meta.url)), "..", "..");
var { realContext: realContext2 } = await Promise.resolve().then(() => (init_context(), context_exports));
var { main: main3 } = await Promise.resolve().then(() => (init_run(), run_exports));
process.exitCode = await main3(process.argv.slice(2), realContext2(repoDir));
export {
  nodeTooOld
};
