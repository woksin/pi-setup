import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { shipConfig } from './train-ship-check.mjs';

export const phaseState = env => env.PI_PHASE_STATE || join(env.HOME || homedir(), '.pi', 'agent', 'pi-phase', 'state');

const WINDOW_MS = 7 * 86400_000;

// Ledger files are named by UTC day; one extra day covers records written just after midnight.
async function ledgerFiles(state, now) {
  const oldest = new Date(now - WINDOW_MS - 86400_000).toISOString().slice(0, 10);
  try { return (await readdir(join(state, 'ledger'))).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= oldest); }
  catch { return []; } // An unreadable ledger is no gate history, never a status failure.
}

function parseLedgerLine(line) {
  try { return JSON.parse(line); }
  catch { return null; } // Partial or malformed lines are not gate history.
}

async function readLedgerFile(path) {
  try { return await readFile(path, 'utf8'); }
  catch { return ''; }
}

async function ledgerRecords(state, now) {
  const records = [];
  for (const file of await ledgerFiles(state, now)) {
    const text = await readLedgerFile(join(state, 'ledger', file));
    records.push(...text.split('\n').map(parseLedgerLine));
  }
  return records;
}

function recentTiming(record, now) {
  if (![record.startedAt, record.endedAt].every(value => Number.isFinite(Date.parse(value)))) return false;
  const stamp = Date.parse(record.ts);
  return stamp <= now && stamp >= now - WINDOW_MS && Number.isFinite(record.runS) && record.runS >= 0;
}

function completed(record, now) {
  if (!record || !['build', 'test', 'integration'].includes(record.kind)) return false;
  if (!['passed', 'failed', 'timeout'].includes(record.outcome) || !Number.isInteger(record.exit)) return false;
  return typeof record.cwd === 'string' && recentTiming(record, now);
}

async function resolveIdentity(api, cwd) {
  const result = await api.git(cwd, ['rev-parse', '--git-common-dir'], { allowFailure: true });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try { return await realpath(resolve(cwd, result.stdout.trim())); }
  catch { return null; }
}

function repositoryIdentity(api) {
  const identities = new Map();
  return async cwd => {
    if (!identities.has(cwd)) {
      identities.set(cwd, resolveIdentity(api, cwd));
    }
    return identities.get(cwd);
  };
}

const p90 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] ?? 0;

function configuredGate(ctx, manifest, override) {
  if (override !== undefined) return { gateSeconds: override, gateSource: 'flag', gateRuns: 0 };
  if (manifest.gateSeconds === undefined) return null;
  if (!Number.isFinite(manifest.gateSeconds) || manifest.gateSeconds <= 0) {
    ctx.err?.(`warning: manifest gateSeconds must be a positive number; using ledger history (${manifest.worktree ?? 'train'})`);
    return null;
  }
  return { gateSeconds: manifest.gateSeconds, gateSource: 'manifest', gateRuns: 0 };
}

// One ledger read and one cwd -> repository cache per invocation, shared by every train in `status --all`.
const shared = new WeakMap();

// The clock is snapshotted with the first read so every train in one invocation uses the same window.
function invocationCache(ctx, api) {
  if (!shared.has(ctx)) shared.set(ctx, { identity: repositoryIdentity(api), records: new Map() });
  const cache = shared.get(ctx);
  const state = phaseState(ctx.env);
  if (!cache.records.has(state)) {
    const now = Date.parse(ctx.now());
    cache.records.set(state, { now, records: ledgerRecords(state, now) });
  }
  return { identity: cache.identity, ...cache.records.get(state) };
}

async function phaseDurations(ctx, api, manifest) {
  const groups = { build: [], test: [] };
  const eligible = [];
  const { identity, records, now } = invocationCache(ctx, api);
  const repo = await identity(manifest.worktree);
  if (repo) {
    for (const record of await records) {
      if (!completed(record, now) || record.kind === 'integration') continue;
      if (await identity(record.cwd) === repo) {
        groups[record.kind].push(record.runS);
        eligible.push(record);
      }
    }
  }
  return { groups, eligible };
}

function componentMatch(record, components) {
  return !components || components.some(component => component.kind === record.kind && new RegExp(component.label, 'i').test(record.label ?? ''));
}

function chainHeads(records, components) {
  const heads = new Map();
  for (const record of records) {
    if (record.dirty !== 'clean' || typeof record.head !== 'string') continue;
    if (!componentMatch(record, components)) continue;
    if (!heads.has(record.head)) heads.set(record.head, []);
    heads.get(record.head).push(record);
  }
  return heads;
}

function splitChains(group) {
  const chains = [];
  let chain = [];
  for (const record of group.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    if (chain.length && Date.parse(record.startedAt) - Date.parse(chain.at(-1).endedAt) > 1800_000) {
      chains.push(chain); chain = [];
    }
    chain.push(record);
  }
  if (chain.length) chains.push(chain);
  return chains;
}

function chainSpans(records, components) {
  return [...chainHeads(records, components).values()].flatMap(splitChains)
    .filter(chain => chain.every(record => record.outcome === 'passed'))
    .map(chain => (Date.parse(chain.at(-1).endedAt) - Date.parse(chain[0].startedAt)) / 1000);
}

function median(values) {
  const sorted = values.sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function gateEstimate(ctx, api, manifest, override) {
  const configured = configuredGate(ctx, manifest, override);
  if (configured) return configured;
  const { groups, eligible } = await phaseDurations(ctx, api, manifest);
  const config = await shipConfig(ctx);
  const chains = chainSpans(eligible, config.gateComponents?.[manifest.repo]);
  if (chains.length >= 3) return { gateSeconds: median(chains), gateSource: 'ledger-chain', gateRuns: chains.length };
  const gateRuns = Object.values(groups).reduce((sum, values) => sum + values.length, 0);
  return { gateSeconds: gateRuns ? Object.values(groups).reduce((sum, values) => sum + p90(values), 0) : null,
    gateSource: gateRuns ? 'ledger-sum' : null, gateRuns };
}
