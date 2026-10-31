import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateEvidence, shipConfig } from './train-ship-check.mjs';
import { TrainError } from './train-gh.mjs';

const manifest = { repo: 'Test/Repo', head: 'abcdef0123456789' };
const components = [{ id: 'release', kind: 'build', label: 'tier1 release' }, { id: 'specs', kind: 'test', label: 'tier1 spec' }];
const config = { gateComponents: { 'Test/Repo': components } };
const record = { outcome: 'passed', verified: true, head: manifest.head, dirty: 'clean', kind: 'build', label: 'TIER1 release' };

async function fixture(t: any, records: any[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'train-ship-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.pi/agent/pi-phase/state/ledger'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '2026-10-23.jsonl'), records.map(value => JSON.stringify(value)).join('\n'));
  const warnings: string[] = [];
  return { root, warnings, ctx: { env: { HOME: root, PI_TRAIN_DIR: join(root, 'trains') }, err: (line: string) => warnings.push(line) } };
}

test('a repository without a component set fails closed, naming the override', async t => {
  const f = await fixture(t, [record]);
  await assert.rejects(gateEvidence(f.ctx, manifest, {}), { message: /no gateComponents configured for Test\/Repo.*--allow-unconfigured-gate/ });
  await assert.rejects(gateEvidence(f.ctx, manifest, {}, { allowUnconfiguredGate: false }), TrainError);
  assert.deepEqual(f.warnings, []);
});

test('--allow-unconfigured-gate accepts legacy evidence with a logged warning', async t => {
  const f = await fixture(t, [record]);
  assert.match(await gateEvidence(f.ctx, manifest, {}, { allowUnconfiguredGate: true }), /build: TIER1 release/);
  assert.deepEqual(f.warnings, ['warning: --allow-unconfigured-gate: no gateComponents for Test/Repo; accepting any verified clean build/test']);
  const none = await fixture(t, []);
  await assert.rejects(gateEvidence(none.ctx, manifest, {}, { allowUnconfiguredGate: true }), /no verified Tier 1/);
});

test('shipConfig supplies the built-in Chronicle component set and lets the user config override it', async t => {
  const f = await fixture(t);
  const chronicle = { repo: 'Cratis/Chronicle', head: manifest.head };
  const config = await shipConfig(f.ctx);
  assert.deepEqual(config.gateComponents['Cratis/Chronicle'].map((c: any) => c.id), ['release', 'specs']);
  const ledger = [{ ...record, label: '12 tier1 release build' }, { ...record, kind: 'test', label: '12 tier1 specs' }];
  const g = await fixture(t, ledger);
  assert.match(await gateEvidence(g.ctx, chronicle, config), /release: build: 12 tier1 release build/);
  const wrong = await fixture(t, [{ ...record, label: 'tier1 specs build' }]);
  await assert.rejects(gateEvidence(wrong.ctx, chronicle, config), /missing release, specs/);
  await mkdir(f.ctx.env.PI_TRAIN_DIR);
  await writeFile(join(f.ctx.env.PI_TRAIN_DIR, 'config.json'), JSON.stringify({ gateComponents: { 'Cratis/Chronicle': [{ id: 'only', kind: 'build', label: 'x' }] } }));
  assert.deepEqual((await shipConfig(f.ctx)).gateComponents['Cratis/Chronicle'].map((c: any) => c.id), ['only']);
});

test('every configured component is listed, matched case-insensitively by kind and regex', async t => {
  const f = await fixture(t, [record, { ...record, kind: 'test', label: '12 Tier1 specs' }]);
  const evidence = await gateEvidence(f.ctx, manifest, config);
  assert.match(evidence, /release: build: TIER1 release/);
  assert.match(evidence, /specs: test: 12 Tier1 specs/);
  assert.deepEqual(f.warnings, []);
});

test('missing components always throw, even with the legacy requireGate: false key', async t => {
  const f = await fixture(t, [record]);
  await assert.rejects(gateEvidence(f.ctx, manifest, config), { message: 'Tier 1 incomplete for abcdef0: missing specs' });
  await assert.rejects(gateEvidence(f.ctx, manifest, { ...config, requireGate: false }), { message: 'Tier 1 incomplete for abcdef0: missing specs' });
  assert.deepEqual(f.warnings, []);
});

test('configured components with only iterate records throw', async t => {
  const f = await fixture(t, [{ ...record, profile: 'iterate' }, { ...record, kind: 'test', label: 'tier1 spec', profile: 'iterate' }]);
  await assert.rejects(gateEvidence(f.ctx, manifest, config), /missing release, specs/);
});

test('skipped, unverified, dirty, wrong-head, wrong-kind records cannot satisfy a component', async t => {
  const invalid = [{ outcome: 'skipped' }, { verified: false }, { dirty: 'hash' }, { head: 'other' }, { kind: 'integration' }, { kind: 'test' }];
  const f = await fixture(t, invalid.map(change => ({ ...record, ...change })));
  await assert.rejects(gateEvidence(f.ctx, manifest, config), /missing release, specs/);
});

test('iterate-profile records are never ship evidence; full and legacy (no profile) records are', async t => {
  const single = { 'Test/Repo': [components[0]] };
  const iterate = await fixture(t, [{ ...record, profile: 'iterate' }]);
  await assert.rejects(gateEvidence(iterate.ctx, manifest, { gateComponents: single }), /missing release/);
  const anyGate = await fixture(t, [{ ...record, profile: 'iterate' }]);
  await assert.rejects(gateEvidence(anyGate.ctx, manifest, {}, { allowUnconfiguredGate: true }), /no verified Tier 1/);
  for (const profile of ['full', undefined]) {
    const f = await fixture(t, [{ ...record, profile }]);
    assert.match(await gateEvidence(f.ctx, manifest, { gateComponents: single }), /release: build: TIER1 release/);
  }
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
