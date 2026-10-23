import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { TrainError } from './train-gh.mjs';
import { trainHome } from './train-manifest.mjs';

export async function shipConfig(ctx) {
  try { return JSON.parse(await readFile(join(trainHome(ctx.env), 'config.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function parseLedgerLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function ledgerEntries(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const name of names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
    const lines = (await readFile(join(directory, name), 'utf8')).split('\n');
    records.push(...lines.map(parseLedgerLine).filter(Boolean));
  }
  return records;
}

function validGateRecord(record, manifest) {
  return record.outcome === 'passed' && record.verified === true && record.head === manifest.head
    && record.dirty === 'clean' && ['build', 'test'].includes(record.kind);
}

function describeEvidence(record) {
  return `${record.kind}: ${record.label ?? ''} (${record.ts ?? ''})`;
}

export async function gateEvidence(ctx, manifest, config) {
  const directory = join(ctx.env.HOME, '.pi', 'agent', 'pi-phase', 'state', 'ledger');
  const records = await ledgerEntries(directory);
  const evidence = records.filter(record => validGateRecord(record, manifest));
  if (evidence.length) return evidence.map(describeEvidence).join('\n');
  const message = `no verified Tier 1 for ${manifest.head.slice(0, 7)}`;
  if (config.requireGate === true) throw new TrainError(message);
  ctx.err(`warning: ${message}`);
  return message;
}

function pending(item) {
  if (item.kind === 'planned') return true;
  if (item.kind !== 'folded') return false;
  return !item.mergedAt || !item.bulletsCopied || item.pendingRun
    || (item.pr && (!item.closedAt || !item.cancelledAt));
}

function checkItems(manifest) {
  if (!['open', 'shipped'].includes(manifest.state)) throw new TrainError('train is not open');
  const folded = manifest.items.filter(item => item.kind === 'folded');
  if (!folded.length || manifest.items.some(pending)) throw new TrainError('ship requires folded items and no pending steps');
  return folded;
}

async function gitValue(api, manifest, args) {
  return (await api.git(manifest.worktree, args)).stdout.trim();
}

async function checkWorktree(api, manifest) {
  const branch = await gitValue(api, manifest, ['branch', '--show-current']);
  const dirty = await gitValue(api, manifest, ['status', '--porcelain']);
  const head = await gitValue(api, manifest, ['rev-parse', 'HEAD']);
  const valid = [!dirty, branch === manifest.train, head === manifest.head].every(Boolean);
  if (!valid) throw new TrainError('train worktree must be clean on manifest.head and the train branch');
}

async function checkBase(api, manifest, options) {
  await api.git(manifest.worktree, ['fetch', 'origin', manifest.base.ref.replace(/^origin\//, '')], { mutate: true });
  if (options.allowBehind) return;
  const result = await api.git(manifest.worktree, ['merge-base', '--is-ancestor', manifest.base.ref, manifest.head], { allowFailure: true });
  if (result.status > 1) throw new TrainError(result.stderr || 'cannot check train base ancestry', 2);
  if (result.status !== 0) throw new TrainError('merge origin/main into the train first');
}

async function closedPRs(api, manifest, folded) {
  const prs = [];
  for (const item of folded.filter(item => item.pr)) {
    const pr = await api.json(manifest.repo, ['pr', 'view', String(item.pr), '--json', 'number,state,labels,comments']);
    if (pr.state === 'OPEN') throw new TrainError(`folded PR #${item.pr} was reopened`);
    prs.push(pr);
  }
  return prs;
}

export async function checkShip(api, manifest, options) {
  const folded = checkItems(manifest);
  await checkWorktree(api, manifest);
  await checkBase(api, manifest, options);
  return closedPRs(api, manifest, folded);
}

// Slice (c) supplies the local package version leak check here.
export async function checkPackageLeaks() {}

async function bodyChecker(manifest, config) {
  const script = join(manifest.worktree, '.cratis', 'ai', 'hooks', 'scripts', 'cratis-check-pr.mjs');
  try { await access(script); return ['node', script, '--body-file', '{bodyFile}', '--label', '{label}']; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return config.checkPr;
}

function checkerArgs(command, files) {
  if (!Array.isArray(command)) throw new TrainError('checkPr must be a nonempty argv array', 2);
  if (!command.length || command.some(arg => typeof arg !== 'string')) throw new TrainError('checkPr must be a nonempty argv array', 2);
  return command.map(arg => arg.replaceAll('{bodyFile}', files.bodyFile).replaceAll('{label}', files.label));
}

function checkerFailure(result) {
  return new TrainError(result.stderr || result.stdout || 'PR-body check failed');
}

export async function checkBody(ctx, manifest, config, request) {
  const command = await bodyChecker(manifest, config);
  if (!command) { ctx.out('no PR-body check in this repo'); return; }
  const [program, ...args] = checkerArgs(command, request.files);
  if (request.dryRun) { ctx.out(`would check PR body: ${[program, ...args].join(' ')}`); return; }
  const result = await ctx.run(program, args, { cwd: manifest.worktree, env: ctx.env });
  if (result.status !== 0) throw checkerFailure(result);
}
