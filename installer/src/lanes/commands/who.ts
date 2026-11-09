import type { Config } from "../config.ts";
import { UsageError } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { parseIssue, type Source } from "../issue-register.ts";
import { buildRoster, filterRows, indexRosterRegistry, readRoster, suggestTarget, type RosterRow } from "../roster.ts";

function humanRow(row: RosterRow): string {
  const issue = row.issue ? `#${row.issue.number}` : "-";
  const notes = row.notes.length ? `; ${row.notes.join("; ")}` : "";
  const inbound = row.lastInbound ? `${row.lastInbound.name} (${row.lastInbound.ageMin}m)` : "-";
  const outbound = row.lastOutbound ? `${row.lastOutbound.name} (${row.lastOutbound.ageMin}m)` : "-";
  return `${row.lane} [${row.identity}] ${row.repo ?? "-"} ${issue} ${row.state} idle=${row.idleMinutes ?? "-"}m ctx=- pid=${row.pid ?? "-"} session=${row.sessionId ?? "-"} branch=${row.branch ?? "-"} cwd=${row.worktree ?? "-"} in=${inbound} out=${outbound} ${row.evidence.join(",")}${notes}`;
}
export function humanSources(sources: Record<string, Source>, ctx: LanesCtx): void {
  for (const [name, source] of Object.entries(sources)) {
    if (source.status !== "ok" || source.detail) ctx.out(`source: ${name} ${source.status}${source.detail ? ` — ${source.detail}` : ""}`);
  }
}
export async function who(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (args.length) throw new UsageError("who takes no positional arguments");
  const selection = { repo: opts.repo, issue: opts.issue === undefined ? undefined : parseIssue(opts.issue) };
  const now = ctx.now(); const input = await readRoster(c, root, ctx); const registry = indexRosterRegistry(input.register.events);
  const roster = buildRoster(input, now, registry);
  const rows = filterRows(roster.rows, selection); const suggest = suggestTarget(roster.rows, { ...input, registry }, selection, now);
  if (opts.json) ctx.out(JSON.stringify({ at: now.toISOString(), rows, sources: roster.sources, suggest }, null, 2));
  else {
    for (const row of rows) ctx.out(humanRow(row));
    humanSources(roster.sources, ctx);
    ctx.out(`suggest: ${suggest.target ?? "-"} [${suggest.rule}] ${suggest.reason}`);
  }
  return rows.length ? 0 : 1;
}
