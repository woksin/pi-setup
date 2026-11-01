import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, collectData, HELP, normalizeJob, parseOptions, percentile, renderReport } from './ci-feedback.mjs';

const START = '2026-10-01T00:00:00.000Z';
const END = '2026-10-15T00:00:00.000Z';
const stamp = minute => new Date(Date.parse(START) + minute * 60000).toISOString();
const options = (extra = {}) => ({ repo: 'example/repo', since: START, until: END, limit: 300, signalPattern: 'build|spec|test', ...extra });
const run = (id = 1, extra = {}) => ({
  id, name: 'Build', head_sha: 'abc123', created_at: START, run_attempt: 1,
  event: 'pull_request', status: 'completed', conclusion: 'success', pull_requests: [{ number: 42 }], ...extra,
});
const job = (id = 1, extra = {}) => ({
  id, name: 'build', status: 'completed', conclusion: 'success', started_at: stamp(1), completed_at: stamp(5), ...extra,
});
const record = (workflow = run(), jobs = [job()], attempt = 1) => ({ run: workflow, jobs, attempt });
const report = (records, extra = {}) => analyze({ records, fetchedRuns: new Set(records.map(r => r.run.id)).size, totalRuns: 2, truncated: false }, options(extra));
const memoryCache = () => {
  const saved = new Map();
  return { saved, read: (id, attempt) => saved.get(`${id}-${attempt}`), write: (id, attempt, jobs) => saved.set(`${id}-${attempt}`, jobs) };
};

test('options have bounded defaults and resolve lookback relative to until', () => {
  const parsed = parseOptions(['example/repo'], new Date(END));
  assert.equal(parsed.limit, 300);
  assert.equal(parsed.until, END);
  assert.equal(parsed.since, '2026-09-15T00:00:00.000Z');
  const explicit = parseOptions(['example/repo', '--days', '7', '--until', '2026-10-15', '--json']);
  assert.equal(explicit.since, '2026-10-08T00:00:00.000Z');
  assert.equal(explicit.json, true);
});

test('options accept explicit windows, signal heuristic and a comparison date', () => {
  const parsed = parseOptions(['example/repo', '--since', '2026-10-01', '--until', '2026-10-15',
    '--compare', '2026-10-08', '--signal-pattern', 'compile|unit', '--limit', '40']);
  assert.equal(parsed.since, START);
  assert.equal(parsed.compare, stamp(7 * 1440));
  assert.equal(parsed.signalPattern, 'compile|unit');
  assert.equal(parsed.limit, 40);
});

test('options reject invalid inputs before any I/O', () => {
  for (const args of [[], ['bad'], ['example/repo', '--unknown'], ['example/repo', '--days'],
    ['example/repo', '--days', '0'], ['example/repo', '--limit', '1.5'], ['example/repo', '--limit', '1001'],
    ['example/repo', '--since', 'yesterday'], ['example/repo', '--signal-pattern', '['],
    ['example/repo', '--compare', '2027-01-01'], ['example/repo', '--since', '2027-01-01']]) {
    assert.throws(() => parseOptions(args, new Date(END)), undefined, args.join(' '));
  }
  assert.match(HELP, /Exit codes:/);
});

test('nearest rank percentiles exclude unknown values but preserve zero', () => {
  assert.equal(percentile([9, 1, null, 0, NaN, 2], 0.5), 1);
  assert.equal(percentile([9, 1, 0, 2], 0.9), 9);
  assert.equal(percentile([], 0.9), null);
  assert.equal(percentile([null], 0.5), null);
});

test('PR SHA combines workflows, uses first run creation and reports parallel job-minutes', () => {
  const result = report([
    record(run(), [job(), job(2, { name: 'lint', started_at: stamp(0), completed_at: stamp(2) })]),
    record(run(2, { name: 'Specs', created_at: stamp(2) }), [job(3, { name: 'specs', started_at: stamp(3), completed_at: stamp(8) })]),
  ]);
  assert.equal(result.pullRequests.length, 1);
  const pr = result.pullRequests[0];
  assert.deepEqual(pr.pullRequests, [42]);
  assert.equal(pr.firstFailureMinutes, null);
  assert.equal(pr.firstSignalMinutes, 5);
  assert.equal(pr.allGreenMinutes, 8);
  assert.equal(pr.jobMinutes, 11);
  assert.equal(pr.jobs[2].queueMinutes, 1);
  assert.equal(result.jobMinutes, 11);
  assert.equal(result.events.find(e => e.event === 'pull_request').jobMinutesPerWeek, 5.5);
});

