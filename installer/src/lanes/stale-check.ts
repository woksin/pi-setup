import type { LanesCtx } from "./ctx.ts";

interface ChangedFile { filename: string; previous_filename?: string }
interface Compare { merge_base_commit: { sha: string }; base_commit: { sha: string }; files: ChangedFile[] }
interface Budget { remaining: number }
export interface GreenRef { repo: string; pr: { number: number; headRefOid?: string } }
interface CheckRun { head_sha: string; status: string; conclusion: string }
const completedCheck = (check: CheckRun) => check.status === "completed" && ["success", "skipped", "neutral"].includes(check.conclusion);
function usableChecks(checks: { check_runs: CheckRun[]; total_count: number }, head: string): boolean {
  if (!checks.check_runs.length) return false;
  if (checks.total_count > checks.check_runs.length) return false;
  return checks.check_runs.every(completedCheck) && checks.check_runs.every((check) => check.head_sha === head);
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);

async function api<T>(ctx: LanesCtx, path: string, budget: Budget): Promise<T> {
  if (budget.remaining-- <= 0) throw new Error("API budget exhausted");
  const r = await ctx.run("gh", ["api", path], { timeoutMs: 5000 });
  if (r.code !== 0 || r.timedOut) throw new Error("API unavailable");
  return JSON.parse(r.stdout) as T;
}

async function ciHead({ repo, pr }: GreenRef, ctx: LanesCtx, budget: Budget): Promise<string> {
  if (!sha(pr.headRefOid)) throw new Error("missing CI head");
  const checks = await api<{ check_runs: CheckRun[]; total_count: number }>(ctx, `repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`, budget);
  if (!usableChecks(checks, pr.headRefOid)) throw new Error("incomplete CI evidence");
  return pr.headRefOid;
}

async function comparisonBase(repo: string, head: string, ctx: LanesCtx, budget: Budget): Promise<Compare> {
  const comparison = await api<Compare>(ctx, `repos/${repo}/compare/main...${head}`, budget);
  if (!sha(comparison.merge_base_commit.sha)) throw new Error("missing merge base");
  if (!sha(comparison.base_commit.sha)) throw new Error("missing main head");
  return comparison;
}
const fileNames = (file: ChangedFile) => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename];

async function overlapCount({ repo, pr }: GreenRef, comparison: Compare, ctx: LanesCtx, budget: Budget): Promise<number> {
  const files = await api<ChangedFile[]>(ctx, `repos/${repo}/pulls/${pr.number}/files?per_page=100`, budget);
  if (files.length >= 100) throw new Error("PR files truncated");
  const paths = new Set(files.flatMap(fileNames));
  const main = await api<Compare>(ctx, `repos/${repo}/compare/${comparison.merge_base_commit.sha}...${comparison.base_commit.sha}`, budget);
  if (!Array.isArray(main.files)) throw new Error("missing main files");
  if (main.files.length >= 300) throw new Error("main files truncated");
  return main.files.filter((f) => fileNames(f).some((path) => paths.has(path))).length;
}

function freshnessNotice(overlap: number, head: string): string {
  const evidence = `CI head ${head.slice(0, 12)}`;
  return overlap ? `stale: main changed ${overlap} overlapping files since CI (${evidence}); merge main + rerun CI + review before merging`
    : `fresh: no overlapping main changes since CI (${evidence})`;
}

/** Bounded, read-only checks. Incomplete pages, moved heads or missing CI evidence are unknown, never fresh. */
async function staleness({ repo, pr }: GreenRef, ctx: LanesCtx, budget: Budget): Promise<string> {
  try {
    const ref = { repo, pr };
    const head = await ciHead(ref, ctx, budget);
    const comparison = await comparisonBase(repo, head, ctx, budget);
    const overlap = await overlapCount(ref, comparison, ctx, budget);
    const current = await api<{ head: { sha: string } }>(ctx, `repos/${repo}/pulls/${pr.number}`, budget);
    if (current.head.sha !== head) throw new Error("PR moved during comparison");
    return freshnessNotice(overlap, head);
  } catch { return "staleness unknown: CI/main comparison unavailable or incomplete; verify before merging"; }
}

export async function annotatedRefs(refs: string[], details: Map<string, GreenRef>, ctx: LanesCtx): Promise<string> {
  const budget = { remaining: 20 }; // At most four complete comparisons per invocation, including a head recheck.
  const lines: string[] = [];
  for (const ref of refs) lines.push(`${ref} — ${await staleness(details.get(ref)!, ctx, budget)}`);
  return lines.join("\n");
}
