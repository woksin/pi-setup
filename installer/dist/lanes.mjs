#!/usr/bin/env node
// pi-setup-source-sha256: 47a5ed41f84322cd948c95d36f9c42df7cda2b08b36028af8be2994d2bfe16dd

// src/lanes/cli.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { realpathSync as realpathSync2 } from "node:fs";

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
  return new Promise((resolve7) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (error) => resolve7({ code: null, stdout: "", stderr: error.message, timedOut: false }));
    child.on("close", (code) => resolve7({ code, stdout: "", stderr: "", timedOut: false }));
  });
}
var realRun = (cmd, args, options = {}) => {
  if (options.inherit) return inherited(cmd, args, options);
  return new Promise((resolve7) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error;
        const code = failure ? typeof failure.code === "number" ? failure.code : null : 0;
        resolve7({
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

// src/lanes/config.ts
import { existsSync as existsSync2, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, isAbsolute, join as join4, resolve as resolve3 } from "node:path";
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
  const match = new RegExp(`^(${ID})-to-(${ID})-([a-z0-9][a-z0-9-]*?)-[0-9]{4}(?:-[0-9]+)?\\.md$`).exec(name);
  if (match) return { from: match[1], to: [match[2]], topic: match[3] };
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
    messages: { dir: "messages", broadcast: "ALL" },
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
function validate(value) {
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
  }
}
function expand(value, c, root, home) {
  let out = value;
  for (let n = 0; n < 8; n++) {
    const next = out.replace(/\$\{(root|reposRoot|worktreesDir)\}/g, (_, key) => key === "root" ? root : c[key]);
    if (next === out) break;
    out = next;
  }
  if (/\$\{/.test(out)) throw new UsageError(`invalid path expansion: ${value}`);
  if (out === "~" || out.startsWith("~/")) out = join4(home, out.slice(2));
  return isAbsolute(out) ? resolve3(out) : resolve3(root, out);
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
  validate(c);
  return c;
}
function saveConfig(root, c) {
  validate(c);
  const tmp = join4(root, `.lanes-${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(c, null, 2)}
`, { flag: "wx" });
  renameSync(tmp, join4(root, "lanes.json"));
}

// src/lanes/commands/init.ts
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3, join as join7, resolve as resolve4 } from "node:path";

// src/lanes/templates.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join6 } from "node:path";

// src/lanes/terminal.ts
import { join as join5 } from "node:path";
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
function launchCommand(c, root, cwd, id, prompt, wrapper, messages) {
  const unset = c.launch.unsetEnv.map((name) => `-u ${name}`).join(" ");
  const exe = /^[A-Za-z0-9_/-]+$/.test(wrapper) ? wrapper : shellQuote(wrapper);
  return `cd ${shellQuote(cwd)} && env ${unset ? `${unset} ` : ""}PI_ORCH_ID=${id} LANES_DIR=${shellQuote(root)} INBOX_DIR=${shellQuote(messages)} LANE_STATUS_DIR=${shellQuote(join5(messages, "status"))} ${exe} ${shellQuote(`@${prompt}`)}`;
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
async function nudgeTerminal(name, ctx, { tty, text }) {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) throw new UsageError("invalid tty");
  if (name === "print") return "not-found";
  if (name === "tmux") {
    const panes = await ctx.run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"], { timeoutMs: 1e4 });
    if (panes.code !== 0) throw new Error("tmux list-panes failed");
    const pane = panes.stdout.split("\n").map((s) => s.trim().split(/\s+/)).find(([t]) => t === `/dev/${tty}`)?.[1];
    if (!pane) return "not-found";
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
  const result = await ctx.run("osascript", ["-e", script], { timeoutMs: 1e4 });
  if (result.code !== 0) throw new Error(`osascript failed: ${result.stderr.trim()}`);
  return result.stdout.trim() === "sent" ? "sent" : "not-found";
}

// src/lanes/templates.ts
function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (token, name) => Object.hasOwn(vars, name) ? String(vars[name]) : token);
}
function readTemplate(ctx, name) {
  return readFileSync2(join6(ctx.templatesDir, name), "utf8");
}
function templateVars(c, ctx, root) {
  const messages = expand(c.messages.dir, c, root, ctx.home);
  return {
    root,
    root_sh: shellQuote(root),
    messages_sh: shellQuote(messages),
    coordinator_sh: shellQuote(c.coordinator.id),
    coordinator: c.coordinator.id,
    maxRunning: c.coordinator.maxRunning,
    rules: join6(root, "rules.md"),
    messages,
    watches: join6(root, "coordinator/WATCHES.md"),
    handoff: join6(root, "coordinator/handoff-protocol.md")
  };
}

// src/lanes/commands/init.ts
async function init(args, opts, ctx) {
  const root = resolve4(ctx.cwd, args[0] || ".");
  const configPath = join7(root, "lanes.json");
  const c = existsSync3(configPath) ? loadConfig(root) : defaults(root, ctx.home, opts["repos-root"]);
  if (!existsSync3(configPath)) {
    c.coordinator.id = opts.coordinator || c.coordinator.id;
    c.terminal.backend = opts.terminal || c.terminal.backend;
    c.launch.preapproveMcp = opts["preapprove-mcp"] === "true" || preapprovalDefault(ctx.templatesDir);
  }
  validate(c);
  const vars = templateVars(c, ctx, root);
  const put = (rel, content) => {
    const path = join7(root, rel);
    mkdirSync(dirname3(path), { recursive: true });
    if (existsSync3(path)) ctx.out(`kept ${path}`);
    else {
      writeFileSync2(path, content, { flag: "wx" });
      ctx.out(`created ${path}`);
    }
  };
  put("lanes.json", `${JSON.stringify(c, null, 2)}
`);
  for (const [source, dest] of [["rules.md", "rules.md"], ["coordinator.md", "prompts/coordinator.md"], ...["WATCHES.md", "handoff-protocol.md", "NOW.md", "STATE.md"].map((n) => [n, `coordinator/${n}`])]) {
    put(dest, renderTemplate(readTemplate(ctx, source), vars));
  }
  const status2 = join7(root, "messages/status");
  const hadStatus = existsSync3(status2);
  mkdirSync(status2, { recursive: true });
  ctx.out(`${hadStatus ? "kept" : "created"} ${status2}`);
  const ignore = join7(root, ".gitignore");
  const text = existsSync3(ignore) ? readFileSync3(ignore, "utf8") : "";
  const missing = [".state/", "messages/"].filter((s) => !text.split(/\r?\n/).includes(s));
  if (missing.length) {
    writeFileSync2(ignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}
`);
    ctx.out(`created ${ignore}`);
  } else ctx.out(`kept ${ignore}`);
  return 0;
}

// src/lanes/commands/add.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname4, join as join9, resolve as resolve5 } from "node:path";

// src/lanes/preapprove.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { join as join8 } from "node:path";
var SUPPORTED_MAJORS = [5];
async function preapprove(ctx, cwd, enabled) {
  if (!enabled) {
    ctx.out("MCP preapproval is off; enable with lanes init --preapprove-mcp for a new folder, or set launch.preapproveMcp to true in lanes.json.");
    return;
  }
  const files = [".mcp.json", ".pi/mcp.json"].filter((f) => existsSync4(join8(cwd, f)));
  if (!files.length) return;
  const skip = (reason2) => ctx.err(`MCP preapproval skipped: ${reason2}; pi will ask once per server when the lane starts.`);
  let reason = "adapter not found";
  try {
    const adapter = join8(ctx.piAgentDir, "npm/node_modules/pi-mcp-adapter");
    const pkg = JSON.parse(readFileSync4(join8(adapter, "package.json"), "utf8"));
    if (!SUPPORTED_MAJORS.includes(Number(String(pkg.version).split(".")[0]))) {
      reason = `adapter ${pkg.version} not supported (supports ${SUPPORTED_MAJORS.join(", ")}.x)`;
      throw new Error(reason);
    }
    reason = "adapter API changed";
    const mod = await ctx.loadModule(join8(adapter, "dist/project-server-trust.js"));
    if (typeof mod.approveProjectServer !== "function" || typeof mod.hashProjectServerDefinition !== "function") throw new Error(reason);
    for (const file of files) {
      let servers;
      try {
        servers = JSON.parse(readFileSync4(join8(cwd, file), "utf8")).mcpServers ?? {};
      } catch {
        skip(`invalid ${file} (${join8(cwd, file)})`);
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
  if (!validId(id) || ["ALL", c.messages.broadcast, c.coordinator.id].includes(id)) throw new UsageError("invalid lane id");
  if (c.lanes.some((l) => l.id === id)) throw new Error(`lane ${id} already exists`);
  const repo = opts.repo;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((s) => [".", ".."].includes(s))) throw new UsageError("invalid repo (expected owner/name)");
  if (opts.issue !== void 0 && (!/^\d+$/.test(opts.issue) || Number(opts.issue) < 1)) throw new UsageError("invalid issue");
  if (opts.goal !== void 0 && !opts.goal.trim()) throw new UsageError("invalid goal");
  const [owner, name] = repo.split("/");
  const lower = id.toLowerCase();
  const worktree = `${lower}-${name.toLowerCase()}`;
  const branch = opts.branch || (opts.issue ? `${lower}-issue-${Number(opts.issue)}` : opts.goal ? `${lower}-${slug(opts.goal)}` : worktree);
  const lane = { id, repo, ...opts.issue ? { issue: Number(opts.issue) } : {}, ...opts.goal ? { goal: opts.goal } : {}, group: opts.group || null, worktree, branch, prompt: `prompts/${id}.md` };
  validate({ ...c, lanes: [...c.lanes, lane] });
  const repos = expand(c.reposRoot, c, root, ctx.home);
  const candidates = [opts.path ? resolve5(ctx.cwd, opts.path) : void 0, c.repos[repo] ? expand(c.repos[repo], c, root, ctx.home) : void 0, join9(repos, name), join9(repos, owner, name)].filter((p) => Boolean(p));
  const git = (clone2, args, timeoutMs = 1e4) => ctx.run("git", ["-C", clone2, ...args], { timeoutMs });
  let clone;
  for (const p of candidates) if ((await git(p, ["rev-parse", "--git-dir"])).code === 0) {
    clone = p;
    break;
  }
  if (!clone) throw new Error(`clone it first: gh repo clone ${repo} ${join9(repos, name)}`);
  const remote = await git(clone, ["remote", "get-url", "origin"]);
  if (!remote.stdout.trim().endsWith(repo) && !remote.stdout.trim().endsWith(`${repo}.git`)) ctx.err(`warning: origin does not match ${repo}`);
  const base = opts.base || c.baseBranch;
  const fetch = await git(clone, ["fetch", "origin"], 12e4);
  const ref = await git(clone, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (ref.code !== 0) throw new Error(`base ${base} does not resolve`);
  if (fetch.code !== 0) ctx.err(`warning: fetch origin failed; using local ${base}`);
  const wt = join9(expand(c.worktreesDir, c, root, ctx.home), worktree);
  if (existsSync5(wt)) throw new Error(`worktree already exists: ${wt}`);
  if ((await git(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) throw new Error(`branch already exists: ${branch}`);
  const created = await git(clone, ["worktree", "add", "-b", branch, wt, base], 12e4);
  if (created.code !== 0) throw new Error(`git worktree add failed: ${created.stderr.trim()}`);
  try {
    const lock = await git(clone, ["worktree", "lock", "--reason", `lanes ${id}`, wt]);
    if (lock.code !== 0) throw new Error(`git worktree lock failed: ${lock.stderr.trim()}`);
    const prompt = expand(lane.prompt, c, root, ctx.home);
    mkdirSync2(dirname4(prompt), { recursive: true });
    writeFileSync3(prompt, renderTemplate(readTemplate(ctx, "lane.md"), { ...templateVars(c, ctx, root), id, repo, issue: lane.issue ?? "none", goal: lane.goal || "none", group: lane.group || "none", worktree: wt, branch, base }), { flag: "wx" });
    c.lanes.push(lane);
    saveConfig(root, c);
    await preapprove(ctx, wt, c.launch.preapproveMcp);
  } catch (e) {
    ctx.err(e.message);
    ctx.err(`undo: git -C ${shellQuote(clone)} worktree unlock ${shellQuote(wt)} && git -C ${shellQuote(clone)} worktree remove ${shellQuote(wt)} && git -C ${shellQuote(clone)} branch -D ${shellQuote(branch)}`);
    return 1;
  }
  ctx.out(`next: lanes start ${id}`);
  return 0;
}

// src/lanes/commands/start.ts
import { existsSync as existsSync6, statSync as statSync3 } from "node:fs";

// src/lanes/sessions.ts
import { readdirSync, statSync as statSync2 } from "node:fs";
import { join as join10 } from "node:path";

// src/lanes/processes.ts
async function runningPi(ctx) {
  const result = await ctx.run("pgrep", ["-x", "pi"], { timeoutMs: 1e4 });
  if (result.code !== 0) return [];
  const found = [];
  for (const token of result.stdout.trim().split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue;
    const pid = Number(token);
    let cwd = await ctx.readCwd?.(pid);
    if (!ctx.readCwd) {
      const r = ctx.platform === "darwin" ? await ctx.run("lsof", ["-a", "-p", token, "-d", "cwd", "-Fn"], { timeoutMs: 1e4 }) : await ctx.run("readlink", [`/proc/${pid}/cwd`], { timeoutMs: 1e4 });
      if (r.code !== 0) continue;
      cwd = ctx.platform === "darwin" ? r.stdout.split("\n").find((s) => s.startsWith("n"))?.slice(1) : r.stdout.trim();
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
  const r = await ctx.run("ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: 1e4 });
  const tty = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9/]+$/.test(tty) ? tty : void 0;
}
async function foregroundPi(ctx, tty) {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) return false;
  const r = await ctx.run("ps", ["-t", tty, "-o", "stat=,comm="], { timeoutMs: 1e4 });
  return r.code === 0 && r.stdout.split("\n").some((line) => {
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
    return m?.[1].includes("+") && m[2].split("/").at(-1) === "pi";
  });
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
  const cwd = coordinator ? expand(c.coordinator.cwd, c, root, ctx.home) : join10(expand(c.worktreesDir, c, root, ctx.home), lane.worktree);
  return { id: coordinator ? c.coordinator.id : id, cwd, coordinator, lane };
}
function idleMinutes(cwd, ctx) {
  try {
    const dir = sessionDirFor(cwd, ctx.piAgentDir);
    const times = readdirSync(dir).map((n) => statSync2(join10(dir, n))).filter((s) => s.isFile()).map((s) => s.mtimeMs);
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

// src/lanes/commands/start.ts
async function start(id, opts, c, root, ctx) {
  const { coordinator, lane, cwd } = laneTarget(id, c, root, ctx);
  const prompt = expand(coordinator ? c.coordinator.prompt : lane.prompt, c, root, ctx.home);
  if (!existsSync6(cwd) || !statSync3(cwd).isDirectory()) throw new Error(`cwd not found: ${cwd}`);
  if (!existsSync6(prompt) || !statSync3(prompt).isFile()) throw new Error(`prompt not found: ${prompt}`);
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
  const command = launchCommand(c, root, cwd, coordinator ? c.coordinator.id : id, prompt, wrapper, expand(c.messages.dir, c, root, ctx.home));
  return terminalBackend(backend).start(ctx, { id: coordinator ? c.coordinator.id : id, cwd, command });
}

// src/lanes/commands/send.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { resolve as resolve6 } from "node:path";

// src/lanes/backend.ts
import { mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync5, renameSync as renameSync2, statSync as statSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
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
    mkdirSync3(this.dir, { recursive: true });
    const at = this.now();
    for (let i = 1; ; i++) {
      const name = messageName(m.from, m.to, m.topic, at, i);
      const path = join11(this.dir, name);
      try {
        writeFileSync4(path, m.body, { flag: "wx" });
        return { name, from: m.from, to: [m.to], topic: m.topic, at, path };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }
  async list(filter = {}) {
    let names;
    try {
      names = readdirSync2(this.dir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const messages = [];
    for (const name of names) {
      const parsed = parseMessageName(name);
      if (!parsed) continue;
      const stat = statSync4(join11(this.dir, name));
      if (!stat.isFile()) continue;
      const ref = { name, ...parsed, at: stat.mtime };
      if (filter.from !== void 0 && ref.from !== filter.from) continue;
      if (filter.to !== void 0 && !addressed(ref, filter.to)) continue;
      messages.push(ref);
    }
    return messages.sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name)).slice(0, filter.limit);
  }
  async inbox(lane, opts = {}) {
    const recipients = [lane, "ALL", this.broadcast, ...opts.groups || [], ...opts.aliases || []];
    return (await this.list()).filter((m) => ![lane, ...opts.aliases || []].includes(m.from) && recipients.some((id) => addressed(m, id)));
  }
  async setStatus(lane, line) {
    if (!validId(lane)) throw new Error("invalid lane id");
    const dir = join11(this.dir, "status");
    mkdirSync3(dir, { recursive: true });
    const tmp = join11(dir, `.${lane}-${randomUUID2()}.tmp`);
    writeFileSync4(tmp, `${line}
`, { flag: "wx" });
    renameSync2(tmp, join11(dir, `${lane}.status`));
  }
  async unread(lane, opts = {}) {
    if (!validId(lane)) throw new Error("invalid lane id");
    let since;
    try {
      since = statSync4(join11(this.dir, `${lane}-inbox.marker`)).mtimeMs;
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

// src/lanes/commands/send.ts
async function send(args, opts, c, root, ctx) {
  const [to, topic, file] = args;
  const from = opts.from || ctx.env.PI_ORCH_ID;
  if (!from) throw new UsageError("set --from or PI_ORCH_ID");
  if (!validId(from)) throw new UsageError("invalid from");
  if (!validId(to)) throw new UsageError("invalid to");
  if (!validTopic(topic)) throw new UsageError("invalid topic");
  if (opts.m !== void 0 && file !== void 0) throw new UsageError("choose a file or -m, not both");
  const known = [c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.flatMap((l) => [l.id, l.group])];
  if (!known.includes(to)) ctx.err(`warning: unknown recipient ${to}; sending anyway`);
  const body = opts.m !== void 0 ? opts.m : file && file !== "-" ? readFileSync6(resolve6(ctx.cwd, file), "utf8") : file === "-" || !ctx.stdinTTY ? await ctx.readStdin() : "";
  if (!body.trim()) throw new UsageError("empty message body");
  ctx.out((await backendFor(c, ctx, root).send({ from, to, topic, body })).path);
  return 0;
}

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
    const minutes = idleMinutes(cwd, ctx);
    if (minutes !== void 0 && minutes > Number(opts.minutes ?? c.idle?.minutes ?? 75)) silent.push(`${lane.id}:${minutes}m`);
  }
  if (!silent.length) return 1;
  ctx.out(`silent: ${silent.join(" ")}`);
  return 0;
}

// src/lanes/commands/nudge.ts
async function nudge(id, text, opts, c, root, ctx) {
  text = text.trim().replace(/[\r\n]/g, " ");
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
  if (!await foregroundPi(ctx, tty)) return refuse(`no foreground pi on ${tty} (lane stopped or busy in a subshell)`);
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
import { existsSync as existsSync7, readFileSync as readFileSync7, statSync as statSync6 } from "node:fs";
import { join as join13 } from "node:path";

// src/lanes/joblogs.ts
import { closeSync, openSync, readSync, readdirSync as readdirSync3, statSync as statSync5 } from "node:fs";
import { join as join12 } from "node:path";
function parseWatches(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const [tag, label, until, interval, ...check] = line.split("|");
    if (tag !== "WATCH") return [];
    if (!label || !until || !/^\d+$/.test(interval) || Number(interval) <= 0 || !check.join("|")) throw new Error("invalid WATCH line");
    return [{ label, until, interval: Number(interval), check: check.join("|") }];
  });
}
function chunk(path, length, position) {
  const fd = openSync(path, "r");
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
    const dir = join12(jobs, day(date));
    let names;
    try {
      names = readdirSync3(dir);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const name of names.filter((n) => n.endsWith(".log"))) {
      const path = join12(dir, name);
      const stat = statSync5(path);
      if (!stat.isFile() || !chunk(path, Math.min(4096, stat.size), 0).split("\n")[0].includes(watch.check)) continue;
      const tail = chunk(path, Math.min(65536, stat.size), Math.max(0, stat.size - 65536));
      const last = tail.split("\n").filter((s) => /^--- check .* exit \d+ ---$/.test(s)).at(-1);
      if (watch.until === "success" && /exit 0 ---$/.test(last || "")) continue;
      if (now.getTime() - stat.mtimeMs <= (watch.interval + 90) * 1e3) return true;
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
  const watches = join13(root, "coordinator/WATCHES.md");
  if (!existsSync7(watches)) {
    ctx.out("MISSING coordinator/WATCHES.md");
    bad = true;
  } else for (const w of parseWatches(readFileSync7(watches, "utf8"))) {
    if (liveWatch(join13(ctx.piAgentDir, "jobs"), w, now)) ctx.out(`OK      watch: ${w.label}`);
    else {
      ctx.out(`MISSING watch: ${w.label} -> job_watch until=${w.until} interval=${w.interval} check from coordinator/WATCHES.md`);
      bad = true;
    }
  }
  const unread = await backendFor(c, ctx, root).unread(c.coordinator.id);
  if (unread === void 0) {
    ctx.out("MISSING inbox marker: the coordinator inbox watch has not run");
    bad = true;
  } else {
    const old = unread.filter((m) => now.getTime() - m.at.getTime() > 3e5);
    for (const m of old) ctx.out(`UNREAD  inbox: ${m.name}`);
    if (old.length) bad = true;
    else ctx.out("OK      inbox: no unread backlog");
  }
  const path = join13(root, "coordinator/NOW.md");
  if (!existsSync7(path)) {
    ctx.out("MISSING coordinator/NOW.md");
    bad = true;
  } else {
    await livePrs(readFileSync7(path, "utf8"), ctx);
    const age = Math.floor((now.getTime() - statSync6(path).mtimeMs) / 6e4);
    if (age > 90) {
      ctx.out(`STALE   NOW.md not updated for ${age} min`);
      bad = true;
    }
  }
  const questions = join13(ctx.piAgentDir, "local-packages/pi-questions/dist/cli.js");
  if (existsSync7(questions)) {
    const r = await ctx.run(process.execPath, [questions, "list", "--all"], { timeoutMs: 15e3 });
    for (const line of r.stdout.split("\n").filter((s) => /^Q-\d+/.test(s))) ctx.out(`OPEN    ${line}`);
  }
  return bad ? 1 : 0;
}

// src/lanes/commands/green-prs.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync4, readFileSync as readFileSync8, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join14 } from "node:path";
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
  const ack = join14(root, ".state/green-ack");
  if (opts.ack) {
    mkdirSync4(join14(root, ".state"), { recursive: true });
    writeFileSync5(ack, refs.length ? `${refs.join("\n")}
` : "");
    ctx.out(`acked ${refs.length}`);
    return 0;
  }
  const previous = opts.new && existsSync8(ack) ? readFileSync8(ack, "utf8").split(/\r?\n/) : [];
  const output = opts.new ? refs.filter((r) => !previous.includes(r)) : refs;
  if (output.length) ctx.out(output.join("\n"));
  return opts.new && !output.length ? 1 : 0;
}

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
  else if (unread.length) body.push(`Unread inbox files of ${id} (newer than ${id}-inbox.marker):`, ...unread.map((m) => `- ${m.name}`));
  else body.push(`Unread inbox files of ${id}: none.`);
  return `${body.join("\n")}
`;
}
async function quit(id, pid, cwd, c, root, ctx) {
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
  const pid = await piIn(target.cwd, ctx);
  if (pid && opts.quit && !await quit(id, pid, target.cwd, c, root, ctx)) return 1;
  if (pid && !opts.quit) ctx.err(`${id} is still running; type /quit in its session or use --quit`);
  const backend = backendFor(c, ctx, root);
  const unread = await backend.unread(id, { groups: target.lane?.group ? [target.lane.group] : [] });
  const line = closedLine(to, opts.reason, ctx.now());
  await backend.setStatus(id, line);
  const message = await backend.send({ from, to: c.messages.broadcast, topic: `lane-closed-${id.toLowerCase()}`, body: closeBody(id, to, opts.reason, unread) });
  ctx.out(`${id}: ${line}`);
  ctx.out(message.path);
  const common = await ctx.run("git", ["-C", target.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 1e4 });
  if (common.code !== 0 || !common.stdout.trim()) throw new Error("cannot find clone for worktree removal hint");
  const clone = shellQuote(dirname5(common.stdout.trim()));
  const wt = shellQuote(target.cwd);
  ctx.out(`when merged, remove the worktree: git -C ${clone} worktree unlock ${wt} && git -C ${clone} worktree remove ${wt}`);
  return 0;
}

// src/lanes/commands/status.ts
import { existsSync as existsSync9 } from "node:fs";
import { join as join15 } from "node:path";
async function status(c, root, ctx) {
  const backend = backendFor(c, ctx, root);
  const processes = await runningPi(ctx);
  const rows = [["LANE", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  const lanes = [{ id: c.coordinator.id, repo: "-", branch: "-", group: null, cwd: expand(c.coordinator.cwd, c, root, ctx.home) }, ...c.lanes.map((l) => ({ ...l, cwd: join15(expand(c.worktreesDir, c, root, ctx.home), l.worktree) }))];
  for (const lane of lanes) {
    let pid = "missing";
    if (existsSync9(lane.cwd)) {
      try {
        pid = String(processes.find((p) => p.cwd === ctx.realpath(lane.cwd))?.pid || "-");
      } catch {
      }
    }
    const messages = [...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }), ...await backend.list({ from: lane.id, limit: 1 })].sort((a, b) => b.at.getTime() - a.at.getTime());
    const last = messages[0];
    rows.push([lane.id, lane.repo, lane.branch, pid, String(idleMinutes(lane.cwd, ctx) ?? "-"), await backend.status(lane.id) || "-", last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 6e4))}m)` : "-"]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  ctx.out(rows.map((r) => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  return 0;
}

// src/lanes/main.ts
var HELP = `Usage: lanes [--dir root] <command> [options]
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
var OPTIONS = { init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"], add: ["repo", "issue", "goal", "group", "branch", "base", "path"], start: ["terminal"], send: ["m", "from"], status: [], "idle-check": ["minutes"], nudge: ["terminal"], "resume-check": [], "green-prs": ["new", "ack"], close: ["reassign-to", "reason", "from", "quit"] };
async function main(argv, ctx) {
  let command = "";
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      ctx.out(HELP);
      return 0;
    }
    const positional = [];
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token === "--") {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (token.startsWith("--") || token === "-m") {
        const key = token === "-m" ? "m" : token.slice(2);
        if (["preapprove-mcp", "new", "ack", "quit"].includes(key)) {
          opts[key] = "true";
          continue;
        }
        if (argv[i + 1] === void 0 || argv[i + 1].startsWith("--")) throw new UsageError(`missing value for ${token}`);
        if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
        opts[key] = argv[++i];
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
    const c = loadConfig(root);
    if (command === "add") return await add(positional[0], opts, c, root, ctx);
    if (command === "start") return await start(positional[0], opts, c, root, ctx);
    if (command === "send") return await send(positional, opts, c, root, ctx);
    if (command === "idle-check") return await idleCheck(opts, c, root, ctx);
    if (command === "nudge") return await nudge(positional[0], positional[1], opts, c, root, ctx);
    if (command === "resume-check") return await resumeCheck(c, root, ctx);
    if (command === "green-prs") return await greenPrs(opts, c, root, ctx);
    if (command === "close") return await close(positional[0], opts, c, root, ctx);
    return await status(c, root, ctx);
  } catch (e) {
    ctx.err(e.message);
    return e instanceof UsageError || ["idle-check", "nudge", "resume-check", "green-prs", "close"].includes(command) ? 2 : 1;
  }
}

// src/lanes/cli.ts
if (process.argv[1] && realpathSync2(process.argv[1]) === fileURLToPath2(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realLanesCtx());
}
export {
  main
};
