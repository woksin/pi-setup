import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { main, realContext } from './pi-train.mjs';
import { cancellable, isBot, RUN_FIELDS } from './train-gh.mjs';
import { loadManifest, manifestPath, repoKey, saveManifest, withManifestLock } from './train-manifest.mjs';
import { copyBullets, extractBullets, renderNotes } from './train-notes.mjs';

const BASE = 'a'.repeat(40), SHA = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const REPO = 'acme/widget', TRAIN = 'train/test';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const bad = (stderr = '', status = 1) => ({ status, stdout: '', stderr });
const prFixture = () => ({ number: 7, state: 'OPEN', headRefName: 'fix/widget', headRefOid: SHA,
  isCrossRepository: false, author: { login: 'me' }, baseRefName: 'main', reviewRequests: [], latestReviews: [],
  body: '## Summary\nNot a release bullet\n## Fixed\n- Fix widgets (#7)\n', comments: [], labels: [] });
const runFixture = (databaseId = 10, extra = {}) => ({ databaseId, status: 'in_progress', headBranch: 'fix/widget',
  headSha: SHA, workflowName: 'CI', name: 'Tests', event: 'pull_request', ...extra });

type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(t: any, init = true) {
  const root = await mkdtemp(join(tmpdir(), 'pi-train-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [], errors: string[] = [], calls: any[] = [];
  const state = { pr: prFixture() as any, runs: [runFixture()] as any[], branchExists: init, head: BASE,
    fetched: SHA, ancestor: false, conflict: false, dirty: false, onBranch: TRAIN, defaultBranch: 'main',
    openPRs: [] as any[], failBefore: '', failAfter: '', closed: 0, comments: 0, merges: 0, aborts: 0,
    branchPR: true, unknownAncestor: false, checkedOut: true, trainPR: null as any, creates: 0, edits: 0, pushes: 0, remoteHead: '' };
  const env = { HOME: root, USER: 'me', PI_TRAIN_DIR: join(root, 'store') };
  const path = manifestPath(env, REPO, TRAIN);
  const manifest = { v: 1, repo: REPO, train: TRAIN, base: { ref: 'origin/main', sha: BASE },
    worktree: join(root, 'worktree'), owner: 'me', state: 'open', head: BASE, pr: null, shippedHead: null,
    label: null, items: [], notes: {}, packages: [], upstream: [], downstream: [], log: [] };
  if (init) await saveManifest(path, manifest);
  const ghRoutes = {
    'api user': () => ok('me\n'),
    'repo view': () => ok(JSON.stringify({ defaultBranchRef: { name: state.defaultBranch } })),
    'pr view': () => ok(JSON.stringify(state.pr)),
    'pr list': (args: string[]) => {
      const matching = state.branchPR ? [{ number: 7 }] : [];
      const head = args[args.indexOf('--head') + 1];
      return ok(JSON.stringify(args.includes('--head') ? (head === TRAIN ? (state.trainPR ? [state.trainPR] : []) : matching) : state.openPRs));
    },
    'pr close': (args: string[]) => {
      state.closed++; state.pr.state = 'CLOSED';
      state.pr.comments.push({ body: args[args.indexOf('--comment') + 1] }); return ok();
    },
    'pr comment': async (args: string[]) => {
      state.comments++;
      const body = args.includes('--body-file') ? await readFile(args[args.indexOf('--body-file') + 1], 'utf8') : args[args.indexOf('--body') + 1];
      (args[2] === '42' ? state.trainPR : state.pr).comments.push({ body }); return ok();
    },
    'pr create': async (args: string[]) => {
      state.creates++;
      state.trainPR = { number: 42, body: await readFile(args[args.indexOf('--body-file') + 1], 'utf8'),
        labels: [{ name: args[args.indexOf('--label') + 1] }], comments: [] };
      return ok('https://github.com/acme/widget/pull/42\n');
    },
    'pr edit': async (args: string[]) => {
      state.edits++;
      if (args.includes('--body-file')) state.trainPR.body = await readFile(args[args.indexOf('--body-file') + 1], 'utf8');
      if (args.includes('--add-label')) state.trainPR.labels.push({ name: args[args.indexOf('--add-label') + 1] });
      const remove = args[args.indexOf('--remove-label') + 1];
      if (args.includes('--remove-label')) state.trainPR.labels = state.trainPR.labels.filter((label: any) => label.name !== remove);
      return ok();
    },
    'run list': () => ok(JSON.stringify(state.runs)),
    'run cancel': (args: string[]) => { state.runs.find(run => String(run.databaseId) === args[2]).status = 'completed'; return ok(); },
  };
  const gitRoutes = {
    remote: () => ok('git@github.com:acme/widget.git\n'),
    'check-ref-format': () => ok(),
    'show-ref': () => state.branchExists ? ok() : bad(),
    fetch: () => ok(),
    worktree: (args: string[]) => ok(args[1] === 'list' && state.checkedOut ? `worktree ${manifest.worktree}\nHEAD ${state.head}\nbranch refs/heads/${TRAIN}\n\n` : ''),
    log: () => ok('abcd Fold widgets\n'),
    push: () => { state.pushes++; state.remoteHead = state.head; return ok(); },
    branch: (args: string[]) => {
      if (args[1] === '--show-current') return ok(state.onBranch);
      state.branchExists = true; return ok();
    },
    'rev-parse': (args: string[]) => ok(args[1] === 'FETCH_HEAD' ? state.fetched : state.head),
    'ls-remote': (args: string[]) => args.at(-1) === `refs/heads/${TRAIN}`
      ? ok(state.remoteHead ? `${state.remoteHead}\trefs/heads/${TRAIN}\n` : '') : ok(`${state.fetched}\trefs/heads/fix/widget\n`),
    status: () => ok(state.dirty ? ' M dirty' : ''),
    'merge-base': (args: string[]) => {
      if (args[1] !== '--is-ancestor') return ok(BASE);
      if (state.unknownAncestor) return bad('unknown object', 128);
      return state.ancestor ? ok() : bad();
    },
    diff: () => ok('conflicted.txt'),
    merge: (args: string[]) => {
      if (args[1] === '--abort') { state.aborts++; return ok(); }
      if (state.conflict) return bad('conflict');
      state.merges++; state.head = MERGE; state.ancestor = true; return ok();
    },
    'rev-list': () => ok('0\t2\n'),
  };
  function route(command: string, args: string[]) {
    const key = command === 'git' ? args[0] : args.slice(0, 2).join(' ');
    const routes = command === 'git' ? gitRoutes : ghRoutes;
    assert.ok(Object.hasOwn(routes, key), `unexpected ${command}: ${args}`);
    return routes[key](args);
  }
  const ctx = { cwd: root, env, now: () => '2026-10-23T12:00:00Z', out: (s: string) => output.push(s), err: (s: string) => errors.push(s),
    run: async (command: string, args: string[]) => {
      calls.push({ command, args });
      const clean = command === 'git' ? args.slice(2) : args;
      const key = `${command} ${clean.slice(0, 2).join(' ')}`;
      if (state.failBefore === key) { state.failBefore = ''; throw new Error('simulated crash before mutation'); }
      const result = route(command, clean);
      if (state.failAfter === key) { state.failAfter = ''; throw new Error('simulated crash after mutation'); }
      return result;
    } };
  return { root, path, state, ctx, calls, output, errors, manifest,
    invoke: (...args: string[]) => main(args, ctx), read: () => loadManifest(path) };
}

const mutations = (f: Fixture) => f.calls.filter(({ command, args }) => command === 'gh'
  ? ['close', 'comment', 'cancel'].includes(args[1]) : ['fetch', 'merge', 'worktree'].includes(args[2]) || (args[2] === 'branch' && args[3] !== '--show-current'));

test('help and usage have stable exit codes without commands', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('--help'), 0);
  assert.equal(await f.invoke('unknown'), 2);
  assert.equal(await f.invoke('fold'), 2);
  assert.equal(await f.invoke('fold', '7', '--override'), 2);
  assert.equal(f.calls.length, 0);
});

