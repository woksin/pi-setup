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
export interface TerminalBackend {
  quit(ctx: LanesCtx, tty: string, beforeSend: () => Promise<void>): Promise<"sent" | "not-found">;
  start(ctx: LanesCtx, launch: Launch): Promise<number>;
  nudge(ctx: LanesCtx, input: { tty: string; text: string }): Promise<"sent" | "not-found">;
}
export function terminalBackend(name: string): TerminalBackend {
  if (!BACKENDS.includes(name) || name === "auto") throw new UsageError("invalid terminal.backend");
  return { quit: (ctx, tty, guard) => nudgeTerminal(name, ctx, { tty, text: "/quit" }, guard), nudge: (ctx, input) => nudgeTerminal(name, ctx, input), async start(ctx, { id, cwd, command }) {
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

async function nudgeTerminal(name: string, ctx: LanesCtx, { tty, text }: { tty: string; text: string }, beforeSend?: () => Promise<void>): Promise<"sent" | "not-found"> {
  if (!/^[A-Za-z0-9/]+$/.test(tty)) throw new UsageError("invalid tty");
  if (name === "print") return "not-found";
  if (name === "tmux") {
    const panes = await ctx.run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"], { timeoutMs: 10000 });
    if (panes.code !== 0) throw new Error("tmux list-panes failed");
    const pane = panes.stdout.split("\n").map((s) => s.trim().split(/\s+/)).find(([t]) => t === `/dev/${tty}`)?.[1];
    if (!pane) return "not-found";
    await guardQuit(beforeSend);
    for (const args of [["send-keys", "-t", pane, "-l", "--", text], ["send-keys", "-t", pane, "Enter"]]) {
      if ((await ctx.run("tmux", args, { timeoutMs: 10000 })).code !== 0) throw new Error("tmux send-keys failed");
    }
    return "sent";
  }
  const escaped = appleScriptString(text);
  const script = name === "terminal-app"
    ? `tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is "/dev/${tty}" then
do script "${escaped}" in t
return "sent"
end if
end repeat
end repeat
return "not-found"
end tell`
    : `tell application "iTerm2"
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
  const result = await ctx.run("osascript", ["-e", script], { timeoutMs: 10000 });
  if (result.code !== 0) throw new Error(`osascript failed: ${result.stderr.trim()}`);
  return result.stdout.trim() === "sent" ? "sent" : "not-found";
}

async function guardQuit(guard?: () => Promise<void>): Promise<void> { if (guard) await guard(); }