test('reruns retain the first failure and all execution cost, but latest attempt can become green', () => {
  const workflow = run(1, { run_attempt: 2 });
  const result = report([
    record(workflow, [job(1, { conclusion: 'failure' })], 1),
    record(workflow, [job(2, { started_at: stamp(10), completed_at: stamp(14) })], 2),
  ]);
  const pr = result.pullRequests[0];
  assert.equal(pr.firstFailureMinutes, 5);
  assert.equal(pr.firstSignalMinutes, 5);
  assert.equal(pr.allGreenMinutes, 14);
  assert.equal(pr.jobMinutes, 8);
  assert.equal(pr.rerunAttempts, 1);
  assert.equal(pr.outcomes.failed, 1);
  assert.equal(pr.latestOutcomes.failed, 0);
  assert.equal(pr.jobs[1].queueMinutes, 10, 'queue baseline is run creation even for reruns');
  assert.equal(result.rerunAttempts, 1);
});

test('latest failed, cancelled, neutral, pending or missing jobs cannot look green', () => {
  for (const conclusion of ['failure', 'cancelled', 'neutral', 'timed_out']) {
    const result = report([record(run(1, { conclusion }), [job(1, { conclusion })])]);
    assert.equal(result.pullRequests[0].allGreenMinutes, null, conclusion);
  }
  const pending = report([record(run(1, { status: 'in_progress', conclusion: null }), [job(1, { status: 'in_progress', completed_at: null, conclusion: null })])]);
  assert.equal(pending.pullRequests[0].allGreenMinutes, null);
  assert.equal(pending.pullRequests[0].jobMinutes, 0);
  assert.equal(pending.outcomes.pending, 1);
  const missing = report([record(run(), [])]);
  assert.equal(missing.pullRequests[0].allGreenMinutes, null);
  assert.equal(missing.pullRequests[0].missingJobRuns, 1);
});

test('skipped, cancelled and failed jobs are distinct; skipped/cancelled jobs are not build signals', () => {
  const result = report([record(run(1, { conclusion: 'failure' }), [
    job(1, { name: 'build routed', conclusion: 'skipped', started_at: null, completed_at: null }),
    job(2, { name: 'specs old', conclusion: 'cancelled', started_at: null, completed_at: stamp(2) }),
    job(3, { name: 'specs actual', conclusion: 'timed_out', completed_at: stamp(7) }),
  ])]);
  assert.deepEqual(result.outcomes, { success: 0, skipped: 1, cancelled: 1, failed: 1, pending: 0, other: 0 });
  assert.equal(result.pullRequests[0].firstSignalMinutes, 7);
  assert.equal(result.pullRequests[0].firstFailureMinutes, 7);
  assert.equal(result.jobMinutes, 6);
});

test('successful plus skipped jobs are green without inventing skipped durations', () => {
  const result = report([record(run(), [job(), job(2, { conclusion: 'skipped', started_at: null, completed_at: null })])]);
  assert.equal(result.pullRequests[0].allGreenMinutes, 5);
  assert.equal(result.pullRequests[0].jobs[1].durationMinutes, null);
});

test('signal pattern is case insensitive and overridable', () => {
  const result = report([record(run(), [job(1, { name: 'lint' }), job(2, { name: 'Compile', completed_at: stamp(8) })])], { signalPattern: 'compile' });
  assert.equal(result.pullRequests[0].firstSignalMinutes, 8);
});

