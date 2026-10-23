import { resolve } from 'node:path';
import { client, TrainError, realContext } from './train-gh.mjs';
import { repoKey } from './train-manifest.mjs';
import { initTrain, repository } from './train-init.mjs';
import { foldTrain } from './train-fold.mjs';
import { statusTrains } from './train-status.mjs';

export { realContext };
export const HELP = `Usage: pi-train [--repo-dir path] [--dry-run] [--json] <command>
  init <repo-dir> <train-branch> [--from origin/main] [--worktree path]
  fold <PR#|branch> [--train branch] [--allow-foreign]
  planned <PR#> <train-branch> [--allow-foreign]
  status [--all] [--train branch] [--json]

Manifest store: \$PI_TRAIN_DIR or ~/.pi/trains. Dry runs print commands and change nothing.
Ship, push guards and local packages are not implemented in this slice.`;

const FLAGS = new Map(Object.entries({ '--dry-run': 'dryRun', '--json': 'json', '--all': 'all', '--allow-foreign': 'allowForeign' }));
const VALUES = new Map(Object.entries({ '--repo-dir': 'repoDir', '--train': 'train', '--from': 'from', '--worktree': 'worktree' }));

function takeValue(argv, flag) {
  const value = argv.shift();
  if (!value || value.startsWith('-')) throw new TrainError(`missing value for ${flag}`, 2);
  return value;
}

function validateOptions(command, options) {
  if (options.all && command !== 'status') throw new TrainError('--all is only valid for status', 2);
  const initOnly = options.from || options.worktree;
  if (initOnly && command !== 'init') throw new TrainError('--from/--worktree require init', 2);
}

function parse(input) {
  const argv = [...input], options = {}, positionals = [];
  while (argv.length) {
    const arg = argv.shift();
    if (FLAGS.has(arg)) options[FLAGS.get(arg)] = true;
    else if (VALUES.has(arg)) options[VALUES.get(arg)] = takeValue(argv, arg);
    else if (arg.startsWith('-')) throw new TrainError(`unknown option: ${arg}`, 2);
    else positionals.push(arg);
  }
  const [command, ...args] = positionals;
  const arity = new Map(Object.entries({ init: 2, fold: 1, planned: 2, status: 0 }));
  if (args.length !== arity.get(command)) throw new TrainError(HELP, 2);
  validateOptions(command, options);
  return { options, command, args };
}

async function dispatch(ctx, request) {
  const { options, command, args } = request;
  const api = client(ctx, options);
  const repoDir = command === 'init' ? resolve(ctx.cwd, args[0]) : ctx.cwd;
  const allRepos = command === 'status' && options.all;
  const repo = allRepos ? null : repoKey(await repository(api, repoDir));
  if (command === 'status') return statusTrains(ctx, api, options, repo);
  if (command === 'init') await initTrain(ctx, api, { ...options, repo, args });
  else await foldTrain(ctx, api, { options, repo, args, planned: command === 'planned' });
  return 0;
}

export async function main(argv, context = realContext()) {
  if (argv.includes('--help') || argv.includes('-h')) { context.out(HELP); return 0; }
  try {
    const request = parse(argv);
    const ctx = { ...context, cwd: resolve(context.cwd, request.options.repoDir ?? '.') };
    return await dispatch(ctx, request);
  } catch (error) {
    context.err(error.message);
    return error instanceof TrainError ? error.code : 2;
  }
}
