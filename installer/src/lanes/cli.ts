import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { realLanesCtx, type LanesCtx } from "./ctx.ts";
import { findRoot, loadConfig, UsageError } from "./config.ts";
import { init } from "./commands/init.ts";
import { add } from "./commands/add.ts";
import { start } from "./commands/start.ts";
import { send } from "./commands/send.ts";
import { status } from "./commands/status.ts";

const HELP = `Usage: lanes [--dir root] <command> [options]
  init [dir] [--repos-root p] [--coordinator ID] [--terminal backend] [--preapprove-mcp]
  add <ID> --repo owner/name [--issue n] [--goal text] [--group G] [--branch b] [--base ref] [--path clone]
  start <ID>|coordinator [--terminal backend]
  send <TO> <topic> [file|-] [-m text] [--from ID]
  status
Terminal backends: auto, terminal-app, iterm, tmux, print. Auto falls back to print.
--preapprove-mcp trusts project MCP server definitions in explicitly added repositories.`;
const OPTIONS: Record<string, string[]> = { init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"], add: ["repo", "issue", "goal", "group", "branch", "base", "path"], start: ["terminal"], send: ["m", "from"], status: [] };
export async function main(argv: string[], ctx: LanesCtx): Promise<number> {
  try {
    if (argv.includes("--help") || argv.includes("-h")) { ctx.out(HELP); return 0; }
    const positional: string[] = []; const opts: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token === "--") { positional.push(...argv.slice(i + 1)); break; }
      if (token.startsWith("--") || token === "-m") {
        const key = token === "-m" ? "m" : token.slice(2);
        if (key === "preapprove-mcp") { opts[key] = "true"; continue; }
        if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new UsageError(`missing value for ${token}`);
        if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
        opts[key] = argv[++i];
      } else if (token.startsWith("-") && token !== "-") throw new UsageError(`unknown option ${token}`);
      else positional.push(token);
    }
    const command = positional.shift() || "";
    if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(HELP);
    for (const key of Object.keys(opts)) if (key !== "dir" && !OPTIONS[command].includes(key)) throw new UsageError(`unknown option --${key}`);
    const bounds: Record<string, [number, number]> = { init: [0, 1], add: [1, 1], start: [1, 1], send: [2, 3], status: [0, 0] };
    if (positional.length < bounds[command][0] || positional.length > bounds[command][1]) throw new UsageError(HELP);
    if (command === "init") return await init(positional, opts, ctx);
    const root = findRoot(opts.dir, ctx.env, ctx.cwd); const c = loadConfig(root);
    if (command === "add") return await add(positional[0], opts, c, root, ctx);
    if (command === "start") return await start(positional[0], opts, c, root, ctx);
    if (command === "send") return await send(positional, opts, c, root, ctx);
    return await status(c, root, ctx);
  } catch (e) { ctx.err((e as Error).message); return e instanceof UsageError ? 2 : 1; }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), realLanesCtx());
}