test('init creates schema, worktree and branch; repeat leaves manifest unchanged', async t => {
  const f = await setup(t, false);
  f.state.fetched = BASE;
  assert.equal(await f.invoke('init', '.', TRAIN), 0);
  const saved = await f.read();
  assert.equal(saved.base.sha, BASE);
  assert.deepEqual([saved.packages, saved.upstream, saved.downstream], [[], [], []]);
  assert.ok(f.calls.some(call => call.args.includes('worktree')));
  const bytes = await readFile(f.path, 'utf8');
  assert.equal(await f.invoke('init', '.', TRAIN), 0);
  assert.equal(await readFile(f.path, 'utf8'), bytes);
  assert.match(f.output.join('\n'), /already initialised/);
});

test('init refuses existing unregistered branch and mismatching base', async t => {
  const f = await setup(t, false); f.state.branchExists = true;
  assert.equal(await f.invoke('init', '.', TRAIN), 1);
  await saveManifest(f.path, f.manifest);
  assert.equal(await f.invoke('init', '.', TRAIN, '--from', 'origin/dev'), 1);
});

for (const [name, change] of [
  ['human request', { reviewRequests: [{ login: 'reviewer' }] }],
  ['team request', { reviewRequests: [{ __typename: 'Team', name: 'Team', slug: 'team' }] }],
  ['changes requested', { latestReviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] }],
  ['fork', { isCrossRepository: true }],
  ['foreign author', { author: { login: 'other' } }],
  ['base mismatch', { baseRefName: 'dev' }],
  ['train head', { headRefName: TRAIN }],
  ['main head', { headRefName: 'main' }],
]) {
  test(`fold refuses ${name} without changes`, async t => {
    const f = await setup(t); Object.assign(f.state.pr, change);
    const before = await readFile(f.path, 'utf8');
    assert.equal(await f.invoke('fold', '7'), 1, f.errors.join('\n'));
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.equal(mutations(f).length, 0);
  });
}

