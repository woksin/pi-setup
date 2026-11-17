// Portable corpus drift check, also loaded by skills.test.mjs in the release gate.
// Uses a pinned fixture rather than skipping when a Cratis/AI checkout is absent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const agents = read('../agent/AGENTS.md');
const block = agents.match(/<!-- pi-setup:codescene:start -->\n([\s\S]*?)\n<!-- pi-setup:codescene:end -->/)?.[1];
const corpus = read('../tools/fixtures/cratis-code-health.md');
const unique = values => [...new Set(values)].sort();
const floors = text => unique(text.match(/\b\d+\.\d+\b/g) ?? []);
const ruleNames = text => unique([...text.matchAll(/`([^`\n]+)`/g)]
  .map(match => match[1]).filter(name => /code_health|analyze_change_set|guiding-refactoring-with-code-health/.test(name)));

function assertMirror(personal, canonical) {
  assert.equal(typeof personal, 'string', 'managed CodeScene block must exist');
  assert.deepEqual(floors(canonical), ['9.5'], 'review changes to the corpus floor explicitly');
  assert.deepEqual(floors(personal), floors(canonical), 'Code Health floors drifted');
  assert.ok(ruleNames(canonical).length > 0, 'corpus rule names must exist');
  assert.deepEqual(ruleNames(personal), ruleNames(canonical), 'Code Health rule names drifted');
  assert.ok(personal.includes('**No fix loops.**'), 'personal no-fix-loops rule must exist');
  assert.ok(canonical.includes('## No fix loops'), 'corpus no-fix-loops rule must exist');
}

test('managed CodeScene block mirrors the pinned corpus floor and rule names', () => {
  assertMirror(block, corpus);
  assert.ok(block.includes('mirrors Cratis AI `.cratis/ai/rules/code-health.md`'));
});

test('drift check catches threshold and rule-name changes on either side', () => {
  const changes = [
    [block.replaceAll('9.5', '9.4'), corpus],
    [block, corpus.replaceAll('9.5', '9.6')],
    [block.replaceAll('code_health_review', 'code_health_other'), corpus],
    [block, corpus.replaceAll('code_health_review', 'code_health_other')],
    [undefined, corpus],
  ];
  for (const [personal, canonical] of changes) assert.throws(() => assertMirror(personal, canonical));
});