test('missing timestamps on executed completed jobs fail explicitly', () => {
  assert.throws(() => normalizeJob(job(1, { started_at: null }), run(), 1), /required field job 1.started_at/);
  const queued = normalizeJob(job(1, { status: 'queued', started_at: null, completed_at: null, conclusion: null }), run(), 1);
  assert.equal(queued.queueMinutes, null);
  assert.equal(queued.durationMinutes, null);
  assert.equal(normalizeJob(job(1, { started_at: stamp(-1) }), run(), 1).queueMinutes, null);
});

test('workflow and job percentiles retain separate workflow identities and include failed durations', () => {
  const result = report([
    record(run(), [job()]),
    record(run(2, { name: 'Build', head_sha: 'other', conclusion: 'failure' }), [job(2, { started_at: stamp(2), completed_at: stamp(12), conclusion: 'failure' })]),
    record(run(3, { name: 'Release', event: 'push' }), [job(3, { started_at: stamp(3), completed_at: stamp(6) })]),
  ]);
  const workflow = result.workflows.find(w => w.name === 'Build');
  assert.deepEqual(workflow.durationMinutes, { samples: 2, p50: 5, p90: 12 });
  assert.deepEqual(workflow.queueMinutes, { samples: 2, p50: 1, p90: 2 });
  const buildJob = result.jobs.find(j => j.workflow === 'Build');
  assert.deepEqual(buildJob.durationMinutes, { samples: 2, p50: 4, p90: 10 });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobDetails.length, 3, 'JSON includes queue time for non-PR jobs too');
  assert.equal(result.pullRequests.length, 2);
});

test('all requested event buckets are present, release and dispatch combine', () => {
  const records = ['pull_request', 'push', 'schedule', 'release', 'workflow_dispatch', 'workflow_run']
    .map((event, index) => record(run(index + 1, { event }), [job(index + 1)]));
  const result = report(records);
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.events.find(e => e.event === 'release/workflow_dispatch').jobMinutes, 8);
  assert.equal(result.events.find(e => e.event === 'schedule').jobMinutesPerWeek, 2);
  assert.equal(result.events.find(e => e.event === 'workflow_run').jobMinutes, 4);
});

test('empty windows have no invented percentiles and zero event rates', () => {
  const result = report([]);
  assert.equal(result.feedback.allGreenMinutes.p50, null);
  assert.equal(result.pullRequests.length, 0);
  assert.ok(result.events.every(e => e.jobMinutesPerWeek === 0));
  assert.match(renderReport(result), /0 runs; 0 PR head SHAs/);
});

test('comparison splits complete SHA cohorts and computes after-minus-before deltas', () => {
  const split = stamp(7 * 1440);
  const afterStart = stamp(8 * 1440);
  const result = report([
    record(run(), [job()]),
    record(run(2, { head_sha: 'new', created_at: afterStart }), [job(2, { started_at: stamp(8 * 1440 + 2), completed_at: stamp(8 * 1440 + 12) })]),
  ], { compare: split });
  assert.equal(result.comparison.before.runs, 1);
  assert.equal(result.comparison.after.runs, 1);
  assert.equal(result.comparison.deltas.feedback.allGreenMinutes.p50, 7);
  assert.equal(result.comparison.deltas.jobs[0].queueMinutes.p90, 1);
  assert.equal(result.comparison.deltas.jobs[0].durationMinutes.p90, 6);
  assert.equal(result.comparison.deltas.events.find(e => e.name === 'pull_request').jobMinutesPerWeek, 6);
  assert.match(renderReport(result), /deltas = after - before/);
});

test('comparison preserves cross-boundary PR workflows but dates non-PR runs individually', () => {
  const result = report([
    record(run(), [job()]),
    record(run(2, { name: 'Specs', created_at: stamp(8 * 1440) }), [job(2, { started_at: stamp(8 * 1440 + 1), completed_at: stamp(8 * 1440 + 5) })]),
    record(run(3, { event: 'push', created_at: stamp(9 * 1440) }), [job(3, { started_at: stamp(9 * 1440 + 1), completed_at: stamp(9 * 1440 + 5) })]),
  ], { compare: stamp(7 * 1440) });
  assert.equal(result.comparison.before.runs, 2);
  assert.equal(result.comparison.before.pullRequests[0].allGreenMinutes, 8 * 1440 + 5);
  assert.equal(result.comparison.after.runs, 1);
  assert.equal(result.comparison.after.pullRequests.length, 0);
  assert.equal(result.comparison.deltas.workflows.find(w => w.name === 'Specs').allGreenMinutes.p50, null);
});

