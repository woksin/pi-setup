import { type LanesCtx } from "./ctx.ts";
import { findRoot, loadConfig, UsageError } from "./config.ts";
import { init } from "./commands/init.ts";
import { add } from "./commands/add.ts";
import { start } from "./commands/start.ts";
import { send } from "./commands/send.ts";
import { idleCheck } from "./commands/idle-check.ts";
import { nudge } from "./commands/nudge.ts";
import { resumeCheck } from "./commands/resume-check.ts";
import { greenPrs } from "./commands/green-prs.ts";
import { close } from "./commands/close.ts";
import { messagesPrune } from "./retention.ts";
import { status } from "./commands/status.ts";

export const HELP = `Usage: lanes [--dir root] <command> [options]
  init [dir] [--repos-root p] [--coordinator ID] [--terminal backend] [--preapprove-mcp]
  add <ID> --repo owner/name [--issue n] [--goal text] [--group G] [--branch b] [--base ref] [--path clone]
  start <ID>|coordinator [--terminal backend]
  send <TO> <topic> [file|-] [-m text] [--from ID]
  status
  messages prune [--dry-run] [--json]
  idle-check [--minutes n]
  nudge <ID|coordinator> <text> [--terminal backend]
  resume-check
  green-prs [--new | --ack]
  close <ID> [--reassign-to ID2] [--reason text] [--from ID] [--quit]
Ops exits: 0 fire/OK, 1 nothing/missing, 2 usage/I/O/gh failure.
Nudge: 0 sent, 3 not sent, 4 tab/pane not found or print.
Terminal backends: auto, terminal-app, iterm, tmux, print. Auto falls back to print.
--preapprove-mcp trusts project MCP server definitions in explicitly added repositories.`;
const OPTIONS: Record<string, string[]> = { init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"], add: ["repo", "issue", "goal", "group", "branch", "base", "path"], start: ["terminal"], send: ["m", "from"], status: [], messages: ["dry-run", "json"], "idle-check": ["minutes"], nudge: ["terminal"], "resume-check": [], "green-prs": ["new", "ack"], close: ["reassign-to", "reason", "from", "quit"] };
export async function main(argv: string[], ctx: LanesCtx): Promise<number> {
  let command = "";
  try {
    if (argv.includes("--help") || argv.includes("-h")) { ctx.out(HELP); return 0; }
    const positional: string[] = []; const opts: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token === "--") { positional.push(...argv.slice(i + 1)); break; }
      if (token.startsWith("--") || token === "-m") {
        const equals = token.startsWith("--") ? token.indexOf("=") : -1;
        const key = token === "-m" ? "m" : token.slice(2, equals < 0 ? undefined : equals);
        if (["preapprove-mcp", "new", "ack", "quit", "dry-run", "json"].includes(key)) {
          if (equals >= 0) throw new UsageError(`unknown option ${token}`);
          opts[key] = "true"; continue;
        }
        if (equals < 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith("--"))) throw new UsageError(`missing value for ${token}`);
        if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
        opts[key] = equals < 0 ? argv[++i] : token.slice(equals + 1);
      } else if (token.startsWith("-") && token !== "-") throw new UsageError(`unknown option ${token}`);
      else positional.push(token);
    }
    command = positional.shift() || "";
    if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(HELP);
    for (const key of Object.keys(opts)) if (key !== "dir" && !OPTIONS[command].includes(key)) throw new UsageError(`unknown option --${key}`);
    const bounds: Record<string, [number, number]> = { init: [0, 1], add: [1, 1], start: [1, 1], send: [2, 3], status: [0, 0], messages: [1, 1], "idle-check": [0, 0], nudge: [2, 2], "resume-check": [0, 0], "green-prs": [0, 0], close: [1, 1] };
    if (positional.length < bounds[command][0] || positional.length > bounds[command][1]) throw new UsageError(HELP);
    if (command === "messages" && positional[0] !== "prune") throw new UsageError(HELP);
    if (opts.minutes !== undefined && (!/^\d+$/.test(opts.minutes) || !Number.isSafeInteger(Number(opts.minutes)) || Number(opts.minutes) <= 0)) throw new UsageError("--minutes must be a positive integer");
    if (command === "init") return await init(positional, opts, ctx);
    const root = findRoot(opts.dir, ctx.env, ctx.cwd); const c = loadConfig(root);
    if (command === "add") return await add(positional[0], opts, c, root, ctx);
    if (command === "start") return await start(positional[0], opts, c, root, ctx);
    if (command === "messages") return messagesPrune(opts, c, root, ctx);
    if (command === "send") return await send(positional, opts, c, root, ctx);
    if (command === "idle-check") return await idleCheck(opts, c, root, ctx);
    if (command === "nudge") return await nudge(positional[0], positional[1], opts, c, root, ctx);
    if (command === "resume-check") return await resumeCheck(c, root, ctx);
    if (command === "green-prs") return await greenPrs(opts, c, root, ctx);
    if (command === "close") return await close(positional[0], opts, c, root, ctx);
    return await status(c, root, ctx);
  } catch (e) { ctx.err((e as Error).message); return e instanceof UsageError || ["idle-check", "nudge", "resume-check", "green-prs", "close"].includes(command) ? 2 : 1; }
}
