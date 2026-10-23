import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parsePushes, trainPushDecision } from './train-guard.ts';
import { protectedItems, pushBlock } from './train-push.mjs';
import { main } from './pi-train.mjs';
import { manifestPath, repoKey, saveManifest } from './train-manifest.mjs';
import extension from '../extensions/train-guard.ts';
import { setGuards } from './guards.ts';

function fakeGit(cwd: string, args: string[]): string {
  if (args[0] === 'remote') return 'https://github.com/acme/widget.git';
  if (args[0] === 'symbolic-ref') return 'fix/current';
  if (args[0] === 'for-each-ref') return 'fix/current\nfix/folded\nmain\n';
  if (args.at(-1)?.endsWith('.merge')) return 'refs/heads/fix/upstream';
  if (args.at(-1)?.endsWith('.remote')) return 'origin';
  return '';
}

for (const [command, branches] of [
  ['git push origin fix/folded', ['fix/folded']],
  ['git push origin fix/source:fix/folded', ['fix/folded']],
  ['git push origin HEAD:refs/heads/fix/folded', ['fix/folded']],
  ['git push origin HEAD', ['fix/current']],
  ['git -C repo push origin fix/folded', ['fix/folded']],
  ['git push --all origin', ['fix/current', 'fix/folded', 'main']],
  ['git push --mirror origin', ['fix/current', 'fix/folded', 'main']],
  ['git push', ['fix/upstream']],
  ['git push origin', ['fix/upstream']],
  ['git push -f -u origin fix/folded', ['fix/folded']],
  ['git push --force origin fix/folded', ['fix/folded']],
  ['git push --force-with-lease origin +HEAD:fix/folded', ['fix/folded']],
  ['git push --force-with-lease=fix/folded:abc origin fix/folded', ['fix/folded']],
  ['git push origin :fix/folded', []],
  ['git push --delete origin fix/folded', []],
  ['git push -d origin fix/folded', []],
  ['git push origin +:fix/folded HEAD:fix/other', ['fix/other']],
] as [string, string[]][]) {
  test(`guard parses ${command}`, () => {
    const result = parsePushes(command, '/work', fakeGit);
    assert.deepEqual(result.notices, []); assert.deepEqual(result.pushes[0].branches, branches);
  });
}

test('guard resolves repeated -C and cd from the effective directory and checks multiple pushes', () => {
  const dirs: string[] = [];
  const result = parsePushes('cd /repo && git -C sub -C ../wt push origin fix/a; git push origin fix/b', '/work',
    (cwd, args) => { dirs.push(cwd); return fakeGit(cwd, args); });
  assert.equal(result.pushes.length, 2); assert.ok(dirs.includes('/repo/wt')); assert.ok(dirs.includes('/repo'));
});

for (const command of ['git push origin "$BRANCH"', 'git -c push.default=matching push', 'git push --unknown origin x',
  'git push origin refs/heads/*:refs/heads/*']) {
  test(`unparseable push allows with a notice: ${command}`, () => {
    const result = parsePushes(command, '/work', fakeGit);
    assert.equal(result.pushes.length, 0); assert.match(result.notices[0], /unparsed push allowed/);
  });
}

