import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { tokenizeShell } from './issue-work.ts';
import { listManifests, repoKey } from './train-manifest.mjs';
import { protectedItems, pushBlock } from './train-push.mjs';

type Git = (cwd: string, args: string[]) => string;
type Push = { cwd: string; remote: string; refs: string[]; all: boolean; delete: boolean };
type Location = { cwd: string; git: Git };
type Segment = Location & { tokens: string[] };
type ParsedPush = { repo: string; branches: string[] };
type ParseResult = { pushes: ParsedPush[]; notices: string[] };
const dynamic = (value: string) => /[$`*?{}<>\n]/.test(value);
const VALUE_OPTIONS = new Set(['--receive-pack', '--exec', '--push-option', '-o']);
const SAFE_OPTIONS = new Set(['-f', '--force', '--force-if-includes', '--force-with-lease', '-u', '--set-upstream',
  '-v', '--verbose', '-q', '--quiet', '--porcelain', '--progress', '--no-verify', '--atomic', '--follow-tags',
  '--tags', '--delete', '-d', '--prune', '--dry-run', '-n', '--signed', '--no-signed', '--ipv4', '--ipv6']);

function knownOption(token: string) {
  const patterns = [/^-[fuvqn]+$/, /^--(?:force-with-lease|force-if-includes|signed|push-option|receive-pack|exec)=/, /^-o.+/];
  return SAFE_OPTIONS.has(token) || patterns.some(pattern => pattern.test(token));
}

function skipOption(option: { token: string; rest: string[] }) {
  const { token, rest } = option;
  if (VALUE_OPTIONS.has(token)) {
    if (!rest.shift()) throw new Error('missing push option value');
    return;
  }
  if (knownOption(token)) return;
  throw new Error(`unknown push option ${token}`);
}

function pushTail(segment: Segment) {
  const rest = segment.tokens, positional: string[] = [];
  const state = { all: false, end: false, delete: false };
  while (rest.length) {
    const token = rest.shift()!;
    if (state.end) { positional.push(token); continue; }
    if (token === '--') { state.end = true; continue; }
    if (['--all', '--mirror'].includes(token)) { state.all = true; continue; }
    if (['--delete', '-d'].includes(token)) { state.delete = true; continue; }
    if (token.startsWith('-')) skipOption({ token, rest });
    else positional.push(token);
  }
  return { remote: positional.shift() ?? '', refs: positional, all: state.all, delete: state.delete };
}

function pushArgs(segment: Segment): Push {
  let { cwd } = segment;
  const rest = segment.tokens.slice(1);
  while (rest[0] === '-C') { rest.shift(); cwd = resolve(cwd, rest.shift()!); }
  if (rest.shift() !== 'push') throw new Error('git options before push');
  return { cwd, ...pushTail({ ...segment, tokens: rest }) };
}

function headBranch(location: Location) { return location.git(location.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); }
function destination(ref: string, push: Push, git: Git): string {
  const clean = ref.replace(/^\+/, '');
  const dest = clean.includes(':') ? clean.split(':')[1] : clean;
  if (!dest) throw new Error('ambiguous refspec');
  if (dynamic(dest)) throw new Error('dynamic refspec');
  if (dest === 'HEAD') return headBranch({ git, cwd: push.cwd });
  return branchRef(dest);
}

function branchRef(dest: string) {
  if (!dest.startsWith('refs/')) return dest;
  if (dest.startsWith('refs/heads/')) return dest.slice(11);
  return '';
}

function pushMode(push: Push, git: Git) {
  const mode = git(push.cwd, ['config', '--get', 'push.default']).trim();
  if (mode && !['simple', 'upstream', 'current'].includes(mode)) throw new Error(`push.default=${mode}`);
  const configured = git(push.cwd, ['config', '--get-all', `remote.${push.remote}.push`]).trim();
  if (configured) throw new Error('configured push refspec');
  return mode;
}

function defaultDestination(push: Push, git: Git): string[] {
  const branch = headBranch({ git, cwd: push.cwd });
  // Git configuration can redirect an implicit push. Only handle the unambiguous upstream case.
  if (pushMode(push, git) === 'current') return [branch];
  const upstream = git(push.cwd, ['config', '--get', `branch.${branch}.merge`]).trim();
  if (!upstream.startsWith('refs/heads/')) throw new Error('no branch upstream');
  return [upstream.slice(11)];
}

function defaultRemote(push: Push, git: Git) {
  const branch = headBranch({ git, cwd: push.cwd });
  const keys = [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`];
  for (const key of keys) {
    const value = git(push.cwd, ['config', '--get', key]).trim();
    if (value) return value;
  }
  return 'origin';
}

