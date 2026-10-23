import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanRepository } from './train-concurrency.mjs';
import { main } from './pi-train.mjs';

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'train-concurrency-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), origin = join(root, 'origin.git');
  const git = async (cwd: string, args: string[]) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    return { status: r.status ?? 2, stdout: r.stdout, stderr: r.stderr };
  };
  const run = async (cwd: string, ...args: string[]) => {
    const r = await git(cwd, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  await mkdir(repo); await mkdir(origin);
  await run(origin, 'init', '--bare'); await run(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'base'), 'base'); await run(repo, 'add', '.'); await run(repo, 'commit', '-m', 'base');
  await run(repo, 'remote', 'add', 'origin', origin); await run(repo, 'push', '-u', 'origin', 'main');
  const worktree = async (branch: string, pending = true) => {
    const path = join(root, branch);
    await run(repo, 'worktree', 'add', '-b', branch, path, 'main');
    if (pending) {
      await writeFile(join(path, branch), branch); await run(path, 'add', '.'); await run(path, 'commit', '-m', branch);
    }
    return path;
  };
  const scan = (manifests: any[] = []) => scanRepository({ git, cwd: repo, manifests });
  return { root, repo, git, run, worktree, scan };
}

test('real git: solo, concurrent, merged idle, dirty main and detached idle; CLI output', async t => {
  const f = await fixture(t), first = await f.worktree('first');
  assert.equal((await f.scan()).verdict, 'solo');
  const output: string[] = [];
  const ctx = { cwd: f.repo, env: { PI_TRAIN_DIR: join(f.root, 'store') }, now: () => '',
    out: (s: string) => output.push(s), err: assert.fail,
    run: (_: string, args: string[]) => f.git(args[1], args.slice(2)) };
  assert.equal(await main(['concurrency'], ctx), 0); assert.deepEqual(output, ['solo: no candidate needed']);
  await f.worktree('second'); await f.worktree('merged', false);
  const detached = join(f.root, 'detached'); await f.run(f.repo, 'worktree', 'add', '--detach', detached);
  const scan = await f.scan();
  assert.equal(scan.verdict, 'concurrent');
  assert.deepEqual(scan.worktrees.filter(w => w.role === 'pending').map(w => w.branch), ['first', 'second']);
  assert.equal(scan.worktrees.find(w => w.branch === 'merged')?.role, 'idle');
  assert.equal(scan.worktrees.find(w => w.path === detached)?.role, 'idle');
  output.length = 0; assert.equal(await main(['concurrency'], ctx), 0);
  assert.match(output.join('\n'), /concurrent[\s\S]*first[\s\S]*second/);
  await f.run(f.repo, 'merge', '--ff-only', 'first'); await f.run(f.repo, 'push', 'origin', 'main');
  assert.equal((await f.scan()).worktrees.find(w => w.path === first)?.role, 'idle');
  await writeFile(join(f.repo, 'dirty'), 'dirty');
  assert.equal((await f.scan()).worktrees.find(w => w.path === f.repo)?.dirty, true);
});

test('train excluded, delivered and forward redelivery classified', async t => {
  const f = await fixture(t), path = await f.worktree('first'), train = await f.worktree('candidate');
  const sha = await f.run(path, 'rev-parse', 'HEAD');
  const manifests = [{ manifest: { repo: 'x/y', state: 'closed' } }, { manifest: {
    repo: (await f.scan()).repo, train: 'candidate', worktree: train, state: 'open', items: [{ branch: 'first', sha, kind: 'folded' }] } }];
  let scan = await f.scan(manifests);
  assert.equal(scan.verdict, 'candidate');
  assert.equal(scan.worktrees.find(w => w.path === train)?.role, 'train');
  assert.equal(scan.worktrees.find(w => w.path === path)?.role, 'delivered');
  await writeFile(join(path, 'more'), 'more'); await f.run(path, 'add', '.'); await f.run(path, 'commit', '-m', 'more');
  scan = await f.scan(manifests);
  assert.equal(scan.worktrees.find(w => w.path === path)?.role, 'redeliver');
  assert.ok(scan.next.includes('pi-train fold first'));
});

test('concurrency outside a git repository exits 2', async t => {
  const f = await fixture(t), errors: string[] = [];
  const status = await main(['concurrency'], { cwd: f.root, env: {}, now: () => '', out: assert.fail,
    err: (text: string) => errors.push(text), run: (_: string, args: string[]) => f.git(args[1], args.slice(2)) });
  assert.equal(status, 2); assert.match(errors.join('\n'), /git/);
});

test('missing/prunable worktrees skipped and scanning capped at 30', async () => {
  const calls: string[] = [];
  const git = async (cwd: string, args: string[]) => {
    calls.push(cwd);
    if (cwd === '/missing') return { status: 1, stdout: '' };
    const routes = { 'rev-parse': '/common', remote: 'git@github.com:acme/repo.git', 'symbolic-ref': 'origin/main',
      worktree: ['worktree /missing\nbranch refs/heads/missing\nprunable gone', ...Array.from({ length: 40 }, (_, i) => `worktree /w${i}\nbranch refs/heads/b${i}`)].join('\n\n'),
      'rev-list': '0', status: '' };
    return { status: 0, stdout: routes[args[0]] ?? '' };
  };
  const result = await scanRepository({ git, cwd: '/main', manifests: [] });
  assert.ok(result.worktrees.length <= 30); assert.ok(!calls.includes('/missing')); assert.ok(!calls.includes('/w30'));
});
