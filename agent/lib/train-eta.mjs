import { TrainError } from './train-gh.mjs';
import { loadManifest, saveManifest, withManifestLock } from './train-manifest.mjs';
import { selectTrain } from './train-resolve.mjs';

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
  const seconds = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TrainError('invalid gate duration; use e.g. 90m or 2h', 2);
  return seconds;
}

function validCalendarDay(value) {
  const day = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value;
}

function validClockTime(parts) {
  return parts.every((part, index) => Number(part) <= [23, 59, 59][index]);
}

function absoluteEta(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  if (!validClockTime(match.slice(2)) || !validCalendarDay(match[1])) return NaN;
  return Date.parse(value);
}

export function parseEta(value, now) {
  const relative = /^\+(\d+)([mhd])$/.exec(value);
  const stamp = relative ? Date.parse(now) + Number(relative[1]) * UNITS[relative[2]] * 1000 : absoluteEta(value);
  if (!Number.isFinite(stamp) || Math.abs(stamp) > 8.64e15) {
    throw new TrainError('invalid eta; use an ISO 8601 timestamp with timezone or +90m/+2h/+1d', 2);
  }
  return new Date(stamp).toISOString();
}

function findDelivery(manifest, value) {
  return manifest.items.find(item => item.branch === value || (item.pr && String(item.pr) === value.replace(/^#/, '')));
}

async function updateEta(ctx, selected, options, { value, eta }) {
  const manifest = await loadManifest(selected.path, selected.manifest.train);
  if (manifest.state !== 'open') throw new TrainError('train is not open');
  const item = findDelivery(manifest, value);
  if (!item) throw new TrainError(`no delivery: ${value}`);
  if (eta === null) delete item.eta;
  else item.eta = eta;
  if (!options.dryRun) {
    manifest.log.push({ at: ctx.now(), op: 'eta', detail: item.branch });
    await saveManifest(selected.path, manifest);
  }
  ctx.out(`${options.dryRun ? 'would set' : 'set'} eta for ${item.branch}: ${eta ?? 'no eta'}`);
}

export async function setEta(ctx, repo, options, args) {
  const eta = args[1] === 'clear' ? null : parseEta(args[1], ctx.now());
  const selected = await selectTrain(ctx, repo, options.train);
  const perform = () => updateEta(ctx, selected, options, { value: args[0], eta });
  if (options.dryRun) await perform();
  else await withManifestLock(selected.path, perform);
}

export const durationText = seconds => seconds < 60 ? `${Math.ceil(seconds)}s` : `${Math.ceil(seconds / 60)}m`;
export const deliveryName = item => item.pr ? `#${item.pr}` : item.branch;
// Only an unmerged delivery is still on its way; leftover close/cancel/notes cleanup never holds a train.
const awaiting = item => item.kind === 'planned' || item.kind === 'pending' || Boolean(item.pending?.includes('merge'));

export function cutRecommendation(items, gate, now) {
  if (gate.gateSeconds === null) return { recommendation: 'unknown', recommendationText: 'recommendation: unknown — no gate history; pass --gate' };
  const deadline = Date.parse(now) + gate.gateSeconds * 1000;
  const due = items.filter(item => awaiting(item) && Number.isFinite(Date.parse(item.eta)) && Date.parse(item.eta) <= deadline)
    .sort((a, b) => Date.parse(a.eta) - Date.parse(b.eta))[0];
  const duration = durationText(gate.gateSeconds);
  if (!due) return { recommendation: 'cut', recommendationText: `recommendation: cut — no pending delivery due within the gate (≈ ${duration})` };
  return holdRecommendation(due, gate, now);
}

function holdRecommendation(due, gate, now) {
  const duration = durationText(gate.gateSeconds);
  const seconds = (Date.parse(due.eta) - Date.parse(now)) / 1000;
  const readiness = seconds < 0 ? 'due now (overdue)' : `due in ${durationText(seconds)}`;
  const history = gate.gateSource === 'ledger-chain' ? `, median of ${gate.gateRuns} measured gate chains`
    : gate.gateSource === 'ledger-sum' ? `, p90 from ${gate.gateRuns} runs` : '';
  return { recommendation: 'hold', recommendationText: `recommendation: hold — ${deliveryName(due)} ${readiness} (gate ≈ ${duration}${history})` };
}
