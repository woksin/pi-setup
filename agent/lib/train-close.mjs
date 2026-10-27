import { TrainError, client } from './train-gh.mjs';
import { loadManifest, saveManifest, withManifestLock } from './train-manifest.mjs';
import { selectTrain } from './train-resolve.mjs';
import { hintSuccessor } from './train-successor.mjs';

function closeRequest(options) {
  if (options.abandoned && (options.shipped || options.head)) throw new TrainError('--abandoned cannot be combined with --shipped/--head', 2);
  if (options.shipped && !/^#?\d+$/.test(options.shipped)) throw new TrainError('--shipped needs a PR number', 2);
  if (options.head && !/^[0-9a-f]{7,40}$/i.test(options.head)) throw new TrainError('--head needs a commit SHA', 2);
  return { state: options.abandoned ? 'abandoned' : 'released', pr: options.shipped ? Number(options.shipped.replace('#', '')) : null,
    head: options.head ?? null };
}

// Closing only records the end state; it never touches the worktree, branches or PRs, so it works when they are gone.
async function markClosed(ctx, selected, options, request) {
  const manifest = await loadManifest(selected.path, selected.manifest.train);
  if (!['open', 'shipped'].includes(manifest.state)) throw new TrainError(`train is already ${manifest.state}`);
  if (!options.dryRun) {
    manifest.state = request.state;
    manifest.closedAt = ctx.now();
    if (request.pr) manifest.pr = request.pr;
    if (request.head) manifest.shippedHead = request.head;
    const detail = [request.state, request.pr && `#${request.pr}`, request.head].filter(Boolean).join(' ');
    manifest.log.push({ at: ctx.now(), op: 'close', detail });
    await saveManifest(selected.path, manifest);
  }
  ctx.out(`${options.dryRun ? 'would mark' : 'marked'} ${manifest.train} ${request.state}${request.pr ? ` (#${request.pr})` : ''}`);
}

export async function closeTrain(ctx, repo, options) {
  const request = closeRequest(options);
  const selected = await selectTrain(ctx, repo, options.train, ['open', 'shipped']);
  const perform = () => markClosed(ctx, selected, options, request);
  if (options.dryRun) await perform();
  else {
    await withManifestLock(selected.path, perform);
    await hintSuccessor(ctx, client(ctx, options), repo, selected.manifest.base?.ref);
  }
}
