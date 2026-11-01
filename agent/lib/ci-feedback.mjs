import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY = 86400000;
const DEFAULT_SIGNAL = 'build|spec|test';
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const GREEN = new Set(['success', 'skipped']);

export const HELP = `Usage: ci-feedback OWNER/REPO [options]
Read-only GitHub Actions feedback times and job-minutes (requires authenticated gh).

Options:
  --days N                 Look back N days (default 30)
  --since ISO              Window start instead of --days
  --until ISO              Window end (default now)
  --limit N                Maximum workflow runs, 1-1000 (default 300)
  --signal-pattern REGEX   Build/spec job-name heuristic (default build|spec|test, case-insensitive)
  --compare ISO            Split at this date; report after-minus-before deltas
  --json                   Emit the full report, including per-job queue times
  -h, --help               Show help without network or filesystem writes

Examples:
  ci-feedback Cratis/cli --days 7 --limit 40
  ci-feedback Cratis/cli --since 2026-10-01 --until 2026-11-01 --compare 2026-10-15 --json
  ci-feedback Cratis/cli --signal-pattern 'compile|unit'

Times are minutes. Push time is approximated by the first observed run created_at
for each PR head SHA. Only Actions jobs in the bounded sample are known; absent
checks/routing reasons are unknown. All-green uses the latest attempt of every
observed run. Job-minutes include all fetched attempts, not billing multipliers.
Completed-run jobs are cached in ~/.cache/ci-feedback/ by repository/run/attempt.

Exit codes:
  0 report or help printed
  1 invalid arguments, GitHub API/auth/rate-limit error, or unavailable required fields
See also: gh api --help, docs/reference.md
`;

