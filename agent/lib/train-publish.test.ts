import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflight, publishText } from './train-publish.mjs';

const manifest = { worktree: '/work/tree' };
const ctx = (extra = {}) => { const out: string[] = []; return { out: (s: string) => out.push(s), output: out, env: { HOME: '/home/fixture' }, ...extra } as any; };
const request = { kind: 'pr-create', repo: 'o/r', title: 'T', body: 'B' };
const leakPath = () => ['', 'Users', 'alice', 'x'].join('/');
const leakToken = () => 'ghp_' + 'a1B2c3D4'.repeat(5);

test('dry run prints only the kind and never sends', async () => {
  let sent = 0; const c = ctx({ publish: async () => { sent++; return { isError: false }; } });
  await publishText(c, { dryRun: true }, { ...request, body: 'private-body', title: 'private-title' }, manifest);
  assert.equal(sent, 0); assert.deepEqual(c.output, ['would publish pr-create']);
});

test('sends the request with the worktree scope', async () => {
  let seen: any;
  const c = ctx({ publish: async (r: unknown, scope: unknown) => { seen = { r, scope }; return { isError: false, code: 'published' }; } });
  await publishText(c, {}, request, manifest);
  assert.deepEqual(seen, { r: request, scope: { home: '/home/fixture', repoRoot: '/work/tree', cwd: '/work/tree' } });
});

test('scan-refused becomes a code 1 error built from kinds, lines and counts only', async () => {
  const diagnostics = { source: 'body', count: 2, findings: [{ kind: 'home-path', line: 3 }, { kind: 'token', line: 9 }] };
  const c = ctx({ publish: async () => ({ isError: true, code: 'scan-refused', text: 'publish: scan-refused', diagnostics }) });
  await assert.rejects(publishText(c, {}, request, manifest), (error: any) => {
    assert.equal(error.code, 1);
    assert.equal(error.message, 'publish: scan-refused\nbody: line 3 home-path\nbody: line 9 token\nfindings: 2');
    return true;
  });
});

test('every other publisher failure is a code 2 error with fixed text', async () => {
  for (const code of ['gh-failed', 'gh-unavailable', 'invalid-request', 'cleanup-failed']) {
    const c = ctx({ publish: async () => ({ isError: true, code, text: `publish: ${code} leaked-value` }) });
    await assert.rejects(publishText(c, {}, request, manifest), (error: any) => error.code === 2 && error.message === `publish: ${code}`);
  }
});

test('preflight refuses a home path and a token without echoing either', () => {
  for (const [value, kind] of [[leakPath(), 'home-path'], [leakToken(), '']] as const) {
    assert.throws(() => preflight(ctx(), manifest, { title: 'ok', body: `a\nb ${value}\n` }), (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.message, /^publish: scan-refused\nbody: line 2 [a-z-]+\n/); assert.match(error.message, new RegExp(kind));
      assert.ok(!error.message.includes(value) && !error.message.includes('alice'));
      return true;
    });
  }
  assert.doesNotThrow(() => preflight(ctx(), manifest, { title: 'Release train: #7', body: '## Fixed\n\n- Fix widgets (#7)\n' }));
});
