import { handoff } from "./commands/handoff.ts";
import { reap } from "./commands/reap.ts";
import { snooze } from "./commands/snooze.ts";
import { type LanesCtx } from "./ctx.ts";
import { findRoot, loadConfig, UsageError, type Config } from "./config.ts";
import { init } from "./commands/init.ts";
import { adopt } from "./commands/adopt.ts";
import { add } from "./commands/add.ts";
import { resume, startCommand } from "./commands/resume.ts";
import { send } from "./commands/send.ts";
import { idleCheck } from "./commands/idle-check.ts";
import { nudge } from "./commands/nudge.ts";
import { resumeCheck } from "./commands/resume-check.ts";
import { greenPrs } from "./commands/green-prs.ts";
import { close } from "./commands/close.ts";
import { messagesPrune } from "./retention.ts";
import { status } from "./commands/status.ts";

export const HELP = `Usage: lanes [--dir root] <command> [options]
  adopt [--messages dir] [--coordinator ID] [--exclude-tty ttysNNN ...] [--inventory file] [--role ID=role ...] [--orchestrates ID=owner/repo,owner/repo ...] [--write]
  init [dir] [--repos-root p] [--coordinator ID] [--terminal backend] [--preapprove-mcp]
  add <ID> --repo owner/name [--issue n] [--goal text] [--group G] [--branch b] [--base ref] [--path clone]
    [--orchestrator ID | --orchestrator-id ID | --no-orchestrator]
  start <ID>|coordinator [--terminal backend] [--from-handoff ID|file]
  resume <ID> [--terminal backend]
  send <TO> <topic> [file|-] [-m text] [--from ID] [--direct]
  status [--all]
  messages prune [--dry-run] [--json] [--legacy [--legacy-age hours] [--apply]]
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
const OPTIONS: Record<string, string[]> = {
  adopt: ["messages", "coordinator", "exclude-tty", "inventory", "role", "orchestrates", "write"],
  init: ["repos-root", "coordinator", "terminal", "preapprove-mcp"],
  add: ["repo", "issue", "goal", "group", "branch", "base", "path",
    "orchestrator", "orchestrator-id", "no-orchestrator"],
  start: ["terminal", "from-handoff"], resume: ["terminal"], send: ["m", "from", "direct"],
  status: ["all"], messages: ["dry-run", "json", "legacy", "legacy-age", "apply"],
  "idle-check": ["minutes"], nudge: ["terminal"], "resume-check": [], "green-prs": ["new", "ack"],
  handoff: ["to", "accept", "from"], reap: ["minutes", "dry-run", "json", "apply", "handoff-to"],
  snooze: ["until", "clear"],
  close: ["reassign-to", "reason", "from", "quit", "inactive", "json", "minutes", "dry-run", "apply", "handoff-to"],
};
const FLAGS = ["write", "preapprove-mcp", "new", "ack", "quit", "dry-run", "json", "direct", "all",
  "no-orchestrator", "inactive", "clear", "apply", "accept", "legacy"];
interface Invocation { command: string; positional: string[]; opts: Record<string, string> }
interface CommandEnv { c: Config; root: string; ctx: LanesCtx }
interface ParsePosition { argv: string[]; index: number }

function parseOption(argv: string[], i: number, opts: Record<string, string>): number {
  const token = argv[i];
  const { equals, key } = optionName({ argv, index: i });
  if (FLAGS.includes(key)) {
    if (equals >= 0) throw new UsageError(`unknown option ${token}`);
    opts[key] = "true"; return i;
  }
  if (equals < 0) requireValue({ argv, index: i });
  if (["exclude-tty", "role", "orchestrates"].includes(key)) return parseRepeated(argv, i, opts, equals);
  return parseSingleOption({ argv, index: i }, opts, { key, equals });
}
function parseSingleOption({ argv, index: i }: ParsePosition, opts: Record<string, string>, { key, equals }: { key: string; equals: number }): number {
  const token = argv[i];
  if (Object.hasOwn(opts, key)) throw new UsageError(`duplicate option ${token}`);
  opts[key] = equals < 0 ? argv[++i] : token.slice(equals + 1);
  return i;
}
function parseRepeated(argv: string[], i: number, opts: Record<string, string>, equals: number): number {
  const { key } = optionName({ argv, index: i });
  const values = [equals < 0 ? argv[++i] : argv[i].slice(equals + 1)];
  if (key === "exclude-tty") i = consumeTtys({ argv, index: i, values });
  opts[key] = [opts[key], ...values].filter(Boolean).join(key === "orchestrates" ? ";" : ",");
  return i;
}
function consumeTtys({ argv, index: i, values }: ParsePosition & { values: string[] }): number {
  while (argv[i + 1] && /^ttys\d+$/.test(argv[i + 1])) values.push(argv[++i]);
  return i;
}
function requireValue({ argv, index }: ParsePosition): void {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`missing value for ${argv[index]}`);
}
function parse(argv: string[]): Omit<Invocation, "command"> {
  const positional: string[] = []; const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (token.startsWith("--") || token === "-m") i = parseOption(argv, i, opts);
    else appendPositional({ argv, index: i }, positional);
  }
  return { positional, opts };
}
function validateInvocation({ command, positional, opts }: Invocation): void {
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(HELP);
  validateOptions({ command, opts });
  const bounds: Record<string, [number, number]> = {
    adopt: [0, 0], init: [0, 1], add: [1, 1], start: [1, 1], resume: [1, 1], send: [2, 3], status: [0, 0], messages: [1, 1],
    "idle-check": [0, 0], nudge: [2, 2], "resume-check": [0, 0], "green-prs": [0, 0], handoff: [1, 1],
    reap: [0, 1], snooze: [1, 1], close: [opts.inactive ? 0 : 1, 1],
  };
  validateBounds(positional, bounds[command]);
  if (command === "messages" && positional[0] !== "prune") throw new UsageError(HELP);
  validateMinutes(opts.minutes);
}
function validateMinutes(minutes: string | undefined): void {
  if (minutes === undefined) return;
  if (invalidMinutes(minutes)) {
    throw new UsageError("--minutes must be a positive integer");
  }
}
async function dispatch(input: Invocation, env: CommandEnv): Promise<number> {
  const { command, positional: args, opts } = input; const { c, root, ctx } = env;
  const handlers: Record<string, () => number | Promise<number>> = {
    add: () => add(args[0], opts, c, root, ctx), start: () => startCommand(args[0], opts, env),
    resume: () => resume(args, opts, env),
    messages: () => messagesPrune(opts, c, root, ctx), send: () => send(args, opts, c, root, ctx),
    "idle-check": () => idleCheck(opts, c, root, ctx), nudge: () => nudge(args[0], args[1], opts, c, root, ctx),
    "resume-check": () => resumeCheck(c, root, ctx), "green-prs": () => greenPrs(opts, c, root, ctx),
    handoff: () => handoff(args, opts, env), snooze: () => snooze(args, opts, env),
    reap: () => reap(args, opts, env), close: () => closeCommand(input, env),
    status: () => status(c, root, ctx, Boolean(opts.all)),
  };
  return await handlers[command]();
}
function closeCommand({ positional, opts }: Invocation, env: CommandEnv): Promise<number> {
  if (opts.inactive) return reap(positional, opts, env);
  return close(positional[0], opts, env.c, env.root, env.ctx);
}
function errorCode({ e, command }: { e: unknown; command: string }): number {
  return e instanceof UsageError || ["idle-check", "nudge", "resume-check", "green-prs", "close", "reap",
    "snooze", "handoff"].includes(command) ? 2 : 1;
}
export async function main(argv: string[], ctx: LanesCtx): Promise<number> {
  let command = "";
  try {
    if (argv.includes("--help") || argv.includes("-h")) { ctx.out(HELP); return 0; }
    const { positional, opts } = parse(argv); command = positional.shift() || "";
    const input = { command, positional, opts }; validateInvocation(input);
    if (command === "init") return await init(positional, opts, ctx);
    if (command === "adopt") return await adopt(opts, ctx);
    const root = findRoot(opts.dir, ctx.env, ctx.cwd); const c = loadConfig(root);
    return await dispatch(input, { c, root, ctx });
  } catch (e) { ctx.err((e as Error).message); return errorCode({ e, command }); }
}

function optionName({ argv, index }: ParsePosition): { equals: number; key: string } {
  const token = argv[index];
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  const key = token === "-m" ? "m" : token.slice(2, equals < 0 ? undefined : equals);
  return { equals, key };
}
function validateOptions({ command, opts }: Pick<Invocation, "command" | "opts">): void {
  for (const key of Object.keys(opts)) {
    if (key !== "dir" && !OPTIONS[command].includes(key)) throw new UsageError(`unknown option --${key}`);
  }
}
function invalidMinutes(minutes: string): boolean {
  if (!/^\d+$/.test(minutes)) return true;
  return !Number.isSafeInteger(Number(minutes)) || Number(minutes) <= 0;
}

function validateBounds(args: string[], bounds: [number, number]): void {
  if (args.length < bounds[0] || args.length > bounds[1]) throw new UsageError(HELP);
}

function appendPositional({ argv, index }: ParsePosition, positional: string[]): void {
  const token = argv[index];
  if (token.startsWith("-") && token !== "-") throw new UsageError(`unknown option ${token}`);
  positional.push(token);
}
