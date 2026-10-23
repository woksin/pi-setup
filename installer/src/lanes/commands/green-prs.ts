import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
interface PullRequest { number: number; isDraft: boolean; labels: { name: string }[]; statusCheckRollup: { conclusion?: string; state?: string }[] }
function green(pr: PullRequest, excluded: string[]): boolean {
  return !pr.isDraft && !pr.labels.some((l) => excluded.includes(l.name)) && pr.statusCheckRollup.length > 0
    && pr.statusCheckRollup.every((s) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(s.conclusion ?? s.state ?? ""));
}
export async function greenPrs(opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (opts.new && opts.ack) throw new UsageError("--new and --ack are mutually exclusive");
  const repos = c.github?.repos.length ? c.github.repos : [...new Set([...c.lanes.map((l) => l.repo), ...Object.keys(c.repos)])];
  if (!repos.length) { ctx.err("no repositories configured (lanes.json github.repos)"); return 1; }
  if (!ctx.which("gh")) { ctx.err("gh not found"); return 2; }
  const refs: string[] = [];
  for (const repo of repos) {
    const r = await ctx.run("gh", ["pr", "list", "--repo", repo, "--author", c.github?.author || "@me", "--state", "open", "--limit", "100", "--json", "number,isDraft,labels,statusCheckRollup"], { timeoutMs: 30000 });
    if (r.code !== 0 || r.timedOut) { ctx.err(`gh pr list failed for ${repo}: ${r.stderr.trim()}`); return 2; }
    try {
      const prs: PullRequest[] = JSON.parse(r.stdout);
      refs.push(...prs.filter((p) => green(p, c.github?.excludeLabels || [])).map((p) => `${repo}#${p.number}`));
    } catch { ctx.err(`invalid gh pr list response for ${repo}`); return 2; }
  }
  refs.sort();
  const ack = join(root, ".state/green-ack");
  if (opts.ack) {
    mkdirSync(join(root, ".state"), { recursive: true }); writeFileSync(ack, refs.length ? `${refs.join("\n")}\n` : "");
    ctx.out(`acked ${refs.length}`); return 0;
  }
  const previous = opts.new && existsSync(ack) ? readFileSync(ack, "utf8").split(/\r?\n/) : [];
  const output = opts.new ? refs.filter((r) => !previous.includes(r)) : refs;
  if (output.length) ctx.out(output.join("\n"));
  return opts.new && !output.length ? 1 : 0;
}