test('window is half-open and render discloses truncation and unknown routing', () => {
  const result = analyze({ records: [record(run()), record(run(2, { created_at: END }))], fetchedRuns: 2, totalRuns: 30, truncated: true }, options());
  assert.equal(result.runs, 1);
  assert.match(renderReport(result), /bounded sample \(2\/30 runs\)/);
  assert.match(renderReport(result), /routing reasons unknown/);
  assert.match(renderReport(result), /Skipped is not proof of routing/);
});

test('reader bounds run pagination and uses a stable page size', () => {
  const calls = [];
  const api = endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('/jobs?')) return { jobs: [], total_count: 0 };
    const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
    return { total_count: 500, workflow_runs: Array.from({ length: 100 }, (_, i) => run((page - 1) * 100 + i + 1)) };
  };
  const data = collectData(options({ limit: 101 }), { api, cache: memoryCache() });
  assert.equal(data.fetchedRuns, 101);
  assert.equal(data.records.length, 101);
  assert.equal(data.truncated, true);
  const runCalls = calls.filter(endpoint => !endpoint.includes('/jobs?'));
  assert.equal(runCalls.length, 2);
  assert.ok(runCalls.every(endpoint => endpoint.includes('per_page=100')));
  assert.match(runCalls[1], /page=2/);
});

test('reader paginates jobs for each attempt and caches only completed runs', () => {
  const calls = [];
  const cache = memoryCache();
  const workflow = run(1, { run_attempt: 2 });
  cache.write(1, 1, [job()]);
  const api = endpoint => {
    calls.push(endpoint);
    if (!endpoint.includes('/jobs?')) return { total_count: 1, workflow_runs: [workflow] };
    return endpoint.endsWith('page=1') ? { total_count: 101, jobs: Array.from({ length: 100 }, (_, i) => job(i + 2)) }
      : { total_count: 101, jobs: [job(102)] };
  };
  const data = collectData(options(), { api, cache });
  assert.equal(data.records.length, 2);
  assert.equal(data.records[0].jobs.length, 1);
  assert.equal(data.records[1].jobs.length, 101);
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every(endpoint => endpoint.includes('/attempts/2/jobs?')));
  assert.equal(cache.saved.get('1-2').length, 101);
});

test('active runs neither read nor write persistent job cache', () => {
  const cache = { read: () => assert.fail('active cache read'), write: () => assert.fail('active cache write') };
  const api = endpoint => endpoint.includes('/jobs?') ? { total_count: 1, jobs: [job()] }
    : { total_count: 1, workflow_runs: [run(1, { status: 'in_progress', conclusion: null })] };
  assert.equal(collectData(options(), { api, cache }).records.length, 1);
});

test('reader handles empty repositories and propagates API/auth or required-field failures', () => {
  const cache = memoryCache();
  const empty = collectData(options(), { api: () => ({ total_count: 0, workflow_runs: [] }), cache });
  assert.equal(empty.fetchedRuns, 0);
  assert.equal(empty.truncated, false);
  assert.throws(() => collectData(options(), { api: () => { throw new Error('rate limit'); }, cache }), /rate limit/);
  assert.throws(() => collectData(options(), { api: () => ({ workflow_runs: [] }), cache }), /required field workflow runs response.total_count/);
  assert.throws(() => collectData(options(), { api: () => ({ total_count: 1, workflow_runs: [run(1, { run_attempt: null })] }), cache }), /required field run.run_attempt/);
});

test('reader refuses incomplete job pagination instead of treating a partial list as green', () => {
  const api = endpoint => endpoint.includes('/jobs?') ? { total_count: 1, jobs: [] }
    : { total_count: 1, workflow_runs: [run()] };
  assert.throws(() => collectData(options(), { api, cache: memoryCache() }), /Incomplete jobs response/);
});
