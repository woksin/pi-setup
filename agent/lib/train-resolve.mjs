import { TrainError, PR_FIELDS, checkReviews, isBot } from './train-gh.mjs';
import { baseBranch } from './train-init.mjs';
import { listManifests, loadManifest, manifestPath } from './train-manifest.mjs';

export async function selectTrain(ctx, repo, branch, states = ['open']) {
  if (branch) {
    const path = manifestPath(ctx.env, repo, branch);
    const manifest = await loadManifest(path, branch);
    if (!manifest || !states.includes(manifest.state)) throw new TrainError(`no open train: ${branch}`);
    return { path, manifest };
  }
  const trains = (await listManifests(ctx.env, repo)).filter(entry => states.includes(entry.manifest.state));
  if (trains.length !== 1) throw new TrainError('select a train with --train (expected exactly one open train)');
  return trains[0];
}

export async function resolveItem(api, manifest, value) {
  let number = /^#?\d+$/.test(value) ? value.replace(/^#/, '') : null;
  if (!number) {
    const prs = await api.json(manifest.repo, ['pr', 'list', '--head', value, '--state', 'open', '--json', 'number']);
    if (prs.length > 1) throw new TrainError(`multiple open PRs for ${value}`);
    number = prs[0]?.number ?? manifest.items.find(item => item.branch === value)?.pr;
  }
  if (!number) return { branch: value, pr: null };
  const pr = await api.json(manifest.repo, ['pr', 'view', String(number), '--json', PR_FIELDS]);
  return { branch: pr.headRefName, sha: pr.headRefOid, pr };
}

async function checkAuthor(api, pr, allowForeign) {
  if (allowForeign || isBot(pr.author)) return;
  if (pr.author?.login !== await api.user()) throw new TrainError('another author: --allow-foreign is required');
}

export async function checkItem(api, manifest, resolved, options) {
  const { defaultRef, allowForeign } = options;
  if (['main', defaultRef, manifest.train].includes(resolved.branch)) throw new TrainError('cannot fold main, default or train branch');
  const pr = resolved.pr;
  if (!pr) return;
  if (pr.isCrossRepository) throw new TrainError('fork PRs cannot be folded');
  if (pr.baseRefName !== baseBranch(manifest)) throw new TrainError('PR base differs from train base');
  checkReviews(pr);
  await checkAuthor(api, pr, allowForeign);
}
