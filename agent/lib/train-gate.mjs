import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

function invocationCache(ctx, api, now) {
  if (!shared.has(ctx)) shared.set(ctx, { identity: repositoryIdentity(api), records: new Map() });
  const cache = shared.get(ctx);
  const state = phaseState(ctx.env);
  const key = `${state}\0${now}`;
  if (!cache.records.has(key)) cache.records.set(key, ledgerRecords(state, now));
  return { identity: cache.identity, records: cache.records.get(key) };
}

async function phaseDurations(ctx, api, manifest) {
  const groups = { build: [], test: [], integration: [] };
  const now = Date.parse(ctx.now());
  const { identity, records } = invocationCache(ctx, api, now);
  const repo = await identity(manifest.worktree);
  if (repo) {
    for (const record of await records) {
      if (completed(record, now) && await identity(record.cwd) === repo) groups[record.kind].push(record.runS);
    }
  }
  return groups;
}

export async function gateEstimate(ctx, api, manifest, override) {
  const configured = configuredGate(ctx, manifest, override);
  if (configured) return configured;
  const groups = await phaseDurations(ctx, api, manifest);
  const gateRuns = Object.values(groups).reduce((sum, values) => sum + values.length, 0);
  return { gateSeconds: gateRuns ? Object.values(groups).reduce((sum, values) => sum + p90(values), 0) : null,
    gateSource: gateRuns ? 'ledger' : null, gateRuns };
}
