import type { LanesCtx } from "../ctx.ts";
import type { Lane } from "../config.ts";
import { changedPaths, commitList, treeDigest } from "./tree.ts";
export interface GitEvidence {
  head?: string; dirty?: boolean; merged?: boolean; ahead?: number; error?: string;
  status?: string; paths?: string[]; unpushed?: string[]; digest?: string;
}
type Probe = Awaited<ReturnType<LanesCtx["run"]>>;
function succeeded(probe: Probe): boolean { return !probe.code && !probe.timedOut; }
function validHead(head: Probe): boolean { return succeeded(head) && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()); }
function mergedAtHead(prs: Probe, head: string): boolean | undefined {
  if (!succeeded(prs)) return undefined;
  try {
    const rows = JSON.parse(prs.stdout);
    if (Array.isArray(rows)) return rows.some(p => p.headRefOid === head);
  } catch { /* Unknown is never success. */ }
  return undefined;
}
export async function gitEvidence(ctx: LanesCtx, lane: Lane, cwd: string): Promise<GitEvidence> {
  const run = (args: string[]) => ctx.run("git", ["--no-optional-locks", "-C", cwd, ...args], { timeoutMs: 4000 });
  const head = await run(["rev-parse", "HEAD"]);
  const status = await run(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (!validHead(head) || !succeeded(status)) return { error: "git HEAD/status unknown" };
  const ahead = await run(["rev-list", "HEAD", "--not", "--remotes"]);
  const diff = await run(["diff", "--binary", "HEAD"]);
  if (!succeeded(ahead) || !succeeded(diff)) return { error: "git unpushed/tree evidence unknown" };
  const unpushed = commitList(ahead.stdout); const paths = changedPaths(status.stdout);
  const digest = treeDigest({ cwd, paths, status: status.stdout, diff: diff.stdout });
  const prs = await ctx.run("gh", [
    "pr", "list", "--repo", lane.repo, "--head", lane.branch, "--state", "merged", "--json", "headRefOid",
  ], { cwd, timeoutMs: 5000 });
  return {
    head: head.stdout.trim(), dirty: Boolean(status.stdout.trim()),
    merged: mergedAtHead(prs, head.stdout.trim()), ahead: unpushed.length,
    status: status.stdout, paths, unpushed, digest,
  };
}
