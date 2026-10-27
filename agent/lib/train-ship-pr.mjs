import { createHash } from 'node:crypto';
import { TrainError } from './train-gh.mjs';
import { baseBranch } from './train-init.mjs';
import { renderNotes } from './train-notes.mjs';
import { publishText } from './train-publish.mjs';

const RELEASE_LABELS = ['major', 'minor', 'patch', 'no-release'];
export function shipLabel(options, prs) {
  if (options.label) {
    if (!RELEASE_LABELS.includes(options.label)) throw new TrainError('label must be major, minor, patch or no-release', 2);
    return options.label;
  }
  const labels = new Set(prs.flatMap(pr => (pr.labels ?? []).map(label => label.name)));
  const label = RELEASE_LABELS.filter(value => value !== 'no-release').find(value => labels.has(value));
  if (label) return label;
  if (allNoRelease(prs)) return 'no-release';
  throw new TrainError('no release label on folded PRs; provide --label');
}

function allNoRelease(prs) {
  return prs.length > 0 && prs.every(pr => (pr.labels ?? []).some(label => label.name === 'no-release'));
}

export function shipBody(manifest, summary) {
  return [summary.trim(), renderNotes(manifest.notes)].filter(Boolean).join('\n\n') + '\n';
}

export function reviewerNotes(manifest, evidence) {
  const lines = manifest.items.filter(item => item.kind === 'folded').map(item =>
    `- ${item.pr ? `#${item.pr}` : item.branch}: ${item.sha}; cancelled runs: ${(item.cancelledRuns ?? []).join(', ') || 'none'}`);
  return `## Folded items\n\n${lines.join('\n')}\n\n## Verification\n\n${evidence}\n`;
}

function labelChanges(pr, files) {
  const labels = pr.labels ?? [];
  const add = labels.some(label => label.name === files.label) ? [] : [files.label];
  const remove = labels.filter(label => RELEASE_LABELS.includes(label.name) && label.name !== files.label).map(label => label.name);
  return { add, remove };
}

export function shipTitle(options, manifest) {
  return options.title ?? `Release train: ${manifest.items.filter(item => item.kind === 'folded').slice(0, 4)
    .map(item => item.pr ? `#${item.pr}` : item.branch).join(', ')}`;
}

async function editTrainPR(session, pr, files) {
  const { ctx, manifest, options } = session;
  const { add, remove } = labelChanges(pr, files);
  if (![pr.body !== files.body, add.length, remove.length].some(Boolean)) return;
  const request = { kind: 'pr-edit', repo: manifest.repo, number: pr.number, body: files.body };
  if (add.length) request.addLabels = add;
  if (remove.length) request.removeLabels = remove;
  await publishText(ctx, options, request, manifest);
}

async function createTrainPR(session, files) {
  const { ctx, api, manifest, options } = session;
  await publishText(ctx, options, { kind: 'pr-create', repo: manifest.repo, title: shipTitle(options, manifest), body: files.body,
    labels: [files.label], base: baseBranch(manifest), head: manifest.train }, manifest);
  // The publisher never returns gh output, so the new PR number is re-read.
  const found = await api.json(manifest.repo, ['pr', 'list', '--head', manifest.train, '--state', 'open', '--json', 'number']);
  if (found.length !== 1) throw new TrainError('train PR created but not found; rerun ship', 2);
  return { number: found[0].number, comments: [] };
}

export async function upsertTrainPR(session, files) {
  const { api, manifest } = session;
  const prs = await api.json(manifest.repo, ['pr', 'list', '--head', manifest.train, '--state', 'open', '--json', 'number,body,labels,comments']);
  if (prs.length > 1) throw new TrainError('multiple open train PRs');
  const pr = prs[0];
  if (!pr) return createTrainPR(session, files);
  await editTrainPR(session, pr, files);
  return pr;
}

export function notesMarker(manifest, notes) {
  const hash = createHash('sha256').update(`${manifest.head}\n${notes}`).digest('hex');
  return `<!-- pi-train:ship ${manifest.train} ${hash} -->`;
}

export async function linkFoldedPRs(session, prs, save) {
  const { ctx, manifest, options } = session;
  for (const pr of prs) {
    const marker = `<!-- pi-train:train-pr ${manifest.train} pr=${manifest.pr} -->`;
    const item = manifest.items.find(item => item.pr === pr.number);
    if (item.trainPR === manifest.pr || (pr.comments ?? []).some(comment => comment.body?.includes(marker))) continue;
    await publishText(ctx, options, { kind: 'pr-comment', repo: manifest.repo, number: pr.number, body: `Train PR: #${manifest.pr}\n\n${marker}` }, manifest);
    item.trainPR = manifest.pr;
    await save();
  }
}
