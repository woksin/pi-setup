import { listManifests } from './train-manifest.mjs';

export function protectedItems(manifests, repo) {
  return manifests.filter(({ manifest }) => manifest.repo === repo && !['released', 'abandoned'].includes(manifest.state))
    .flatMap(({ manifest }) => manifest.items.filter(item => ['folded', 'planned'].includes(item.kind))
      .map(item => ({ branch: item.branch, train: manifest.train, pr: manifest.pr })));
}

export function pushBlock(items, branches, allowBranch) {
  const item = items.find(item => branches.includes(item.branch) && item.branch !== allowBranch);
  if (!item) return undefined;
  const pr = item.pr ? ` (#${item.pr})` : '';
  return `Push refused: ${item.branch} is folded/planned into ${item.train}${pr}. Push the train instead.`;
}

export async function stdinGuard(ctx, repo, input) {
  const items = protectedItems(await listManifests(ctx.env, repo), repo);
  const branches = input.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)[2]?.replace(/^refs\/heads\//, ''));
  const reason = pushBlock(items, branches, ctx.env.PI_TRAIN_ALLOW_PUSH);
  if (!reason) return 0;
  ctx.err(reason);
  return 1;
}