for (const [name, change] of [
  ['bot reviews', { reviewRequests: [{ login: 'Copilot' }, { login: 'helper[bot]' }], latestReviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'helper[bot]' } }] }],
  ['author reviews', { reviewRequests: [{ login: 'me' }], latestReviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'me' } }] }],
  ['dependabot author', { author: { login: 'dependabot[bot]' } }],
  ['renovate author', { author: { login: 'renovate' } }],
]) {
  test(`fold accepts ${name}`, async t => {
    const f = await setup(t); Object.assign(f.state.pr, change);
    assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
  });
}

test('allow-foreign permits another author but never a fork or reviews', async t => {
  const f = await setup(t); f.state.pr.author.login = 'other';
  assert.equal(await f.invoke('fold', '7', '--allow-foreign'), 0);
  f.state.pr.isCrossRepository = true;
  assert.equal(await f.invoke('fold', '7', '--allow-foreign'), 1);
  f.state.pr.isCrossRepository = false; f.state.pr.reviewRequests = [{ login: 'me' }];
  assert.equal(await f.invoke('fold', '7', '--allow-foreign'), 1);
});

test('fold merges, closes with exact marker, cancels and copies notes', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
  const m = await f.read(), item = m.items[0];
  assert.equal(m.head, MERGE); assert.equal(item.sha, SHA); assert.equal(item.kind, 'folded');
  assert.ok(item.mergedAt && item.closedAt && item.cancelledAt && item.bulletsCopied);
  assert.deepEqual(item.cancelledRuns, [10]);
  assert.equal(m.notes.Fixed[0].text, '- Fix widgets (#7)');
  assert.equal(f.state.pr.comments[0].body, `Folded into \`${TRAIN}\` (local release train). Its changes and release notes ship with the train PR.\n\n<!-- pi-train:fold ${TRAIN} -->`);
  const bytes = await readFile(f.path, 'utf8');
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.equal(await readFile(f.path, 'utf8'), bytes);
  assert.equal(f.state.merges, 1); assert.equal(f.state.closed, 1); assert.equal(f.state.comments, 0);
  assert.equal((await f.read()).notes.Fixed.length, 1);
});

test('moved head, dirty worktree and wrong branch refuse before merge/close', async t => {
  const f = await setup(t); f.state.fetched = BASE;
  assert.equal(await f.invoke('fold', '7'), 1);
  f.state.fetched = SHA; f.state.dirty = true;
  assert.equal(await f.invoke('fold', '7'), 1);
  f.state.dirty = false; f.state.onBranch = 'wrong';
  assert.equal(await f.invoke('fold', '7'), 1);
  assert.equal(f.state.merges + f.state.closed, 0);
  assert.equal((await f.read()).items.length, 0);
});

test('merge conflict aborts and leaves PR and manifest untouched', async t => {
  const f = await setup(t); f.state.conflict = true;
  const before = await readFile(f.path, 'utf8');
  assert.equal(await f.invoke('fold', '7'), 1);
  assert.equal(f.state.aborts, 1); assert.equal(f.state.closed, 0);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.match(f.errors.join('\n'), /conflicted.txt/);
});

test('ancestor skips merge; merged PR is recorded as in-main without network mutations', async t => {
  const f = await setup(t); f.state.ancestor = true;
  assert.equal(await f.invoke('fold', '7'), 0); assert.equal(f.state.merges, 0);
  f.state.pr.state = 'MERGED'; f.calls.length = 0;
  assert.equal(await f.invoke('fold', '7'), 1);
  assert.equal((await f.read()).items[0].kind, 'in-main');
  assert.equal(mutations(f).length, 0);
});

for (const marker of [false, true]) {
  test(`already closed PR ${marker ? 'with' : 'without'} marker`, async t => {
    const f = await setup(t); f.state.pr.state = 'CLOSED';
    if (marker) f.state.pr.comments.push({ body: `<!-- pi-train:fold ${TRAIN} -->` });
    assert.equal(await f.invoke('fold', '7'), 0);
    assert.equal(f.state.closed, 0); assert.equal(f.state.comments, marker ? 0 : 1);
  });
}

const exclusions = [
  { headBranch: 'other' }, { headBranch: 'main' }, { headBranch: TRAIN }, { headBranch: 'default' },
  { status: 'completed' }, { workflowName: 'Publish package' }, { workflowName: 'RELEASE' },
  { workflowName: 'deploy' }, { name: 'Publish' }, { name: 'release step' }, { name: 'DEPLOY' },
  { event: 'release' }, { event: 'schedule' }, { event: 'workflow_dispatch' },
];
test('run filter excludes every protected run and branch', async t => {
  const f = await setup(t);
  f.state.runs = [runFixture(), ...exclusions.map((extra, i) => runFixture(20 + i, extra))];
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.deepEqual((await f.read()).items[0].cancelledRuns, [10]);
  for (const branch of ['main', TRAIN, 'default']) assert.equal(cancellable(runFixture(1, { headBranch: branch }), branch, TRAIN, 'default'), false);
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) assert.equal(cancellable(runFixture(1, { status }), 'fix/widget', TRAIN, 'default'), true);
  assert.ok(f.calls.some(call => call.args.includes(RUN_FIELDS)));
});

