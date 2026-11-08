import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { notesMarker, reviewerNotes } from './train-ship-pr.mjs';
import { scan } from './secret-mask.ts';
import { scanPublication } from './publish-scan.ts';

const sha = ['0123456789abcdef', 'abcdef0123456789', '01234567'].join('');
const branch = 'fix/secret-mask-false-positives';
const evidence = 'Tier 1 passed';

for (const pr of [undefined, 7]) {
  test(`reviewer notes render ${pr ? 'PR' : 'branch'} and SHA as code, not a credential assignment`, () => {
    const manifest = { items: [
      { kind: 'planned', branch: 'fix/not-folded', sha },
      { kind: 'folded', branch, sha, pr, cancelledRuns: [10, 11] },
      { kind: 'folded', branch: 'fix/other', sha },
    ] };
    assert.equal(reviewerNotes(manifest, evidence), `## Folded items\n\n- \`${pr ? '#7' : branch}\` at \`${sha}\`; cancelled runs: 10, 11\n- \`fix/other\` at \`${sha}\`; cancelled runs: none\n\n## Verification\n\n${evidence}\n`);
  });
}

test('secret-like branch names with a 40-hex commit SHA are safe for both scanners', () => {
  const manifest = { train: 'train/test', head: sha, items: [{ kind: 'folded', branch, sha }] };
  const notes = reviewerNotes(manifest, evidence);
  const context = { home: '/srv/operator', repoRoot: '/opt/source/project' };
  // Prove the fixture exercises the false positive, rather than a scanner exemption.
  const oldLine = `- ${branch}: ${sha}; cancelled runs: none`;
  assert.ok(scan(oldLine).count > 0);
  assert.ok(scanPublication(oldLine, context).count > 0);
  const marker = notesMarker(manifest, notes);
  const hash = createHash('sha256').update(`${sha}\n${notes}`).digest('hex');
  assert.equal(marker, `<!-- pi-train:ship train/test ${hash} -->`);
  const comment = `${notes}\n${marker}\n`;
  assert.equal(scan(comment).count, 0);
  assert.equal(scanPublication(comment, context).count, 0);
});
