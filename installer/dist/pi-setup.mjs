#!/usr/bin/env node
// pi-setup-source-sha256: d6901590fa2b9ec895bd151dfef88b38c801d49d67ec63e1e5bf4a28b0977ffe
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
  return new Promise((resolve2) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (error) => resolve2({ code: null, stdout: "", stderr: error.message, timedOut: false }));
    child.on("close", (code) => resolve2({ code, stdout: "", stderr: "", timedOut: false }));
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
      return new Promise((resolve2) => {
        const child = execFile(
          cmd,
          args,
          { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
          (error, stdout2, stderr) => {
            const failure = error;
            const code = failure ? typeof failure.code === "number" ? failure.code : null : 0;
            resolve2({
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

// src/fsx.ts
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync as statSync2,
  utimesSync,
  writeSync
} from "node:fs";
import { dirname, join as join2 } from "node:path";
function timestamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function listFiles(dir, base = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(join2(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isFile()) out.push(rel);
    else if (entry.isDirectory()) out.push(...listFiles(dir, rel));
  }
  return out.sort();
}
function backupCopy(from, to) {
  copyFileSync(from, to);
  const st = statSync2(from);
  chmodSync(to, st.mode & 4095);
  utimesSync(to, st.atime, st.mtime);
}
function atomicWrite(path, data, mode, pid = process.pid) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
var pad;
var init_fsx = __esm({
  "src/fsx.ts"() {
    pad = (n3) => String(n3).padStart(2, "0");
  }
});

// src/apply.ts
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  lstatSync,
  mkdirSync as mkdirSync2,
  readFileSync,
  statSync as statSync3,
  symlinkSync,
  utimesSync as utimesSync2,
  writeFileSync
} from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
function describe(action) {
  if (action.op === "install") return `install ${action.path}`;
  if (action.op === "register") return `register ./local-packages/pi-questions in ${action.path}`;
  return void 0;
}
function writeInstall(action, stamp) {
  mkdirSync2(dirname2(action.path), { recursive: true });
  if (action.existed && existsSync2(action.path)) backupCopy(action.path, `${action.path}.bak-${stamp}`);
  if (action.path.endsWith("/user.json") || action.path.endsWith("/settings.json")) {
    atomicWrite(action.path, action.content, action.mode);
  } else {
    writeFileSync(action.path, action.content);
    chmodSync2(action.path, action.mode);
  }
  if (action.mtimeMs !== void 0) utimesSync2(action.path, action.mtimeMs / 1e3, action.mtimeMs / 1e3);
}
function runAction(action, stamp) {
  if (action.op === "install") {
    writeInstall(action, stamp);
  } else if (action.op === "register") {
    if (action.existed) backupCopy(action.path, `${action.path}.bak-${stamp}`);
    atomicWrite(action.path, action.content, action.mode);
  } else if (action.op === "symlink") {
    mkdirSync2(dirname2(action.path), { recursive: true });
    try {
      lstatSync(action.path);
    } catch {
      symlinkSync(action.target, action.path);
    }
  } else if (existsSync2(action.path) && (statSync3(action.path).mode & 73) === 0) {
    chmodSync2(action.path, statSync3(action.path).mode | 73);
  }
}
function touchesProfile(actions, piDir, profile) {
  const watched = [join3(piDir, "agents"), join3(piDir, "workflows"), join3(piDir, "profiles", profile), join3(piDir, "AGENTS.md")];
  return actions.some((a2) => (a2.op === "install" || a2.op === "register") && watched.some((w) => a2.path === w || a2.path.startsWith(`${w}/`)));
}
function needsNpm(actions, piDir) {
  const npmDir = join3(piDir, "npm");
  const pkg = join3(npmDir, "package.json");
  const lock = join3(npmDir, "node_modules", ".package-lock.json");
  if (actions.some((a2) => a2.op === "install" && a2.path === pkg)) return true;
  if (!existsSync2(pkg)) return false;
  if (!existsSync2(join3(npmDir, "node_modules")) || !existsSync2(lock)) return true;
  return statSync3(pkg).mtimeMs > statSync3(lock).mtimeMs;
}
async function apply(ctx, actions, options) {
  const piDir = join3(ctx.home, ".pi", "agent");
  const stamp = timestamp(ctx.now());
  for (const action of actions) {
    const line = describe(action);
    if (line) ctx.out(line);
  }
  if (options.dryRun) return 0;
  for (const action of actions) runAction(action, stamp);
  const code = await applyProfile(ctx, actions, options, piDir);
  if (code !== 0) return code;
  return runNpm(ctx, actions, options, piDir);
}
async function applyProfile(ctx, actions, options, piDir) {
  if (options.activeBefore === void 0) {
    atomicWrite(join3(piDir, "profiles", "ACTIVE"), `${options.profile}
`, 420);
    return 0;
  }
  if (options.activeBefore === options.profile && !touchesProfile(actions, piDir, options.profile)) return 0;
  const result = await ctx.run("python3", [join3(piDir, "bin", "pi-profile"), "use", options.profile, "--force"], { timeoutMs: 6e4 });
  if (result.code !== 0) {
    ctx.err(`pi-profile use ${options.profile} failed: ${(result.stderr || result.stdout).trim()}`);
    return 1;
  }
  return 0;
}
async function runNpm(ctx, actions, options, piDir) {
  if (options.skipNpm) return 0;
  if (!needsNpm(actions, piDir)) {
    ctx.out("npm packages up to date");
    return 0;
  }
  const args = ["install", "--legacy-peer-deps"];
  const cwd = join3(piDir, "npm");
  options.spinner?.start("Installing npm packages");
  const result = await ctx.run("npm", args, { cwd, inherit: options.inheritNpm });
  options.spinner?.stop(result.code === 0 ? "npm packages installed" : "npm install failed");
  if (result.code === 0) return 0;
  if (!options.inheritNpm) ctx.err((result.stdout + result.stderr).trim().split("\n").slice(-15).join("\n"));
  ctx.err("Files installed; npm install failed: (cd ~/.pi/agent/npm && npm install --legacy-peer-deps)");
  return 1;
}
function readActive(piDir) {
  const file = join3(piDir, "profiles", "ACTIVE");
  return existsSync2(file) ? readFileSync(file, "utf8").trim() : void 0;
}
var init_apply = __esm({
  "src/apply.ts"() {
    init_fsx();
  }
});

// src/args.ts
function isAbsoluteOrHome(value) {
  return value.startsWith("/") || value.startsWith("~");
}
function parseArgs(argv, cwd) {
  const options = {
    command: "install",
    help: false,
    dryRun: false,
    user: "",
    reposRoot: "",
    profile: "",
    yes: false,
    skipNpm: false,
    plan: false,
    json: false
  };
  const args = argv[0] === "install" ? argv.slice(1) : argv;
  for (let i2 = 0; i2 < args.length; i2++) {
    const arg = args[i2];
    if (arg in BOOLEAN_FLAGS) {
      options[BOOLEAN_FLAGS[arg]] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[i2 + 1];
      if (value === void 0 || value === "" || value.startsWith("--")) {
        return { ok: false, error: `Missing value for ${arg}` };
      }
      i2++;
      if (arg === "--user") options.user = value;
      else if (arg === "--profile") options.profile = value;
      else options.reposRoot = isAbsoluteOrHome(value) ? value : `${cwd}/${value}`;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  return { ok: true, options };
}
function isInteractive(options, env, stdinTTY, stdoutTTY) {
  return stdinTTY && stdoutTTY && !env.CI && !options.yes && !options.json && !options.plan && !options.dryRun;
}
var USAGE, VALUE_FLAGS, BOOLEAN_FLAGS;
var init_args = __esm({
  "src/args.ts"() {
    USAGE = `Usage: ./install.sh [install] [options]

  --dry-run             show what would change, write nothing
  --plan                print the full plan (detection, profile, actions), write nothing
  --json                print one JSON object on stdout (combine with --plan or --dry-run)
  --user <login>        GitHub login (default: saved, then gh, then ask)
  --repos-root <dir>    repositories root (default: saved, then best scan match, then ~/repos)
  --profile <name|auto> profile to apply (default: the active one, else chosen from your logins)
  --yes                 never prompt
  --skip-npm            do not run npm install in ~/.pi/agent/npm
  --help                this text`;
    VALUE_FLAGS = /* @__PURE__ */ new Set(["--user", "--repos-root", "--profile"]);
    BOOLEAN_FLAGS = {
      "--dry-run": "dryRun",
      "--yes": "yes",
      "--skip-npm": "skipNpm",
      "--plan": "plan",
      "--json": "json",
      "--help": "help"
    };
  }
});

// src/repos-scan.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync2, statSync as statSync4 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
function originUrl(gitDir) {
  try {
    const config = readFileSync2(join4(gitDir, "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function scoreCandidate(path, owners, options) {
  let entries;
  try {
    entries = readdirSync2(path).filter((name) => !SKIP.has(name)).slice(0, options.maxChildren);
  } catch {
    return 0;
  }
  const names = owners.filter(Boolean).map(escapeRegExp);
  const owned = names.length ? new RegExp(`[:/](${names.join("|")})/`, "i") : void 0;
  let score = 0;
  for (const name of entries) {
    if (options.expired()) break;
    const git = join4(path, name, ".git");
    if (!existsSync3(git)) continue;
    score += 1;
    if (owned && statSync4(git).isDirectory() && owned.test(originUrl(git))) score += 1;
  }
  return score;
}
function scanRoots(candidates, owners, options) {
  const deadline = options.now() + (options.deadlineMs ?? 1500);
  const expired = () => options.now() > deadline;
  const seen = /* @__PURE__ */ new Set();
  const scored = [];
  for (const path of candidates) {
    if (seen.has(path) || expired()) continue;
    seen.add(path);
    scored.push({ path, score: scoreCandidate(path, owners, { maxChildren: options.maxChildren ?? 500, expired }) });
  }
  return scored.filter((c2) => c2.score > 0).sort((a2, b) => b.score - a2.score).slice(0, 3);
}
async function candidateRoots(ctx) {
  const list = [];
  const common = await ctx.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ctx.repoDir,
    timeoutMs: 3e3
  });
  if (common.code === 0 && common.stdout.trim()) list.push(dirname3(dirname3(common.stdout.trim())));
  list.push(...NAMES.map((n3) => join4(ctx.home, n3)));
  if (ctx.platform === "darwin") {
    let volumes = [];
    try {
      volumes = readdirSync2("/Volumes");
    } catch {
      volumes = [];
    }
    for (const volume of volumes) list.push(...NAMES.map((n3) => join4("/Volumes", volume, n3)));
  }
  return list;
}
var NAMES, SKIP;
var init_repos_scan = __esm({
  "src/repos-scan.ts"() {
    NAMES = ["repos", "src", "code", "dev", "projects", "git", "work", "source"];
    SKIP = /* @__PURE__ */ new Set(["Library", "node_modules", ".Trash"]);
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

// src/detect.ts
import { existsSync as existsSync4 } from "node:fs";
import { join as join5 } from "node:path";
function parseAuthStatus(text2) {
  const match = /Logged in to (\S+) account (\S+)/.exec(text2);
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
  const path = ctx.which(name);
  if (!path) return { name };
  const result = await ctx.run(name, ["--version"], { timeoutMs: name === "pi" ? PI_MS : SHORT_MS });
  const first = result.stdout.trim().split("\n")[0] || result.stderr.trim().split("\n")[0];
  return { name, path, version: result.timedOut || !first ? void 0 : first };
}
async function lines(ctx, args) {
  const result = await ctx.run("gh", args, { timeoutMs: SHORT_MS });
  if (result.code !== 0) return void 0;
  return result.stdout.split("\n").map((l2) => l2.trim()).filter(Boolean);
}
async function probeGithub(ctx, request) {
  const state = { orgs: [] };
  if (!ctx.which("gh") || !(request.needLogin || request.wantGithubDetails || request.needScan)) return state;
  const status = request.wantGithubDetails ? ctx.run("gh", ["auth", "status"], { timeoutMs: SHORT_MS }) : Promise.resolve(void 0);
  const user = request.needLogin || request.wantGithubDetails ? lines(ctx, ["api", "user", "--jq", ".login"]) : void 0;
  const orgs = request.needScan && request.needLogin || request.wantGithubDetails ? lines(ctx, ["api", "user/orgs", "--jq", ".[].login"]) : void 0;
  const parsed = parseAuthStatus(`${(await status)?.stdout ?? ""}
${(await status)?.stderr ?? ""}`);
  state.host = parsed.host;
  state.login = (await user)?.[0] ?? parsed.login;
  state.orgs = await orgs ?? [];
  return state;
}
async function probeProvider(ctx, id) {
  const result = await ctx.run("pi", ["auth", "check", "--provider", id, "--no-refresh", "--json"], { timeoutMs: PI_MS });
  return result.timedOut ? { status: "unknown" } : parseProviderCheck(result.stdout);
}
async function probeCatalog(ctx) {
  const result = await ctx.run("pi", ["--offline", "--list-models"], { timeoutMs: PI_MS });
  if (result.timedOut) return null;
  const text2 = `${result.stdout}
${result.stderr}`;
  return /No models available/i.test(text2) ? /* @__PURE__ */ new Set() : parseModelTable(result.stdout);
}
async function detect(ctx, request) {
  const piPresent = Boolean(ctx.which("pi"));
  const providers = {};
  const probePi = request.probePi && piPresent;
  const [tools, github, states, catalog] = await Promise.all([
    Promise.all(TOOLS.map((t2) => t2 === "pi" && !request.probePi ? Promise.resolve({ name: t2, path: ctx.which(t2) }) : probeTool(ctx, t2))),
    probeGithub(ctx, request),
    Promise.all(PROVIDER_IDS.map((id) => probePi ? probeProvider(ctx, id) : Promise.resolve({ status: "unknown" }))),
    probePi ? probeCatalog(ctx) : Promise.resolve(null)
  ]);
  PROVIDER_IDS.forEach((id, i2) => {
    providers[id] = states[i2];
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
    providers,
    hints: {
      codexAuthFile: existsSync4(join5(ctx.home, ".codex", "auth.json")),
      claudeDir: existsSync4(join5(ctx.home, ".claude"))
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

// src/settings.ts
import { existsSync as existsSync5, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { resolve } from "node:path";
function readSettings(path) {
  if (!existsSync5(path)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync3(path, "utf8"));
  } catch (error) {
    throw new SetupError(`${path}: ${error.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SetupError(`${path}: expected a JSON object`);
  }
  const record = data;
  for (const key of ["githubUser", "reposRoot"]) {
    const value = record[key];
    if (key in record && (typeof value !== "string" || !value.trim())) {
      throw new SetupError(`${path}: ${key} must be a nonempty string`);
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
  const text2 = buf.toString("utf8").split("{{GITHUB_USER}}").join(settings2.githubUser).split("{{REPOS_ROOT}}").join(settings2.reposRoot);
  return Buffer.from(text2, "utf8");
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

// src/profiles.ts
import { existsSync as existsSync6, readdirSync as readdirSync3, readFileSync as readFileSync4 } from "node:fs";
import { join as join6 } from "node:path";
function profilesDir(repoDir2) {
  return join6(repoDir2, "agent", "profiles");
}
function profileNames(repoDir2) {
  const dir = profilesDir(repoDir2);
  if (!existsSync6(dir)) return [];
  return readdirSync3(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
function loadProfiles(repoDir2) {
  const metas = [];
  for (const name of profileNames(repoDir2)) {
    const file = join6(profilesDir(repoDir2), name, "profile.json");
    if (!existsSync6(file)) continue;
    const data = JSON.parse(readFileSync4(file, "utf8"));
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
function chooseProfile(ready, profiles) {
  const fit = profiles.filter((p) => p.requires.every((r2) => ready.has(r2))).sort((a2, b) => b.rank - a2.rank)[0];
  const name = fit?.name ?? FALLBACK_PROFILE;
  return { name, reason: reasonFor(ready, name), provisional: !fit, source: "chooser" };
}
function reasonFor(ready, name) {
  const claude = ready.has("anthropic");
  const gpt = ready.has("openai-codex");
  const kimi = ready.has("kimi-coding");
  if (claude && gpt && kimi) return "you have Claude, ChatGPT and Kimi: each role goes where it is strongest";
  if (claude && gpt) return "you have Claude and ChatGPT; Kimi roles (ops, scout) fall back to GPT via provider-fallback";
  if (gpt && !claude) return `only ChatGPT is logged in: ${name} keeps every role on GPT`;
  if (claude) return "no Claude-only profile yet; balanced is used and GPT roles need a ChatGPT login";
  return "log in with /login in pi, then rerun ./install.sh --profile auto";
}
function kimiNote(profile, ready) {
  if (!profile?.uses.includes("kimi-coding") || ready.has("kimi-coding")) return void 0;
  return "Kimi is not logged in: the Kimi roles fall back to GPT.";
}
function pinnedModels(profileDir) {
  const pins = /* @__PURE__ */ new Set();
  for (const file of listFiles(join6(profileDir, "agents")).filter((f) => f.endsWith(".md"))) {
    const text2 = readFileSync4(join6(profileDir, "agents", file), "utf8");
    const match = /^model:\s*(\S+)/m.exec(text2);
    if (match) pins.add(match[1]);
  }
  return [...pins].sort();
}
function pinWarnings(pins, ready, catalog) {
  if (!catalog || catalog.size === 0) return [];
  return pins.filter((pin) => ready.has(pin.split("/")[0]) && !catalog.has(pin)).map((pin) => `Pinned model ${pin} is not in this pi's model catalog.`);
}
function overlayFor(repoDir2, name, settings2) {
  const base = join6(profilesDir(repoDir2), name);
  if (!existsSync6(base)) throw new SetupError(`unknown profile '${name}'. available: ${profileNames(repoDir2).join(", ")}`);
  const sources = /* @__PURE__ */ new Map();
  for (const sub of ["agents", "workflows"]) {
    for (const file of listFiles(join6(base, sub))) {
      if (!file.includes("/")) sources.set(`${sub}/${file}`, join6(base, sub, file));
    }
  }
  const routingPath = join6(base, "routing.md");
  return { sources, routing: existsSync6(routingPath) ? render(readFileSync4(routingPath), settings2) : void 0 };
}
function spliceRouting(agentsMd2, routing) {
  const text2 = agentsMd2.toString("utf8");
  const start = text2.indexOf(START);
  const end = text2.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new SetupError("routing markers not found in AGENTS.md");
  const bodyStart = text2.indexOf("\n", start) + 1;
  return Buffer.from(text2.slice(0, bodyStart) + routing.toString("utf8") + text2.slice(end), "utf8");
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
import { existsSync as existsSync7, lstatSync as lstatSync2, readdirSync as readdirSync4, readFileSync as readFileSync5, statSync as statSync5 } from "node:fs";
import { join as join7 } from "node:path";
function fromSource(src, settings2) {
  const raw = readFileSync5(src);
  const st = statSync5(src);
  const mode = st.mode & 4095;
  return hasTokens(raw) ? { content: render(raw, settings2), mode } : { content: raw, mode, mtimeMs: st.mtimeMs };
}
function sameBytes(dest, content) {
  return existsSync7(dest) && statSync5(dest).isFile() && readFileSync5(dest).equals(content);
}
function put(actions, dest, desired) {
  if (sameBytes(dest, desired.content)) return;
  actions.push({ op: "install", path: dest, existed: existsSync7(dest), ...desired });
}
function putSource(actions, src, dest, settings2) {
  put(actions, dest, fromSource(src, settings2));
}
function putTree(actions, srcDir, destDir, settings2, overlay, prefix = "") {
  const files = new Set(listFiles(srcDir));
  for (const [rel, src] of overlay ?? []) if (rel.startsWith(prefix)) files.add(rel.slice(prefix.length));
  for (const rel of [...files].sort()) {
    const src = overlay?.get(`${prefix}${rel}`) ?? join7(srcDir, rel);
    putSource(actions, src, join7(destDir, rel), settings2);
  }
}
function userJsonAction(actions, piDir, settings2) {
  const path = join7(piDir, "user.json");
  const existing = readSettings(path);
  const merged = mergeUserJson(existing, settings2);
  if (existsSync7(path) && deepEqual(existing, merged)) return;
  actions.push({
    op: "install",
    path,
    existed: existsSync7(path),
    mode: 420,
    content: Buffer.from(`${JSON.stringify(merged, null, 2)}
`)
  });
}
function agentsMd(input) {
  const base = fromSource(join7(input.repoDir, "agent", "AGENTS.md"), input.settings);
  if (!input.overlay.routing) return base;
  return { content: spliceRouting(base.content, input.overlay.routing), mode: base.mode };
}
function registerAction(actions, piDir) {
  const path = join7(piDir, "settings.json");
  const pending = actions.find((a2) => a2.op === "install" && a2.path === path);
  const content = pending && pending.op === "install" ? pending.content : existsSync7(path) ? readFileSync5(path) : void 0;
  if (!content) return;
  let data;
  try {
    data = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new SetupError(`${path}: ${error.message}`);
  }
  const packages = Array.isArray(data.packages) ? data.packages : [];
  if (packages.includes(PACKAGE)) return;
  const updated = { ...data, packages: [...packages, PACKAGE] };
  const mode = pending && pending.op === "install" ? pending.mode : statSync5(path).mode & 4095;
  const next = Buffer.from(`${JSON.stringify(updated, null, 2)}
`);
  if (pending && pending.op === "install") {
    pending.content = next;
    actions.push({ op: "register", path, content: next, mode, existed: false });
  } else {
    actions.push({ op: "register", path, content: next, mode, existed: true });
  }
}
function buildPlan(input) {
  const { repoDir: repoDir2, home, settings: settings2, overlay } = input;
  const agent = join7(repoDir2, "agent");
  const piDir = join7(home, ".pi", "agent");
  const actions = [];
  userJsonAction(actions, piDir, settings2);
  for (const tree of TREES) {
    const useOverlay = tree === "agents" || tree === "workflows";
    putTree(actions, join7(agent, tree), join7(piDir, tree), settings2, useOverlay ? overlay.sources : void 0, useOverlay ? `${tree}/` : "");
  }
  putTree(actions, join7(agent, "local-packages/pi-questions"), join7(piDir, "local-packages/pi-questions"), settings2);
  actions.push({ op: "chmod-x", path: join7(piDir, "local-packages/pi-questions/dist/cli.js") });
  put(actions, join7(piDir, "AGENTS.md"), agentsMd(input));
  putSource(actions, join7(agent, "AGENTS.subagent.md"), join7(piDir, "AGENTS.subagent.md"), settings2);
  for (const name of ONLY_IF_ABSENT) {
    if (!existsSync7(join7(piDir, name))) putSource(actions, join7(agent, name), join7(piDir, name), settings2);
  }
  registerAction(actions, piDir);
  const absent = [
    ["docker-guardian/pinned.example.txt", "docker-guardian/pinned.txt"],
    ["dev-doctor.example.json", "dev-doctor.json"],
    ["npm-package.json", "npm/package.json"]
  ];
  for (const [from, to] of absent) {
    if (!existsSync7(join7(piDir, to))) putSource(actions, join7(agent, from), join7(piDir, to), settings2);
  }
  for (const skill of listSkills(repoDir2)) {
    putTree(actions, join7(repoDir2, "skills", skill), join7(home, ".agents", "skills", skill), settings2);
  }
  const link = join7(piDir, "skills", "ai-work-lifecycle");
  if (!lstatExists(link)) actions.push({ op: "symlink", path: link, target: join7(home, ".agents", "skills", "ai-work-lifecycle") });
  putTree(actions, join7(repoDir2, "tools/ai-work-lifecycle"), join7(home, ".local/share/ai-work-lifecycle"), settings2);
  const bin = join7(repoDir2, "tools/bin/ai-work-lifecycle");
  putSource(actions, bin, join7(home, ".local/bin/ai-work-lifecycle"), settings2);
  return actions;
}
function listSkills(repoDir2) {
  const dir = join7(repoDir2, "skills");
  if (!existsSync7(dir)) return [];
  return readdirSync4(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}
function lstatExists(path) {
  try {
    lstatSync2(path);
    return true;
  } catch {
    return false;
  }
}
var TREES, ONLY_IF_ABSENT, PACKAGE;
var init_plan = __esm({
  "src/plan.ts"() {
    init_settings();
    init_fsx();
    init_profiles();
    init_types();
    TREES = ["agents", "extensions", "early-extensions", "lib", "workflows", "templates", "profiles", "loose-threads", "bin", "pi-phase", "lane-policy"];
    ONLY_IF_ABSENT = ["settings.json", "models.json", "subagents.json", "provider-fallback.json", "mcp-adapter.json", "efficiency.json", "context-budget.json"];
    PACKAGE = "./local-packages/pi-questions";
  }
});

// src/report.ts
function countActions(actions) {
  const installs = actions.filter((a2) => a2.op === "install");
  return {
    added: installs.filter((a2) => !a2.existed).length,
    changed: installs.filter((a2) => a2.existed).length,
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
function symbol(status) {
  if (status === "ready") return "\u2713";
  return status === "not_ready" ? "\u2717" : "?";
}
function summaryLines(args) {
  const { settings: settings2, choice, actions } = args;
  const counts = countActions(actions);
  const lines2 = [
    `GitHub login: ${settings2.githubUser} (${USER_SOURCES[settings2.userSource]})`,
    `Repositories root: ${settings2.reposRoot} (${ROOT_SOURCES[settings2.rootSource]})`,
    ...detectionLines(args.detection, args.probed),
    `Profile: ${choice.name} (${choice.reason})${choice.provisional ? " [provisional]" : ""}`
  ];
  if (args.profile?.summary) lines2.push(args.profile.summary);
  if (args.kimi) lines2.push(args.kimi);
  lines2.push(
    `Files: ${counts.added} new, ${counts.changed} changed${counts.register ? ", register pi-questions" : ""}`,
    `npm install: ${args.skipNpm ? "skipped (--skip-npm)" : args.npm ? "yes" : "up to date"}`
  );
  for (const warning of args.warnings.filter((w) => w !== args.kimi)) lines2.push(`warning: ${warning}`);
  return lines2;
}
var USER_SOURCES, ROOT_SOURCES;
var init_report = __esm({
  "src/report.ts"() {
    init_types();
    USER_SOURCES = { flag: "from --user", saved: "saved in user.json", detected: "from gh", prompt: "you typed it" };
    ROOT_SOURCES = { flag: "from --repos-root", saved: "saved in user.json", scan: "best match found", default: "default", prompt: "you typed it" };
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
    options: input.profiles.map((m) => ({ value: m.name, label: m.name, hint: m.summary })),
    initial: initial.name
  });
  return p.isCancel(chosen) ? CANCEL : chosen;
}
async function collectChoices(p, input) {
  p.note(detectionLines(input.detection).join("\n"), "What I found");
  const user = await askLogin(p, input);
  if (p.isCancel(user)) return CANCEL;
  const root = await askRoot(p, input);
  if (p.isCancel(root)) return CANCEL;
  const profile = await askProfile(p, input);
  if (p.isCancel(profile)) return CANCEL;
  return { user, root, profile };
}
async function confirmApply(p, summary) {
  p.note(summary.join("\n"), "Plan");
  const answer = await p.confirm({ message: "Apply?", initial: true });
  return !p.isCancel(answer) && answer === true;
}
var savedString;
var init_wizard = __esm({
  "src/wizard.ts"() {
    init_report();
    init_settings();
    init_types();
    savedString = (saved, key) => typeof saved[key] === "string" ? saved[key] : "";
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
      const LIMIT = truncationOptions.limit ?? Infinity;
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
      let truncationLimit = Math.max(0, LIMIT - ELLIPSIS_WIDTH);
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
            if (width + widthExtra > LIMIT) {
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
            if (width + widthExtra > LIMIT) {
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
        ellipsed: truncationEnabled && LIMIT >= ELLIPSIS_WIDTH
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
var init_main = __esm({
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
    const i2 = a2 === "return" ? 0 : -1, m = a2 === "return" ? -1 : 0;
    l.moveCursor(r2, i2, m, () => {
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
`).map((c2, i2, m) => {
    const d = t2 ? t2(c2, i2) : c2;
    return i2 === 0 ? `${n3}${d}` : i2 === m.length - 1 ? `${s}${d}` : `${o}${d}`;
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
var import_sisteransi, a$1, t, settings, R, CANCEL_SYMBOL, getColumns, getRows, y, r, n$1, n2;
var init_dist3 = __esm({
  "node_modules/@clack/core/dist/index.mjs"() {
    init_main();
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
var import_sisteransi2, unicode, isCI, unicodeOr, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, S_BAR_START, S_BAR, S_BAR_END, S_BAR_START_RIGHT, S_BAR_END_RIGHT, S_RADIO_ACTIVE, S_RADIO_INACTIVE, S_CHECKBOX_ACTIVE, S_CHECKBOX_SELECTED, S_CHECKBOX_INACTIVE, S_PASSWORD_MASK, S_BAR_H, S_CORNER_TOP_RIGHT, S_CONNECT_LEFT, S_CORNER_BOTTOM_RIGHT, S_CORNER_BOTTOM_LEFT, S_CORNER_TOP_LEFT, S_INFO, S_SUCCESS, S_WARN, S_ERROR, symbol2, symbolBar, I, limitOptions, confirm, MULTISELECT_INSTRUCTIONS, intro, outro, W$1, C, note, W, spinner, u2, SELECT_INSTRUCTIONS, c, select, i, text;
var init_dist4 = __esm({
  "node_modules/@clack/prompts/dist/index.mjs"() {
    init_dist3();
    init_dist3();
    init_main();
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
          const m = l2[i2];
          if (m && (r2 -= m.length), O++, r2 <= b) break;
        }
      else
        for (let i2 = w; i2 < p; i2++) {
          const m = l2[i2];
          if (m && (r2 -= m.length), O++, r2 <= b) break;
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
      const i2 = getColumns(p) - C2, m = getRows(p), M = styleText2("dim", "..."), v = Math.max(m - r2, 0), a2 = Math.max(Math.min(b, v), 5);
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
        g.reduce((m, F) => {
          const O = dist_default2(F);
          return O > m ? O : m;
        }, 0),
        n3
      ) + 2, h2 = g.map(
        (m) => `${styleText2("gray", S_BAR)}  ${m}${" ".repeat(t2 - dist_default2(m))}${styleText2("gray", S_BAR)}`
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
      signal: m,
      ...I2
    } = {}) => {
      const u3 = isCI();
      let M, T, d = false, S = false, s = "", p, w = performance.now();
      const x = getColumns(n3), k = I2?.styleFrame ?? W, g = (e) => {
        const r2 = e > 1 ? O ?? settings.messages.error : G ?? settings.messages.cancel;
        S = e === 1, d && (a2(r2, e), S && typeof h2 == "function" && h2());
      }, f = () => g(2), i2 = () => g(1), A = () => {
        process.on("uncaughtExceptionMonitor", f), process.on("unhandledRejection", f), process.on("SIGINT", i2), process.on("SIGTERM", i2), process.on("exit", g), m && m.addEventListener("abort", i2);
      }, H = () => {
        process.removeListener("uncaughtExceptionMonitor", f), process.removeListener("unhandledRejection", f), process.removeListener("SIGINT", i2), process.removeListener("SIGTERM", i2), process.removeListener("exit", g), m && m.removeEventListener("abort", i2);
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
      const o = (n3, m) => {
        if (n3 === void 0)
          return "";
        const s = n3.label ?? String(n3.value);
        switch (m) {
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
          const n3 = t2.withGuide ?? settings.withGuide, m = `${symbol2(this.state)}  `, s = `${symbolBar(this.state)}  `, i2 = wrapTextWithPrefix(
            t2.output,
            t2.message,
            s,
            m
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
    text = (t2) => new n2({
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
    text: async (o) => wrap(await text({ message: o.message, initialValue: o.initial, validate: o.validate })),
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
  main: () => main
});
import { join as join8 } from "node:path";
function pickProfile(options, activeBefore, ready, profiles, names, readOnly = false) {
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
    return { name: "balanced", reason: "providers not probed in dry-run; using --profile, then the active profile, then balanced", provisional: false, source: "chooser" };
  }
  return chooseProfile(ready, profiles);
}
function requiredToolErrors(ctx, detection, options) {
  const needed = ["python3", ...options.skipNpm ? [] : ["npm"]];
  return needed.filter((tool) => !toolPath(detection, tool)).map((tool) => `${tool} is required but was not found on PATH; install it with: ${installHint(ctx.platform, tool)}`);
}
function resolveAll(ctx, options, detection, saved, answers) {
  const piDir = join8(ctx.home, ".pi", "agent");
  const settings2 = resolveSettings({
    flagUser: answers.user ?? options.user,
    flagRoot: answers.root ?? options.reposRoot,
    saved,
    detectedUser: detection.github.login,
    scanRoot: detection.candidates[0]?.path,
    home: ctx.home,
    repoDir: ctx.repoDir
  });
  if (answers.user) settings2.userSource = answers.user === savedString2(saved, "githubUser") ? "saved" : "prompt";
  if (answers.root) settings2.rootSource = "prompt";
  const names = profileNames(ctx.repoDir);
  const profiles = loadProfiles(ctx.repoDir);
  const activeBefore = readActive(piDir);
  const ready = readyProviders(detection);
  const asked = answers.profile ? { ...options, profile: answers.profile } : options;
  const choice = pickProfile(asked, activeBefore, ready, profiles, names, options.dryRun || options.plan);
  const profile = profiles.find((p) => p.name === choice.name);
  const actions = buildPlan({ repoDir: ctx.repoDir, home: ctx.home, settings: settings2, overlay: overlayFor(ctx.repoDir, choice.name, settings2) });
  const kimi = options.dryRun || options.plan ? void 0 : kimiNote(profile, ready);
  const warnings = [
    ...settings2.warnings,
    ...detection.warnings,
    ...pinWarnings(pinnedModels(join8(profilesDir(ctx.repoDir), choice.name)), ready, detection.catalog),
    ...kimi ? [kimi] : []
  ];
  return { settings: settings2, choice, actions, warnings, profile, ready, activeBefore, piDir, npm: needsNpm(actions, piDir) };
}
function jsonReport(r2, detection, exitCode) {
  return JSON.stringify({
    settings: { ...r2.settings },
    detection: { ...detection, catalog: detection.catalog ? [...detection.catalog].sort() : null },
    profile: { name: r2.choice.name, reason: r2.choice.reason, provisional: r2.choice.provisional, source: r2.choice.source },
    actions: r2.actions.map((a2) => ({ op: a2.op, path: a2.path })),
    warnings: r2.warnings,
    exitCode
  });
}
async function main(argv, baseCtx, injected) {
  const parsed = parseArgs(argv, baseCtx.cwd);
  if (!parsed.ok) {
    baseCtx.err(parsed.error);
    return 1;
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
    return await execute(ctx, options, interactive ? prompter : void 0, baseCtx);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    ctx.err(error.message.startsWith("pi-setup:") || error.message.startsWith("Missing value") ? error.message : `pi-setup: ${error.message}`);
    return 1;
  }
}
async function execute(ctx, options, prompter, baseCtx) {
  const piDir = join8(ctx.home, ".pi", "agent");
  const saved = readSettings(join8(piDir, "user.json"));
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
    const result = await collectChoices(prompter, { options, saved, detection, profiles, initial, home: ctx.home, repoDir: ctx.repoDir });
    if (result === CANCEL) return cancelled(ctx);
    answers = result;
  }
  const r2 = resolveAll(ctx, options, detection, saved, answers);
  r2.warnings.push(...toolErrors.map((e) => e));
  if (!toolPath(detection, "pi")) r2.warnings.push(`pi was not found on PATH; install it with: ${installHint(ctx.platform, "pi")}`);
  const summary = summaryLines({ ...r2, detection, kimi: readOnly ? void 0 : kimiNote(r2.profile, r2.ready), skipNpm: options.skipNpm, probed: !readOnly });
  if (options.plan) return finish(ctx, baseCtx, options, r2, detection, summary, 0);
  if (prompter && !await confirmApply(prompter, summary)) return cancelled(ctx);
  const applyOptions = {
    dryRun: options.dryRun,
    skipNpm: options.skipNpm || options.dryRun,
    inheritNpm: !prompter && !options.json,
    profile: r2.choice.name,
    activeBefore: r2.activeBefore,
    spinner: prompter?.spinner()
  };
  const code = await apply(ctx, r2.actions, applyOptions);
  return finish(ctx, baseCtx, options, r2, detection, prompter || options.json ? [] : summary.filter((l2) => l2.startsWith("Profile:") || l2.startsWith("Kimi") || l2.startsWith("warning:")), code, prompter);
}
function cancelled(ctx) {
  ctx.err("Cancelled; nothing written.");
  return 1;
}
function finish(ctx, baseCtx, options, r2, detection, lines2, code, prompter) {
  if (options.json) {
    baseCtx.out(jsonReport(r2, detection, code));
    return code;
  }
  for (const line of lines2) (line.startsWith("warning:") ? ctx.err : ctx.out)(line);
  if (code === 0) {
    const done = options.plan || options.dryRun ? "Nothing was written." : "Done. Restart pi (or /reload).";
    const hint = r2.choice.provisional && !options.plan && !options.dryRun ? ` ${r2.choice.reason}.` : "";
    if (prompter) prompter.outro(`${done}${hint}`);
    else ctx.out(`${done}${hint}`);
  }
  return code;
}
var savedString2;
var init_run = __esm({
  "src/run.ts"() {
    init_apply();
    init_args();
    init_detect();
    init_plan();
    init_profiles();
    init_report();
    init_settings();
    init_types();
    init_wizard();
    savedString2 = (saved, key) => typeof saved[key] === "string" ? saved[key] : "";
  }
});

// src/cli.ts
import { dirname as dirname4, join as join9 } from "node:path";
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
var repoDir = join9(dirname4(fileURLToPath(import.meta.url)), "..", "..");
var { realContext: realContext2 } = await Promise.resolve().then(() => (init_context(), context_exports));
var { main: main2 } = await Promise.resolve().then(() => (init_run(), run_exports));
process.exitCode = await main2(process.argv.slice(2), realContext2(repoDir));
export {
  nodeTooOld
};
