import { listManifests, normalizeRepo } from './train-manifest.mjs';

export function protectedItems(manifests, repo) {
  return manifests.filter(({ manifest }) => normalizeRepo(manifest.repo) === normalizeRepo(repo) && !['released', 'abandoned'].includes(manifest.state))
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

export function unreadablePush(repo, error) {
  return `Train guard: ${repo} manifests unreadable (${error.message}); repair or remove the unreadable file or storage path before pushing.`;
}

export async function stdinGuard(ctx, repo, input) {
  const branches = input.trim().split('\n').map(pushedBranch).filter(branch => branch && branch !== ctx.env.PI_TRAIN_ALLOW_PUSH);
  if (!branches.length) return 0;
  let manifests;
  try { manifests = await listManifests(ctx.env, repo); }
  catch (error) { ctx.err(unreadablePush(repo, error)); return 1; }
  const items = protectedItems(manifests, repo);
  const reason = pushBlock(items, branches, ctx.env.PI_TRAIN_ALLOW_PUSH);
  if (!reason) return 0;
  ctx.err(reason);
  return 1;
}
