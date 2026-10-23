import { resolve } from 'node:path';
import { repoKey } from './train-manifest.mjs';

async function value(git, cwd, args) {
  const result = await git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function worktreeEntries(text) {
  return text.split('\n\n').filter(Boolean).slice(0, 30).map(block => {
    const lines = block.split('\n');
    return { path: lines.find(line => line.startsWith('worktree '))?.slice(9),
      branch: lines.find(line => line.startsWith('branch '))?.slice(18) ?? '',
      prunable: lines.some(line => line.startsWith('prunable')) };
  });
}

function roleFor(entry, trains, { ahead, dirty, sha }) {
  if (trains.some(train => resolve(train.worktree) === resolve(entry.path))) return 'train';
  const item = trains.flatMap(train => train.items ?? []).find(item => item.branch === entry.branch && item.kind === 'folded');
  if (item) return item.sha === sha && !dirty ? 'delivered' : 'redeliver';
  return ahead > 0 || dirty ? 'pending' : 'idle';
}

async function inspect(git, entry, defaultBranch, trains) {
  if (!entry.path || entry.prunable) return null;
  try {
    const ahead = entry.branch ? Number(await value(git, entry.path, ['rev-list', '--count', `origin/${defaultBranch}..${entry.branch}`])) : 0;
    const dirty = !!await value(git, entry.path, ['status', '--porcelain']);
    const sha = await value(git, entry.path, ['rev-parse', 'HEAD']);
    return { path: entry.path, branch: entry.branch, ahead, dirty, role: roleFor(entry, trains, { ahead, dirty, sha }) };
  } catch { return null; }
}

async function defaultRef(git, cwd) {
  try { return (await value(git, cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, ''); }
  catch { return 'main'; }
}

function nextCommands(verdict, worktrees, main) {
  const next = verdict === 'concurrent' ? [`pi-train init ${main} train/${new Date().toISOString().slice(0, 10)}`] : [];
  for (const entry of worktrees) {
    if (entry.branch && ['pending', 'redeliver'].includes(entry.role)) next.push(`pi-train fold ${entry.branch}`);
  }
  return verdict === 'solo' ? [] : next;
}

export async function scanRepository({ git, cwd, manifests }) {
  const commonDir = await value(git, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repo = repoKey(await value(git, cwd, ['remote', 'get-url', 'origin']));
  const defaultBranch = await defaultRef(git, cwd);
  const trains = manifests.map(entry => entry.manifest).filter(m => m.repo === repo && m.state === 'open');
  const entries = worktreeEntries(await value(git, cwd, ['worktree', 'list', '--porcelain']));
  const worktrees = [];
  for (const entry of entries) {
    const inspected = await inspect(git, entry, defaultBranch, trains);
    if (inspected) worktrees.push(inspected);
  }
  const pending = worktrees.filter(entry => ['pending', 'redeliver'].includes(entry.role)).length;
  const verdict = trains.length ? 'candidate' : pending >= 2 ? 'concurrent' : 'solo';
  return { repo, commonDir, defaultBranch, trains: trains.map(({ train, worktree }) => ({ train, worktree })),
    worktrees, verdict, next: nextCommands(verdict, worktrees, entries[0]?.path ?? cwd) };
}
