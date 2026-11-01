import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export const TOOL = { id: 'dotnet-affected', version: '7.0.1' };
const DEFAULTS = new URL('./pi-affected-defaults.json', import.meta.url);
const exec = promisify(execFile);
export const HELP = `Usage: pi-affected [options]
       pi-affected install
Pick .NET projects for iteration with pinned dotnet-affected 7.0.1.
Selection is for iteration only; Tier 1 and delivery gates always build the whole solution.

Options:
  --repo DIR          Worktree (default cwd)
  --from REF          Diff base (default merge-base with origin's default branch)
  --solution FILE     Solution (default single root slnx, else sln)
  --out FILE          Generated filter (default ignored .ai-work/affected/, else temp)
  --timeout SECONDS   Tool evaluation timeout (default 180)
  --json              Emit the decision as JSON
  -h, --help          Show help without side effects

Examples:
  pi-affected --from HEAD --json
  pi-affected --repo . --solution Toy.slnx
  pi-affected install

Exit codes:
  0  Decision printed (selected, full or none), or install succeeded
  1  Usage/environment/config error or failed explicit install
Tool failures select the whole solution, not a nonzero exit.

See also: docs/reference.md, pi-phase --help
`;

const slash = text => text.replaceAll('\\', '/');
const normalized = path => slash(path).replace(/^\.\//, '');
const sorted = values => [...new Set(values)].sort();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);

function globRegex(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; pattern += '(?:.*/)?'; }
      else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}
const matches = (path, globs = []) => globs.some(glob => globRegex(glob).test(path));
const docs = (path, config) => /\.md$/i.test(path) || path.startsWith('Documentation/') || matches(path, config.ignorePaths);
const BUILD_NAMES = new Set(['global.json', 'nuget.config', 'directory.packages.props', 'directory.build.props', 'directory.build.targets', 'directory.build.rsp', 'directory.solution.props', 'directory.solution.targets', '.editorconfig', '.globalconfig']);
function buildInput(path, config) {
  return BUILD_NAMES.has(basename(path).toLowerCase()) || /\.(sln|slnx|slnf|ruleset|props|targets)$/i.test(path)
    || /^(\.github|\.config|eng|build)\//.test(path) || /^[^/]+\.(sh|ps1|cmd)$/i.test(path) || matches(path, config.fullOnPaths);
}

const validEdges = value => object(value) && Object.entries(value).every(([source, targets]) => source.length > 0 && strings(targets));
const entryValidators = { note: value => typeof value === 'string', ignorePaths: strings, fullOnPaths: strings, edges: validEdges };
const validSchema = config => object(config) && config.schema === 1 && object(config.repos);
function validateEntry(entry) {
  if (!object(entry)) throw new Error('invalid repo config');
  for (const [key, value] of Object.entries(entry)) {
    if (!Object.hasOwn(entryValidators, key) || !entryValidators[key](value)) throw new Error(`invalid repo config key or type: ${key}`);
  }
}
function readConfig(file, optional = false) {
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return { repos: {} }; throw error; }
  if (!validSchema(config)) throw new Error('invalid pi-affected config schema');
  Object.values(config.repos).forEach(validateEntry);
  return config;
}
export function loadConfig(defaultsPath, userPath, repo) {
  const defaults = readConfig(defaultsPath);
  const user = readConfig(userPath, true);
  return { ...defaults.repos, ...user.repos }[repo] ?? {};
}

