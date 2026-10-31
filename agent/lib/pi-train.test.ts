import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { main, realContext } from './pi-train.mjs';
import { cancellable, isBot, RUN_FIELDS } from './train-gh.mjs';
import { loadManifest, manifestPath, repoKey, saveManifest, withManifestLock } from './train-manifest.mjs';
import { copyBullets, extractBullets, renderNotes } from './train-notes.mjs';
import { shipLabel } from './train-ship-pr.mjs';
import { publish } from './publisher.ts';

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
    raw: [] as string[][], localBranches: {} as Record<string, string>, branchPR: true, unknownAncestor: false, checkedOut: true, trainPR: null as any, creates: 0, edits: 0, pushes: 0, remoteHead: '', candidates: {} as Record<string, number>, failCandidates: false, wtBranch: '' };
  const env = { HOME: root, USER: 'me', PI_TRAIN_DIR: join(root, 'store') };
  const path = manifestPath(env, REPO, TRAIN);
  const manifest = { v: 1, repo: REPO, train: TRAIN, base: { ref: 'origin/main', sha: BASE },
    worktree: join(root, 'worktree'), owner: 'me', state: 'open', head: BASE, pr: null, shippedHead: null,
    label: null, items: [], notes: {}, packages: [], upstream: [], downstream: [], log: [] };
  if (init) { await saveManifest(path, manifest); await mkdir(manifest.worktree, { recursive: true }); }
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
    'show-ref': (args: string[]) => {
      if (!args.includes('--hash')) return state.branchExists ? ok() : bad();
      const sha = state.localBranches[args.at(-1)!.replace('refs/heads/', '')];
      return sha ? ok(sha) : bad();
    },
    fetch: () => ok(),
    worktree: (args: string[]) => ok(args[1] === 'list' && state.checkedOut ? `worktree ${manifest.worktree}\nHEAD ${state.head}\nbranch refs/heads/${state.wtBranch || TRAIN}\n\n` : ''),
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
    'for-each-ref': () => state.failCandidates ? bad('boom') : ok(Object.keys(state.candidates).map(name => `${name}\n`).join('')),
    'rev-list': (args: string[]) => args[1] === '--count' ? ok(`${state.candidates[args[2].split('..')[1]] ?? 0}\n`) : ok('0\t2\n'),
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
  // Real publisher core; only gh resolution and the process boundary are faked. `--flag=value` is split so the routes stay readable.
  const split = (argv: string[]) => argv.flatMap(arg => /^--[a-z-]+=/.test(arg) ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg]);
  const adapters = {
    io: { realpath: async () => '/trusted/gh', stat: async () => ({ size: 1, isFile: () => true }), access: async () => {} },
    spawn: (_executable: string, argv: string[]) => {
      const child: any = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      state.raw.push(argv);
      const args = split(argv), repo = args[args.indexOf('--repo') + 1];
      const finish = (code: number) => { child.stdout.end(); child.stderr.end(); child.emit('close', code); };
      Promise.resolve().then(() => (ctx as any).run('gh', [...args.filter((_, i) => args[i] !== '--repo' && args[i - 1] !== '--repo'), '--repo', repo]))
        .then((result: any) => finish(result.status), () => finish(1));
      return child;
    },
  };
  (ctx as any).publish = (request: unknown, context: unknown) => publish(request, context as any, adapters as any);
  return { root, path, state, ctx, calls, output, errors, manifest,
    invoke: (...args: string[]) => main(args, ctx), read: () => loadManifest(path) };
}

test('fold and planned checkpoint ETAs, update them and preserve them without the flag', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('planned', '7', TRAIN, '--eta', '+90m'), 0, f.errors.join('\n'));
  assert.equal((await f.read()).items[0].eta, '2026-10-23T13:30:00.000Z');
  assert.equal(await f.invoke('planned', '7', TRAIN, '--eta', '+2h'), 0);
  assert.equal((await f.read()).items[0].eta, '2026-10-23T14:00:00.000Z');
  assert.equal(await f.invoke('fold', '7', '--eta', '2026-10-23T15:00:00+02:00'), 0);
  assert.equal((await f.read()).items[0].eta, '2026-10-23T13:00:00.000Z');
  assert.equal(await f.invoke('fold', '7', '--eta', '+1d'), 0);
  assert.equal((await f.read()).items[0].eta, '2026-10-24T12:00:00.000Z');
  assert.equal(await f.invoke('fold', '7'), 0);
  assert.equal((await f.read()).items[0].eta, '2026-10-24T12:00:00.000Z');
});