test('PR cancellation verifies head and earlier commit SHAs, not just a shared branch name', async t => {
  const f = await setup(t); f.state.pr.commits = [{ oid: BASE }];
  f.state.runs = [runFixture(), runFixture(11, { headSha: BASE }), runFixture(12, { headSha: MERGE })];
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.deepEqual((await f.read()).items[0].cancelledRuns, [10, 11]);
  assert.equal(f.state.runs[2].status, 'in_progress');
  assert.ok(f.calls.some(call => call.args.includes('commits,headRefOid')));
});

test('bare branch cancels only reachable run SHAs and prints others as manual items', async t => {
  const f = await setup(t); f.state.branchPR = false;
  f.state.runs = [runFixture(), runFixture(11, { headSha: BASE }), runFixture(12, { headSha: MERGE }), runFixture(13, { headSha: 'unknown' })];
  const original = f.ctx.run;
  f.ctx.run = async (command, args) => {
    if (`${command} ${args[2]} ${args[5]}` === `git merge-base ${SHA}`) {
      return [SHA, BASE].includes(args[4]) ? ok() : bad('not reachable or unknown', 128);
    }
    return original(command, args);
  };
  assert.equal(await f.invoke('fold', 'fix/widget'), 0, f.errors.join('\n'));
  assert.deepEqual((await f.read()).items[0].cancelledRuns, [10, 11]);
  assert.match(f.output.join('\n'), /manual: run 12/);
  assert.match(f.output.join('\n'), /manual: run 13/);
  assert.equal(f.state.closed, 0);
  assert.equal(await f.invoke('status', '--json'), 1);
  assert.ok(JSON.parse(f.output.at(-1)!).trains[0].activeRuns.every(run => run.manual));
});

test('pending cancellation rechecks the run SHA before retrying', async t => {
  const f = await setup(t); f.state.failBefore = 'gh run cancel';
  assert.equal(await f.invoke('fold', '7'), 2);
  f.state.runs[0].headSha = MERGE;
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.equal(f.state.runs[0].status, 'in_progress');
  assert.deepEqual((await f.read()).items[0].cancelledRuns, []);
  assert.match(f.output.join('\n'), /manual: pending run 10/);
});

test('bot identification uses only the typename, bot suffix or exact allow-list', async t => {
  for (const login of ['dependabot', 'renovate', 'github-actions', 'Copilot', 'copilot-pull-request-reviewer', 'helper[bot]']) assert.equal(isBot({ login }), true);
  for (const login of ['renovate-joe', 'dependabot-joe', 'copilot-human']) assert.equal(isBot({ login }), false);
  assert.equal(isBot({ __typename: 'Bot', login: 'service' }), true);
  assert.equal(isBot({ type: 'Bot', login: 'service' }), false);
  const f = await setup(t); f.state.pr.reviewRequests = [{ login: 'renovate-joe' }];
  assert.equal(await f.invoke('fold', '7'), 1);
  f.state.pr.reviewRequests = []; f.state.pr.author.login = 'renovate-joe';
  assert.equal(await f.invoke('fold', '7'), 1);
});

test('already-completed cancellation succeeds and real cancellation failure is resumable', async t => {
  const f = await setup(t); const original = f.ctx.run;
  let complete = false;
  f.ctx.run = async (command, args) => command === 'gh' && args[0] === 'run' && args[1] === 'cancel'
    ? bad(complete ? 'already completed' : 'network failure') : original(command, args);
  assert.equal(await f.invoke('fold', '7'), 2);
  assert.ok((await f.read()).items[0].closedAt);
  complete = true;
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.deepEqual((await f.read()).items[0].cancelledRuns, [10]);
});

for (const step of ['git merge --no-ff', 'gh pr close', 'gh run cancel']) {
  test(`crash immediately after ${step} resumes without duplicate effects`, async t => {
    const f = await setup(t); f.state.failAfter = step;
    assert.equal(await f.invoke('fold', '7'), 2);
    assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
    const m = await f.read();
    assert.equal(m.items.length, 1); assert.ok(m.items[0].bulletsCopied);
    assert.deepEqual(m.items[0].cancelledRuns, [10]);
    assert.equal(f.state.merges, 1); assert.equal(f.state.closed, 1); assert.equal(f.state.comments, 0);
    assert.equal(m.notes.Fixed.length, 1);
  });
}

