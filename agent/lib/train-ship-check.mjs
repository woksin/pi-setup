import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { TrainError } from './train-gh.mjs';
import { trainHome } from './train-manifest.mjs';

// Built-in Tier 1 component sets, derived from each repository's CI; the user's config.json wins per repository.
const DEFAULTS = new URL('./train-gate-defaults.json', import.meta.url);

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function shipConfig(ctx) {
  const defaults = await readJson(DEFAULTS);
  const config = await readJson(join(trainHome(ctx.env), 'config.json'));
  validateComponents(defaults);
  validateComponents(config);
  if (defaults.gateComponents) config.gateComponents = { ...defaults.gateComponents, ...config.gateComponents };
  return config;
}

function validateComponent(component) {
  if (!component || !['build', 'test'].includes(component.kind)) throw new TrainError('Tier 1 is non-integration; component kind must be build or test');
  if (!nonemptyString(component.id) || typeof component.label !== 'string') {
    throw new TrainError('gateComponents require a nonempty id and regex label');
  }
  try { new RegExp(component.label, 'i'); }
  catch { throw new TrainError(`invalid gateComponents regex for ${component.id}`); }
}

function nonemptyString(value) { return typeof value === 'string' && Boolean(value.trim()); }
function objectMap(value) { return Boolean(value) && !Array.isArray(value) && typeof value === 'object'; }

function validateComponentList(components) {
  if (!Array.isArray(components) || !components.length) throw new TrainError('gateComponents must contain nonempty component arrays');
  components.forEach(validateComponent);
  if (new Set(components.map(component => component.id)).size !== components.length) throw new TrainError('gateComponents ids must be unique');
}

function validateComponents(config) {
  if (config.gateComponents === undefined) return;
  if (!objectMap(config.gateComponents)) {
    throw new TrainError('gateComponents must map repositories to component arrays');
  }
  Object.values(config.gateComponents).forEach(validateComponentList);
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

function missingEvidence(ctx, config, message) {
  if (config.requireGate === true) throw new TrainError(message);
  ctx.err(`warning: ${message}`);
  return message;
}

function componentEvidence(ctx, manifest, config, records) {
  const matches = config.gateComponents[manifest.repo].map(component => ({ component, record: records.find(record =>
    record.kind === component.kind && new RegExp(component.label, 'i').test(record.label ?? '')) }));
  const missing = matches.filter(match => !match.record).map(match => match.component.id);
  if (missing.length) return missingEvidence(ctx, config, `Tier 1 incomplete for ${manifest.head.slice(0, 7)}: missing ${missing.join(', ')}`);
  return matches.map(({ component, record }) => `${component.id}: ${describeEvidence(record)}`).join('\n');
}

function unconfiguredEvidence(ctx, manifest, config, evidence, options) {
  if (!options.allowUnconfiguredGate) {
    throw new TrainError(`no gateComponents configured for ${manifest.repo}; add a Tier 1 component set to the train config or pass --allow-unconfigured-gate`);
  }
  ctx.err(`warning: --allow-unconfigured-gate: no gateComponents for ${manifest.repo}; accepting any verified clean build/test`);
  if (evidence.length) return evidence.map(describeEvidence).join('\n');
  return missingEvidence(ctx, config, `no verified Tier 1 for ${manifest.head.slice(0, 7)}`);
}

export async function gateEvidence(ctx, manifest, config, options = {}) {
  validateComponents(config);
  const directory = join(ctx.env.HOME, '.pi', 'agent', 'pi-phase', 'state', 'ledger');
  const records = await ledgerEntries(directory);
  const evidence = records.filter(record => validGateRecord(record, manifest));
  const components = config.gateComponents?.[manifest.repo];
  if (components) return componentEvidence(ctx, manifest, config, evidence);
  return unconfiguredEvidence(ctx, manifest, config, evidence, options);
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
