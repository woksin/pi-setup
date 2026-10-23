#!/usr/bin/env node
// pi-setup-source-sha256: bd47dede76ad5ae998e9cbc57145f7ccc5b435a2c865a3677333991a4343bf5a

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
      for await (const chunk of process.stdin) text += chunk;
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
  return { async start(ctx, { id, cwd, command }) {
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
        skip(`invalid .mcp.json (${join8(cwd, file)})`);
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
import { existsSync as existsSync6, statSync as statSync2 } from "node:fs";
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

// src/lanes/commands/start.ts
async function start(id, opts, c, root, ctx) {
  const coordinator = id === "coordinator" || id === c.coordinator.id;
  const lane = c.lanes.find((l) => l.id === id);
  if (!coordinator && !lane) throw new Error(`lane not found: ${id}`);
  const cwd = coordinator ? expand(c.coordinator.cwd, c, root, ctx.home) : join10(expand(c.worktreesDir, c, root, ctx.home), lane.worktree);
  const prompt = expand(coordinator ? c.coordinator.prompt : lane.prompt, c, root, ctx.home);
  if (!existsSync6(cwd) || !statSync2(cwd).isDirectory()) throw new Error(`cwd not found: ${cwd}`);
  if (!existsSync6(prompt) || !statSync2(prompt).isFile()) throw new Error(`prompt not found: ${prompt}`);
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
import { mkdirSync as mkdirSync3, readdirSync, readFileSync as readFileSync5, statSync as statSync3, writeFileSync as writeFileSync4 } from "node:fs";
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
      names = readdirSync(this.dir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const messages = [];
    for (const name of names) {
      const parsed = parseMessageName(name);
      if (!parsed) continue;
      const stat = statSync3(join11(this.dir, name));
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

// src/lanes/commands/status.ts
import { existsSync as existsSync7, readdirSync as readdirSync2, statSync as statSync4 } from "node:fs";
import { join as join12 } from "node:path";
function idle(cwd, ctx) {
  try {
    const dir = sessionDirFor(cwd, ctx.piAgentDir);
    const times = readdirSync2(dir).map((n) => statSync4(join12(dir, n))).filter((s) => s.isFile()).map((s) => s.mtimeMs);
    return times.length ? String(Math.max(0, Math.floor((ctx.now().getTime() - Math.max(...times)) / 6e4))) : "-";
  } catch {
    return "-";
  }
}
async function status(c, root, ctx) {
  const backend = backendFor(c, ctx, root);
  const processes = await runningPi(ctx);
  const rows = [["LANE", "REPO", "BRANCH", "RUN", "IDLE", "STATUS", "LAST MESSAGE"]];
  const lanes = [{ id: c.coordinator.id, repo: "-", branch: "-", group: null, cwd: expand(c.coordinator.cwd, c, root, ctx.home) }, ...c.lanes.map((l) => ({ ...l, cwd: join12(expand(c.worktreesDir, c, root, ctx.home), l.worktree) }))];
  for (const lane of lanes) {
    let pid = "missing";
    if (existsSync7(lane.cwd)) {
      try {
        pid = String(processes.find((p) => p.cwd === ctx.realpath(lane.cwd))?.pid || "-");
      } catch {
      }
    }
    const messages = [...await backend.inbox(lane.id, { groups: lane.group ? [lane.group] : [] }), ...await backend.list({ from: lane.id, limit: 1 })].sort((a, b) => b.at.getTime() - a.at.getTime());
    const last = messages[0];
    rows.push([lane.id, lane.repo, lane.branch, pid, idle(lane.cwd, ctx), await backend.status(lane.id) || "-", last ? `${last.name} (${Math.max(0, Math.floor((ctx.now().getTime() - last.at.getTime()) / 6e4))}m)` : "-"]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  ctx.out(rows.map((r) => r.map((s, i) => i === r.length - 1 ? s : s.padEnd(widths[i])).join("  ")).join("\n"));
  return 0;
}

// src/lanes/cli.ts
var HELP = `Usage: lanes [--dir root] <command> [options]
  init [dir] [--repos-root p] [--coordinator ID] [--terminal backend] [--preapprove-mcp]
  add <ID> --repo owner/name [--issue n] [--goal text] [--group G] [--branch b] [--base ref] [--path clone]
  start <ID>|coordinator [--terminal backend]
  send <TO> <topic> [file|-] [-m text] [--from ID]
  status
Terminal backends: auto, terminal-app, iterm, tmux, print. Auto falls back to print.
--preapprove-mcp trusts project MCP server definitions in explicitly added repositories.`;
var OPTIONS = { init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"], add: ["repo", "issue", "goal", "group", "branch", "base", "path"], start: ["terminal"], send: ["m", "from"], status: [] };
async function main(argv, ctx) {
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
        if (key === "preapprove-mcp") {
          opts[key] = "true";
          continue;
        }
        if (argv[i + 1] === void 0 || argv[i + 1].startsWith("--")) throw new UsageError(`missing value for ${token}`);
        if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
        opts[key] = argv[++i];
      } else if (token.startsWith("-") && token !== "-") throw new UsageError(`unknown option ${token}`);
      else positional.push(token);
    }
    const command = positional.shift() || "";
    if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(HELP);
    for (const key of Object.keys(opts)) if (key !== "dir" && !OPTIONS[command].includes(key)) throw new UsageError(`unknown option --${key}`);
    const bounds = { init: [0, 1], add: [1, 1], start: [1, 1], send: [2, 3], status: [0, 0] };
    if (positional.length < bounds[command][0] || positional.length > bounds[command][1]) throw new UsageError(HELP);
    if (command === "init") return await init(positional, opts, ctx);
    const root = findRoot(opts.dir, ctx.env, ctx.cwd);
    const c = loadConfig(root);
    if (command === "add") return await add(positional[0], opts, c, root, ctx);
    if (command === "start") return await start(positional[0], opts, c, root, ctx);
    if (command === "send") return await send(positional, opts, c, root, ctx);
    return await status(c, root, ctx);
  } catch (e) {
    ctx.err(e.message);
    return e instanceof UsageError ? 2 : 1;
  }
}
if (process.argv[1] && realpathSync2(process.argv[1]) === fileURLToPath2(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realLanesCtx());
}
export {
  main
};