test('ETA validation happens before any commands; dry runs do not persist ETAs', async t => {
  const f = await setup(t);
  const before = await readFile(f.path, 'utf8');
  assert.equal(await f.invoke('fold', '7', '--eta', 'tomorrow'), 2);
  assert.match(f.errors.at(-1)!, /invalid eta/);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.invoke('fold', '7', '--eta', '+2h', '--dry-run'), 0);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(await f.invoke('status', '--gate', 'bad'), 2);
  assert.equal(await f.invoke('status', '--eta', '+2h'), 2);
  assert.equal(await f.invoke('fold', '7', '--gate', '2h'), 2);
});

test('eta command updates and clears an existing delivery locally, respecting dry runs', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('planned', '7', TRAIN), 0);
  f.calls.length = 0;
  assert.equal(await f.invoke('eta', '#7', '+90m'), 0);
  assert.equal((await f.read()).items[0].eta, '2026-10-23T13:30:00.000Z');
  assert.equal(await f.invoke('eta', 'fix/widget', 'clear', '--dry-run'), 0);
  assert.ok((await f.read()).items[0].eta);
  assert.equal(await f.invoke('eta', 'fix/widget', 'clear'), 0);
  assert.equal((await f.read()).items[0].eta, undefined);
  assert.equal(await f.invoke('eta', 'missing', '+2h'), 1);
  assert.ok(f.calls.every(call => call.command === 'git'));
});

test('close --shipped records the train PR and head for a named train', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('close', TRAIN, '--shipped', '#42', '--head', 'abcdef1'), 0);
  const manifest = await f.read();
  assert.equal(manifest.state, 'released'); assert.equal(manifest.pr, 42); assert.equal(manifest.shippedHead, 'abcdef1');
  assert.equal(await f.invoke('close', TRAIN, '--shipped', 'x'), 2);
  assert.equal(await f.invoke('fold', '7', '--shipped', '1'), 2);
});

test('close marks a train released or abandoned without gh calls, and only once', async t => {
  const f = await setup(t);
  f.calls.length = 0;
  assert.equal(await f.invoke('close', '--dry-run'), 0);
  assert.equal((await f.read()).state, 'open');
  assert.equal(await f.invoke('close', '--abandoned'), 0);
  const manifest = await f.read();
  assert.equal(manifest.state, 'abandoned'); assert.ok(manifest.closedAt);
  assert.equal(manifest.log.at(-1).op, 'close');
  assert.equal(await f.invoke('close', '--train', TRAIN), 1);
  assert.equal(await f.invoke('close', TRAIN, '--abandoned', '--shipped', '9'), 2);
  assert.equal(await f.invoke('status', '--abandoned'), 2);
  assert.ok(f.calls.every(call => call.command === 'git'));
  assert.equal(await f.invoke('status', '--all', '--json'), 0);
  assert.deepEqual(JSON.parse(f.output.at(-1)!).trains, []);
});

test('status exposes ETA recommendations and override precedence without additional gh calls', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('planned', '7', TRAIN, '--eta', '+20m'), 0);
  f.calls.length = 0;
  assert.equal(await f.invoke('status', '--json'), 0);
  let status = JSON.parse(f.output.at(-1)!).trains[0];
  assert.equal(status.recommendation, 'unknown');
  assert.equal(status.gateSeconds, null);
  assert.equal(status.items[0].eta, '2026-10-23T12:20:00.000Z');
  const calls = f.calls.filter(call => call.command === 'gh').map(call => call.args);
  f.calls.length = 0;
  assert.equal(await f.invoke('status', '--json', '--gate', '30m'), 0);
  status = JSON.parse(f.output.at(-1)!).trains[0];
  assert.equal(status.recommendation, 'hold'); assert.equal(status.gateSeconds, 1800); assert.equal(status.gateSource, 'flag');
  assert.deepEqual(f.calls.filter(call => call.command === 'gh').map(call => call.args), calls);
  assert.equal(await f.invoke('status', '--gate', '10m'), 0);
  assert.match(f.output.at(-1)!, /recommendation: cut/);
  const manifest = await f.read(); manifest.gateSeconds = 1800; await saveManifest(f.path, manifest);
  assert.equal(await f.invoke('status', '--json'), 0);
  assert.equal(JSON.parse(f.output.at(-1)!).trains[0].gateSource, 'manifest');
  assert.equal(await f.invoke('status', '--json', '--gate', '10m'), 0);
  assert.equal(JSON.parse(f.output.at(-1)!).trains[0].recommendation, 'cut');
  assert.equal(await f.invoke('eta', '7', '2026-10-23T11:00:00Z'), 0);
  assert.equal(await f.invoke('status'), 0);
  assert.match(f.output.at(-1)!, /hold.*overdue/);
  assert.equal(await f.invoke('eta', '7', 'clear'), 0);
  assert.equal(await f.invoke('status'), 0);
  assert.match(f.output.join('\n'), /eta: no eta/);
  assert.match(f.output.at(-1)!, /recommendation: cut/);
});

