import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateEvidence, shipConfig } from './train-ship-check.mjs';
import { TrainError } from './train-gh.mjs';

const manifest = { repo: 'Test/Repo', head: 'abcdef0123456789' };
const components = [{ id: 'release', kind: 'build', label: 'tier1 release' }, { id: 'specs', kind: 'test', label: 'tier1 spec' }];
const config = { requireGate: true, gateComponents: { 'Test/Repo': components } };
const record = { outcome: 'passed', verified: true, head: manifest.head, dirty: 'clean', kind: 'build', label: 'TIER1 release' };

async function fixture(t: any, records: any[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'train-ship-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.pi/agent/pi-phase/state/ledger'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '2026-10-23.jsonl'), records.map(value => JSON.stringify(value)).join('\n'));
  const warnings: string[] = [];
  return { root, warnings, ctx: { env: { HOME: root, PI_TRAIN_DIR: join(root, 'trains') }, err: (line: string) => warnings.push(line) } };
}

test('legacy evidence is unchanged with one explicit missing-config warning', async t => {
  const f = await fixture(t, [record]);
  assert.match(await gateEvidence(f.ctx, manifest, {}), /build: TIER1 release/);
  assert.deepEqual(f.warnings, ['warning: no gateComponents for Test/Repo; any verified clean build/test accepted']);
});

test('every configured component is listed, matched case-insensitively by kind and regex', async t => {
  const f = await fixture(t, [record, { ...record, kind: 'test', label: '12 Tier1 specs' }]);
  const evidence = await gateEvidence(f.ctx, manifest, config);
  assert.match(evidence, /release: build: TIER1 release/);
  assert.match(evidence, /specs: test: 12 Tier1 specs/);
  assert.deepEqual(f.warnings, []);
});

test('missing components reject required gates or warn and return the same message', async t => {
  const f = await fixture(t, [record]);
  await assert.rejects(gateEvidence(f.ctx, manifest, config), { message: 'Tier 1 incomplete for abcdef0: missing specs' });
  assert.equal(await gateEvidence(f.ctx, manifest, { ...config, requireGate: false }), 'Tier 1 incomplete for abcdef0: missing specs');
  assert.deepEqual(f.warnings, ['warning: Tier 1 incomplete for abcdef0: missing specs']);
});

test('skipped, unverified, dirty, wrong-head, wrong-kind records cannot satisfy a component', async t => {
  const invalid = [{ outcome: 'skipped' }, { verified: false }, { dirty: 'hash' }, { head: 'other' }, { kind: 'integration' }, { kind: 'test' }];
  const f = await fixture(t, invalid.map(change => ({ ...record, ...change })));
  await assert.rejects(gateEvidence(f.ctx, manifest, config), /missing release, specs/);
});

test('component configuration rejects malformed regexes, kinds and schemas with TrainError', async t => {
  const f = await fixture(t);
  await mkdir(f.ctx.env.PI_TRAIN_DIR);
  for (const component of [{ ...components[0], label: '[' }, { ...components[0], kind: 'integration' }, { ...components[0], kind: 'ci' }, { ...components[0], id: '' }, { ...components[0], label: 42 }]) {
    const value = { gateComponents: { 'Test/Repo': [component] } };
    await writeFile(join(f.ctx.env.PI_TRAIN_DIR, 'config.json'), JSON.stringify(value));
    await assert.rejects(shipConfig(f.ctx), TrainError);
    await assert.rejects(gateEvidence(f.ctx, manifest, value), TrainError);
  }
  await assert.rejects(gateEvidence(f.ctx, manifest, { gateComponents: { 'Test/Repo': [] } }), TrainError);
  await assert.rejects(gateEvidence(f.ctx, manifest, { gateComponents: { 'Test/Repo': [{ ...components[0], kind: 'integration' }] } }), /Tier 1 is non-integration/);
});
