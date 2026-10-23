import { basename, dirname, join, resolve } from 'node:path';
import { TrainError, defaultBranch } from './train-gh.mjs';
import { loadManifest, manifestPath, saveManifest, slug, withManifestLock } from './train-manifest.mjs';

async function adoptedWorktree(api, cwd, train) {
  const listing = (await api.git(cwd, ['worktree', 'list', '--porcelain'])).stdout;
  const block = listing.split('\n\n').find(entry => entry.split('\n').includes(`branch refs/heads/${train}`));
  if (block) return { path: block.split('\n').find(line => line.startsWith('worktree ')).slice(9), create: false };
  return { path: join(dirname(cwd), '.worktrees', `${basename(cwd)}-${slug(train)}`), create: true };
}

async function candidates(api, manifest, cwd) {
  const commits = (await api.git(cwd,
    ['log', '--first-parent', '--merges', '--format=%h %s', `${manifest.base.sha}..${manifest.train}`])).stdout.trim();
  const prs = await api.json(manifest.repo, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,headRefOid,baseRefName']);
  const result = [];
  for (const pr of prs) {
    if (pr.headRefName === manifest.train) continue;
    const ancestry = await api.git(cwd,
      ['merge-base', '--is-ancestor', pr.headRefOid, manifest.train], { allowFailure: true });
    if (ancestry.status > 1) throw new TrainError(ancestry.stderr || 'cannot check PR ancestry', 2);
    if (ancestry.status === 0) result.push(pr);
  }
  return { commits, prs: result };
}

async function validateTarget(api, target) {
  const { cwd, repo, train, base } = target;
  if (!/^origin\/.+/.test(base)) throw new TrainError('--base must be an origin/<branch> ref', 2);
  if (['main', await defaultBranch(api, repo)].includes(train)) throw new TrainError('cannot adopt main or default branch');
  await api.git(cwd, ['show-ref', '--verify', `refs/heads/${train}`]);
}

export async function adoptTrain(ctx, api, options) {
  const { repo, args } = options;
  const cwd = resolve(ctx.cwd, args[0]), train = args[1], base = options.base ?? 'origin/main';
  await validateTarget(api, { cwd, repo, train, base });
  const path = manifestPath(ctx.env, repo, train);
  const perform = async () => {
    if (await loadManifest(path, train)) throw new TrainError(`manifest already exists: ${train}`);
    const target = await adoptedWorktree(api, cwd, train);
    const sha = (await api.git(cwd, ['merge-base', train, base])).stdout.trim();
    const head = (await api.git(cwd, ['rev-parse', train])).stdout.trim();
    const manifest = { v: 1, repo, train, base: { ref: base, sha }, worktree: target.path,
      owner: ctx.env.PI_TRAIN_OWNER ?? ctx.env.USER ?? '', state: 'open', head, pr: null, shippedHead: null,
      label: null, items: [], notes: {}, packages: [], upstream: [], downstream: [],
      log: [{ at: ctx.now(), op: 'adopt', detail: train }] };
    const found = await candidates(api, manifest, cwd);
    if (target.create) await api.git(cwd, ['worktree', 'add', target.path, train], { mutate: true });
    if (!options.dryRun) await saveManifest(path, manifest);
    ctx.out(`${options.dryRun ? 'would adopt' : 'adopted'} ${train}; fold candidates (not folded automatically):`);
    ctx.out(found.commits || '(no first-parent merge commits)');
    for (const pr of found.prs) ctx.out(`#${pr.number} ${pr.headRefName} (${pr.headRefOid}): pi-train fold ${pr.number} --train ${train}`);
  };
  if (options.dryRun) await perform();
  else await withManifestLock(path, perform);
}