export function solutionProjects(text, kind) {
  const pattern = kind === '.slnx' ? /<Project\b[^>]*\bPath="([^"]+)"/g : /^Project\("[^"\n]+"\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"/gm;
  return [...text.matchAll(pattern)].map(match => match[1]);
}
export function parseToolOutput(stdout, exit, root) {
  if (exit === 166) return [];
  if (exit !== 0) throw new Error(`unexpected tool exit ${exit}`);
  const lines = stdout.split(/\r?\n/);
  const marker = lines.findIndex(line => line.trim() === 'DRY-RUN: CONTENTS:');
  if (marker < 0) throw new Error('missing DRY-RUN: CONTENTS:');
  return sorted(lines.slice(marker + 1).filter(line => line.trim()).map(line => {
    const path = resolve(root, line.trim());
    return slash(relative(root, existsSync(path) ? realpathSync(path) : path));
  }));
}
export function applyEdges(selected, edges = {}, solutionSet) {
  const projects = new Set(selected);
  const added = [];
  const notes = [];
  for (const because of projects) {
    for (const project of edges[because] ?? []) {
      if (!solutionSet.has(project)) { notes.push(`Skipping edge ${because} -> ${project}: absent from solution`); continue; }
      if (!projects.has(project)) { projects.add(project); added.push({ project, because }); }
    }
  }
  return { projects: sorted(projects), added, notes };
}
export function renderSlnf(solution, out, projects) {
  return JSON.stringify({ solution: { path: slash(relative(dirname(out), solution)), projects: sorted(projects) } }, null, 2) + '\n';
}
export function changedFiles(git, sha, out) {
  return sorted([...git(['diff', '--name-only', '--no-renames', '-z', sha]).split('\0'), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(path => path && normalized(path) !== normalized(out)));
}

function toolEnvironment(env) {
  if (env.DOTNET_ROOT) return { ...env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  let dotnetRoot = '/usr/local/share/dotnet';
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (/pi-phase/.test(entry)) continue;
    try {
      const candidate = dirname(realpathSync(join(entry, 'dotnet')));
      if (existsSync(join(candidate, 'sdk'))) { dotnetRoot = candidate; break; }
    } catch { /* PATH entries need not contain dotnet. */ }
  }
  return { ...env, DOTNET_ROOT: dotnetRoot, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
}
export function install(env = process.env) {
  const cache = resolve(env.PI_AFFECTED_CACHE || join(homedir(), '.cache', 'pi-affected'));
  const toolDir = join(cache, `${TOOL.id}-${TOOL.version}`);
  const executable = join(toolDir, TOOL.id);
  const installed = () => existsSync(executable) && existsSync(join(toolDir, '.store', TOOL.id, TOOL.version));
  mkdirSync(cache, { recursive: true });
  const options = { cwd: cache, env: toolEnvironment(env), encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 };
  if (!installed()) {
    const temporary = `${toolDir}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    execFileSync('dotnet', ['tool', 'install', TOOL.id, '--version', TOOL.version, '--tool-path', temporary], options);
    try { renameSync(temporary, toolDir); }
    catch (error) {
      if (!installed()) throw error;
      rmSync(temporary, { recursive: true });
    }
  }
  const version = execFileSync(executable, ['--version'], options);
  if (!version.includes(TOOL.version)) throw new Error(`expected ${TOOL.id} ${TOOL.version}, got ${version.trim()}`);
  return executable;
}
const normalExit = error => typeof error.code === 'number' && !error.killed && !error.signal;
async function runTool(executable, args, options) {
  try { return { ...await exec(executable, args, options), exit: 0 }; }
  catch (error) {
    if (normalExit(error)) return { exit: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw error;
  }
}
function toolArgs(input) {
  return ['--filter-file-path', relative(input.root, input.solution), '--from', input.sha, '--uncommitted', 'All', '--format', 'text', '--dry-run'];
}
const reason = (rule, paths = [], detail = '') => ({ rule, paths, detail });
function failureDetail(error) { return error.message ?? String(error); }

async function select(input, deps, tool) {
  const env = deps.env ?? process.env;
  let executable;
  try {
    executable = env.PI_AFFECTED_TOOL;
    if (executable) accessSync(executable, constants.X_OK);
    else executable = await (deps.install ?? install)(env);
  } catch (error) { return { error: reason('tool-unavailable', [], failureDetail(error)) }; }
  const start = Date.now();
  tool.ran = true;
  try {
    const result = await (deps.runTool ?? runTool)(executable, input.solution ? toolArgs(input) : [], { cwd: input.root, env: toolEnvironment(env), timeout: (input.timeout ?? 180) * 1000, maxBuffer: 64 * 1024 * 1024 });
    tool.exit = result.exit;
    if (![0, 166].includes(result.exit)) throw new Error(`exit ${result.exit}: ${(result.stderr ?? '').trim().split(/\r?\n/).at(-1)}`);
    return { projects: parseToolOutput(result.stdout ?? '', result.exit, input.root) };
  } catch (error) { return { error: reason('tool-error', [], failureDetail(error)) }; }
  finally { tool.ms = Date.now() - start; }
}
function selectionFallback(selection, input) {
  const config = input.config ?? {};
  if (selection.error) return selection.error;
  const nonDocs = input.changed.filter(path => !docs(path, config));
  if (!selection.projects.length) return nonDocs.length ? reason('empty-selection', nonDocs) : null;
  const unowned = nonDocs.filter(path => !/\.cs$/i.test(path) && !selection.projects.some(p => path.startsWith(`${dirname(p)}/`)));
  if (unowned.length) return reason('unowned-non-cs', unowned);
  const solutionSet = new Set(input.projects.map(normalized));
  if (selection.projects.some(p => !solutionSet.has(p))) return reason('tool-error', [], 'selection outside solution');
  return null;
}
export async function decide(input, deps = {}) {
  const { changed, projects, config = {} } = input;
  const tool = { name: TOOL.id, version: TOOL.version, ran: false, exit: null, ms: 0 };
  const result = (mode, reasons = [], extra = {}) => ({ mode, projects: mode === 'full' ? sorted(projects) : [], added: [], reasons, notes: [], tool, ...extra });
  if (!changed.length) return result('none');
  const buildPaths = changed.filter(path => buildInput(path, config));
  if (buildPaths.length) return result('full', [reason('build-input', buildPaths)]);
  const selection = await select(input, deps, tool);
  const fallback = selectionFallback(selection, input);
  if (fallback) return result('full', [fallback]);
  if (!selection.projects.length) return result('none');
  return result('selected', [], applyEdges(selection.projects, config.edges, new Set(projects.map(normalized))));
}

const VALUE_OPTIONS = new Set(['--repo', '--from', '--solution', '--out', '--timeout']);
function optionValue(args, index) {
  const key = args[index];
  if (!VALUE_OPTIONS.has(key)) throw new Error(`unknown option: ${key}`);
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
  return value;
}
function parseOptions(args) {
  const options = { repo: process.cwd(), timeout: 180 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--json') { options.json = true; continue; }
    options[key.slice(2)] = optionValue(args, i);
    i++;
  }
  options.timeout = Number(options.timeout);
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw new Error('--timeout must be positive seconds');
  return options;
}
function tryGit(git, args) { try { return git(args).trim(); } catch { return null; } }
function baseRef(git, from) {
  if (from) return { ref: from, sha: git(['rev-parse', '--verify', `${from}^{commit}`]).trim() };
  const symbolic = tryGit(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  for (const ref of sortedRefs(symbolic)) {
    const sha = tryGit(git, ['merge-base', 'HEAD', ref]);
    if (sha) return { ref, sha };
  }
  throw new Error('cannot resolve origin default branch; pass --from');
}
const sortedRefs = symbolic => [...new Set([symbolic, 'origin/main', 'origin/master'].filter(Boolean))];
function requestedSolution(root, requested) {
  const path = resolve(root, requested);
  if (!['.slnx', '.sln'].includes(extname(path))) throw new Error('--solution must be a .slnx or .sln');
  return path;
}
function findSolution(root, requested) {
  if (requested) return requestedSolution(root, requested);
  const files = readdirSync(root);
  for (const extension of ['.slnx', '.sln']) {
    const candidates = files.filter(file => file.endsWith(extension));
    if (candidates.length > 1) throw new Error('ambiguous solution; pass --solution');
    if (candidates.length === 1) return join(root, candidates[0]);
  }
  throw new Error('no solution; pass --solution');
}
function outputPath(root, solution, requested, git) {
  if (requested) return resolve(root, requested);
  const ignored = tryGit(git, ['check-ignore', '-q', '.ai-work/affected/x']) !== null;
  const directory = ignored ? join(root, '.ai-work', 'affected') : join(tmpdir(), 'pi-affected', createHash('sha1').update(root).digest('hex').slice(0, 12));
  return join(directory, `${basename(solution, extname(solution))}.affected.slnf`);
}
function writeSelection(report, out, entries) {
  if (report.mode !== 'selected') {
    try { unlinkSync(out); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  const temporary = `${out}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const selectedEntries = entries.filter(entry => report.projects.includes(normalized(entry)));
  writeFileSync(temporary, renderSlnf(report.solution, out, selectedEntries));
  renameSync(temporary, out);
}
function repoKey(remote) {
  const match = remote?.trim().match(/(?:[:/])([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  const repo = match ? `${match[1]}/${match[2]}` : null;
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}
function renderHuman(report) {
  let summary;
  if (report.mode === 'full') summary = `FULL ${report.solution} — ${report.reasons[0].rule}: ${report.reasons[0].paths.slice(0, 3).join(', ')}`;
  else if (report.mode === 'none') summary = `none — ${report.changed.count ? 'only documentation changed' : 'no changes'} (${report.changed.count} files)`;
  else {
    const added = new Set(report.added.map(edge => edge.project));
    summary = `selected ${report.projects.length} of ${report.total} projects vs ${report.base.sha.slice(0, 7)} (${report.base.ref}): ${report.projects.map(p => `${basename(p, '.csproj')}${added.has(p) ? ' (+edge)' : ''}`).join(', ')}`;
  }
  return `pi-affected: ${summary}\ntarget: ${report.target ? relative(process.cwd(), report.target) : 'none'}  (iteration only; never gate or delivery evidence)\n`;
}
async function evaluate(options, deps, env) {
  const gitAt = cwd => args => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const root = realpathSync((deps.git ?? gitAt(options.repo))(['rev-parse', '--show-toplevel']).trim());
  const git = deps.git ?? gitAt(root);
  const solution = findSolution(root, options.solution);
  const entries = solutionProjects(readFileSync(solution, 'utf8'), extname(solution));
  const projects = entries.map(normalized);
  const base = baseRef(git, options.from);
  const out = outputPath(root, solution, options.out, git);
  const changed = changedFiles(git, base.sha, slash(relative(root, out)));
  const repo = repoKey(tryGit(git, ['remote', 'get-url', 'origin']));
  const config = loadConfig(DEFAULTS, env.PI_AFFECTED_CONFIG || join(homedir(), '.pi', 'agent', 'pi-affected.json'), repo);
  const decision = await decide({ root, solution, sha: base.sha, projects, changed, config, timeout: options.timeout }, { ...deps, env });
  const report = { schema: 1, mode: decision.mode, iterationOnly: true, repo, root, solution, base, target: decision.mode === 'selected' ? out : decision.mode === 'full' ? solution : null, projects: decision.projects, added: decision.added, reasons: decision.reasons, notes: decision.notes, changed: { count: changed.length, docs: changed.filter(path => docs(path, config)).length, sample: changed.slice(0, 20) }, tool: decision.tool };
  writeSelection(report, out, entries);
  return { report, total: projects.length };
}
export async function main(args, deps = {}) {
  const stdout = deps.stdout ?? (text => process.stdout.write(text));
  if (args.includes('--help') || args.includes('-h')) { stdout(HELP); return 0; }
  const stderr = deps.stderr ?? (text => process.stderr.write(text));
  const env = deps.env ?? process.env;
  try {
    if (args.length === 1 && args[0] === 'install') { stdout(`${await (deps.install ?? install)(env)}\n`); return 0; }
    const options = parseOptions(args);
    const { report, total } = await evaluate(options, deps, env);
    stdout(options.json ? JSON.stringify(report) + '\n' : renderHuman({ ...report, total }));
    return 0;
  } catch (error) { stderr(`pi-affected: ${error.message}\n`); return 1; }
}