test('cancellation progress is saved after each successful mutation', async t => {
  const f = await setup(t); f.state.runs.push(runFixture(11));
  const original = f.ctx.run;
  f.ctx.run = async (command, args) => {
    if (`${command} ${args.slice(0, 3).join(' ')}` === 'gh run cancel 11') {
      assert.deepEqual((await f.read()).items[0].cancelledRuns, [10]);
      return bad('unavailable');
    }
    return original(command, args);
  };
  assert.equal(await f.invoke('fold', '7'), 2);
  f.ctx.run = original;
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.deepEqual((await f.read()).items[0].cancelledRuns, [10, 11]);
});

test('planned closes and cancels without merging; fold converts it', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('planned', '7', TRAIN), 0);
  let item = (await f.read()).items[0];
  assert.equal(item.kind, 'planned'); assert.ok(item.planned.at); assert.equal(item.mergedAt, undefined);
  assert.equal(f.state.merges, 0);
  assert.match(f.state.pr.comments[0].body, /^Will be folded into/);
  assert.match(f.state.pr.comments[0].body, /<!-- pi-train:planned train\/test -->/);
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.match(f.state.pr.comments[1].body, /^Folded into/);
  assert.match(f.state.pr.comments[1].body, /<!-- pi-train:fold train\/test -->/);
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.equal(f.state.comments, 1);
  item = (await f.read()).items[0];
  assert.equal(item.kind, 'folded'); assert.ok(item.mergedAt); assert.equal(f.state.closed, 1);
});

test('planned head movement warns; folded head movement refuses', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('planned', '7', TRAIN), 0);
  f.state.pr.headRefOid = BASE; f.state.fetched = BASE;
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.match(f.errors.join('\n'), /planned head moved/);
  f.state.pr.headRefOid = SHA; f.state.fetched = SHA;
  assert.equal(await f.invoke('fold', '7'), 1);
});

test('branch finds its open PR and resumes a closed PR; bare branch has no close/cancel', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('fold', 'fix/widget'), 0);
  f.state.branchPR = false;
  assert.equal(await f.invoke('fold', 'fix/widget'), 0);
  assert.equal(f.state.closed, 1);
  const m = await f.read(); m.items = []; await saveManifest(f.path, m);
  f.calls.length = 0;
  assert.equal(await f.invoke('fold', 'bare'), 0);
  assert.equal((await f.read()).items[0].pr, null);
  assert.equal(f.calls.filter(call => call.command === 'gh' && ['close', 'cancel'].includes(call.args[1])).length, 0);
});

for (const command of [['fold', '7'], ['planned', '7', TRAIN]]) {
  test(`${command[0]} dry run prints exact commands and changes nothing, including locks`, async t => {
    const f = await setup(t); const bytes = await readFile(f.path, 'utf8');
    const listing = await readdir(join(f.root, 'store', 'acme__widget'));
    assert.equal(await f.invoke(...command, '--dry-run'), 0, f.errors.join('\n'));
    assert.equal(await readFile(f.path, 'utf8'), bytes);
    assert.deepEqual(await readdir(join(f.root, 'store', 'acme__widget')), listing);
    assert.equal(mutations(f).length, 0);
    const text = f.output.join('\n');
    assert.match(text, /would: gh pr close 7 --comment/);
    assert.match(text, /would: gh run cancel 10 --repo acme\/widget/);
    if (command[0] === 'fold') assert.match(text, /would: git -C .* merge --no-ff/);
  });
}

test('init dry run does not even create the manifest directory', async t => {
  const f = await setup(t, false);
  assert.equal(await f.invoke('init', '.', TRAIN, '--dry-run'), 0);
  assert.equal(mutations(f).length, 0);
  await assert.rejects(readdir(join(f.root, 'store')), { code: 'ENOENT' });
});

test('status reports folded/planned, pending, ancestry, active runs, mismatch and unknown objects', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('fold', '7'), 0);
  f.state.pr.state = 'OPEN'; f.state.runs = [runFixture(12)];
  f.state.openPRs = [f.state.pr]; f.state.head = SHA;
  const m = await f.read(); delete m.items[0].cancelledAt; await saveManifest(f.path, m);
  assert.equal(await f.invoke('status', '--json'), 1);
  let status = JSON.parse(f.output.at(-1)!).trains[0];
  assert.equal(status.items[0].closed, false); assert.equal(status.items[0].cancelledRunCount, 1);
  assert.deepEqual(status.pending[0].pending, ['close', 'cancel']);
  assert.equal(status.activeRuns[0].databaseId, 12);
  assert.ok(status.anomalies.some((text: string) => text.includes('ancestor')));
  assert.ok(status.anomalies.some((text: string) => text.includes('manifest.head')));
  f.state.unknownAncestor = true;
  assert.equal(await f.invoke('status', '--json'), 1);
  status = JSON.parse(f.output.at(-1)!).trains[0];
  assert.ok(status.anomalies.some((text: string) => text.includes('unverified')));
});

test('status clean exits zero, warns for missing bullets, all needs no current repo', async t => {
  const f = await setup(t); f.state.pr.body = '## Summary\nNo notes';
  assert.equal(await f.invoke('planned', '7', TRAIN), 0);
  assert.equal(await f.invoke('status', '--all', '--json'), 0);
  const status = JSON.parse(f.output.at(-1)!).trains[0];
  assert.equal(status.items[0].kind, 'planned');
  assert.ok(status.items[0].warnings.includes('no release bullets in #7'));
  assert.equal(status.ahead, 2); assert.equal(status.behind, 0);
});

