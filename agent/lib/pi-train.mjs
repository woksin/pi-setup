import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { client, TrainError, realContext } from './train-gh.mjs';
import { repoKey, listManifests } from './train-manifest.mjs';
import { scanRepository } from './train-concurrency.mjs';
import { initTrain, repository } from './train-init.mjs';
import { foldTrain } from './train-fold.mjs';
import { statusTrains } from './train-status.mjs';
import { adoptTrain } from './train-adopt.mjs';
import { shipTrain } from './train-ship.mjs';
import { manageHook } from './train-hook.mjs';
import { stdinGuard } from './train-push.mjs';
import { parseDuration, parseEta, setEta } from './train-eta.mjs';
import { closeTrain } from './train-close.mjs';

export { realContext };
export const HELP = `Usage: pi-train [--repo-dir path] [--dry-run] [--json] <command>
  init <repo-dir> <train-branch> [--from origin/main] [--worktree path]
  init --adopt <repo-dir> <existing-train-branch> [--base origin/main]
  fold [PR#|branch] [--train branch] [--allow-foreign] [--eta when]
  planned <PR#> <train-branch> [--allow-foreign] [--eta when]
  eta <PR#|branch> <when|clear> [--train branch]
  concurrency [--json]
  status [--all] [--train branch] [--json] [--gate duration]
  ship [--train branch] [--label major|minor|patch|no-release] [--summary-file f] [--title text] [--allow-behind] [--allow-unconfigured-gate]
  close [train-branch] [--shipped PR#] [--head sha] | [--abandoned]   (manifest only; works when the worktree is gone)
  hook install|uninstall
  guard --stdin [--push-url url]

Manifest store: \$PI_TRAIN_DIR or ~/.pi/trains. Dry runs print commands and change nothing.
ETA: ISO 8601 with timezone or +90m/+2h/+1d. Gate duration: e.g. 90m or 2h.
Local train packages are not implemented in this slice.

Examples:
  pi-train status --all                         # read-only
  pi-train --dry-run ship --train my-train      # prints commands, changes nothing
  pi-train init . my-train --from origin/main   # state-changing: creates a train
Exit codes:
  0 ok
  1 a failed step reported by a command
  2 usage error or refused request
See also: docs/reference.md, README.md`;

const FLAGS = new Map(Object.entries({ '--dry-run': 'dryRun', '--json': 'json', '--all': 'all', '--allow-foreign': 'allowForeign',
  '--adopt': 'adopt', '--allow-behind': 'allowBehind', '--allow-unconfigured-gate': 'allowUnconfiguredGate', '--stdin': 'stdin', '--abandoned': 'abandoned' }));
const VALUES = new Map(Object.entries({ '--repo-dir': 'repoDir', '--train': 'train', '--from': 'from', '--worktree': 'worktree',
  '--base': 'base', '--label': 'label', '--summary-file': 'summaryFile', '--title': 'title', '--push-url': 'pushUrl', '--eta': 'eta', '--gate': 'gate',
  '--shipped': 'shipped', '--head': 'head' }));

function takeValue(argv, flag) {
  const value = argv.shift();
  if (!value || value.startsWith('-')) throw new TrainError(`missing value for ${flag}`, 2);
  return value;
}

const OPTION_GROUPS = [
  { command: 'status', keys: ['all'], message: '--all is only valid for status' },
  { command: 'status', keys: ['gate'], message: '--gate is only valid for status' },
  { command: 'init', keys: ['from', 'worktree'], message: '--from/--worktree require init' },
  { command: 'init', keys: ['adopt', 'base'], message: '--adopt/--base require init' },
  { command: 'ship', keys: ['label', 'summaryFile', 'title', 'allowBehind', 'allowUnconfiguredGate'], message: 'ship options require ship' },
  { command: 'guard', keys: ['stdin', 'pushUrl'], message: '--stdin/--push-url require guard' },
  { command: 'close', keys: ['abandoned', 'shipped', 'head'], message: '--abandoned/--shipped/--head require close' },
];

function validateAdopt(options) {
  if (options.base && !options.adopt) throw new TrainError('--base requires --adopt', 2);
  if (options.adopt && [options.from, options.worktree].some(Boolean)) throw new TrainError('--adopt cannot use --from/--worktree', 2);
}

function validateEtaOption(command, options) {
  if (options.eta && !['fold', 'planned'].includes(command)) throw new TrainError('--eta requires fold/planned', 2);
}

function validateOptions(command, options) {
  for (const group of OPTION_GROUPS) {
    if (command === group.command) continue;
    if (group.keys.some(key => options[key])) throw new TrainError(group.message, 2);
  }
  validateAdopt(options);
  validateEtaOption(command, options);
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
  if (['close', 'fold'].includes(command) && args.length <= 1) return;
  if (command === 'concurrency' && args.length === 0) return;
  const arity = new Map(Object.entries({ init: 2, fold: 1, planned: 2, eta: 2, status: 0, ship: 0, close: 0, hook: 1, guard: 0 }));
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
  if (command === 'eta') return setEta(ctx, repo, options, args);
  if (command === 'ship') return shipTrain(ctx, api, options, repo);
  if (command === 'close') return closeTrain(ctx, repo, { ...options, train: args[0] ?? options.train });
  if (command === 'init') return (options.adopt ? adoptTrain : initTrain)(ctx, api, { ...options, repo, args });
  return foldTrain(ctx, api, { options, repo, args, planned: command === 'planned' });
}

async function commandRepo(ctx, api, request) {
  if (request.command === 'status' && request.options.all) return null;
  const repoDir = request.command === 'init' ? resolve(ctx.cwd, request.args[0]) : ctx.cwd;
  return repoKey(await repository(api, repoDir));
}

async function concurrency(ctx, api, options) {
  const scan = await scanRepository({ git: (cwd, args) => api.git(cwd, args, { allowFailure: true }),
    cwd: ctx.cwd, manifests: await listManifests(ctx.env) });
  if (options.json) ctx.out(JSON.stringify(scan));
  else if (scan.verdict === 'solo') ctx.out('solo: no candidate needed');
  else {
    ctx.out(`${scan.verdict}: ${scan.repo}${scan.trains.length ? ` (${scan.trains.map(t => t.train).join(', ')})` : ''}`);
    for (const entry of scan.worktrees.filter(w => w.role !== 'idle')) ctx.out(`${entry.branch || '(detached)'}: ${entry.role} (${entry.path})`);
    for (const command of scan.next) ctx.out(command);
  }
  return 0;
}

async function dispatch(ctx, request) {
  const { options, command, args } = request;
  const api = client(ctx, options);
  if (command === 'hook') { await manageHook(ctx, api, args[0], options.dryRun); return 0; }
  if (command === 'concurrency') return concurrency(ctx, api, options);
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

function normalizeRequest(request, now) {
  if (request.options.eta) request.options.eta = parseEta(request.options.eta, now);
  if (request.options.gate) request.options.gate = parseDuration(request.options.gate);
  return request;
}

export async function main(argv, context = realContext()) {
  if (argv.includes('--help') || argv.includes('-h')) { context.out(HELP); return 0; }
  let request;
  try {
    request = normalizeRequest(parse(argv), context.now());
    return await dispatch(repoContext(context, request), request);
  } catch (error) {
    return reportError(context, error, request);
  }
}
