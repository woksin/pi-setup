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

function pushedBranch(line) {
  const fields = line.split(/\s+/);
  if (fields.length !== 4) return '';
  const [, sha, remoteRef] = fields;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return '';
  if (/^0+$/.test(sha)) return '';
  if (!remoteRef.startsWith('refs/heads/')) return '';
  return remoteRef.slice(11);
}

export async function stdinGuard(ctx, repo, input) {
  const items = protectedItems(await listManifests(ctx.env, repo), repo);
  const branches = input.trim().split('\n').map(pushedBranch).filter(Boolean);
  const reason = pushBlock(items, branches, ctx.env.PI_TRAIN_ALLOW_PUSH);
  if (!reason) return 0;
  ctx.err(reason);
  return 1;
}
