import { TrainError } from './train-gh.mjs';
import { loadManifest, saveManifest, withManifestLock } from './train-manifest.mjs';
import { selectTrain } from './train-resolve.mjs';

// Closing only records the end state; it never touches the worktree, branches or PRs, so it works when they are gone.
async function markClosed(ctx, selected, options, state) {
  const manifest = await loadManifest(selected.path, selected.manifest.train);
  if (!['open', 'shipped'].includes(manifest.state)) throw new TrainError(`train is already ${manifest.state}`);
  if (!options.dryRun) {
    manifest.state = state;
    manifest.closedAt = ctx.now();
    manifest.log.push({ at: ctx.now(), op: 'close', detail: state });
    await saveManifest(selected.path, manifest);
  }
  ctx.out(`${options.dryRun ? 'would mark' : 'marked'} ${manifest.train} ${state}`);
}

export async function closeTrain(ctx, repo, options) {
  const state = options.abandoned ? 'abandoned' : 'released';
  const selected = await selectTrain(ctx, repo, options.train, ['open', 'shipped']);
  const perform = () => markClosed(ctx, selected, options, state);
  if (options.dryRun) await perform();
  else await withManifestLock(selected.path, perform);
}
