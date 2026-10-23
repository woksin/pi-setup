import { basename, dirname, join, resolve } from 'node:path';
import { TrainError } from './train-gh.mjs';
import { loadManifest, manifestPath, saveManifest, slug, withManifestLock } from './train-manifest.mjs';

export async function repository(api, cwd) {
  return (await api.git(cwd, ['remote', 'get-url', 'origin'])).stdout.trim();
}

export function baseBranch(manifest) { return manifest.base.ref.replace(/^origin\//, ''); }

async function alreadyInitialised(api, request) {
  const { cwd, train, existing, base } = request;
  const branch = await api.git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${train}`], { allowFailure: true });
  if (!existing) {
    if (branch.status === 0) throw new TrainError(`branch already exists without a matching manifest: ${train}`);
    return false;
  }
  if (branch.status !== 0 || existing.base.ref !== base) throw new TrainError('existing train does not match branch and base');
  return true;
}

export async function initTrain(ctx, api, options) {
  const { repo, args } = options;
  const cwd = resolve(ctx.cwd, args[0]);
  const train = args[1];
  const base = options.from ?? 'origin/main';
  if (!/^origin\/.+/.test(base)) throw new TrainError('--from must be an origin/<branch> ref', 2);
  await api.git(cwd, ['check-ref-format', '--branch', train]);
  const path = manifestPath(ctx.env, repo, train);
  const perform = async () => {
    const existing = await loadManifest(path, train);
    if (await alreadyInitialised(api, { cwd, train, existing, base })) {
      ctx.out(`already initialised: ${train}`);
      return;
    }
    await api.git(cwd, ['fetch', 'origin', base.slice(7)], { mutate: true });
    const sha = options.dryRun
      ? (await api.git(cwd, ['ls-remote', 'origin', `refs/heads/${base.slice(7)}`])).stdout.trim().split(/\s+/)[0]
      : (await api.git(cwd, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
    if (!sha) throw new TrainError(`base ref not found: ${base}`, 2);
    const worktree = resolve(ctx.cwd, options.worktree ?? join(dirname(cwd), '.worktrees', `${basename(cwd)}-${slug(train)}`));
    await api.git(cwd, ['branch', train, sha], { mutate: true });
    await api.git(cwd, ['worktree', 'add', worktree, train], { mutate: true });
    const manifest = {
      v: 1, repo, train, base: { ref: base, sha }, worktree, owner: ctx.env.PI_TRAIN_OWNER ?? ctx.env.USER ?? '',
      state: 'open', head: sha, pr: null, shippedHead: null, label: null, items: [], notes: {},
      packages: [], upstream: [], downstream: [], log: [{ at: ctx.now(), op: 'init', detail: train }],
    };
    if (!options.dryRun) await saveManifest(path, manifest);
    ctx.out(`${options.dryRun ? 'would initialise' : 'initialised'} ${train} in ${worktree}`);
  };
  if (options.dryRun) await perform();
  else await withManifestLock(path, perform);
}