const CAND = 'cand/next';
test('close with no open train left points at an untracked ahead candidate with the real adopt syntax', async t => {
  const f = await setup(t);
  f.state.candidates = { [CAND]: 3, 'cand/flat': 0, 'cand/other': 2 };
  const other = { ...f.manifest, train: 'cand/other' };
  await saveManifest(manifestPath(f.ctx.env, REPO, 'cand/other'), { ...other, state: 'abandoned' });
  assert.equal(await f.invoke('close'), 0);
  assert.deepEqual(f.output.slice(1), ['next: no open train; untracked candidate cand/next (ahead 3)',
    `adopt with: pi-train init --adopt ${f.root} cand/next --base origin/main`]);
  assert.ok(f.calls.every(call => !['fetch', 'push'].includes(call.args[2])));
});

test('close hint uses the worktree that has the candidate checked out', async t => {
  const f = await setup(t);
  f.state.candidates = { [CAND]: 1 }; f.state.wtBranch = CAND;
  await rm(f.path);
  await saveManifest(manifestPath(f.ctx.env, REPO, 'train/old'), { ...f.manifest, train: 'train/old' });
  assert.equal(await f.invoke('close'), 0);
  assert.match(f.output.at(-1)!, new RegExp(`adopt with: pi-train init --adopt ${f.manifest.worktree} ${CAND} --base origin/main`));
});

test('close prints no hint while another train is open, nothing tracked is listed, and --dry-run stays quiet', async t => {
  const f = await setup(t);
  f.state.candidates = { [CAND]: 3 };
  await saveManifest(manifestPath(f.ctx.env, REPO, 'train/second'), { ...f.manifest, train: 'train/second' });
  assert.equal(await f.invoke('close', TRAIN), 0);
  assert.deepEqual(f.output, [`marked ${TRAIN} released`]);
  f.output.length = 0;
  assert.equal(await f.invoke('close', 'train/second', '--dry-run'), 0);
  assert.equal(f.output.length, 1);
  await saveManifest(manifestPath(f.ctx.env, REPO, CAND), { ...f.manifest, train: CAND, state: 'released' });
  f.output.length = 0;
  assert.equal(await f.invoke('close', 'train/second'), 0);
  assert.deepEqual(f.output, ['marked train/second released']);
});

test('close with a git failure reports the lookup failure and still succeeds', async t => {
  const f = await setup(t);
  f.state.failCandidates = true;
  assert.equal(await f.invoke('close'), 0);
  assert.equal((await f.read()).state, 'released');
  assert.equal(f.output.at(-1), 'next: candidate lookup failed');
});

test('status lists untracked candidates beside open trains and in json', async t => {
  const f = await setup(t);
  f.state.candidates = { [CAND]: 2, 'cand/flat': 0 };
  assert.equal(await f.invoke('status'), 0);
  assert.ok(f.output.includes('warning: untracked candidate cand/next (ahead 2)'));
  assert.ok(f.output.some(line => line.startsWith('adopt with: pi-train init --adopt ')));
  assert.equal(await f.invoke('status', '--json'), 0);
  assert.deepEqual(JSON.parse(f.output.at(-1)!).untrackedCandidates, [{ branch: CAND, ahead: 2, base: 'origin/main', dir: f.root }]);
  f.state.failCandidates = true;
  assert.equal(await f.invoke('status'), 0);
  assert.equal(f.output.at(-1), 'warning: candidate lookup failed');
});

