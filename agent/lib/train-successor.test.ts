import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { adoptCommand } from './train-successor.mjs';

const argv = (command: string) =>
  JSON.parse(execFileSync('sh', ['-c', `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${command.replace(/^pi-train /, '')}`], { encoding: 'utf8' }));

test('adopt command leaves plain arguments bare', () => {
  assert.equal(adoptCommand({ dir: '/work/repo', branch: 'cand/next', base: 'origin/main' }),
    'pi-train init --adopt /work/repo cand/next --base origin/main');
});

test('adopt command quotes spaces, apostrophes and shell metacharacters so the shell sees each argument once', () => {
  const candidate = { dir: "/tmp/my repo/it's", branch: 'cand/a;$(x)`y`&b', base: 'origin/main' };
  assert.deepEqual(argv(adoptCommand(candidate)), ['init', '--adopt', candidate.dir, candidate.branch, '--base', 'origin/main']);
});