function isoDate(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${flag} requires an ISO date`);
  }
  return new Date(value).toISOString();
}

function argumentValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function readArguments(args, options) {
  const values = new Map([
    ['--days', 'days'], ['--limit', 'limit'], ['--since', 'since'],
    ['--until', 'until'], ['--compare', 'compare'], ['--signal-pattern', 'signalPattern'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (values.has(arg)) {
      options[values.get(arg)] = argumentValue(args, ++i, arg);
      continue;
    }
    if (!arg.startsWith('-') && !options.repo) {
      options.repo = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

function validateLimits(options) {
  options.days = Number(options.days);
  options.limit = Number(options.limit);
  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days must be positive');
  if (!Number.isInteger(options.limit)) {
    throw new Error('--limit must be an integer from 1 to 1000 (GitHub filtered-run cap)');
  }
  if (options.limit < 1 || options.limit > 1000) {
    throw new Error('--limit must be an integer from 1 to 1000 (GitHub filtered-run cap)');
  }
}

function resolveWindow(options) {
  options.until = isoDate(options.until, '--until');
  options.since = options.since ? isoDate(options.since, '--since')
    : new Date(Date.parse(options.until) - options.days * DAY).toISOString();
  if (options.since >= options.until) throw new Error('--since must precede --until');
  if (options.compare) {
    options.compare = isoDate(options.compare, '--compare');
    if (options.compare <= options.since || options.compare >= options.until) {
      throw new Error('--compare must be inside the window');
    }
  }
}

export function parseOptions(args, now = new Date()) {
  const options = { days: 30, limit: 300, until: now.toISOString(), signalPattern: DEFAULT_SIGNAL, json: false };
  readArguments(args, options);
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo ?? '')) throw new Error('Expected repository OWNER/REPO');
  validateLimits(options);
  resolveWindow(options);
  // Validate before any API calls, including on an empty repository.
  new RegExp(options.signalPattern, 'i');
  return options;
}

function ghApi(endpoint) {
  try {
    return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', endpoint], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    throw new Error(`gh api failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function diskCache(repo) {
  const directory = join(homedir(), '.cache', 'ci-feedback', ...repo.toLowerCase().split('/'));
  const path = (run, attempt) => join(directory, `${run}-${attempt}.json`);
  return {
    read(run, attempt) {
      try {
        const data = JSON.parse(readFileSync(path(run, attempt), 'utf8'));
        return data.version === 1 && Array.isArray(data.jobs) ? data.jobs : null;
      } catch { return null; }
    },
    write(run, attempt, jobs) {
      try {
        mkdirSync(directory, { recursive: true });
        const destination = path(run, attempt);
        const temporary = `${destination}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
        renameSync(temporary, destination);
      } catch (error) { process.stderr.write(`ci-feedback: cache write skipped: ${error.message}\n`); }
    },
  };
}

function requireFields(value, fields, context) {
  for (const field of fields) {
    if (value[field] === undefined || value[field] === null) {
      throw new Error(`Unavailable required field ${context}.${field}`);
    }
  }
}

function jobsForAttempt(run, attempt, { repo, api, cache }) {
  const cached = run.status === 'completed' ? cache.read(run.id, attempt) : null;
  if (cached) return cached;
  const jobs = [];
  let page = 1;
  while (true) {
    const response = api(`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    requireFields(response, ['jobs', 'total_count'], `run ${run.id} jobs response`);
    jobs.push(...response.jobs);
    if (jobs.length >= response.total_count) break;
    if (response.jobs.length === 0) throw new Error(`Incomplete jobs response for run ${run.id}, attempt ${attempt}`);
    page++;
  }
  if (run.status === 'completed') cache.write(run.id, attempt, jobs);
  return jobs;
}

function fetchRuns(options, api) {
  const runs = [];
  // Keep page size fixed: changing it on the last page would repeat/omit runs.
  const size = Math.min(100, options.limit);
  let total = 0;
  for (let page = 1; runs.length < options.limit; page++) {
    const query = new URLSearchParams({ created: `${options.since}..${options.until}`, per_page: String(size), page: String(page) });
    const response = api(`repos/${options.repo}/actions/runs?${query}`);
    requireFields(response, ['workflow_runs', 'total_count'], 'workflow runs response');
    total = response.total_count;
    runs.push(...response.workflow_runs.slice(0, options.limit - runs.length));
    if (response.workflow_runs.length < size || runs.length >= total) break;
  }
  return { runs, total };
}

function runRecords(run, reader) {
  requireFields(run, ['id', 'head_sha', 'created_at', 'run_attempt', 'event', 'status', 'name'], 'run');
  if (run.status === 'completed') requireFields(run, ['conclusion'], `run ${run.id}`);
  return Array.from({ length: run.run_attempt }, (_, index) => {
    const attempt = index + 1;
    return { run, attempt, jobs: jobsForAttempt(run, attempt, reader) };
  });
}

// Dependencies are injectable so pagination, bounds and cache policy can be tested without I/O.
export function collectData(options, { api = ghApi, cache = diskCache(options.repo) } = {}) {
  const { runs, total } = fetchRuns(options, api);
  const reader = { repo: options.repo, api, cache };
  return {
    records: runs.flatMap(run => runRecords(run, reader)),
    fetchedRuns: runs.length, totalRuns: total, truncated: total > runs.length,
  };
}

function time(value) {
  return value ? Date.parse(value) : NaN;
}

function minutes(start, end) {
  const elapsed = (time(end) - time(start)) / 60000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

function distribution(values) {
  return { samples: values.filter(Number.isFinite).length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

function outcome(job) {
  if (job.status !== 'completed') return 'pending';
  if (GREEN.has(job.conclusion)) return job.conclusion;
  if (job.conclusion === 'cancelled') return 'cancelled';
  return FAILED.has(job.conclusion) ? 'failed' : 'other';
}

function counts(jobs) {
  const result = { success: 0, skipped: 0, cancelled: 0, failed: 0, pending: 0, other: 0 };
  for (const job of jobs) result[job.outcome]++;
  return result;
}

export function normalizeJob(job, run, attempt) {
  requireFields(job, ['id', 'name', 'status'], `job in run ${run.id}`);
  // Skipped/queued jobs legitimately have no timestamps; completed executed jobs do not.
  if (job.status === 'completed' && !['skipped', 'cancelled'].includes(job.conclusion)) {
    requireFields(job, ['started_at', 'completed_at', 'conclusion'], `job ${job.id}`);
  }
  return {
    id: job.id, name: job.name, runId: run.id, workflow: run.name, attempt,
    headSha: run.head_sha, event: run.event, status: job.status, conclusion: job.conclusion,
    startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    queueMinutes: minutes(run.created_at, job.started_at),
    durationMinutes: minutes(job.started_at, job.completed_at), outcome: outcome(job),
  };
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return groups;
}

function firstCompletion(jobs, predicate) {
  return jobs.filter(job => predicate(job) && Number.isFinite(time(job.completedAt)))
    .map(job => job.completedAt).sort()[0] ?? null;
}

function latestCompletion(latest, jobs) {
  const completed = jobs.map(job => job.completedAt).filter(value => Number.isFinite(time(value))).sort();
  const isComplete = latest.length > 0
    && latest.every(record => record.run.status === 'completed' && record.jobs.length > 0)
    && jobs.every(job => job.status === 'completed');
  const isGreen = isComplete && latest.every(record => GREEN.has(record.run.conclusion))
    && jobs.every(job => GREEN.has(job.conclusion));
  return { completedAt: isComplete ? completed.at(-1) : null, allGreenAt: isGreen ? completed.at(-1) ?? null : null };
}

function feedback(records, signal) {
  const jobs = records.flatMap(record => record.jobs);
  const latest = records.filter(record => record.attempt === record.run.run_attempt);
  const latestJobs = latest.flatMap(record => record.jobs);
  const pushedAt = records.map(record => record.run.created_at).sort()[0];
  const firstFailureAt = firstCompletion(jobs, job => job.outcome === 'failed');
  const firstSignalAt = firstCompletion(jobs, job => ['success', 'failed'].includes(job.outcome) && signal.test(job.name));
  const { completedAt, allGreenAt } = latestCompletion(latest, latestJobs);
  return {
    pushedAt, firstFailureAt, firstSignalAt, allGreenAt,
    completedMinutes: minutes(pushedAt, completedAt),
    firstFailureMinutes: minutes(pushedAt, firstFailureAt),
    firstSignalMinutes: minutes(pushedAt, firstSignalAt), allGreenMinutes: minutes(pushedAt, allGreenAt),
    jobMinutes: jobs.reduce((sum, job) => sum + (job.durationMinutes ?? 0), 0),
    rerunAttempts: records.filter(record => record.attempt > 1).length,
    missingJobRuns: latest.filter(record => record.jobs.length === 0).length,
    outcomes: counts(jobs), latestOutcomes: counts(latestJobs),
  };
}

function feedbackDistributions(items) {
  return Object.fromEntries(['firstFailureMinutes', 'firstSignalMinutes', 'allGreenMinutes']
    .map(key => [key, distribution(items.map(item => item[key]))]));
}

function workflowMetrics(records, signal) {
  return [...groupBy(records, record => record.run.name)].map(([name, group]) => {
    const perRun = [...groupBy(group, record => record.run.id).values()].map(attempts => feedback(attempts, signal));
    const jobs = group.flatMap(record => record.jobs);
    return {
      name, runs: perRun.length, jobMinutes: jobs.reduce((sum, job) => sum + (job.durationMinutes ?? 0), 0),
      queueMinutes: distribution(jobs.map(job => job.queueMinutes)),
      durationMinutes: distribution(perRun.map(item => item.completedMinutes)),
      ...feedbackDistributions(perRun), outcomes: counts(jobs),
      rerunAttempts: group.filter(record => record.attempt > 1).length,
    };
  });
}

function jobMetrics(jobs) {
  return [...groupBy(jobs, job => JSON.stringify([job.workflow, job.name]))].map(([, group]) => ({
    workflow: group[0].workflow, name: group[0].name, jobs: group.length,
    jobMinutes: group.reduce((sum, job) => sum + (job.durationMinutes ?? 0), 0),
    durationMinutes: distribution(group.map(job => job.durationMinutes)),
    queueMinutes: distribution(group.map(job => job.queueMinutes)), outcomes: counts(group),
  }));
}

function eventMetrics(records, since, until) {
  const weeks = (time(until) - time(since)) / (7 * DAY);
  const eventName = event => ['release', 'workflow_dispatch'].includes(event) ? 'release/workflow_dispatch' : event;
  const groups = groupBy(records, record => eventName(record.run.event));
  for (const event of ['pull_request', 'push', 'schedule', 'release/workflow_dispatch']) {
    if (!groups.has(event)) groups.set(event, []);
  }
  return [...groups].map(([event, group]) => {
    const jobMinutes = group.flatMap(record => record.jobs).reduce((sum, job) => sum + (job.durationMinutes ?? 0), 0);
    return { event, runs: new Set(group.map(record => record.run.id)).size, jobMinutes, jobMinutesPerWeek: jobMinutes / weeks };
  });
}

function summarize(records, options) {
  const signal = new RegExp(options.signalPattern, 'i');
  const prRecords = records.filter(record => record.run.event === 'pull_request' || record.run.event === 'pull_request_target');
  const pullRequests = [...groupBy(prRecords, record => record.run.head_sha)].map(([headSha, group]) => ({
    headSha, pullRequests: [...new Set(group.flatMap(record => (record.run.pull_requests ?? []).map(pr => pr.number)))],
    ...feedback(group, signal), jobs: group.flatMap(record => record.jobs),
  }));
  const jobs = records.flatMap(record => record.jobs);
  return {
    since: options.since, until: options.until, runs: new Set(records.map(record => record.run.id)).size,
    pullRequests, feedback: feedbackDistributions(pullRequests), outcomes: counts(jobs),
    jobMinutes: jobs.reduce((sum, job) => sum + (job.durationMinutes ?? 0), 0),
    rerunAttempts: records.filter(record => record.attempt > 1).length,
    workflows: workflowMetrics(records, signal), jobs: jobMetrics(jobs), jobDetails: jobs,
    events: eventMetrics(records, options.since, options.until),
  };
}

function difference(before, after) {
  return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
}

function metricDeltas(before, after) {
  const result = { jobMinutes: difference(before.jobMinutes, after.jobMinutes) };
  for (const key of ['durationMinutes', 'queueMinutes', 'firstFailureMinutes', 'firstSignalMinutes', 'allGreenMinutes']) {
    if (before[key] || after[key]) {
      result[key] = Object.fromEntries(['p50', 'p90'].map(p => [p, difference(before[key]?.[p], after[key]?.[p])]));
    }
  }
  return result;
}

export function compareSummaries(before, after) {
  const match = (oldItems, newItems, key, delta) => {
    const oldMap = new Map(oldItems.map(item => [key(item), item]));
    const newMap = new Map(newItems.map(item => [key(item), item]));
    return [...new Set([...oldMap.keys(), ...newMap.keys()])].map(name => ({
      name, ...delta(oldMap.get(name) ?? {}, newMap.get(name) ?? {}),
    }));
  };
  return {
    jobMinutes: difference(before.jobMinutes, after.jobMinutes),
    feedback: metricDeltas(before.feedback, after.feedback),
    workflows: match(before.workflows, after.workflows, item => item.name, metricDeltas),
    jobs: match(before.jobs, after.jobs, item => `${item.workflow} / ${item.name}`, metricDeltas),
    events: match(before.events, after.events, item => item.event, (old, current) => ({
      jobMinutesPerWeek: difference(old.jobMinutesPerWeek, current.jobMinutesPerWeek),
    })),
  };
}

export function analyze(data, options) {
  const records = data.records.filter(({ run }) => run.created_at >= options.since && run.created_at < options.until)
    .map(record => ({ ...record, jobs: record.jobs.map(job => normalizeJob(job, record.run, record.attempt)) }));
  const report = { repository: options.repo, signalPattern: options.signalPattern,
    sample: { fetchedRuns: data.fetchedRuns, totalRuns: data.totalRuns, truncated: data.truncated },
    ...summarize(records, options) };
  if (options.compare) {
    // Assign an entire SHA's PR runs to its first-observed side, avoiding split feedback chains.
    const isPR = run => ['pull_request', 'pull_request_target'].includes(run.event);
    const starts = new Map();
    for (const { run } of records.filter(record => isPR(record.run))) {
      if (!starts.has(run.head_sha) || run.created_at < starts.get(run.head_sha)) starts.set(run.head_sha, run.created_at);
    }
    const cohortStart = run => isPR(run) ? starts.get(run.head_sha) : run.created_at;
    const before = records.filter(({ run }) => cohortStart(run) < options.compare);
    const after = records.filter(({ run }) => cohortStart(run) >= options.compare);
    report.comparison = {
      split: options.compare,
      before: summarize(before, { ...options, until: options.compare }),
      after: summarize(after, { ...options, since: options.compare }),
    };
    report.comparison.deltas = compareSummaries(report.comparison.before, report.comparison.after);
  }
  return report;
}

const number = value => Number.isFinite(value) ? value.toFixed(2) : '-';
const pair = value => `${number(value?.p50)}/${number(value?.p90)}`;

function table(headers, rows) {
  const clean = value => String(value).replace(/[\r\n\t\x1b]/g, ' ');
  const all = [headers, ...rows].map(row => row.map(clean));
  const widths = headers.map((_, index) => Math.max(...all.map(row => row[index].length)));
  return all.map(row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()).join('\n');
}

function comparisonTables(comparison) {
  const delta = comparison.deltas;
  const sections = [`Compare ${comparison.split}: before ${comparison.before.runs} runs, after ${comparison.after.runs} runs; deltas = after - before`,
    table(['PR feedback delta (min)', 'p50/p90'], ['firstFailureMinutes', 'firstSignalMinutes', 'allGreenMinutes']
      .map(key => [key, pair(delta.feedback[key])])),
    table(['Event delta', 'job-min/week'], delta.events.map(item => [item.name, number(item.jobMinutesPerWeek)]))];
  for (const [title, items] of [['Workflow delta', delta.workflows], ['Job delta', delta.jobs]]) {
    sections.push(table([title, 'duration p50/p90', 'queue p50/p90', 'failure p50/p90', 'signal p50/p90', 'green p50/p90'],
      items.map(item => [item.name, ...['durationMinutes', 'queueMinutes', 'firstFailureMinutes', 'firstSignalMinutes', 'allGreenMinutes'].map(key => pair(item[key]))])));
  }
  return sections.join('\n\n');
}

export function renderReport(report) {
  const o = report.outcomes;
  const sections = [
    `${report.repository} | ${report.since} .. ${report.until}`,
    `${report.runs} runs; ${report.pullRequests.length} PR head SHAs; ${number(report.jobMinutes)} job-min; ${report.rerunAttempts} rerun attempts`,
    `Jobs: ${o.success} success, ${o.skipped} skipped, ${o.cancelled} cancelled, ${o.failed} failed, ${o.pending} pending, ${o.other} other`,
    table(['PR head SHA', 'fail min', 'signal min', 'green min', 'job-min', 'reruns', 'skip/cancel/fail', 'missing runs'],
      report.pullRequests.map(pr => [pr.headSha.slice(0, 12), number(pr.firstFailureMinutes), number(pr.firstSignalMinutes), number(pr.allGreenMinutes),
        number(pr.jobMinutes), pr.rerunAttempts, `${pr.outcomes.skipped}/${pr.outcomes.cancelled}/${pr.outcomes.failed}`, pr.missingJobRuns])),
    table(['Workflow', 'runs', 'green p50/p90', 'failure p50/p90', 'signal p50/p90', 'queue p50/p90', 'job-min'],
      report.workflows.map(w => [w.name, w.runs, pair(w.allGreenMinutes), pair(w.firstFailureMinutes), pair(w.firstSignalMinutes), pair(w.queueMinutes), number(w.jobMinutes)])),
    table(['Workflow / job', 'n', 'duration p50/p90', 'queue p50/p90'],
      report.jobs.map(job => [`${job.workflow} / ${job.name}`, job.jobs, pair(job.durationMinutes), pair(job.queueMinutes)])),
    table(['Event', 'runs', 'job-min', 'job-min/week'], report.events.map(event => [event.event, event.runs, number(event.jobMinutes), number(event.jobMinutesPerWeek)])),
  ];
  if (report.comparison) sections.push(comparisonTables(report.comparison));
  sections.push('Minutes; p50/p90 = nearest rank; - = unavailable. Queue = job start minus run creation (includes rerun delay).',
    'Push = first observed run creation, not git push. All-green covers observed Actions runs only; missing checks/routing reasons unknown.',
    'Signal = first executed completed build/spec/test job (not skipped/cancelled). Skipped is not proof of routing.',
    'Job-minutes include all attempts; unfinished jobs have unknown duration. Completed-run jobs are cached.');
  if (report.sample.truncated) sections.push(`WARNING: bounded sample (${report.sample.fetchedRuns}/${report.sample.totalRuns} runs); weekly rates are sampled lower bounds.`);
  return sections.join('\n\n') + '\n';
}

export async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const options = parseOptions(args);
    const report = analyze(collectData(options), options);
    process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : renderReport(report));
    return 0;
  } catch (error) {
    process.stderr.write(`ci-feedback: ${error.message}\n`);
    return 1;
  }
}
