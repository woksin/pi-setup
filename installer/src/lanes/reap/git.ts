import type { LanesCtx } from "../ctx.ts";
import type { Lane } from "../config.ts";
export interface GitEvidence { head?: string; dirty?: boolean; merged?: boolean; ahead?: number; error?: string }
type Probe = Awaited<ReturnType<LanesCtx["run"]>>;
function succeeded(probe: Probe): boolean { return !probe.code && !probe.timedOut; }
function validHead(head: Probe): boolean { return succeeded(head) && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()); }
function aheadCount(ahead: Probe): number | undefined {
  return !ahead.code && /^\d+$/.test(ahead.stdout.trim()) ? Number(ahead.stdout) : undefined;
}
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
  const status = await run(["status", "--porcelain"]);
  if (!validHead(head) || !succeeded(status)) return { error: "git HEAD/status unknown" };
  const ahead = await run(["rev-list", "--count", "@{upstream}..HEAD"]);
  const prs = await ctx.run("gh", [
    "pr", "list", "--repo", lane.repo, "--head", lane.branch, "--state", "merged", "--json", "headRefOid",
  ], { cwd, timeoutMs: 5000 });
  return {
    head: head.stdout.trim(), dirty: Boolean(status.stdout.trim()),
    merged: mergedAtHead(prs, head.stdout.trim()), ahead: aheadCount(ahead),
  };
}
