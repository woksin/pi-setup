import { join, relative } from "node:path";
import { UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { prepare, readPack, handoffRecipient, packPath, fingerprint, recipient } from "../reap/handoff.ts";
import { safeQuit } from "../reap/safe-quit.ts";
import { archive, checkRetirement } from "../reap/archive.ts";
import { collect, type EvidenceContext, type Signals } from "../reap/signals.ts";
import { atomicJson } from "../reap/files.ts";
import { verdict, type Decision } from "../reap/verdict.ts";
interface Row extends Decision { id: string; signals: Signals; pack?: string; failed?: boolean }
function validateArgs(args: string[], opts: Record<string, string>, c: Config): number {
  if (args.length > 1) throw new UsageError("reap accepts one active lane ID");
  validateId(args[0], c);
  if (opts.apply && opts["dry-run"]) throw new UsageError("choose --apply or --dry-run");
  const minutes = Number(opts.minutes ?? c.idle?.minutes ?? 90);
  if (!Number.isFinite(minutes) || minutes < 1) throw new UsageError("--minutes must be positive"); return minutes;
}
async function applyRow(row: Row, env: EvidenceContext, opts: Record<string, string>): Promise<void> {
  const { lane, c, root, ctx } = env; checkRetirement(lane, c, root);
  const to = opts["handoff-to"] || readPack({ root, lane })?.to || handoffRecipient(lane, c);
  const pack = await prepare(env, to, row.signals); row.pack = relative(root, packPath({ root, lane }));
  if (pack.acceptance?.from !== to || pack.acceptance?.fingerprint !== fingerprint(row.signals)) { row.reason = `takeover request sent to ${to}; explicit acceptance required`; return; }
  await recipient(env, to); await safeQuit(env, row.signals, to);
  row.pack = relative(root, await archive(env, row.signals, to)); row.verdict = "retire"; row.ground = "takeover"; row.reason = `takeover accepted by ${to}; /quit exit confirmed; archived`;
}
async function planRow(env: EvidenceContext, opts: Record<string, string>): Promise<Row> {
  const signals = await collect(env); const row: Row = { id: env.lane.id, ...verdict(signals), signals };
  if (!opts.apply || row.verdict !== "handoff") return row;
  try { await applyRow(row, env, opts); } catch (e) { row.verdict = "ask"; row.reason = (e as Error).message; row.failed = true; }
  return row;
}
function display(rows: Row[], json: boolean, ctx: LanesCtx): void {
  if (json) { ctx.out(JSON.stringify(rows)); return; }
  ctx.out("LANE\tVERDICT\tREASON"); for (const row of rows) ctx.out(`${row.id}\t${row.verdict}${row.ground ? ` (${row.ground})` : ""}\t${row.reason}`);
}
export async function reap(args: string[], opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const minutes = validateArgs(args, opts, c); const rows: Row[] = [];
  const active = c.lanes.filter(l => !l.retired).filter(l => !args[0] || l.id === args[0]);
  for (const lane of active) rows.push(await planRow({ c, lane, root, ctx, minutes }, opts));
  atomicJson(join(root, ".state/reap-plan.json"), { at: ctx.now().toISOString(), minutes, rows }); display(rows, Boolean(opts.json), ctx);
  return rows.some(row => row.failed) ? 2 : 0;
}

function validateId(id: string | undefined, c: Config): void {
  if (!id) return;
  if (!c.lanes.some(l => l.id === id && !l.retired)) throw new UsageError("reap accepts one active lane ID");
}
