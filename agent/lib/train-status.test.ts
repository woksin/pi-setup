import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifestPath, saveManifest } from './train-manifest.mjs';
import { statusTrains } from './train-status.mjs';

test('status --all reports a train whose worktree is gone and keeps going', async t => {
  const root = await mkdtemp(join(tmpdir(), 'train-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, PI_TRAIN_DIR: join(root, 'store'), PI_PHASE_STATE: join(root, 'state') };
  const manifest = { v: 1, repo: 'o/r', train: 'gone', base: { ref: 'origin/main', sha: 'a'.repeat(40) },
    worktree: join(root, 'missing'), owner: 'me', state: 'open', head: 'a'.repeat(40), pr: null, shippedHead: null,
    label: null, items: [], notes: {}, packages: [], upstream: [], downstream: [], log: [] };
  await saveManifest(manifestPath(env, 'o/r', 'gone'), manifest);
  await saveManifest(manifestPath(env, 'o/r', 'closed'), { ...manifest, train: 'closed', state: 'released' });
  const out: string[] = [];
  const ctx = { env, out: (line: string) => out.push(line), err: () => {}, now: () => '2026-10-23T12:00:00Z' };
  const api = {
    git: async () => { throw new Error('git -C missing rev-parse HEAD: fatal: cannot change\nmore'); },
    gh: async () => { throw new Error('no gh'); },
  };
  assert.equal(await statusTrains(ctx, api, { all: true, json: true }), 1);
  const [train] = JSON.parse(out.at(-1)!).trains;
  assert.equal(train.train, 'gone');
  assert.equal(train.recommendation, 'unknown');
  assert.match(train.anomalies[0], /^train unavailable: worktree missing: .*missing; close the train/);
  out.length = 0;
  assert.equal(await statusTrains(ctx, api, { all: true }), 1);
  assert.match(out.join('\n'), /anomaly: train unavailable/);
});

test('status propagates operational errors for a train whose worktree exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'train-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, PI_TRAIN_DIR: join(root, 'store'), PI_PHASE_STATE: join(root, 'state') };
  await saveManifest(manifestPath(env, 'o/r', 'here'), { v: 1, repo: 'o/r', train: 'here', worktree: root, state: 'open',
    head: 'a'.repeat(40), items: [], notes: {}, log: [] });
  const ctx = { env, out: () => {}, err: () => {}, now: () => '2026-10-23T12:00:00Z' };
  const api = { git: async () => { throw new Error('gh auth required'); }, gh: async () => { throw new Error('gh auth required'); } };
  await assert.rejects(statusTrains(ctx, api, { all: true, json: true }), /gh auth required/);
});
