import { HELP } from './pi-train.mjs';
import { TrainError, defaultBranch } from './train-gh.mjs';
import { loadManifest, saveManifest, withManifestLock } from './train-manifest.mjs';
import { checkItem, resolveItem, selectTrain } from './train-resolve.mjs';
import { fetchHead, mergeHead } from './train-merge.mjs';
import { closePR, cancelRuns, copyNotes } from './train-effects.mjs';

function recorder(ctx, options, path, manifest) {
  let checkpoint = JSON.stringify(manifest);
  return {
    now: ctx.now,
    manual: text => ctx.out(`manual: ${text}`),
    save: async (op, detail) => {
      if (options.dryRun || JSON.stringify(manifest) === checkpoint) return;
      manifest.log.push({ at: ctx.now(), op, detail });
      await saveManifest(path, manifest);
      checkpoint = JSON.stringify(manifest);
    },
  };
}

async function recordAlreadyMerged(operation) {
  const { manifest, resolved, record } = operation;
  const known = manifest.items.find(item => item.pr === resolved.pr.number);
  if (known) known.kind = 'in-main';
  else manifest.items.push({ branch: resolved.branch, pr: resolved.pr.number, sha: resolved.sha, kind: 'in-main' });
  await record.save('in-main', resolved.branch);
  throw new TrainError('PR is already merged (in-main)');
}

async function prepareOperation(ctx, api, request, selected) {
  const { options, repo, args, planned } = request;
  const manifest = await loadManifest(selected.path, selected.manifest.train);
  if (manifest.state !== 'open') throw new TrainError('train is not open');
  const branch = args[0] ?? (await api.git(ctx.cwd, ['branch', '--show-current'])).stdout.trim();
  if (!branch) throw new TrainError(HELP, 2);
  const resolved = await resolveItem(api, manifest, branch);
  const defaultRef = await defaultBranch(api, repo);
  await checkItem(api, manifest, resolved, { defaultRef, allowForeign: options.allowForeign });
  if (planned && !resolved.pr) throw new TrainError('planned requires a PR', 2);
  const record = recorder(ctx, options, selected.path, manifest);
  return { manifest, resolved, defaultRef, record, planned, report: text => ctx.out(text) };
}

export async function foldTrain(ctx, api, request) {
  const { options, repo, args, planned } = request;
  const selected = await selectTrain(ctx, repo, planned ? args[1] : options.train);
  const perform = async () => {
    const operation = await prepareOperation(ctx, api, request, selected);
    if (operation.resolved.pr?.state === 'MERGED') await recordAlreadyMerged(operation);
    await applyFold(ctx, api, options, operation);
  };
  if (options.dryRun) await perform();
  else await withManifestLock(selected.path, perform);
}

async function forwardDelivery(api, manifest, item, resolved) {
  if (item.pr !== null || resolved.pr) return false;
  return (await api.git(manifest.worktree, ['merge-base', '--is-ancestor', item.sha, resolved.sha], { allowFailure: true })).status === 0;
}

async function checkPriorHead(ctx, api, operation, item) {
  const { manifest, resolved } = operation;
  if (!item || !resolved.sha) return;
  if (item.sha === resolved.sha) return;
  if (item.kind !== 'planned') {
    if (await forwardDelivery(api, manifest, item, resolved)) return;
    throw new TrainError('folded branch head moved');
  }
  ctx.err(`warning: planned head moved for ${resolved.branch}`);
}

function updateItem(operation, item, options) {
  const { resolved, planned, record } = operation;
  if (options.eta !== undefined) item.eta = options.eta;
  item.sha = resolved.sha;
  item.kind = planned ? 'planned' : 'folded';
  if (planned) item.planned ??= { at: record.now() };
  else item.mergedAt ??= record.now();
}

function foldedHeadMoved(item, resolved) {
  return item?.kind === 'folded' && item.sha !== resolved.sha;
}

async function mergeItem(api, options, operation, item) {
  const { manifest, resolved } = operation;
  resolved.sha = await fetchHead(api, manifest, resolved, options.dryRun, operation.report);
  if (foldedHeadMoved(item, resolved) && !await forwardDelivery(api, manifest, item, resolved)) {
    throw new TrainError('folded branch head moved');
  }
  manifest.head = await mergeHead(api, manifest, resolved, options.dryRun);
}

function createItem(operation) {
  const { manifest, resolved } = operation;
  const item = { branch: resolved.branch, pr: resolved.pr?.number ?? null, cancelledRuns: [] };
  manifest.items.push(item);
  return item;
}

async function finishItem(api, operation, item) {
  const { manifest, resolved, record } = operation;
  if (resolved.pr) {
    await closePR(api, operation, item);
  }
  await cancelRuns(api, operation, item);
  copyNotes(manifest, item, resolved.pr);
  await record.save('notes', resolved.branch);
}

async function applyFold(ctx, api, options, operation) {
  const { manifest, resolved, record, planned } = operation;
  const prior = manifest.items.find(entry => entry.branch === resolved.branch);
  if (prior?.kind === 'folded' && planned) throw new TrainError('item is already folded');
  await checkPriorHead(ctx, api, operation, prior);
  if (!planned) await mergeItem(api, options, operation, prior);
  const item = prior ?? createItem(operation);
  updateItem(operation, item, options);
  await record.save(planned ? 'planned' : 'merge', resolved.branch);
  await finishItem(api, operation, item);
  const prefix = options.dryRun ? 'would ' : '';
  const verb = planned ? 'plan' : 'fold';
  ctx.out(`${prefix}${verb} ${resolved.branch} into ${manifest.train}`);
}
