import { activeRuns, defaultBranch } from './train-gh.mjs';
import { listManifests } from './train-manifest.mjs';

const needsClosing = (item, liveState) => item.pr && (!item.closedAt || liveState === 'OPEN');

function pendingSteps(item, liveState) {
  const pending = [];
  if (item.kind === 'folded' && !item.mergedAt) pending.push('merge');
  if (needsClosing(item, liveState)) pending.push('close');
  if (item.pr && !item.cancelledAt) pending.push('cancel');
  if (!item.bulletsCopied) pending.push('notes');
  return pending;
}

function itemWarnings(item) {
  const warnings = [];
  if (item.noReleaseBullets) warnings.push(`no release bullets in #${item.pr}`);
  if (item.summaryDropped) warnings.push(`Summary omitted from #${item.pr} release notes`);
  return warnings;
}

async function statusItems(api, manifest, defaultRef, anomalies) {
  const items = [];
  const runs = [];
  for (const item of manifest.items) {
    if (!['folded', 'planned'].includes(item.kind)) { items.push({ ...item }); continue; }
    const pr = item.pr ? await api.json(manifest.repo, ['pr', 'view', String(item.pr), '--json', 'number,state']) : null;
    if (pr?.state === 'OPEN') anomalies.push(`open PR #${item.pr} for ${item.kind} item`);
    runs.push(...await activeRuns(api, manifest, item.branch, defaultRef));
    items.push({ ...item, closed: pr ? pr.state !== 'OPEN' : null, cancelledRunCount: item.cancelledRuns?.length ?? 0,
      pending: pendingSteps(item, pr?.state), warnings: itemWarnings(item) });
  }
  return { items, activeRuns: runs };
}

async function ancestorAnomalies(api, manifest, head, anomalies) {
  const prs = await api.json(manifest.repo, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,headRefOid']);
  for (const pr of prs) {
    if (pr.headRefName === manifest.train) continue;
    const result = await api.git(manifest.worktree, ['merge-base', '--is-ancestor', pr.headRefOid, head], { allowFailure: true });
    if (result.status === 0) anomalies.push(`open PR #${pr.number} head is an ancestor of ${manifest.train}`);
    else if (result.status !== 1) anomalies.push(`unverified ancestry for open PR #${pr.number}`);
  }
}

async function trainStatus(api, manifest) {
  const anomalies = [];
  const head = (await api.git(manifest.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await api.git(manifest.worktree, ['branch', '--show-current'])).stdout.trim();
  if (head !== manifest.head) anomalies.push('train HEAD differs from manifest.head');
  if (branch !== manifest.train) anomalies.push('worktree is not on train branch');
  const counts = await api.git(manifest.worktree, ['rev-list', '--left-right', '--count', `origin/main...${head}`], { allowFailure: true });
  const [behind, ahead] = counts.status === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
  if (counts.status !== 0) anomalies.push('unverified position relative to origin/main');
  const defaultRef = await defaultBranch(api, manifest.repo);
  const details = await statusItems(api, manifest, defaultRef, anomalies);
  await ancestorAnomalies(api, manifest, head, anomalies);
  return { repo: manifest.repo, train: manifest.train, state: manifest.state, head, manifestHead: manifest.head,
    ahead, behind, ...details, anomalies, pending: details.items.filter(item => item.pending?.length) };
}

function display(ctx, status) {
  ctx.out(`${status.repo} ${status.train}: ahead ${status.ahead ?? '?'}, behind ${status.behind ?? '?'}`);
  for (const item of status.items) {
    ctx.out(`  ${item.kind} ${item.branch} ${item.sha} ${item.pr ? `#${item.pr} closed=${item.closed}` : '(no PR)'} cancelled=${item.cancelledRunCount ?? 0}`);
    if (item.pending?.length) ctx.out(`    pending: ${item.pending.join(', ')}`);
    for (const warning of item.warnings ?? []) ctx.out(`    warning: ${warning}`);
  }
  for (const anomaly of status.anomalies) ctx.out(`  anomaly: ${anomaly}`);
  for (const run of status.activeRuns) ctx.out(`  active run: ${run.databaseId} ${run.headBranch} (${run.workflowName}, ${run.status})`);
}

function printStatuses(ctx, trains, json) {
  if (json) { ctx.out(JSON.stringify({ v: 1, trains })); return; }
  if (!trains.length) { ctx.out('no open trains'); return; }
  for (const status of trains) display(ctx, status);
}

function matches(manifest, options) {
  if (manifest.state !== 'open') return false;
  return !options.train || manifest.train === options.train;
}

const anomalous = status => status.anomalies.length || status.activeRuns.length || status.pending.length;

export async function statusTrains(ctx, api, options, repo) {
  const entries = await listManifests(ctx.env, options.all ? undefined : repo);
  const trains = [];
  for (const entry of entries.filter(entry => matches(entry.manifest, options))) {
    trains.push(await trainStatus(api, entry.manifest));
  }
  printStatuses(ctx, trains, options.json);
  return trains.some(anomalous) ? 1 : 0;
}
