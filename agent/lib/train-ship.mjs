import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadManifest, saveManifest, slug, withManifestLock } from './train-manifest.mjs';
import { selectTrain } from './train-resolve.mjs';
import { checkBody, checkPackageLeaks, checkShip, gateEvidence, shipConfig } from './train-ship-check.mjs';
import { linkFoldedPRs, notesMarker, reviewerNotes, shipBody, shipLabel, shipTitle, upsertTrainPR } from './train-ship-pr.mjs';
import { preflight, publishText } from './train-publish.mjs';
import { baseBranch } from './train-init.mjs';

async function pushTrain(api, manifest) {
  const remote = (await api.git(manifest.worktree, ['ls-remote', 'origin', `refs/heads/${manifest.train}`])).stdout.trim().split(/\s+/)[0];
  if (manifest.shippedHead === manifest.head && remote === manifest.head) return;
  await api.git(manifest.worktree, ['push', '-u', 'origin', manifest.train], { mutate: true });
}

async function publish(ctx, api, operation) {
  const { manifest, options, prs, files, save } = operation;
  await pushTrain(api, manifest);
  if (options.dryRun) { ctx.out(`would open or update train PR for ${manifest.train}`); return; }
  manifest.shippedHead = manifest.head;
  await save();
  const session = { ctx, api, manifest, options };
  const pr = await upsertTrainPR(session, files);
  manifest.pr = pr.number;
  await save();
  const marker = notesMarker(manifest, files.notes);
  if (manifest.shipComment !== marker && !(pr.comments ?? []).some(comment => comment.body?.includes(marker))) {
    await publishText(ctx, options, { kind: 'pr-comment', repo: manifest.repo, number: pr.number, body: files.notesComment }, manifest);
  }
  manifest.shipComment = marker;
  await save();
  await linkFoldedPRs(session, prs, save);
  manifest.state = 'shipped';
  manifest.label = files.label;
  await save();
  ctx.out(`shipped ${manifest.train}: #${manifest.pr}`);
}

async function writeShipFiles(directory, manifest, files) {
  await mkdir(directory, { recursive: true });
  await writeFile(files.bodyFile, files.body);
  await writeFile(files.notesFile, files.notesComment);
}

export async function shipTrain(ctx, api, options, repo) {
  const selected = await selectTrain(ctx, repo, options.train, ['open', 'shipped']);
  const perform = async () => {
    const manifest = await loadManifest(selected.path, selected.manifest.train);
    const prs = await checkShip(api, manifest, options);
    await checkPackageLeaks(ctx, manifest);
    const config = await shipConfig(ctx);
    const evidence = await gateEvidence(ctx, manifest, config, options);
    const label = shipLabel(options, prs);
    const summary = options.summaryFile ? await readFile(resolve(ctx.cwd, options.summaryFile), 'utf8') : '';
    const body = shipBody(manifest, summary), notes = reviewerNotes(manifest, evidence);
    const directory = join(manifest.worktree, '.ai-work', 'trains', slug(manifest.train));
    const notesComment = `${notes}\n${notesMarker(manifest, notes)}\n`;
    const files = { body, notes, notesComment, label, bodyFile: join(directory, 'pr-body.md'), notesFile: join(directory, 'pr-notes.md') };
    // Fail before any file, check or push; the bytes sent later are these in-memory strings, never the files.
    preflight(ctx, manifest, { title: shipTitle(options, manifest), body, notes: notesComment, train: manifest.train, base: baseBranch(manifest), repo: manifest.repo });
    if (!options.dryRun) await writeShipFiles(directory, manifest, files);
    await checkBody(ctx, manifest, config, { files, dryRun: options.dryRun });
    const save = () => saveManifest(selected.path, manifest);
    await publish(ctx, api, { manifest, options, prs, files, save });
  };
  if (options.dryRun) await perform();
  else await withManifestLock(selected.path, perform);
}