test('notes strip comments, drop Summary/placeholders/None, keep groups and continuations, dedupe', () => {
  const body = `## Summary\n- Not a note\n<!-- ## Fixed\n- Hidden -->\n## Added\n- Short statement of addition\n- None.\n### Client\n* New API (#12)\n  with continuation\n## Fixed\n- Repair widget (#7)\n## Changed\n- Changed behaviour\n## Removed\n- Removed old API\n## Deprecated\n- Deprecated old API\n## Security\n- Security fix\n## Testing\n- Ignore tests`;
  const extracted = extractBullets(body), notes: any = {};
  assert.equal(extracted.summaryDropped, true);
  copyBullets(notes, extracted.notes, 12);
  copyBullets(notes, extractBullets(body.replace('Repair widget', 'repair   widget')).notes, 13);
  assert.equal(notes.Added.length, 1); assert.equal(notes.Fixed.length, 1);
  assert.deepEqual(notes.Added[0], { text: '- New API (#12)\n  with continuation', group: 'Client', from: 12 });
  const rendered = renderNotes(notes);
  assert.match(rendered, /## Added\n\n### Client\n\n- New API \(#12\)/);
  assert.doesNotMatch(rendered, /Summary|Hidden|None|Short statement|Closes|Ignore tests/);
  for (const section of ['Changed', 'Fixed', 'Removed', 'Deprecated', 'Security']) assert.match(rendered, new RegExp(`## ${section}`));
});

test('manifest rejects unknown major version and slug collisions; repo forms share a key', async t => {
  const f = await setup(t);
  for (const url of ['git@github.com:acme/widget.git', 'https://github.com/acme/widget.git', 'ssh://git@github.com/acme/widget']) assert.equal(repoKey(url), REPO);
  await assert.rejects(loadManifest(f.path, 'train_test'), /collision/);
  await saveManifest(f.path, { ...f.manifest, v: 2 });
  assert.equal(await f.invoke('status'), 1);
});

test('manifest lock serialises concurrent read-modify-writes and reclaims stale locks', async t => {
  const f = await setup(t);
  await Promise.all(Array.from({ length: 6 }, () => withManifestLock(f.path, async () => {
    const m = await f.read(); await new Promise(resolve => setTimeout(resolve, 5));
    m.log.push({ op: 'test' }); await saveManifest(f.path, m);
  })));
  assert.equal((await f.read()).log.length, 6);
  await mkdir(`${f.path}.lock`);
  await writeFile(join(`${f.path}.lock`, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  await withManifestLock(f.path, async () => assert.ok(await f.read()));
});

test('old lock with a live pid refuses instead of being reclaimed', async t => {
  const f = await setup(t), lock = `${f.path}.lock`;
  await mkdir(lock);
  const owner = JSON.stringify({ pid: process.pid, token: 'live-owner' });
  await writeFile(join(lock, 'owner.json'), owner);
  const old = new Date(Date.now() - 660_000); await utimes(lock, old, old);
  await assert.rejects(withManifestLock(f.path, async () => assert.fail('must not acquire live lock')), /older than 10 minutes has live pid/);
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), owner);
});

test('lock cleanup tolerates a missing owner file or lock directory', async t => {
  const f = await setup(t), lock = `${f.path}.lock`;
  await withManifestLock(f.path, async () => rm(join(lock, 'owner.json')));
  await rm(lock, { recursive: true });
  await withManifestLock(f.path, async () => rm(lock, { recursive: true }));
  await assert.rejects(readdir(lock), { code: 'ENOENT' });
});

test('failed merge abort does not mask the original merge error', async t => {
  const f = await setup(t); f.state.conflict = true;
  const original = f.ctx.run;
  f.ctx.run = async (command, args) => command === 'git' && args[2] === 'merge' && args[3] === '--abort'
    ? bad('abort failed: no merge in progress') : original(command, args);
  assert.equal(await f.invoke('fold', '7'), 1);
  assert.match(f.errors.join('\n'), /merge failed; conflicts: conflicted.txt: conflict/);
  assert.doesNotMatch(f.errors.join('\n'), /abort failed/);
  assert.equal(f.state.closed, 0);
});

function nativeGit(cwd: string, args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  return { status: result.status ?? 2, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' };
}

test('real local bare origin: init, merge, ancestor rerun and conflict abort keep PR untouched', async t => {
  const f = await setup(t, false), repo = join(f.root, 'repo'), origin = join(f.root, 'origin.git'), wt = join(f.root, 'train');
  await mkdir(repo); await mkdir(origin);
  const git = (cwd: string, ...args: string[]) => {
    const result = nativeGit(cwd, args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(origin, 'init', '--bare'); git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'file.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-u', 'origin', 'main');
  const mock = f.ctx.run;
  f.ctx.run = async (command, args) => command === 'git' && args[2] !== 'remote' ? nativeGit(args[1], args.slice(2)) : mock(command, args);
  assert.equal(await f.invoke('init', repo, TRAIN, '--worktree', wt), 0, f.errors.join('\n'));
  git(repo, 'checkout', '-b', 'fix/widget');
  await writeFile(join(repo, 'file.txt'), 'feature\n'); git(repo, 'commit', '-am', 'feature'); git(repo, 'push', 'origin', 'fix/widget');
  f.state.pr.headRefOid = git(repo, 'rev-parse', 'HEAD');
  assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
  assert.equal(await readFile(join(wt, 'file.txt'), 'utf8'), 'feature\n');
  const foldedHead = git(wt, 'rev-parse', 'HEAD');
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), foldedHead);
  git(repo, 'checkout', '-b', 'fix/conflict', 'main');
  await writeFile(join(repo, 'file.txt'), 'conflict\n'); git(repo, 'commit', '-am', 'conflict'); git(repo, 'push', 'origin', 'fix/conflict');
  f.state.pr = { ...prFixture(), number: 8, headRefName: 'fix/conflict', headRefOid: git(repo, 'rev-parse', 'HEAD') };
  assert.equal(await f.invoke('fold', '8'), 1);
  assert.equal(f.state.pr.state, 'OPEN'); assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), foldedHead);
});

