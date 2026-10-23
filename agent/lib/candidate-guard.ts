import { basename } from 'node:path';
import { tokenizeShell } from './issue-work.ts';
import { listManifests, repoKey } from './train-manifest.mjs';
import { scanRepository } from './train-concurrency.mjs';
import { nativeGuardGit, changedDirectory, commandTokens } from './train-guard.ts';

type Git = typeof nativeGuardGit;
type Decision = { block?: string; warn?: string; log?: string };
type Segment = { tokens: string[]; cwd: string; git: Git; exception: boolean; exceptionName: string };
const dynamic = (value: string) => /[$`*?{}<>\n]/.test(value);
const unparsed = (error: unknown) => `Candidate guard: unparsed, allowed (${(error as Error).message})`;
const prCreate = (tokens: string[]) => basename(tokens[0] ?? '') === 'gh' && tokens[1] === 'pr' && tokens[2] === 'create';

function segments(command: string, cwd: string, git: Git) {
  const result: Segment[] = [];
  for (const raw of tokenizeShell(command)) {
    const segment = commandTokens({ tokens: raw, cwd, git });
    if (segment.tokens[0] === 'cd') { cwd = changedDirectory(segment); continue; }
    const prefix = raw.slice(0, raw.length - segment.tokens.length);
    const exceptionName = prefix.filter(t => t.startsWith('PI_CANDIDATE_EXCEPTION=')).at(-1)?.split('=')[1] ?? '';
    result.push({ ...segment, exceptionName, exception: ['major', 'urgent-fix'].includes(exceptionName) });
  }
  return result;
}

function validate(segment: Segment) {
  if (!segment.cwd || segment.tokens.some(dynamic)) throw new Error('dynamic shell syntax or unresolved working directory');
}

function followingValue(tokens: string[], index: number) {
  const value = tokens[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`missing ${tokens[index]} value`);
  return value;
}

function optionValue(tokens: string[], index: number, names: { short: string; long: string }) {
  const token = tokens[index];
  if ([names.short, names.long].includes(token)) return followingValue(tokens, index);
  if (token.startsWith(`${names.long}=`)) return token.slice(names.long.length + 1);
  if (token.startsWith(names.short) && token.length > names.short.length) return token.slice(names.short.length);
}

function option(tokens: string[], short: string, long: string) {
  for (let i = 3; i < tokens.length; i++) {
    const value = optionValue(tokens, i, { short, long });
    if (value !== undefined) return value;
  }
}

function identity(segment: Segment) {
  validate(segment);
  const { tokens, cwd, git } = segment;
  const remote = option(tokens, '-R', '--repo') ?? git(cwd, ['remote', 'get-url', 'origin']);
  const repo = repoKey(/^[\w.-]+\/[\w.-]+$/.test(remote) ? `https://github.com/${remote}` : remote);
  const head = (option(tokens, '-H', '--head') ?? git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()).replace(/^[^:]+:/, '');
  if (!head) throw new Error('unresolved branch');
  return { repo, head };
}

async function repositoryScan(segment: Segment, manifests: any[]) {
  const git = async (cwd: string, args: string[]) => ({ status: 0, stdout: segment.git(cwd, args) });
  return scanRepository({ git, cwd: segment.cwd, manifests });
}

function concurrentNotice(scan: any) {
  const pending = scan.worktrees.filter((w: any) => ['pending', 'redeliver'].includes(w.role));
  if (pending.length < 2) return;
  return `${pending.length} worktrees in ${scan.repo} hold unshipped work (${pending.map((w: any) => w.branch).join(', ')}). Converge them into one candidate (\`pi-train concurrency\`) instead of separate PRs.`;
}

function refusal(repo: string, train: string, head: string) {
  return `PR refused: ${repo} has open candidate ${train}. Deliver this branch with \`pi-train fold ${head}\`; the candidate ships as one PR (\`pi-train ship\`). Named exceptions: prefix \`PI_CANDIDATE_EXCEPTION=major\` or \`=urgent-fix\` and give the reason in your report.`;
}

async function decidePR(segment: Segment, env: NodeJS.ProcessEnv, orchestrated: boolean): Promise<Decision> {
  const { repo, head } = identity(segment);
  const manifests = await listManifests(env);
  const trains = manifests.map(entry => entry.manifest).filter(m => m.repo === repo && m.state === 'open');
  if (trains.some(train => train.train === head)) return {};
  if (trains.length) {
    if (segment.exception) return { log: `exception ${segment.exceptionName} for ${head}` };
    const reason = refusal(repo, trains[0].train, head);
    return orchestrated ? { warn: reason } : { block: reason };
  }
  const warn = concurrentNotice(await repositoryScan(segment, manifests));
  return warn ? { warn } : {};
}

export async function prCreateDecision(command: string, cwd: string, env = process.env, git: Git = nativeGuardGit, orchestrated = false): Promise<Decision> {
  try {
    const result: Decision = {};
    for (const segment of segments(command, cwd, git).filter(s => prCreate(s.tokens))) {
      const decision = await decidePR(segment, env, orchestrated);
      if (decision.block) return decision;
      Object.assign(result, decision);
    }
    return result;
  } catch (error) { return { warn: unparsed(error) }; }
}

function gateRun(tokens: string[]) {
  return basename(tokens[0] ?? '') === 'pi-phase' && tokens[1] === 'run'
    && tokens.some((token, i) => token === '--kind' && ['build', 'test'].includes(tokens[i + 1]) || /^--kind=(build|test)$/.test(token))
    && /release-check|ci-local|tier[ -]?1|full|gate/i.test(tokens.join(' '));
}

function candidateGateNotice(scan: any, entry: any, segment: Segment) {
  const branch = entry?.branch ?? segment.git(segment.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  const delivery = entry?.role === 'delivered' ? `branch ${branch} is already delivered; run targeted checks here and redeliver changes with` : 'run targeted checks here and deliver with';
  return `This repository has open candidate ${scan.trains[0].train}: ${delivery} \`pi-train fold ${branch}\`; Tier 1 runs once on the candidate. Proceeding.`;
}

async function gateNotice(segment: Segment, env: NodeJS.ProcessEnv) {
  validate(segment);
  if (segment.exception) return;
  const scan = await repositoryScan(segment, await listManifests(env));
  const entry = scan.worktrees.find(w => w.path === segment.cwd);
  if (entry?.role === 'train') return;
  if (scan.trains.length) return candidateGateNotice(scan, entry, segment);
  const notice = concurrentNotice(scan);
  return notice ? `${notice} Proceeding.` : undefined;
}

export async function gateRunNotice(command: string, cwd: string, env = process.env, git: Git = nativeGuardGit): Promise<string | undefined> {
  try {
    for (const segment of segments(command, cwd, git).filter(s => gateRun(s.tokens))) {
      const notice = await gateNotice(segment, env);
      if (notice) return notice;
    }
  } catch (error) { return unparsed(error); }
}
