import { listManifests } from './train-manifest.mjs';

const DEFAULT_BASE = 'origin/main';
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);

// Directory holding the branch checked out, else the repository directory; read-only.
async function checkoutDirs(api, cwd) {
  const dirs = new Map();
  let current = null;
  for (const line of (await api.git(cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && current) dirs.set(line.slice('branch refs/heads/'.length), current);
  }
  return dirs;
}

async function aheadOf(api, cwd, base, branch) {
  return Number((await api.git(cwd, ['rev-list', '--count', `${base}..${branch}`])).stdout.trim());
}

/** Local cand/* branches ahead of the base that no manifest (any state) uses as its train branch. Read-only git. */
export async function untrackedCandidates(ctx, api, repo, base = DEFAULT_BASE) {
  const tracked = new Set((await listManifests(ctx.env, repo)).map(entry => entry.manifest.train));
  const branches = lines((await api.git(ctx.cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/cand/'])).stdout)
    .filter(branch => branch.startsWith('cand/') && !tracked.has(branch));
  if (!branches.length) return [];
  const dirs = await checkoutDirs(api, ctx.cwd);
  const found = [];
  for (const branch of branches) {
    const ahead = await aheadOf(api, ctx.cwd, base, branch);
    if (ahead > 0) found.push({ branch, ahead, base, dir: dirs.get(branch) ?? ctx.cwd });
  }
  return found;
}

export const adoptCommand = candidate => `pi-train init --adopt ${candidate.dir} ${candidate.branch} --base ${candidate.base}`;

export function printCandidates(ctx, found, prefix) {
  for (const candidate of found) ctx.out(`${prefix}untracked candidate ${candidate.branch} (ahead ${candidate.ahead})`);
  for (const candidate of found) ctx.out(`adopt with: ${adoptCommand(candidate)}`);
}

async function hasOpenTrain(ctx, repo) {
  return (await listManifests(ctx.env, repo)).some(entry => entry.manifest.state === 'open');
}

/** After a real close with no open train left, point at candidates nobody tracks. Never fails the close. */
export async function hintSuccessor(ctx, api, repo, base) {
  try {
    if (await hasOpenTrain(ctx, repo)) return;
    const found = await untrackedCandidates(ctx, api, repo, base);
    printCandidates(ctx, found, 'next: no open train; ');
  } catch { ctx.out('next: candidate lookup failed'); }
}
