import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { client, TrainError, realContext } from './train-gh.mjs';
import { repoKey } from './train-manifest.mjs';
import { initTrain, repository } from './train-init.mjs';
import { foldTrain } from './train-fold.mjs';
import { statusTrains } from './train-status.mjs';
import { adoptTrain } from './train-adopt.mjs';
import { shipTrain } from './train-ship.mjs';
import { manageHook } from './train-hook.mjs';
import { stdinGuard } from './train-push.mjs';

export { realContext };
export const HELP = `Usage: pi-train [--repo-dir path] [--dry-run] [--json] <command>
  init <repo-dir> <train-branch> [--from origin/main] [--worktree path]
  init --adopt <repo-dir> <existing-train-branch> [--base origin/main]
  fold <PR#|branch> [--train branch] [--allow-foreign]
  planned <PR#> <train-branch> [--allow-foreign]
  status [--all] [--train branch] [--json]
  ship [--train branch] [--label major|minor|patch|no-release] [--summary-file f] [--title text] [--allow-behind]
  hook install|uninstall
  guard --stdin [--push-url url]

Manifest store: \$PI_TRAIN_DIR or ~/.pi/trains. Dry runs print commands and change nothing.
Local train packages are not implemented in this slice.`;

const FLAGS = new Map(Object.entries({ '--dry-run': 'dryRun', '--json': 'json', '--all': 'all', '--allow-foreign': 'allowForeign',
  '--adopt': 'adopt', '--allow-behind': 'allowBehind', '--stdin': 'stdin' }));
const VALUES = new Map(Object.entries({ '--repo-dir': 'repoDir', '--train': 'train', '--from': 'from', '--worktree': 'worktree',
  '--base': 'base', '--label': 'label', '--summary-file': 'summaryFile', '--title': 'title', '--push-url': 'pushUrl' }));

function takeValue(argv, flag) {
  const value = argv.shift();
  if (!value || value.startsWith('-')) throw new TrainError(`missing value for ${flag}`, 2);
  return value;
}

const OPTION_GROUPS = [
  { command: 'status', keys: ['all'], message: '--all is only valid for status' },
  { command: 'init', keys: ['from', 'worktree'], message: '--from/--worktree require init' },
  { command: 'init', keys: ['adopt', 'base'], message: '--adopt/--base require init' },
  { command: 'ship', keys: ['label', 'summaryFile', 'title', 'allowBehind'], message: 'ship options require ship' },
  { command: 'guard', keys: ['stdin', 'pushUrl'], message: '--stdin/--push-url require guard' },
];

function validateAdopt(options) {
  if (options.base && !options.adopt) throw new TrainError('--base requires --adopt', 2);
  if (options.adopt && [options.from, options.worktree].some(Boolean)) throw new TrainError('--adopt cannot use --from/--worktree', 2);
}

function validateOptions(command, options) {
  for (const group of OPTION_GROUPS) {
    if (command === group.command) continue;
    if (group.keys.some(key => options[key])) throw new TrainError(group.message, 2);
  }
  validateAdopt(options);
  if (command === 'guard' && !options.stdin) throw new TrainError('guard requires --stdin', 2);
}

function addArgument(argv, parsed) {
  const arg = argv.shift();
  if (FLAGS.has(arg)) parsed.options[FLAGS.get(arg)] = true;
  else if (VALUES.has(arg)) parsed.options[VALUES.get(arg)] = takeValue(argv, arg);
  else if (arg.startsWith('-')) throw new TrainError(`unknown option: ${arg}`, 2);
  else parsed.positionals.push(arg);
}

function validateArity(command, args) {
  const arity = new Map(Object.entries({ init: 2, fold: 1, planned: 2, status: 0, ship: 0, hook: 1, guard: 0 }));
  if (args.length !== arity.get(command)) throw new TrainError(HELP, 2);
}

function parse(input) {
  const argv = [...input], parsed = { options: {}, positionals: [] };
  while (argv.length) addArgument(argv, parsed);
  const [command, ...args] = parsed.positionals;
  validateArity(command, args);
  validateOptions(command, parsed.options);
  return { options: parsed.options, command, args };
}

async function runGuard(ctx, options, repo) {
  if (options.pushUrl && repoKey(options.pushUrl) !== repo) return 0;
  return stdinGuard(ctx, repo, ctx.stdin ?? readFileSync(0, 'utf8'));
}

async function mutateTrain(ctx, api, request, repo) {
  const { options, command, args } = request;
  if (command === 'ship') return shipTrain(ctx, api, options, repo);
  if (command === 'init') return (options.adopt ? adoptTrain : initTrain)(ctx, api, { ...options, repo, args });
  return foldTrain(ctx, api, { options, repo, args, planned: command === 'planned' });
}

async function commandRepo(ctx, api, request) {
  if (request.command === 'status' && request.options.all) return null;
  const repoDir = request.command === 'init' ? resolve(ctx.cwd, request.args[0]) : ctx.cwd;
  return repoKey(await repository(api, repoDir));
}

async function dispatch(ctx, request) {
  const { options, command, args } = request;
  const api = client(ctx, options);
  if (command === 'hook') { await manageHook(ctx, api, args[0], options.dryRun); return 0; }
  const repo = await commandRepo(ctx, api, request);
  if (command === 'status') return statusTrains(ctx, api, options, repo);
  if (command === 'guard') return runGuard(ctx, options, repo);
  await mutateTrain(ctx, api, request, repo);
  return 0;
}

function repoContext(context, request) {
  return { ...context, cwd: resolve(context.cwd, request.options.repoDir ?? '.') };
}

function errorStatus(error, request) {
  if (request?.command === 'guard') return 2;
  return error instanceof TrainError ? error.code : 2;
}

function reportError(context, error, request) {
  context.err(error.message);
  return errorStatus(error, request);
}

export async function main(argv, context = realContext()) {
  if (argv.includes('--help') || argv.includes('-h')) { context.out(HELP); return 0; }
  let request;
  try {
    request = parse(argv);
    return await dispatch(repoContext(context, request), request);
  } catch (error) {
    return reportError(context, error, request);
  }
}