test('adopt lists first-parent and ancestor PR candidates without folding; fold closes and cancels without merge', async t => {
  const f = await setup(t, false);
  f.state.branchExists = true; f.state.head = MERGE; f.state.ancestor = true;
  f.state.openPRs = [f.state.pr, { ...f.state.pr, number: 8, headRefName: TRAIN }];
  assert.equal(await f.invoke('init', '--adopt', '.', TRAIN), 0, f.errors.join('\n'));
  const adopted = await f.read();
  assert.equal(adopted.base.sha, BASE); assert.equal(adopted.head, MERGE); assert.equal(adopted.items.length, 0);
  assert.match(f.output.join('\n'), /abcd Fold widgets/); assert.match(f.output.join('\n'), /pi-train fold 7/);
  assert.equal(f.state.closed, 0); assert.equal(f.state.merges, 0);
  assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
  assert.equal(f.state.merges, 0); assert.equal(f.state.closed, 1); assert.equal(f.state.runs[0].status, 'completed');
  assert.equal(await f.invoke('init', '--adopt', '.', TRAIN), 1);
  assert.equal(await f.invoke('init', '--adopt', '.', 'main'), 1);
});

test('adopt attaches an unchecked-out branch without recreating it; dry run creates nothing', async t => {
  const f = await setup(t, false);
  f.state.branchExists = true; f.state.checkedOut = false;
  assert.equal(await f.invoke('init', '--adopt', '.', TRAIN, '--dry-run'), 0, f.errors.join('\n'));
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  assert.equal(f.calls.some(call => call.args.includes('add')), false);
  assert.equal(await f.invoke('init', '--adopt', '.', TRAIN), 0, f.errors.join('\n'));
  assert.equal(f.calls.filter(call => call.args.includes('add')).length, 1);
  assert.equal(f.calls.some(call => call.args.includes('branch') && call.args.includes(TRAIN)), false);
});

async function readyToShip(t: any) {
  const f = await setup(t);
  f.state.pr.labels = [{ name: 'patch' }, { name: 'minor' }];
  assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
  return f;
}

