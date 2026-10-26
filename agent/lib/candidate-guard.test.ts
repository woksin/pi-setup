import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { prCreateDecision, publicationDecision, gateRunNotice } from './candidate-guard.ts';
import { manifestPath, saveManifest } from './train-manifest.mjs';
import extension from '../extensions/train-guard.ts';
import outputCap from '../extensions/output-cap.ts';

async function fixture(t: any, open = true) {
  const root = await mkdtemp(join(tmpdir(), 'candidate-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PI_TRAIN_DIR: join(root, 'store') };
  const manifest = { v: 1, repo: 'acme/widget', train: 'train/test', worktree: '/train', state: 'open', items: [] as any[] };
  if (open) await saveManifest(manifestPath(env, manifest.repo, manifest.train), manifest);
  const calls: any[] = [];
  const git = (cwd: string, args: string[]) => { calls.push([cwd, args]); return gitOutput(args); };
  return { root, env, manifest, calls, git, decide: (command = 'gh pr create', orchestrated = false) => prCreateDecision(command, '/repo', env, git, orchestrated) };
}

function gitOutput(args: string[]) {
  if (args[0] === 'remote') return 'git@github.com:acme/widget.git';
  if (args[0] === 'symbolic-ref') return args.includes('refs/remotes/origin/HEAD') ? 'origin/main' : 'fix/local';
  if (args[0] === 'rev-parse') return args.includes('--git-common-dir') ? '/repo/.git' : 'abc';
  if (args[0] === 'worktree') return 'worktree /repo\nbranch refs/heads/fix/local\n\nworktree /other\nbranch refs/heads/fix/other\n\nworktree /train\nbranch refs/heads/train/test\n\n';
  if (args[0] === 'rev-list') return '1';
  return '';
}

test('typed and CLI PR create share head/repo, candidate and trusted exception rules', async t => {
  const f = await fixture(t), request = { kind: 'pr-create', repo: 'acme/widget', head: 'fix/local', base: 'main', title: 'Title', body: 'private-value' };
  const context = { cwd: '/repo', env: f.env, git: f.git };
  assert.match((await publicationDecision(request, context)).block!, /PR refused/);
  assert.match((await f.decide('pi-publish pr-create --repo acme/widget --head fix/local --title Title --body Safe')).block!, /PR refused/);
  assert.deepEqual(await publicationDecision({ ...request, head: 'train/test' }, context), {});
  assert.deepEqual(await f.decide('/trusted/pi-publish pr-create --repo acme/widget --head train/test --title Title --body Safe'), {});
  assert.equal((await publicationDecision(request, { ...context, env: { ...f.env, PI_CANDIDATE_EXCEPTION: 'major' } })).log, 'exception major for fix/local');
  assert.equal((await f.decide('PI_CANDIDATE_EXCEPTION=urgent-fix pi-publish pr-create --repo acme/widget --head fix/local --title Title --body Safe')).log, 'exception urgent-fix for fix/local');
  assert.match((await publicationDecision(request, { ...context, orchestrated: true })).warn!, /PR refused/);
  assert.deepEqual(await publicationDecision({ kind: 'issue-comment', repo: 'acme/widget', number: 1, body: 'Safe' }, context), {});
  const invalid = await publicationDecision({ ...request, env: { PI_CANDIDATE_EXCEPTION: 'major' } }, context);
  assert.equal(invalid.block, 'Candidate guard: invalid publication request.');
  assert.ok(!JSON.stringify(invalid).includes('private-value'));
});

test('typed candidate fallback remains fail-open but value-free on native metadata errors', async t => {
  const f = await fixture(t);
  const decision = await publicationDecision({ kind: 'pr-create', repo: 'acme/widget', title: 'Title', body: 'Safe' }, { cwd: '/repo', env: f.env, git: () => { throw new Error('private-value'); } });
  assert.equal(decision.warn, 'Candidate guard: unparsed publication, allowed.');
});

test('exact open candidate evidence blocks only non-candidate PRs, exceptions logged and orchestration warns', async t => {
  const f = await fixture(t);
  assert.match((await f.decide()).block!, /PR refused: acme\/widget has open candidate train\/test/);
  assert.deepEqual(await f.decide('gh pr create --head train/test'), {});
  assert.deepEqual(await f.decide('gh pr create -H me:train/test -R acme/widget'), {});
  for (const value of ['major', 'urgent-fix']) {
    assert.equal((await f.decide(`PI_CANDIDATE_EXCEPTION=${value} gh pr create`)).log, `exception ${value} for fix/local`);
  }
  assert.ok((await f.decide('PI_CANDIDATE_EXCEPTION=typo gh pr create')).block);
  assert.ok((await f.decide('gh pr create', true)).warn);
  assert.equal((await f.decide('gh pr create', true)).block, undefined);
  assert.equal(f.calls.some(([, args]) => args[0] === 'worktree'), false);
});

test('cd, assignment prefixes, multiple commands, explicit other repo and fail-open errors', async t => {
  const f = await fixture(t);
  assert.ok((await f.decide('cd nested && X=1 command /bin/gh pr create')).block);
  assert.ok(f.calls.some(([cwd]) => cwd === '/repo/nested'));
  assert.ok((await f.decide('gh pr create -H train/test; gh pr create -H fix/other')).block);
  assert.match((await f.decide('gh pr create --head "$BRANCH"')).warn!, /unparsed, allowed/);
  assert.match((await prCreateDecision('gh pr create', '/repo', f.env, () => { throw new Error('broken'); })).warn!, /broken/);
  assert.match((await f.decide('gh pr create --head')).warn!, /missing/);
});

test('PR free text cannot bypass candidate refusal; dynamic decision inputs still fail open', async t => {
  const f = await fixture(t);
  const text = 'Question? <!-- template --> {details} <summary>\nMore details';
  for (const flag of ['--title', '--body', '--body-file', '--label']) {
    assert.ok((await f.decide(`gh pr create ${flag} '${text}'`)).block, flag);
    assert.ok((await f.decide(`gh pr create ${flag}='${text}'`)).block, `${flag}=`);
  }
  assert.ok((await f.decide('gh pr create --title "--head=train/test"')).block);
  assert.ok((await f.decide('gh pr create --body "--repo=$REPO"')).block);
  for (const flag of ['-R', '--repo', '-H', '--head']) {
    assert.match((await f.decide(`gh pr create ${flag} "$VALUE"`)).warn!, /unparsed, allowed/);
  }
  assert.match((await prCreateDecision('gh pr create', '/repo/$DIR', f.env, f.git)).warn!, /unparsed, allowed/);
});

test('concurrency only warns, solo stays silent and nonmatching commands make no git calls', async t => {
  const f = await fixture(t, false);
  assert.match((await f.decide()).warn!, /3 worktrees.*fix\/local.*fix\/other/);
  const solo = (cwd: string, args: string[]) => args[0] === 'worktree' ? 'worktree /repo\nbranch refs/heads/fix/local\n\n' : f.git(cwd, args);
  assert.deepEqual(await prCreateDecision('gh pr create', '/repo', f.env, solo), {});
  f.calls.length = 0;
  assert.deepEqual(await f.decide('echo hello'), {});
  assert.equal(await gateRunNotice('pi-phase run --kind test -- node --test affected.test.ts', '/repo', f.env, f.git), undefined);
  assert.deepEqual(f.calls, []);
});

test('gate notices never block, candidate worktree and named exception silent, delivered wording', async t => {
  const f = await fixture(t), command = 'pi-phase run --kind test -- tools/release-check.sh';
  assert.match((await gateRunNotice(command, '/repo', f.env, f.git))!, /targeted checks.*Tier 1.*Proceeding/);
  assert.equal(await gateRunNotice(command, '/train', f.env, f.git), undefined);
  assert.equal(await gateRunNotice(`PI_CANDIDATE_EXCEPTION=major ${command}`, '/repo', f.env, f.git), undefined);
  f.manifest.items.push({ branch: 'fix/local', sha: 'abc', kind: 'folded' });
  await saveManifest(manifestPath(f.env, 'acme/widget', 'train/test'), f.manifest);
  assert.match((await gateRunNotice(command, '/repo', f.env, f.git))!, /already delivered/);
  const noTrain = await fixture(t, false);
  assert.match((await gateRunNotice(command, '/repo', noTrain.env, noTrain.git))!, /worktrees.*Proceeding/);
  assert.match((await gateRunNotice(command, '/repo', f.env, () => { throw new Error('broken'); }))!, /unparsed, allowed/);
});

function capture(factory: any) {
  const handlers = new Map<string, any[]>();
  factory({ on: (name: string, handler: any) => handlers.set(name, [...handlers.get(name) ?? [], handler]) });
  return { path: 'test', handlers };
}

function environment(t: any, values: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

test('extension: block, exception, orchestrated result warning chains after real output-cap, switch and solo', async t => {
  const f = await fixture(t), repo = join(f.root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-b', 'fix/local'); git('remote', 'add', 'origin', 'git@github.com:acme/widget.git');
  environment(t, { ...f.env, PI_GUARDS_FILE: join(f.root, 'guards.json'), PI_GUARDS_OFF: '', PI_ORCH_ID: '',
    PI_ORCH_MODE_FILE: join(f.root, 'no-mode'), PI_GUARD_DECISIONS_LOG: join(f.root, 'decisions.jsonl'),
    PI_EFFICIENCY_FILE: join(f.root, 'efficiency.json') });
  await writeFile(process.env.PI_EFFICIENCY_FILE!, JSON.stringify({ outputCap: { enabled: true, maxChars: 4000, scope: 'all' } }));
  const train = capture(extension), cap = capture(outputCap), handler = train.handlers.get('tool_call')![0];
  const ctx = { cwd: repo, hasUI: false, sessionManager: { getSessionId: () => 'candidate-test' } };
  const event = { toolName: 'bash', toolCallId: 'one', input: { command: 'gh pr create' } };
  assert.equal((await handler(event, ctx)).block, true);
  const typed = { toolName: 'publish', toolCallId: 'typed', input: { kind: 'pr-create', repo: 'acme/widget', title: 'Title', body: 'Safe' } };
  assert.equal((await handler(typed, ctx)).block, true);
  assert.equal((await handler({ ...event, input: { command: 'pi-publish pr-create --repo acme/widget --title Title --body Safe' } }, ctx)).block, true);
  assert.equal(await handler({ ...typed, input: { kind: 'check', files: ['a'] } }, ctx), undefined);
  assert.equal(await handler({ ...event, input: { command: 'PI_CANDIDATE_EXCEPTION=urgent-fix gh pr create' } }, ctx), undefined);
  assert.match(await readFile(process.env.PI_GUARD_DECISIONS_LOG!, 'utf8'), /exception urgent-fix/);
  process.env.PI_ORCH_ID = 'lane';
  const before = await readFile(process.env.PI_GUARD_DECISIONS_LOG!, 'utf8');
  assert.equal(await handler({ ...event, input: { command: 'pi-phase status' } }, ctx), undefined);
  assert.equal(await readFile(process.env.PI_GUARD_DECISIONS_LOG!, 'utf8'), before);
  assert.equal(await handler(event, ctx), undefined);
  // Use pi's actual runner, with both extensions loaded, rather than emulating chaining.
  let entry: string;
  try { entry = new URL(import.meta.resolve('@earendil-works/pi-coding-agent')).pathname; }
  catch { entry = join(process.env.HOME!, '.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js'); }
  const { ExtensionRunner } = await import(pathToFileURL(join(dirname(entry), 'core/extensions/runner.js')).href);
  const runner = new ExtensionRunner([cap, train], {}, repo, ctx.sessionManager, {});
  runner.createContext = () => ctx;
  const resultEvent = { ...event, content: [{ type: 'text', text: 'line\n'.repeat(5000) }], isError: false };
  const result = await runner.emitToolResult(resultEvent);
  assert.match(result.content[0].text, /full output:/);
  assert.match(result.content.at(-1).text, /\[candidate\].*PR refused/);
  assert.equal(await train.handlers.get('tool_result')![0](resultEvent), undefined);
  await writeFile(process.env.PI_GUARDS_FILE!, JSON.stringify({ off: { trains: true } }));
  assert.equal(await handler(event, ctx), undefined);
  assert.equal(await handler(typed, ctx), undefined);
  await writeFile(process.env.PI_GUARDS_FILE!, JSON.stringify({ off: { trains: false } }));
  process.env.PI_ORCH_ID = '';
  assert.equal(await handler({ ...event, input: { command: 'echo hello' } }, ctx), undefined);
  f.manifest.state = 'released'; await saveManifest(manifestPath(f.env, 'acme/widget', 'train/test'), f.manifest);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('commit', '--allow-empty', '-m', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(await handler(event, ctx), undefined);
  assert.equal(await train.handlers.get('tool_result')![0](resultEvent), undefined);
});
