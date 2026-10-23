import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { client, realContext } from './train-gh.mjs';
import { gateEstimate, phaseState } from './train-gate.mjs';
import { cutRecommendation, parseDuration, parseEta } from './train-eta.mjs';

const NOW = '2026-10-23T12:00:00Z';

test('ETA grammar normalizes absolute offsets and resolves relative units', () => {
  assert.equal(parseEta('2026-10-23T14:30:00+02:00', NOW), '2026-10-23T12:30:00.000Z');
  assert.equal(parseEta('2026-10-23T12:30:00.123Z', NOW), '2026-10-23T12:30:00.123Z');
  assert.equal(parseEta('+90m', NOW), '2026-10-23T13:30:00.000Z');
  assert.equal(parseEta('+2h', NOW), '2026-10-23T14:00:00.000Z');
  assert.equal(parseEta('+1d', NOW), '2026-10-24T12:00:00.000Z');
  for (const value of ['tomorrow', '2026-02-30T12:00:00Z', '2026-10-23', '2026-10-23T12:00:00', '2026-10-23T24:00:00Z', '+2w', '-1h']) {
    assert.throws(() => parseEta(value, NOW), /invalid eta/);
  }
});

test('gate durations require positive finite numbers with units', () => {
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('1.5h'), 5400);
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('1d'), 86400);
  for (const value of ['0m', '-2h', '1w', '500', 'no']) assert.throws(() => parseDuration(value), /invalid gate duration/);
});

test('recommendation considers only awaiting deliveries and includes the exact gate boundary', () => {
  const gate = { gateSeconds: 600, gateSource: 'ledger', gateRuns: 9 };
  const item = { pr: 7, kind: 'planned', eta: '2026-10-23T12:10:00Z' };
  assert.equal(cutRecommendation([item], gate, NOW).recommendation, 'hold');
  assert.match(cutRecommendation([item], gate, NOW).recommendationText, /p90 from 9 runs/);
  assert.equal(cutRecommendation([{ ...item, eta: '2026-10-23T12:10:01Z' }], gate, NOW).recommendation, 'cut');
  assert.match(cutRecommendation([{ ...item, eta: '2026-10-23T11:00:00Z' }], gate, NOW).recommendationText, /overdue/);
  assert.equal(cutRecommendation([{ ...item, eta: NOW }], gate, NOW).recommendation, 'hold');
  assert.equal(cutRecommendation([{ ...item, eta: undefined }], gate, NOW).recommendation, 'cut');
  assert.equal(cutRecommendation([{ ...item, kind: 'folded', pending: [] }], gate, NOW).recommendation, 'cut');
  assert.equal(cutRecommendation([{ ...item, kind: 'folded', pending: ['merge'] }], gate, NOW).recommendation, 'hold');
  for (const step of ['close', 'cancel', 'notes']) {
    assert.equal(cutRecommendation([{ ...item, kind: 'folded', pending: [step], eta: '2026-10-23T11:00:00Z' }], gate, NOW).recommendation, 'cut');
  }
  assert.equal(cutRecommendation([item], { gateSeconds: null }, NOW).recommendation, 'unknown');
});

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'train-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  await mkdir(join(state, 'ledger'), { recursive: true });
  const ctx = { ...realContext(), cwd: root, env: { ...process.env, HOME: root, PI_PHASE_STATE: state }, now: () => NOW };
  const api = client(ctx, {});
  return { root, state, ctx, api };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function run(cwd: string, kind = 'build', runS = 60) {
  return { v: 1, ts: NOW, kind, cwd, exit: 0, outcome: 'passed', runS, waitS: 9999,
    startedAt: '2026-10-23T11:00:00Z', endedAt: NOW };
}

