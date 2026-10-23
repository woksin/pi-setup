import { join } from "node:path";
import { BACKENDS, UsageError, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";

export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
export const appleScriptString = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
export function detectBackend(configured: string, ctx: Pick<LanesCtx, "env" | "platform">): string {
  if (!BACKENDS.includes(configured)) throw new UsageError("invalid terminal.backend");
  if (configured !== "auto") return configured;
  if (ctx.env.TMUX) return "tmux";
  if (ctx.platform === "darwin" && ctx.env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (ctx.platform === "darwin" && ctx.env.TERM_PROGRAM === "Apple_Terminal") return "terminal-app";
  return "print";
}
export function launchCommand(c: Config, root: string, cwd: string, id: string, prompt: string, wrapper: string, messages: string): string {
  const unset = c.launch.unsetEnv.map((name) => `-u ${name}`).join(" ");
  const exe = /^[A-Za-z0-9_/-]+$/.test(wrapper) ? wrapper : shellQuote(wrapper);
  return `cd ${shellQuote(cwd)} && env ${unset ? `${unset} ` : ""}PI_ORCH_ID=${id} LANES_DIR=${shellQuote(root)} INBOX_DIR=${shellQuote(messages)} LANE_STATUS_DIR=${shellQuote(join(messages, "status"))} ${exe} ${shellQuote(`@${prompt}`)}`;
}
interface Launch { id: string; cwd: string; command: string }
export interface TerminalBackend { start(ctx: LanesCtx, launch: Launch): Promise<number> }
export function terminalBackend(name: string): TerminalBackend {
  if (!BACKENDS.includes(name) || name === "auto") throw new UsageError("invalid terminal.backend");
  return { async start(ctx, { id, cwd, command }) {
    if (name === "print") { ctx.out(command); return 0; }
    let cmd: string; let args: string[];
    if (name === "terminal-app") {
      cmd = "osascript"; args = ["-e", `tell application "Terminal" to do script "${appleScriptString(command)}"`, "-e", 'tell application "Terminal" to activate'];
    } else if (name === "iterm") {
      cmd = "osascript"; args = ["-e", `tell application "iTerm2"\ncreate window with default profile\ntell current session of current window to write text "${appleScriptString(command)}"\nactivate\nend tell`];
    } else {
      cmd = "tmux";
      if (ctx.env.TMUX) args = ["new-window", "-n", id, "-c", cwd];
      else {
        const exists = (await ctx.run("tmux", ["has-session", "-t", "lanes"], { timeoutMs: 10000 })).code === 0;
        args = exists ? ["new-window", "-t", "lanes", "-n", id, "-c", cwd] : ["new-session", "-d", "-s", "lanes", "-n", id, "-c", cwd];
      }
      args.push(`sh -c ${shellQuote(command)}`);
    }
    const result = await ctx.run(cmd, args, { timeoutMs: 30000 });
    if (result.code !== 0) { ctx.err(`${cmd} failed: ${result.stderr.trim()}`); ctx.out(command); return 1; }
    if (name === "tmux" && !ctx.env.TMUX) ctx.out("attach with: tmux attach -t lanes");
    return 0;
  } };
}