test('ship creates a PR, aggregates notes, warns without gate evidence, links items and is idempotent', async t => {
  const f = await readyToShip(t);
  assert.equal(await f.invoke('ship'), 0, f.errors.join('\n'));
  const shipped = await f.read();
  assert.equal(shipped.pr, 42); assert.equal(shipped.shippedHead, MERGE); assert.equal(shipped.label, 'minor');
  assert.match(f.state.trainPR.body, /## Fixed\n\n- Fix widgets/);
  assert.match(f.errors.join('\n'), /no verified Tier 1 for ccccccc/);
  assert.equal(f.state.pushes, 1); assert.equal(f.state.creates, 1);
  const comments = f.state.comments;
  assert.equal(await f.invoke('ship'), 0, f.errors.join('\n'));
  assert.equal(f.state.pushes, 1); assert.equal(f.state.creates, 1); assert.equal(f.state.edits, 0);
  assert.equal(f.state.comments, comments);
  const summary = join(f.root, 'summary.md'); await writeFile(summary, '## Summary\n\nA train.\n');
  assert.equal(await f.invoke('ship', '--summary-file', summary, '--label', 'major'), 0);
  assert.equal(f.state.edits, 1); assert.match(f.state.trainPR.body, /A train/);
  assert.deepEqual(f.state.trainPR.labels, [{ name: 'major' }]);
});

test('ship updates an existing train PR rather than creating and does not repeat recovery comments', async t => {
  const f = await readyToShip(t);
  f.state.trainPR = { number: 42, body: 'old', labels: [], comments: [] };
  assert.equal(await f.invoke('ship'), 0, f.errors.join('\n'));
  assert.equal(f.state.creates, 0); assert.equal(f.state.edits, 1);
  const manifest = await f.read(); delete manifest.shipComment; delete manifest.items[0].trainPR;
  await saveManifest(f.path, manifest); const comments = f.state.comments;
  assert.equal(await f.invoke('ship'), 0);
  assert.equal(f.state.comments, comments);
});

test('ship checks PR body before pushing; Cratis check takes precedence over configured hook', async t => {
  const f = await readyToShip(t), scripts = join(f.manifest.worktree, '.cratis/ai/hooks/scripts');
  await mkdir(scripts, { recursive: true }); await writeFile(join(scripts, 'cratis-check-pr.mjs'), '');
  await writeFile(join(f.root, 'store/config.json'), JSON.stringify({ checkPr: ['other-check'] }));
  const original = f.ctx.run; let checkArgs: string[] = [];
  f.ctx.run = async (command, args) => {
    if (command === 'node') { checkArgs = args; return bad('invalid release notes'); }
    return original(command, args);
  };
  assert.equal(await f.invoke('ship'), 1); assert.equal(f.state.pushes, 0); assert.equal(f.state.creates, 0);
  assert.match(f.errors.join('\n'), /invalid release notes/); assert.ok(checkArgs.includes('--body-file'));
});

test('ship refuses behind main, reopened PRs, pending steps, dirty worktree and missing labels', async t => {
  const f = await readyToShip(t);
  f.state.ancestor = false;
  assert.equal(await f.invoke('ship'), 1); assert.match(f.errors.at(-1)!, /merge origin\/main/);
  f.state.ancestor = true; f.state.pr.state = 'OPEN';
  assert.equal(await f.invoke('ship'), 1); assert.match(f.errors.at(-1)!, /reopened/);
  f.state.pr.state = 'CLOSED'; f.state.dirty = true;
  assert.equal(await f.invoke('ship'), 1); f.state.dirty = false;
  const m = await f.read(); delete m.items[0].cancelledAt; await saveManifest(f.path, m);
  assert.equal(await f.invoke('ship'), 1); m.items[0].cancelledAt = f.ctx.now(); await saveManifest(f.path, m);
  f.state.pr.labels = [];
  assert.equal(await f.invoke('ship'), 1); assert.match(f.errors.at(-1)!, /provide --label/);
  assert.equal(f.state.pushes, 0);
  f.state.ancestor = false;
  assert.equal(await f.invoke('ship', '--label', 'no-release', '--allow-behind'), 0);
});

test('ship gate requirement accepts only verified clean build/test records for the train head', async t => {
  const f = await readyToShip(t);
  await writeFile(join(f.root, 'store/config.json'), JSON.stringify({ requireGate: true, checkPr: ['body-check', '{bodyFile}', '{label}'] }));
  assert.equal(await f.invoke('ship'), 1); assert.equal(f.state.pushes, 0);
  const ledger = join(f.root, '.pi/agent/pi-phase/state/ledger'); await mkdir(ledger, { recursive: true });
  const record = { outcome: 'passed', verified: true, head: MERGE, dirty: 'clean', kind: 'test', label: 'Tier 1' };
  await writeFile(join(ledger, '2026-10-23.jsonl'), JSON.stringify({ ...record, verified: false }) + '\ninvalid\n');
  assert.equal(await f.invoke('ship'), 1);
  await writeFile(join(ledger, '2026-10-23.jsonl'), JSON.stringify(record) + '\n');
  const original = f.ctx.run; let checked = false;
  f.ctx.run = async (command, args) => { if (command === 'body-check') { checked = true; assert.equal(args[1], 'minor'); return ok(); } return original(command, args); };
  assert.equal(await f.invoke('ship'), 0, f.errors.join('\n')); assert.equal(checked, true);
  assert.match(f.state.trainPR.comments[0].body, /test: Tier 1/);
});

test('ship dry run leaves manifests, artifacts and network unchanged', async t => {
  const f = await readyToShip(t), before = await readFile(f.path, 'utf8');
  const count = f.state.comments;
  assert.equal(await f.invoke('ship', '--dry-run'), 0, f.errors.join('\n'));
  assert.equal(await readFile(f.path, 'utf8'), before); assert.equal(f.state.pushes, 0); assert.equal(f.state.comments, count);
  await assert.rejects(readFile(join(f.manifest.worktree, '.ai-work/trains/train_test/pr-body.md')), { code: 'ENOENT' });
});

test('realContext executes an injected PATH shim, never GitHub', async t => {
  const f = await setup(t); const bin = join(f.root, 'bin'); await mkdir(bin);
  const shim = join(bin, 'gh');
  await writeFile(shim, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const result = realContext().run('gh', ['pr', 'view', '7'], { cwd: f.root, env: { ...process.env, PATH: bin } });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'pr\nview\n7\n');
});