test('guard only matches folded/planned items in active manifests for the same origin', () => {
  const manifest = { repo: 'acme/widget', train: 'train/test', pr: 42, state: 'shipped',
    items: [{ branch: 'fix/folded', kind: 'folded' }, { branch: 'fix/planned', kind: 'planned' }, { branch: 'fix/old', kind: 'in-main' }] };
  const items = protectedItems([{ manifest }], 'acme/widget');
  assert.match(pushBlock(items, ['fix/planned'])!, /train\/test \(#42\)/);
  assert.equal(pushBlock(items, ['fix/planned'], 'fix/planned'), undefined);
  assert.equal(pushBlock(items, ['other']), undefined);
  for (const state of ['released', 'abandoned']) assert.deepEqual(protectedItems([{ manifest: { ...manifest, state } }], 'acme/widget'), []);
  assert.deepEqual(protectedItems([{ manifest }], 'other/repo'), []);
});

const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
type GitCommand = { cwd: string; args: string[]; env?: NodeJS.ProcessEnv };
function native(command: GitCommand) {
  const { cwd, args, env = gitEnv() } = command;
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, env });
  return { status: result.status ?? 2, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' };
}
function checkedGit(command: GitCommand) {
  const result = native(command); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'train-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), origin = join(root, 'origin.git'); await mkdir(repo); await mkdir(origin);
  const git = checkedGit;
  git({ cwd: origin, args: ['init', '--bare'] }); git({ cwd: repo, args: ['init', '-b', 'main'] });
  await writeFile(join(repo, 'file'), 'base'); git({ cwd: repo, args: ['add', '.'] }); git({ cwd: repo, args: ['commit', '-m', 'base'] });
  git({ cwd: repo, args: ['remote', 'add', 'origin', origin] }); git({ cwd: repo, args: ['push', '-u', 'origin', 'main'] });
  git({ cwd: repo, args: ['checkout', '-b', 'fix/folded'] });
  const env = { ...gitEnv(), HOME: root, PI_TRAIN_DIR: join(root, 'trains') };
  const key = repoKey(origin);
  const manifest = { v: 1, repo: key, train: 'train/test', pr: 42, state: 'open', items: [{ branch: 'fix/folded', kind: 'folded' }] };
  const path = manifestPath(env, key, manifest.train); await saveManifest(path, manifest);
  const errors: string[] = [], output: string[] = [];
  const ctx = { cwd: repo, env, now: () => new Date().toISOString(), out: (s: string) => output.push(s), err: (s: string) => errors.push(s),
    run: (program: string, args: string[]) => { assert.equal(program, 'git'); return native({ cwd: args[1], args: args.slice(2), env }); } };
  return { root, repo, origin, env, key, manifest, path, git, ctx, errors, output, invoke: (...args: string[]) => main(args, ctx) };
}

test('decision is cheap for non-push and blocks a folded branch without exempting coordinator lanes', async t => {
  const f = await fixture(t);
  assert.deepEqual(await trainPushDecision('echo hello', f.repo, f.env, () => { throw new Error('must not resolve git'); }), { notices: [] });
  const decision = await trainPushDecision('git push origin fix/folded', f.repo, { ...f.env, PI_LANE: 'PISETUP' });
  assert.match(decision.reason!, /fix\/folded.*train\/test/);
  const good = await trainPushDecision('git push origin main', f.repo, f.env); assert.equal(good.reason, undefined);
  const other = join(f.root, 'other.git'); await mkdir(other); f.git({ cwd: other, args: ['init', '--bare'] }); f.git({ cwd: f.repo, args: ['remote', 'add', 'other', other] });
  assert.equal((await trainPushDecision('git push other fix/folded', f.repo, f.env)).reason, undefined);
});

test('extension blocks folded pushes and honours the trains guard switch', async t => {
  const f = await fixture(t), old = { PI_TRAIN_DIR: process.env.PI_TRAIN_DIR, PI_GUARDS_OFF: process.env.PI_GUARDS_OFF, PI_GUARDS_FILE: process.env.PI_GUARDS_FILE };
  Object.assign(process.env, { PI_TRAIN_DIR: f.env.PI_TRAIN_DIR, PI_GUARDS_FILE: join(f.root, 'guards.json'), PI_GUARDS_OFF: '' });
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let handler: any; extension({ on: (name: string, fn: any) => { assert.equal(name, 'tool_call'); handler = fn; } } as any);
  const event = { toolName: 'bash', input: { command: 'git push origin fix/folded' } };
  const ctx = { cwd: f.repo, hasUI: true, ui: { notify: () => {} } };
  assert.equal((await handler(event, ctx)).block, true);
  setGuards(['trains'], true); assert.equal(await handler(event, ctx), undefined);
  setGuards(['trains'], false);
});

test('hook install chains existing hook, rejects a real push, escape hatch permits, uninstall restores', async t => {
  const f = await fixture(t), hook = join(f.repo, '.git/hooks/pre-push'), receipt = join(f.root, 'chained-input');
  const original = `#!/bin/sh\ncat > '${receipt}'\n`;
  await writeFile(hook, original, { mode: 0o755 });
  assert.equal(await f.invoke('hook', 'install'), 0, f.errors.join('\n'));
  const installed = await readFile(hook, 'utf8');
  assert.equal(await f.invoke('hook', 'install'), 0); assert.equal(await readFile(hook, 'utf8'), installed);
  const push = native({ cwd: f.repo, args: ['push', 'origin', 'fix/folded'], env: f.env });
  assert.notEqual(push.status, 0); assert.match(push.stderr, /Push refused.*train\/test/);
  assert.match(await readFile(receipt, 'utf8'), /refs\/heads\/fix\/folded/);
  assert.equal(f.git({ cwd: f.repo, args: ['ls-remote', 'origin', 'refs/heads/fix/folded'] }), '');
  const allowed = native({ cwd: f.repo, args: ['push', 'origin', 'fix/folded'], env: { ...f.env, PI_TRAIN_ALLOW_PUSH: 'fix/folded' } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(await f.invoke('hook', 'uninstall'), 0); assert.equal(await readFile(hook, 'utf8'), original);
});

test('extension allows unparseable pushes without accessing a missing headless UI', async t => {
  const f = await fixture(t);
  let handler: any; extension({ on: (_name: string, fn: any) => { handler = fn; } } as any);
  const result = await handler({ toolName: 'bash', input: { command: 'git push origin "$BRANCH"' } }, { cwd: f.repo, hasUI: false });
  assert.equal(result, undefined);
});

for (const failure of ['corrupt manifest', 'unsupported manifest', 'missing origin', 'missing node', 'missing runner']) {
  test(`hook fails open with a notice on ${failure}`, async t => {
    const f = await fixture(t), hook = join(f.repo, '.git/hooks/pre-push');
    assert.equal(await f.invoke('hook', 'install'), 0, f.errors.join('\n'));
    let env = f.env;
    if (failure === 'corrupt manifest') await writeFile(f.path, '{broken');
    if (failure === 'unsupported manifest') await saveManifest(f.path, { ...f.manifest, v: 999 });
    if (failure === 'missing origin') f.git({ cwd: f.repo, args: ['remote', 'remove', 'origin'] });
    if (failure === 'missing runner') {
      const installed = await readFile(hook, 'utf8');
      await writeFile(hook, installed.replaceAll('train-hook-runner.mjs', 'missing-runner.mjs'));
    }
    if (failure === 'missing node') {
      const tools = join(f.root, 'tools'); await mkdir(tools);
      for (const command of ['git', 'mktemp', 'cat', 'rm']) {
        const resolved = spawnSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
        await symlink(resolved, join(tools, command));
      }
      await writeFile(hook, (await readFile(hook, 'utf8')).replaceAll(process.execPath, join(f.root, 'missing-node')));
      env = { ...f.env, PATH: tools };
    }
    const result = native({ cwd: f.repo, args: ['push', f.origin, 'fix/folded'], env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /pi-train guard unavailable; push allowed/);
    assert.match(f.git({ cwd: f.repo, args: ['ls-remote', f.origin, 'refs/heads/fix/folded'] }), /refs\/heads\/fix\/folded/);
  });
}

test('hook resolves the runtime node when its recorded path is stale and still refuses folded pushes', async t => {
  const f = await fixture(t), hook = join(f.repo, '.git/hooks/pre-push');
  assert.equal(await f.invoke('hook', 'install'), 0);
  await writeFile(hook, (await readFile(hook, 'utf8')).replaceAll(process.execPath, join(f.root, 'missing-node')));
  const result = native({ cwd: f.repo, args: ['push', 'origin', 'fix/folded'], env: f.env });
  assert.equal(result.status, 1); assert.match(result.stderr, /Push refused/);
});

for (const args of [['--delete', 'origin', 'fix/folded'], ['origin', ':fix/folded']]) {
  test(`folded branch deletion is allowed by both layers: ${args.join(' ')}`, async t => {
    const f = await fixture(t);
    f.git({ cwd: f.repo, args: ['push', 'origin', 'fix/folded'] });
    assert.equal(await f.invoke('hook', 'install'), 0);
    const decision = await trainPushDecision(`git push ${args.join(' ')}`, f.repo, f.env);
    assert.equal(decision.reason, undefined);
    const result = native({ cwd: f.repo, args: ['push', ...args], env: f.env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git({ cwd: f.repo, args: ['ls-remote', 'origin', 'refs/heads/fix/folded'] }), '');
  });
}

test('non-executable original hook is preserved but not chained, with a warning', async t => {
  const f = await fixture(t), hook = join(f.repo, '.git/hooks/pre-push'), receipt = join(f.root, 'unexpected-hook');
  const original = `#!/bin/sh\ntouch '${receipt}'\nexit 1\n`;
  await writeFile(hook, original, { mode: 0o644 });
  assert.equal(await f.invoke('hook', 'install'), 0);
  assert.match(f.errors.join('\n'), /not executable.*not.*chain/i);
  const result = native({ cwd: f.repo, args: ['push', 'origin', 'HEAD:cleanup'], env: f.env });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
  assert.equal(await f.invoke('hook', 'uninstall'), 0);
  assert.equal(await readFile(hook, 'utf8'), original); assert.equal((await stat(hook)).mode & 0o777, 0o644);
});

for (const dir of ['custom-hooks', '.husky', '.husky/_']) {
  test(`hook install refuses a tracked or husky-managed hooks directory: ${dir}`, async t => {
    const f = await fixture(t), directory = join(f.repo, dir), hook = join(directory, 'pre-push');
    await mkdir(directory, { recursive: true });
    const tracked = join(f.repo, dir === '.husky/_' ? '.husky/pre-commit' : `${dir}/pre-commit`);
    await writeFile(tracked, '#!/bin/sh\nexit 0\n'); f.git({ cwd: f.repo, args: ['add', tracked] });
    await writeFile(hook, '#!/bin/sh\n# original\n');
    f.git({ cwd: f.repo, args: ['config', 'core.hooksPath', dir] });
    assert.equal(await f.invoke('hook', 'install'), 1);
    assert.match(f.errors.join('\n'), /tracked|husky/i);
    assert.equal(await readFile(hook, 'utf8'), '#!/bin/sh\n# original\n');
    await assert.rejects(readFile(`${hook}.pi-train-chained`), { code: 'ENOENT' });
  });
}

test('hook respects configured path and common-dir from another worktree; does not uninstall a foreign hook', async t => {
  const f = await fixture(t), wt = join(f.root, 'worktree');
  f.git({ cwd: f.repo, args: ['worktree', 'add', '-b', 'train/test', wt] });
  f.ctx.cwd = wt;
  assert.equal(await f.invoke('hook', 'install'), 0); assert.match(await readFile(join(f.repo, '.git/hooks/pre-push'), 'utf8'), /pi-train pre-push/);
  assert.equal(await f.invoke('hook', 'uninstall'), 0);
  f.git({ cwd: f.repo, args: ['config', 'core.hooksPath', join(f.root, 'hooks')] });
  assert.equal(await f.invoke('hook', 'install', '--dry-run'), 0);
  await assert.rejects(readFile(join(f.root, 'hooks/pre-push')), { code: 'ENOENT' });
  assert.equal(await f.invoke('hook', 'install'), 0); assert.equal(await f.invoke('hook', 'uninstall'), 0);
  await writeFile(join(f.root, 'hooks/pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await f.invoke('hook', 'uninstall'), 1); assert.match(f.errors.at(-1)!, /not a pi-train hook/);
});
