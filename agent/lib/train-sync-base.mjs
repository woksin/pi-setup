import { TrainError } from './train-gh.mjs';
import { baseBranch } from './train-init.mjs';
import { loadManifest, manifestRecorder, withManifestLock } from './train-manifest.mjs';
import { mergeHead } from './train-merge.mjs';
import { selectTrain } from './train-resolve.mjs';

async function fetchBase(api, manifest, dryRun) {
  const ref = `refs/heads/${baseBranch(manifest)}`;
  // A dry run must not move remote-tracking refs, so it only reads the remote.
  if (!dryRun) await api.git(manifest.worktree, ['fetch', 'origin', ref], { mutate: true });
  const sha = dryRun
    ? (await api.git(manifest.worktree, ['ls-remote', 'origin', ref])).stdout.trim().split(/\s+/)[0]
    : (await api.git(manifest.worktree, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
  if (!sha) throw new TrainError(`base ref not found: ${manifest.base.ref}`, 2);
  return sha;
}

export async function syncBase(ctx, api, options, repo) {
  const { path, manifest: selected } = await selectTrain(ctx, repo, options.train);
  const perform = async () => {
    const manifest = await loadManifest(path, selected.train);
    if (manifest?.state !== 'open') throw new TrainError('train is not open');
    const record = manifestRecorder(ctx, options, path, manifest);
    const { ref } = manifest.base;
    const sha = await fetchBase(api, manifest, options.dryRun);
    const message = `Merge ${ref} into ${manifest.train}`;
    const { head, merged } = await mergeHead(api, manifest, { sha, message }, options.dryRun);
    if (!merged) {
      ctx.out(`${manifest.train} already contains ${ref}`);
      return;
    }
    manifest.head = head;
    manifest.base.sha = sha;
    await record.save('sync-base', ref);
    ctx.out(`${options.dryRun ? 'would sync' : 'synced'} ${ref} into ${manifest.train}`);
  };
  if (options.dryRun) await perform();
  else await withManifestLock(path, perform);
}
