import { spawnSync } from 'node:child_process';

export class TrainError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

export function realContext() {
  return {
    cwd: process.cwd(), env: process.env, now: () => new Date().toISOString(),
    out: text => console.log(text), err: text => console.error(text),
    run: (command, args, options) => {
      const result = spawnSync(command, args, { ...options, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      return { status: result.status ?? 2, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' };
    },
  };
}

const quote = value => /^[\w./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function client(ctx, options) {
  async function execute(command, args, { mutate = false, allowFailure = false } = {}) {
    if (mutate && options.dryRun) {
      ctx.out(`would: ${[command, ...args].map(quote).join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    }
    const result = await ctx.run(command, args, { cwd: ctx.cwd, env: ctx.env });
    if (result.status !== 0 && !allowFailure) {
      throw new TrainError(`${command} ${args.join(' ')}: ${result.stderr || result.stdout || 'command failed'}`, 2);
    }
    return result;
  }
  return {
    git: (cwd, args, flags) => execute('git', ['-C', cwd, ...args], flags),
    gh: (repo, args, flags) => execute('gh', [...args, '--repo', repo], flags),
    user: async () => (await execute('gh', ['api', 'user', '--jq', '.login'])).stdout.trim(),
    json: async (repo, args) => JSON.parse((await execute('gh', [...args, '--repo', repo])).stdout),
    repoInfo: async repo => JSON.parse((await execute('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef'])).stdout),
  };
}

export const PR_FIELDS = 'number,state,headRefName,headRefOid,isCrossRepository,author,baseRefName,reviewRequests,latestReviews,body,url,comments,labels';
export const RUN_FIELDS = 'databaseId,status,headBranch,headSha,workflowName,name,event';

export function cancellable(run, branch, train, defaultBranch) {
  return run.headBranch === branch && !['main', defaultBranch, train].includes(branch)
    && run.status !== 'completed' && !/publish|release|deploy/i.test(`${run.workflowName ?? ''} ${run.name ?? ''}`)
    && !['release', 'schedule', 'workflow_dispatch'].includes(run.event);
}

export async function activeRuns(api, manifest, branch, defaultBranch) {
  const runs = await api.json(manifest.repo, ['run', 'list', '--branch', branch, '--limit', '100', '--json', RUN_FIELDS]);
  return runs.filter(run => cancellable(run, branch, manifest.train, defaultBranch));
}

export const isBot = person => person?.type === 'Bot' || /\[bot\]$|^copilot(?:[-\[]|$)|^(?:dependabot|renovate)(?:[-\[]|$)/i.test(person?.login ?? '');

const nonAuthorHuman = (person, author) => !isBot(person) && person?.login !== author;
function requestBlocks(person, author) {
  if (person.__typename === 'Team' || person.slug) return true;
  return nonAuthorHuman(person, author);
}
function changesRequested(review, author) {
  return review.state === 'CHANGES_REQUESTED' && nonAuthorHuman(review.author, author);
}

export function checkReviews(pr) {
  const author = pr.author?.login;
  if ((pr.reviewRequests ?? []).some(person => requestBlocks(person, author))) throw new TrainError('unresolved human or team review request');
  if ((pr.latestReviews ?? []).some(review => changesRequested(review, author))) throw new TrainError('non-author CHANGES_REQUESTED review');
}

export async function defaultBranch(api, repo) {
  return (await api.repoInfo(repo)).defaultBranchRef.name;
}
