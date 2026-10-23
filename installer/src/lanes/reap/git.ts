import type { LanesCtx } from "../ctx.ts";
import type { Lane } from "../config.ts";
export interface GitEvidence { head?: string; dirty?: boolean; merged?: boolean; ahead?: number; error?: string }
export async function gitEvidence(ctx: LanesCtx, lane: Lane, cwd: string): Promise<GitEvidence> {
  const run = (args: string[]) => ctx.run("git", ["--no-optional-locks", "-C", cwd, ...args], { timeoutMs: 4000 });
  const head = await run(["rev-parse", "HEAD"]);
  const status = await run(["status", "--porcelain"]);
  if (head.code || head.timedOut || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim()) || status.code || status.timedOut) return { error: "git HEAD/status unknown" };
  const ahead = await run(["rev-list", "--count", "@{upstream}..HEAD"]);
  const prs = await ctx.run("gh", ["pr", "list", "--repo", lane.repo, "--head", lane.branch, "--state", "merged", "--json", "headRefOid"], { cwd, timeoutMs: 5000 });
  let merged: boolean | undefined;
  if (!prs.code && !prs.timedOut) { try { const rows = JSON.parse(prs.stdout); if (Array.isArray(rows)) merged = rows.some(p => p.headRefOid === head.stdout.trim()); } catch { /* Unknown is never success. */ } }
  return { head: head.stdout.trim(), dirty: Boolean(status.stdout.trim()), merged, ahead: !ahead.code && /^\d+$/.test(ahead.stdout.trim()) ? Number(ahead.stdout) : undefined };
}
