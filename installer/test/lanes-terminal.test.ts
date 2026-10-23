import { strict as assert } from "node:assert";
import { test } from "node:test";
import { tempDir, REPO } from "./helpers/home.ts";
import { join } from "node:path";
import { defaults } from "../src/lanes/config.ts";
import { detectBackend, launchCommand, terminalBackend, shellQuote, appleScriptString } from "../src/lanes/terminal.ts";
import { runningPi } from "../src/lanes/processes.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
export function laneCtx(over: Partial<LanesCtx> = {}): LanesCtx {
  const home = tempDir("lanes-ctx");
  return { home, cwd: home, env: {}, platform: "linux", now: () => new Date(2026, 0, 2, 3, 4),
    run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }), which: () => undefined,
    out: () => {}, err: () => {}, stdinTTY: true, readStdin: async () => "", templatesDir: join(REPO, "installer/lanes/templates"),
    piAgentDir: join(home, ".pi/agent"), loadModule: async () => ({}), realpath: (p) => p, ...over };
}
test("terminal auto detection is conservative and explicit backend wins", () => {
  const ctx = laneCtx();
  for (const [env, platform, expected] of [[{}, "linux", "print"], [{ TMUX: "x" }, "linux", "tmux"], [{ TERM_PROGRAM: "iTerm.app" }, "darwin", "iterm"], [{ TERM_PROGRAM: "Apple_Terminal" }, "darwin", "terminal-app"], [{ TERM_PROGRAM: "Apple_Terminal" }, "linux", "print"]] as const) {
    assert.equal(detectBackend("auto", { ...ctx, env, platform }), expected);
    assert.equal(detectBackend("print", { ...ctx, env, platform }), "print");
  }
});
test("all terminal backends quote shell and AppleScript without executing a terminal", async () => {
  const calls: [string, string[]][] = []; const lines: string[] = [];
  const ctx = laneCtx({ out: (s) => lines.push(s), run: async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: "", stderr: "", timedOut: false }; } });
  const c = defaults(ctx.home, ctx.home); const cwd = `/tmp/a 'and "b`;
  const cmd = launchCommand(c, ctx.home, cwd, "L1", "/tmp/prompt", "pi-session", ctx.home);
  assert.ok(cmd.startsWith(`cd ${shellQuote(cwd)} && env -u PI_MCP_CONFIG_MODE PI_ORCH_ID=L1`));
  assert.ok(cmd.endsWith("pi-session '@/tmp/prompt'"));
  assert.equal(await terminalBackend("print").start(ctx, { id: "L1", cwd, command: cmd }), 0); assert.deepEqual(lines, [cmd]); assert.equal(calls.length, 0);
  for (const backend of ["terminal-app", "iterm", "tmux"]) assert.equal(await terminalBackend(backend).start(ctx, { id: "L1", cwd, command: cmd }), 0);
  assert.equal(calls[0][0], "osascript"); assert.ok(calls[0][1].join(" ").includes(appleScriptString(cmd)));
  assert.ok(calls[1][1].join(" ").includes("create window with default profile"));
  assert.ok(calls.some(([name, args]) => name === "tmux" && args.includes("new-window")));
  calls.length = 0; ctx.env.TMUX = "yes"; await terminalBackend("tmux").start(ctx, { id: "L1", cwd, command: cmd }); assert.equal(calls[0][1][0], "new-window");
  ctx.env = {}; ctx.run = async (name, args) => { calls.push([name, args]); return { code: 1, stdout: "", stderr: "no", timedOut: false }; };
  assert.equal(await terminalBackend("terminal-app").start(ctx, { id: "L1", cwd, command: cmd }), 1); assert.equal(lines.at(-1), cmd);
  assert.equal(await terminalBackend("tmux").start(ctx, { id: "L1", cwd, command: cmd }), 1);
  assert.ok(calls.some(([, args]) => args[0] === "new-session"));
});
test("running pi uses exact pids and resolves cwd on both platforms", async () => {
  for (const platform of ["darwin", "linux"]) {
    const calls: string[] = [];
    const ctx = laneCtx({ platform, realpath: (p) => p.replace("alias", "real"), run: async (name, args) => { calls.push(`${name} ${args.join(" ")}`); return { code: 0, stdout: name === "pgrep" ? "12\n34\n" : platform === "darwin" ? "p12\nn/tmp/alias\n" : "/tmp/alias\n", stderr: "", timedOut: false }; } });
    assert.deepEqual(await runningPi(ctx), [{ pid: 12, cwd: "/tmp/real" }, { pid: 34, cwd: "/tmp/real" }]);
    assert.equal(calls[0], "pgrep -x pi"); assert.match(calls[1], platform === "darwin" ? /^lsof -a -p 12 -d cwd -Fn$/ : /^readlink \/proc\/12\/cwd$/);
  }
  assert.deepEqual(await runningPi(laneCtx()), []);
});
