import { TrainError } from './train-gh.mjs';

export async function fetchHead(api, manifest, resolved, dryRun, report = () => {}) {
  await api.git(manifest.worktree, ['check-ref-format', '--branch', resolved.branch]);
  if (!resolved.pr) {
    const local = (await api.git(manifest.worktree, ['for-each-ref', '--format=%(objectname)', `refs/heads/${resolved.branch}`])).stdout.trim();
    if (local) {
      report(`folding local head ${local.slice(0, 7)} of ${resolved.branch}`);
      return local;
    }
  }
  await api.git(manifest.worktree, ['fetch', 'origin', resolved.branch], { mutate: true });
  const sha = dryRun
    ? (await api.git(manifest.worktree, ['ls-remote', 'origin', `refs/heads/${resolved.branch}`])).stdout.trim().split(/\s+/)[0]
    : (await api.git(manifest.worktree, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
  if (!sha) throw new TrainError('branch head not found', 2);
  if (resolved.sha && resolved.sha !== sha) throw new TrainError('PR head moved since it was resolved; retry');
  return sha;
}

async function cleanTrain(api, manifest) {
  const branch = (await api.git(manifest.worktree, ['branch', '--show-current'])).stdout.trim();
  const dirty = (await api.git(manifest.worktree, ['status', '--porcelain'])).stdout.trim();
  if (branch !== manifest.train || dirty) throw new TrainError('train worktree must be clean and on the train branch');
}

async function performMerge(api, manifest, resolved) {
  const name = resolved.pr ? `#${resolved.pr.number}` : resolved.branch;
  const message = `Fold ${name} (${resolved.branch}) into ${manifest.train}`;
  const result = await api.git(manifest.worktree, ['merge', '--no-ff', '--no-edit', '-m', message, resolved.sha],
    { mutate: true, allowFailure: true });
  if (result.status === 0) return;
  const conflicts = (await api.git(manifest.worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim();
  await api.git(manifest.worktree, ['merge', '--abort'], { mutate: true, allowFailure: true });
  const detail = conflicts ? `; conflicts: ${conflicts}` : '';
  throw new TrainError(`merge failed${detail}: ${result.stderr}`);
}

export async function mergeHead(api, manifest, resolved, dryRun) {
  await cleanTrain(api, manifest);
  const ancestor = await api.git(manifest.worktree, ['merge-base', '--is-ancestor', resolved.sha, 'HEAD'], { allowFailure: true });
  // A dry run cannot fetch missing objects without changing the repository.
  if (ancestor.status > 1 && !dryRun) throw new TrainError(ancestor.stderr || 'cannot check ancestry', 2);
  if (ancestor.status !== 0) await performMerge(api, manifest, resolved);
  return dryRun ? manifest.head : (await api.git(manifest.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
}
