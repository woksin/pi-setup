import { createHash } from 'node:crypto';
import { TrainError } from './train-gh.mjs';
import { baseBranch } from './train-init.mjs';
import { renderNotes } from './train-notes.mjs';

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

function editArguments(pr, files) {
  const args = ['pr', 'edit', String(pr.number)];
  if (pr.body !== files.body) args.push('--body-file', files.bodyFile);
  if (!(pr.labels ?? []).some(label => label.name === files.label)) args.push('--add-label', files.label);
  const obsolete = (pr.labels ?? []).filter(label => RELEASE_LABELS.includes(label.name) && label.name !== files.label);
  for (const label of obsolete) args.push('--remove-label', label.name);
  return args;
}

export async function upsertTrainPR(api, manifest, options, files) {
  const prs = await api.json(manifest.repo, ['pr', 'list', '--head', manifest.train, '--state', 'open', '--json', 'number,body,labels,comments']);
  if (prs.length > 1) throw new TrainError('multiple open train PRs');
  const pr = prs[0];
  if (pr) {
    const args = editArguments(pr, files);
    if (args.length > 3) await api.gh(manifest.repo, args, { mutate: true });
    return pr;
  }
  const title = options.title ?? `Release train: ${manifest.items.filter(item => item.kind === 'folded').slice(0, 4)
    .map(item => item.pr ? `#${item.pr}` : item.branch).join(', ')}`;
  const result = await api.gh(manifest.repo, ['pr', 'create', '--base', baseBranch(manifest), '--head', manifest.train,
    '--title', title, '--body-file', files.bodyFile, '--label', files.label], { mutate: true });
  const match = result.stdout.trim().match(/\/(\d+)\/?$/);
  if (!match) throw new TrainError('could not read created train PR number', 2);
  return { number: Number(match[1]), comments: [] };
}

export function notesMarker(manifest, notes) {
  const hash = createHash('sha256').update(`${manifest.head}\n${notes}`).digest('hex');
  return `<!-- pi-train:ship ${manifest.train} ${hash} -->`;
}

export async function linkFoldedPRs(api, manifest, prs, save) {
  for (const pr of prs) {
    const marker = `<!-- pi-train:train-pr ${manifest.train} pr=${manifest.pr} -->`;
    const item = manifest.items.find(item => item.pr === pr.number);
    if (item.trainPR === manifest.pr || (pr.comments ?? []).some(comment => comment.body?.includes(marker))) continue;
    await api.gh(manifest.repo, ['pr', 'comment', String(pr.number), '--body', `Train PR: #${manifest.pr}\n\n${marker}`], { mutate: true });
    item.trainPR = manifest.pr;
    await save();
  }
}