const mutations = (f: Fixture) => f.calls.filter(({ command, args }) => command === 'gh'
  ? ['close', 'comment', 'cancel'].includes(args[1]) : ['fetch', 'merge', 'worktree'].includes(args[2]) || (args[2] === 'branch' && args[3] !== '--show-current'));

test('help and usage have stable exit codes without commands', async t => {
  const f = await setup(t);
  assert.equal(await f.invoke('--help'), 0);
  assert.equal(await f.invoke('unknown'), 2);
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

test('local branch skips fetch, PR still fetches, implicit branch and detached usage', async t => {
  const f = await setup(t);
  f.state.branchPR = false; f.state.runs = []; f.state.localBranches['fix/local'] = SHA;
  f.state.onBranch = 'fix/local';
  // Only the caller is on the delivery branch; the train remains on its own branch.
  const mock = f.ctx.run;
  f.ctx.run = async (command, args) => args[1] === f.ctx.cwd && args[2] === 'branch'
    ? ok(f.state.onBranch) : command === 'git' && args[2] === 'branch' && args[3] === '--show-current' ? ok(TRAIN) : mock(command, args);
  assert.equal(await f.invoke('fold'), 0, f.errors.join('\n'));
  assert.equal((await f.read()).items[0].sha, SHA);
  assert.ok(!f.calls.some(c => c.command === 'git' && c.args[2] === 'fetch'));
  assert.match(f.output.join('\n'), /folding local head bbbbbbb/);
  f.state.onBranch = '';
  assert.equal(await f.invoke('fold'), 2); assert.match(f.errors.at(-1)!, /Usage: pi-train/);
  const pr = await setup(t); pr.state.localBranches['fix/widget'] = BASE;
  assert.equal(await pr.invoke('fold', '7'), 0);
  assert.ok(pr.calls.some(c => c.command === 'git' && c.args[2] === 'fetch'));
});

test('real local worktree: never-pushed delivery, forward redelivery, rewrite refused', async t => {
  const f = await setup(t, false), repo = join(f.root, 'repo'), origin = join(f.root, 'origin.git');
  const train = join(f.root, 'train'), lane = join(f.root, 'lane');
  await mkdir(repo); await mkdir(origin);
  const git = (cwd: string, ...args: string[]) => {
    const r = nativeGit(cwd, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(origin, 'init', '--bare'); git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'file'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-u', 'origin', 'main');
  const mock = f.ctx.run; let fetches = 0;
  f.ctx.run = async (command, args) => {
    if (command !== 'git' || args[2] === 'remote') return mock(command, args);
    if (args[2] === 'fetch') fetches++;
    return nativeGit(args[1], args.slice(2));
  };
  assert.equal(await f.invoke('init', repo, TRAIN, '--worktree', train), 0, f.errors.join('\n'));
  git(repo, 'worktree', 'add', '-b', 'fix/local', lane); f.ctx.cwd = lane;
  f.state.branchPR = false; f.state.runs = [];
  for (const text of ['first', 'second']) {
    await writeFile(join(lane, 'file'), text); git(lane, 'commit', '-am', text);
    assert.equal(await f.invoke('fold'), 0, f.errors.join('\n'));
    const item = (await f.read()).items[0];
    assert.equal(item.branch, 'fix/local'); assert.equal(item.pr, null); assert.equal(item.kind, 'folded');
    assert.equal(item.sha, git(lane, 'rev-parse', 'HEAD'));
    assert.equal(await readFile(join(train, 'file'), 'utf8'), text);
  }
  assert.equal(fetches, 1); // init only
  // Only feature/task exists locally: folding feature must fetch the exact origin ref.
  git(repo, 'branch', 'feature/task', 'fix/local');
  const base = git(repo, 'rev-parse', 'main');
  git(origin, 'update-ref', 'refs/heads/feature', base);
  assert.notEqual(nativeGit(repo, ['show-ref', '--verify', '--hash', 'refs/heads/feature']).status, 0);
  assert.equal(await f.invoke('fold', 'feature'), 0, f.errors.join('\n'));
  assert.equal((await f.read()).items.find(item => item.branch === 'feature')!.sha, base);
  assert.equal(fetches, 2);
  git(lane, 'reset', '--hard', 'main');
  await writeFile(join(lane, 'file'), 'rewritten'); git(lane, 'commit', '-am', 'rewritten');
  assert.equal(await f.invoke('fold'), 1); assert.equal(f.errors.at(-1), 'folded branch head moved');
});

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

async function readyToShip(t: any, closed = false) {
  const f = await setup(t);
  f.state.pr.labels = [{ name: 'patch' }, { name: 'minor' }];
  assert.equal(await f.invoke('fold', '7'), 0, f.errors.join('\n'));
  // Ship tests exercise the legacy any-build/test evidence; the fail-closed default has its own test.
  if (!closed) { const invoke = f.invoke; f.invoke = (...args: string[]) => invoke(...(args[0] === 'ship' ? [...args, '--allow-unconfigured-gate'] : args)); }
  return f;
}

test('ship fails closed without a Tier 1 component set, and the override is logged', async t => {
  const f = await readyToShip(t, true);
  assert.equal(await f.invoke('ship'), 1); assert.match(f.errors.join('\n'), /no gateComponents configured for acme\/widget.*--allow-unconfigured-gate/);
  assert.equal(f.state.pushes, 0);
  assert.equal(await f.invoke('ship', '--allow-unconfigured-gate'), 0, f.errors.join('\n'));
  assert.match(f.errors.join('\n'), /--allow-unconfigured-gate: no gateComponents for acme\/widget/);
});

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

test('no-release fallback requires every folded PR to opt out; mixed or missing labels require --label', () => {
  const prs = (...groups: string[][]) => groups.map(names => ({ labels: names.map(name => ({ name })) }));
  for (const groups of [[['no-release'], []], [['no-release'], ['docs']], [[], []], [['docs']], []]) {
    assert.throws(() => shipLabel({}, prs(...groups)), /provide --label/);
  }
  assert.equal(shipLabel({}, prs(['no-release'], ['docs', 'no-release'])), 'no-release');
  assert.equal(shipLabel({}, prs(['no-release'], ['patch'])), 'patch');
  assert.equal(shipLabel({ label: 'no-release' }, prs(['no-release'], [])), 'no-release');
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

const leakPath = () => ['', 'Users', 'alice', 'secret-notes.md'].join('/');
const leakToken = () => 'ghp_' + 'a1B2c3D4'.repeat(5);
const gh = (f: Fixture, group: string) => f.calls.filter(call => call.command === 'gh' && call.args.slice(0, 2).join(' ') === group);
function assertNoSideEffects(f: Fixture) {
  assert.equal(f.state.pushes, 0); assert.equal(f.state.creates, 0); assert.equal(f.state.edits, 0); assert.equal(f.state.comments, 0);
  assert.equal(f.state.raw.length, 0);
}
function assertValueFree(f: Fixture) {
  const text = [...f.errors, ...f.output].join('\n');
  assert.doesNotMatch(text, /alice|secret-notes|ghp_|\/trusted\/gh|--body/);
  return text;
}

test('ship refuses a leaking summary file before push, create, edit or comment, with value-free diagnostics', async t => {
  const f = await readyToShip(t), summary = join(f.root, 'summary.md');
  await writeFile(summary, `See ${leakPath()}\n`);
  assert.equal(await f.invoke('ship', '--summary-file', summary), 1);
  assertNoSideEffects(f);
  assert.match(assertValueFree(f), /body: line 1 home-path/);
  assert.match(f.errors.join('\n'), /findings: 1/);
});

test('ship refuses a leak inside folded-PR bullets and a leaking title before push', async t => {
  const f = await readyToShip(t), manifest = await f.read();
  manifest.notes = { Fixed: [{ text: `- Fix ${leakToken()}` }] }; await saveManifest(f.path, manifest);
  assert.equal(await f.invoke('ship'), 1);
  assertNoSideEffects(f); assertValueFree(f);
  assert.match(f.errors.join('\n'), /body: line \d+ /);
  manifest.notes = {}; await saveManifest(f.path, manifest); f.errors.length = 0;
  assert.equal(await f.invoke('ship', '--title', `Release ${leakPath()}`), 1);
  assertNoSideEffects(f); assert.match(assertValueFree(f), /title: line 1 home-path/);
});

test('ship dry run with a leak fails with no side effects', async t => {
  const f = await readyToShip(t), summary = join(f.root, 'summary.md'), before = await readFile(f.path, 'utf8');
  await writeFile(summary, `See ${leakPath()}\n`);
  assert.equal(await f.invoke('ship', '--dry-run', '--summary-file', summary), 1);
  assertNoSideEffects(f); assertValueFree(f);
  assert.equal(await readFile(f.path, 'utf8'), before);
});

test('ship sends the in-memory generated bytes, not files a checker rewrote after generation', async t => {
  const f = await readyToShip(t), summary = join(f.root, 'summary.md');
  await writeFile(summary, '## Summary\n\nGenerated.\n');
  await writeFile(join(f.root, 'store/config.json'), JSON.stringify({ checkPr: ['body-check', '{bodyFile}', '{label}'] }));
  const original = f.ctx.run; let generated = '';
  f.ctx.run = async (command, args) => {
    if (command === 'body-check') {
      generated = await readFile(args[0], 'utf8');
      await writeFile(args[0], `rewritten ${leakPath()}\n`); await writeFile(join(args[0], '..', 'pr-notes.md'), `rewritten ${leakPath()}\n`);
      return ok();
    }
    return original(command, args);
  };
  assert.equal(await f.invoke('ship', '--summary-file', summary), 0, f.errors.join('\n'));
  assert.match(generated, /^## Summary\n\nGenerated\.\n\n## Fixed/);
  assert.equal(f.state.trainPR.body, generated);
  assert.doesNotMatch(JSON.stringify(f.state.trainPR), /rewritten|alice/);
  assert.equal(gh(f, 'pr create').length, 1);
  // Raw argv: snapshot body file, forced flags, no free text on argv.
  const create = f.state.raw.find(argv => argv[1] === 'create')!;
  assert.ok(create.some(arg => arg.startsWith('--body-file=')) && !create.includes('--body'));
  assert.ok(create.includes('--label=minor') && create.includes('--head=train/test') && create.includes('--base=main'));
});

test('ship routes create, notes comment and link comment through gh with exact generated text and no direct free text', async t => {
  const f = await readyToShip(t);
  assert.equal(await f.invoke('ship'), 0, f.errors.join('\n'));
  const pr = f.state.trainPR, linkBody = f.state.pr.comments.at(-1).body;
  assert.match(pr.comments[0].body, /^## Folded items\n\n- #7: /); assert.match(pr.comments[0].body, /<!-- pi-train:ship train\/test [0-9a-f]{64} -->\n$/);
  assert.equal(linkBody, `Train PR: #42\n\n<!-- pi-train:train-pr train/test pr=42 -->`);
  // Every free-text write reached gh via the publisher's private body file; none carries --body or --title text on argv.
  const writes = f.state.raw.filter(argv => ['create', 'edit', 'comment'].includes(argv[1]));
  assert.equal(writes.length, 3);
  for (const argv of writes) assert.ok(argv.some(arg => arg.startsWith('--body-file=')) && !argv.some(arg => /^--body(=|$)/.test(arg)));
});

test('ship label-only update sends pr-edit with the unchanged body and the label operations', async t => {
  const f = await readyToShip(t);
  assert.equal(await f.invoke('ship'), 0, f.errors.join('\n'));
  const body = f.state.trainPR.body; f.state.raw.length = 0;
  assert.equal(await f.invoke('ship', '--label', 'major'), 0, f.errors.join('\n'));
  assert.equal(f.state.edits, 1); assert.equal(f.state.trainPR.body, body);
  const edit = f.state.raw.find(argv => argv[1] === 'edit')!;
  assert.ok(edit.includes('--add-label=major') && edit.includes('--remove-label=minor') && edit.some(arg => arg.startsWith('--body-file=')));
  assert.deepEqual(f.state.trainPR.labels, [{ name: 'major' }]);
});

test('ship fails clearly when the created train PR cannot be found afterwards', async t => {
  const f = await readyToShip(t), original = f.ctx.run;
  f.ctx.run = async (command, args) => {
    const result = await original(command, args);
    if (command === 'gh' && args[1] === 'create') f.state.trainPR = null;
    return result;
  };
  assert.equal(await f.invoke('ship'), 2); assert.match(f.errors.join('\n'), /created but not found; rerun ship/);
});

test('ship maps publisher failures to fixed value-free errors', async t => {
  const f = await readyToShip(t), original = f.ctx.run;
  f.ctx.run = async (command, args) => command === 'gh' && args[1] === 'create' ? bad('boom ' + leakPath()) : original(command, args);
  assert.equal(await f.invoke('ship'), 2);
  assert.match(f.errors.join('\n'), /publish: gh-failed/); assertValueFree(f);
});
