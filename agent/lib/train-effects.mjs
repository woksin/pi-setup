import { TrainError, activeRuns } from './train-gh.mjs';
import { copyBullets, extractBullets } from './train-notes.mjs';

export async function closePR(api, operation, item) {
  const { manifest, resolved: { pr }, planned, record } = operation;
  const marker = `<!-- pi-train:fold ${manifest.train} -->`;
  const text = planned
    ? `Will be folded into \`${manifest.train}\` (local release train). Its changes and release notes ship with the train PR.`
    : `Folded into \`${manifest.train}\` (local release train). Its changes and release notes ship with the train PR.`;
  const comment = `${text}\n\n${marker}`;
  if (pr.state === 'OPEN') {
    await api.gh(manifest.repo, ['pr', 'close', String(pr.number), '--comment', comment], { mutate: true });
  } else if (!(pr.comments ?? []).some(entry => entry.body?.includes(marker))) {
    await api.gh(manifest.repo, ['pr', 'comment', String(pr.number), '--body', comment], { mutate: true });
  }
  item.closedAt ??= record.now();
  await record.save('close', `#${pr.number}`);
}

async function cancelRun(api, manifest, run) {
  const result = await api.gh(manifest.repo, ['run', 'cancel', String(run.databaseId)], { mutate: true, allowFailure: true });
  if (result.status === 0 || /already completed|cannot cancel.*completed/i.test(`${result.stdout} ${result.stderr}`)) return;
  throw new TrainError(`gh run cancel ${run.databaseId}: ${result.stderr || result.stdout}`, 2);
}

async function recordedCancel(api, operation, item, run) {
  const { manifest, record } = operation;
  item.pendingRun = run.databaseId;
  delete item.cancelledAt;
  await record.save('cancel-start', String(run.databaseId));
  await cancelRun(api, manifest, run);
  if (!item.cancelledRuns.includes(run.databaseId)) item.cancelledRuns.push(run.databaseId);
  delete item.pendingRun;
  await record.save('cancel', String(run.databaseId));
}

export async function cancelRuns(api, operation, item) {
  const { manifest, defaultRef, record } = operation;
  // The intent survives a crash between GitHub accepting a cancel and our checkpoint.
  if (item.pendingRun) await recordedCancel(api, operation, item, { databaseId: item.pendingRun });
  for (const run of await activeRuns(api, manifest, item.branch, defaultRef)) {
    await recordedCancel(api, operation, item, run);
  }
  item.cancelledAt ??= record.now();
  await record.save('cancel-complete', item.branch);
}

export function copyNotes(manifest, item, pr) {
  const extracted = extractBullets(pr?.body);
  copyBullets(manifest.notes, extracted.notes, pr?.number ?? null);
  item.summaryDropped = extracted.summaryDropped;
  item.noReleaseBullets = !!pr && !Object.values(extracted.notes).some(entries => entries.length);
  item.bulletsCopied = true;
}