function pushBranches(push: Push, git: Git) {
  if (push.delete) return [];
  if (push.all) return git(push.cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).trim().split('\n');
  if (push.refs.length) return push.refs.filter(ref => !/^\+?:.+/.test(ref)).map(ref => destination(ref, push, git));
  return defaultDestination(push, git);
}

function pushOrigin(push: Push, git: Git) {
  const origin = git(push.cwd, ['remote', 'get-url', 'origin']).trim();
  const target = git(push.cwd, ['remote', 'get-url', '--push', push.remote]).trim() || push.remote;
  return { origin: repoKey(origin), target: repoKey(target) };
}

function resolvePush(push: Push, git: Git) {
  if (!push.remote) push.remote = defaultRemote(push, git);
  const keys = pushOrigin(push, git);
  if (keys.origin !== keys.target) return { repo: '', branches: [] };
  return { repo: keys.origin, branches: pushBranches(push, git) };
}

function missingConfig(result: { args: string[]; status: number | null }) {
  const { args, status } = result;
  if (args[0] === 'config') return status === 1;
  if (args[0] === 'remote') return args.at(-1) !== 'origin';
  return false;
}

export function nativeGuardGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2_000 });
  if (result.status === 0) return result.stdout;
  if (missingConfig({ args, status: result.status })) return '';
  throw new Error(result.error?.message || result.stderr || 'git resolution failed');
}

function changedDirectory(segment: Segment) {
  const { tokens, cwd } = segment;
  if (tokens.length !== 2) return '';
  if (dynamic(tokens[1])) return '';
  return resolve(cwd, tokens[1]);
}

function commandTokens(segment: Segment) {
  const tokens = [...segment.tokens];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
  if (tokens[0] === 'command') tokens.shift();
  return { ...segment, tokens };
}

function simplePush(segment: Segment) {
  return basename(segment.tokens[0] ?? '') === 'git' && segment.tokens.includes('push');
}

function resolveTokens(segment: Segment) {
  if (!simplePush(segment)) throw new Error('unsupported shell wrapper');
  if (!segment.cwd) throw new Error('unresolved working directory');
  if (segment.tokens.some(dynamic)) throw new Error('dynamic shell syntax');
  return resolvePush(pushArgs(segment), segment.git);
}

function parseSegment(segment: Segment, result: ParseResult) {
  const normalized = commandTokens(segment);
  if (!/\bgit\b.*\bpush\b/.test(normalized.tokens.join(' '))) return;
  try { result.pushes.push(resolveTokens(normalized)); }
  catch (error) { result.notices.push(`Train guard: unparsed push allowed (${(error as Error).message}); install the pre-push hook for exact refs.`); }
}

export function parsePushes(command: string, cwd: string, git: Git = nativeGuardGit) {
  const result: ParseResult = { pushes: [], notices: [] };
  for (const tokens of tokenizeShell(command)) {
    const segment = { tokens, cwd, git };
    if (tokens[0] === 'cd') cwd = changedDirectory(segment);
    else parseSegment(segment, result);
  }
  return result;
}

function blockedPush(manifests: any[], pushes: ParsedPush[]) {
  for (const push of pushes) {
    const reason = pushBlock(protectedItems(manifests, push.repo), push.branches);
    if (reason) return reason;
  }
}

export async function trainPushDecision(command: string, cwd: string, env = process.env, git: Git = nativeGuardGit) {
  if (!command.includes('push')) return { notices: [] as string[] };
  const { pushes, notices } = parsePushes(command, cwd, git);
  if (!pushes.some(push => push.repo)) return { notices };
  try {
    const manifests = await listManifests(env);
    const reason = blockedPush(manifests, pushes);
    if (reason) return { reason, notices };
  } catch (error) { notices.push(`Train guard: manifests unavailable; push allowed (${(error as Error).message}).`); }
  return { notices };
}
