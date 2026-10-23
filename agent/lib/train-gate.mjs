import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { TrainError } from './train-gh.mjs';

export const phaseState = env => env.PI_PHASE_STATE || join(env.HOME || homedir(), '.pi', 'agent', 'pi-phase', 'state');

async function ledgerFiles(state) {
  try { return (await readdir(join(state, 'ledger'))).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function parseLedgerLine(line) {
  try { return JSON.parse(line); }
  catch { return null; } // Partial or malformed lines are not gate history.
}

async function readLedgerFile(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function ledgerRecords(state) {
  const records = [];
  for (const file of await ledgerFiles(state)) {
    const text = await readLedgerFile(join(state, 'ledger', file));
    records.push(...text.split('\n').map(parseLedgerLine));
  }
  return records;
}

function recentTiming(record, now) {
  if (![record.startedAt, record.endedAt].every(value => Number.isFinite(Date.parse(value)))) return false;
  const stamp = Date.parse(record.ts);
  return stamp <= now && stamp >= now - 7 * 86400_000 && Number.isFinite(record.runS) && record.runS >= 0;
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

function configuredGate(manifest, override) {
  if (override !== undefined) return { gateSeconds: override, gateSource: 'flag', gateRuns: 0 };
  if (manifest.gateSeconds === undefined) return null;
  if (!Number.isFinite(manifest.gateSeconds) || manifest.gateSeconds <= 0) throw new TrainError('manifest gateSeconds must be a positive number', 2);
  return { gateSeconds: manifest.gateSeconds, gateSource: 'manifest', gateRuns: 0 };
}

async function phaseDurations(ctx, api, manifest) {
  const groups = { build: [], test: [], integration: [] };
  const identity = repositoryIdentity(api);
  const repo = await identity(manifest.worktree);
  if (repo) {
    const now = Date.parse(ctx.now());
    for (const record of await ledgerRecords(phaseState(ctx.env))) {
      if (completed(record, now) && await identity(record.cwd) === repo) groups[record.kind].push(record.runS);
    }
  }
  return groups;
}

export async function gateEstimate(ctx, api, manifest, override) {
  const configured = configuredGate(manifest, override);
  if (configured) return configured;
  const groups = await phaseDurations(ctx, api, manifest);
  const gateRuns = Object.values(groups).reduce((sum, values) => sum + values.length, 0);
  return { gateSeconds: gateRuns ? Object.values(groups).reduce((sum, values) => sum + p90(values), 0) : null,
    gateSource: gateRuns ? 'ledger' : null, gateRuns };
}