test('ledger matches real common directories across checkouts, worktrees and subdirectories, not other repos', async t => {
  const f = await fixture(t);
  const repo = join(f.root, 'repo'), worktree = join(f.root, 'elsewhere'), other = join(f.root, 'other');
  await mkdir(repo); await mkdir(other);
  git(repo, 'init');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', 'train', worktree);
  git(other, 'init');
  const subdir = join(repo, 'nested'); await mkdir(subdir);
  const workSubdir = join(worktree, 'nested'); await mkdir(workSubdir);
  const records = Array.from({ length: 10 }, (_, i) => run(i % 2 ? subdir : workSubdir, 'build', (i + 1) * 10));
  records.push(run(repo, 'test', 120), run(worktree, 'integration', 180));
  records.push(run(other, 'build', 99999), run(join(f.root, 'missing'), 'build', 99999));
  for (const outcome of ['cancelled', 'skipped', 'rejected', 'queue-timeout', 'error']) records.push({ ...run(repo, 'build', 99999), outcome });
  records.push({ ...run(repo, 'build', 99999), ts: '2026-10-16T11:59:59Z' });
  records.push({ ...run(repo, 'build', 99999), ts: '2026-10-23T12:00:01Z' });
  records.push({ ...run(repo, 'build', 99999), startedAt: null });
  records.push({ ...run(repo, 'build', 99999), runS: -1 });
  await writeFile(join(f.state, 'ledger', '2026-10-23.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n{partial\nnull\n');
  assert.deepEqual(await gateEstimate(f.ctx, f.api, { worktree }), { gateSeconds: 390, gateSource: 'ledger', gateRuns: 12 });
});

test('failed and timed-out completed runs count, but unstarted and non-gate phases do not', async t => {
  const f = await fixture(t); git(f.root, 'init');
  const records = ['failed', 'timeout'].map(outcome => ({ ...run(f.root), outcome, exit: 1 }));
  records.push({ ...run(f.root), startedAt: null }, run(f.root, 'ci', 99999));
  await writeFile(join(f.state, 'ledger', '2026-10-23.jsonl'), records.map(record => JSON.stringify(record)).join('\n'));
  assert.deepEqual(await gateEstimate(f.ctx, f.api, { worktree: f.root }), { gateSeconds: 60, gateSource: 'ledger', gateRuns: 2 });
});

test('missing ledger is unknown; flag and manifest overrides need no history', async t => {
  const f = await fixture(t); git(f.root, 'init');
  const manifest = { worktree: f.root };
  assert.deepEqual(await gateEstimate(f.ctx, f.api, manifest), { gateSeconds: null, gateSource: null, gateRuns: 0 });
  assert.equal(phaseState({ HOME: '/fake' }), '/fake/.pi/agent/pi-phase/state');
  assert.equal(phaseState({ PI_PHASE_STATE: '/custom' }), '/custom');
  assert.deepEqual(await gateEstimate(f.ctx, f.api, { ...manifest, gateSeconds: 90 }), { gateSeconds: 90, gateSource: 'manifest', gateRuns: 0 });
  assert.deepEqual(await gateEstimate(f.ctx, f.api, { ...manifest, gateSeconds: 90 }, 120), { gateSeconds: 120, gateSource: 'flag', gateRuns: 0 });
  const warnings: string[] = [];
  const warned = { ...f.ctx, err: (line: string) => warnings.push(line) };
  assert.deepEqual(await gateEstimate(warned, f.api, { ...manifest, gateSeconds: '90' }), { gateSeconds: null, gateSource: null, gateRuns: 0 });
  assert.match(warnings.join('\n'), /gateSeconds/);
});

test('ledger files older than the window are not read, and one read serves every train in an invocation', async t => {
  const f = await fixture(t); git(f.root, 'init');
  await writeFile(join(f.state, 'ledger', '2026-10-14.jsonl'), JSON.stringify(run(f.root, 'build', 99999)));
  await writeFile(join(f.state, 'ledger', '2026-10-23.jsonl'), JSON.stringify(run(f.root, 'build', 60)));
  assert.deepEqual(await gateEstimate(f.ctx, f.api, { worktree: f.root }), { gateSeconds: 60, gateSource: 'ledger', gateRuns: 1 });
  await writeFile(join(f.state, 'ledger', '2026-10-23.jsonl'), JSON.stringify(run(f.root, 'build', 600)));
  assert.equal((await gateEstimate(f.ctx, f.api, { worktree: f.root })).gateSeconds, 60);
  let tick = 0;
  const ticking = { ...f.ctx, now: () => new Date(Date.parse(NOW) + 1000 * tick++).toISOString() };
  assert.equal((await gateEstimate(ticking, f.api, { worktree: f.root })).gateSeconds, 600);
  await writeFile(join(f.state, 'ledger', '2026-10-23.jsonl'), JSON.stringify(run(f.root, 'build', 6)));
  assert.equal((await gateEstimate(ticking, f.api, { worktree: f.root })).gateSeconds, 600);
});
